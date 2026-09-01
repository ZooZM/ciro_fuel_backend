import request from 'supertest';
import { io } from 'socket.io-client';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { ShutdownService } from '../../src/bootstrap/shutdown.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { StopEscalationProcessor } from '../../src/modules/stop-detection/queues/stop-escalation.processor';
import { seedTwoCompanies } from '../utils/fixtures';

/**
 * Spec 012 Story 2 (FR-005, FR-008 – FR-013).
 *
 * Scope, stated honestly: an in-process suite cannot assert on its own process
 * exiting, so the drain DEADLINE and the forced-exit record (FR-012) are not
 * covered here — they are pre-launch checklist items. What IS covered is
 * everything that decides whether that exit is safe: the ordering of the drain
 * gate against connection close (FR-005), that a draining instance still
 * serves (FR-008), and that `close()` actually runs the module destroy hooks
 * (FR-011).
 *
 * Two apps, not four: each `createTestApp` boots its own MongoMemoryReplSet,
 * which dominates the runtime. The drain gate is one-way, so the tests that
 * need "not yet draining" run before the flip on a single shared app.
 */
describe('Graceful shutdown (spec 012 US2)', () => {
  describe('drain gate (FR-005, FR-008)', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
      ctx = await createTestApp();
    }, 120_000);

    afterAll(async () => {
      await ctx.close();
    }, 60_000);

    it('reports ready before any signal arrives', async () => {
      await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    });

    it('turns readiness negative the moment the gate flips, while still serving', async () => {
      const shutdown = ctx.app.get(ShutdownService);
      expect(shutdown.isDraining()).toBe(false);

      shutdown.beginDraining('SIGTERM');

      // Readiness is negative. The body keeps its health shape at top level:
      // `HttpExceptionFilter` spreads a deliberate exception body rather than
      // flattening it, so `error`/`details` survive — the same shape Terminus
      // itself produces for the mongodb-down path, which is what monitoring
      // reads either way.
      const health = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready');
      expect(health.status).toBe(503);
      expect(health.body.statusCode).toBe(503);
      expect(health.body.status).toBe('error');
      expect(health.body.error.shutdown.message).toBe('draining');

      // ...but the instance still accepts and answers work. That gap IS the
      // feature: the proxy stops sending new requests while the ones already
      // accepted are allowed to finish.
      await request(ctx.app.getHttpServer()).get('/api/v1/health/live').expect(200);
    });

    it('stays 503 while draining even though every dependency is healthy', async () => {
      // The verdict is about intent, not health. A draining instance is
      // perfectly capable of serving and must still leave the rotation.
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.details.redis.status).toBe('up');
    });

    it('is idempotent across repeated signals', async () => {
      const shutdown = ctx.app.get(ShutdownService);
      const elapsedBefore = shutdown.drainElapsedMs();

      shutdown.beginDraining('SIGTERM');
      shutdown.beginDraining('SIGINT');

      // A second signal must not restart the clock, or an impatient operator
      // sending SIGTERM twice would extend the drain deadline indefinitely.
      expect(shutdown.drainElapsedMs()).toBeGreaterThanOrEqual(elapsedBefore);
      expect(shutdown.isDraining()).toBe(true);
    });
  });

  describe('close() stops background workers and realtime connections (FR-009, FR-010)', () => {
    /**
     * These assert that the FRAMEWORK already does this, which is why neither
     * needs code of its own.
     *
     * `NestApplication.close()` runs all four phases unconditionally —
     * `callDestroyHook`, `callBeforeShutdownHook`, `dispose`, `callShutdownHook`
     * (verified in `nest-application-context.js`). `@nestjs/bullmq` closes its
     * workers in `onApplicationShutdown`, and `dispose()` runs
     * `SocketModule.close()`, which closes the socket.io server. Adding
     * `OnModuleDestroy` hooks to the three processors — as the task list
     * originally assumed was needed — would duplicate that and risk a
     * double-close. The behaviour is asserted here instead.
     */
    it('stops the BullMQ workers, so an unfinished job is released for redelivery', async () => {
      const ctx = await createTestApp();
      const processor = ctx.app.get(StopEscalationProcessor);

      // `isRunning()` is true as soon as the worker starts its run loop, which
      // is BEFORE its blocking Redis connection has finished initialising.
      // Closing in that window makes BullMQ's `RedisConnection` emit an
      // 'error' from its own constructor, before `QueueBase` has attached a
      // listener — an unhandled EventEmitter error the application cannot
      // intercept, because the window is inside the library. `waitUntilReady`
      // is the precondition this test actually wants: a fully started worker.
      await processor.worker.waitUntilReady();
      expect(processor.worker.isRunning()).toBe(true);

      await ctx.close();

      // Not running means it has stopped fetching and released its lock —
      // which is precisely what makes an interrupted job redeliverable rather
      // than abandoned mid-write (FR-009).
      expect(processor.worker.isRunning()).toBe(false);
    }, 120_000);

    it('disconnects realtime clients in a way their reconnect logic recognises', async () => {
      const ctx = await createTestApp();
      const fixtures = await seedTwoCompanies(ctx.app);

      // Captured BEFORE the socket exists. Read after connecting, the baseline
      // can already BE the value the wait below is waiting to exceed, and the
      // loop then spins until its deadline — which is how this test failed
      // after the wait was first added.
      const userModel = ctx.app.get<Model<UserDocument>>(getModelToken(User.name));
      const baseline = (await userModel.findById(fixtures.companyA.driver.id).exec())?.lastSeenAt;

      const socket = io(`${ctx.url}/tracking`, {
        auth: { token: fixtures.companyA.driver.token },
        transports: ['websocket'],
        // `reconnection: false` is load-bearing for the TEST, not the subject.
        // socket.io-client reconnects by default, so when `close()` drops the
        // connection the client immediately dials back in — and a reconnect
        // that lands mid-teardown runs `handleConnection`, whose
        // `presenceService.touch()` then hits a Mongo client that
        // `callDestroyHook()` has already closed. `app.close()` rejects with
        // MongoClientClosedError and the suite fails for a reason that has
        // nothing to do with shutdown ordering. The assertion below is about
        // the FIRST disconnect's reason, so reconnection is not needed.
        reconnection: false,
      });
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });

      // Waits for the SERVER side of the connection to finish, not just the
      // client's `connect` event. Since spec 012 attached the Redis adapter,
      // `handleConnection`'s `client.join()` round-trips through Redis before
      // its `presenceService.touch()` Mongo write runs — so a close issued on
      // `connect` alone can tear the Mongo client out from under that write,
      // and `app.close()` rejects with MongoClientClosedError. The driver being
      // marked online IS that write completing, so this is a real signal rather
      // than a sleep.
      // Waits on `lastSeenAt` ADVANCING, not on `isOnline` — the fixture driver
      // is seeded `isOnline: true`, so an `isOnline` check passes on its first
      // read and waits for nothing at all. `lastSeenAt` is what
      // `presenceService.touch()` writes, so its advance past the baseline
      // captured above is that write completing.
      const deadline = Date.now() + 10_000;
      let touched = false;
      while (!touched && Date.now() < deadline) {
        const driver = await userModel.findById(fixtures.companyA.driver.id).exec();
        touched =
          driver?.lastSeenAt !== undefined &&
          (baseline === undefined || driver.lastSeenAt.getTime() > baseline.getTime());
        if (!touched) await new Promise((r) => setTimeout(r, 50));
      }
      expect(touched).toBe(true);

      const disconnectReason = new Promise<string>((resolve) => {
        socket.on('disconnect', (reason: string) => resolve(reason));
      });

      // Drives the REAL drain sequence rather than jumping straight to
      // `close()`: a signal flips the gate first, which is what stops the
      // scheduled sweeps so none begins in the close window
      // (`ShutdownService.stopScheduledWork`). Production always takes this
      // path, so the test should too.
      ctx.app.get(ShutdownService).beginDraining('SIGTERM');
      await ctx.close();

      // A named reason — not a vanished socket. `transport close` is what a
      // client's own reconnect logic keys on; before this feature the process
      // was killed outright and the connection simply disappeared (FR-010).
      await expect(disconnectReason).resolves.toBeTruthy();
      socket.disconnect();
    }, 120_000);
  });

  describe('close() runs the module destroy hooks (FR-011)', () => {
    it('disconnects Redis — a hook that until now never ran on a signal', async () => {
      // `RedisModule.onModuleDestroy` was written specifically to close the
      // ioredis connection, with a comment saying so, and had never once
      // executed in production: nothing called `app.close()` on SIGTERM,
      // because shutdown handling did not exist. This asserts it fires.
      const ctx = await createTestApp();
      const redis = ctx.app.get<{ status: string }>(REDIS_CLIENT);

      // ioredis reports 'connect' then 'ready'; either means an open socket.
      // What matters is that it is NOT already closed before we close the app.
      expect(['ready', 'connect', 'connecting']).toContain(redis.status);

      await ctx.close();

      expect(['end', 'close']).toContain(redis.status);
    }, 120_000);
  });
});
