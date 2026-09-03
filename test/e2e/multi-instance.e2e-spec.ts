import { io, Socket } from 'socket.io-client';
import { createMultiInstanceApps, MultiInstanceContext } from '../utils/multi-instance.factory';
import { SchedulerLeaseService } from '../../src/common/scheduler/scheduler-lease.service';
import { SWEEP_NAMES } from '../../src/common/scheduler/sweep-names.const';
import { RealtimeGatewayService } from '../../src/common/realtime/realtime-gateway.service';
import { PresenceService } from '../../src/modules/tracking/presence/presence.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UsersService } from '../../src/modules/users/users.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import type Redis from 'ioredis';

jest.setTimeout(300_000);

/**
 * Spec 012 Story 9 (FR-056b – FR-063b, SC-017).
 *
 * **These guarantees are not observable with one instance.** A single app
 * cannot distinguish a working scheduler lease from no lease, a working socket
 * adapter from a broken one, or a shared rate-limit counter from a per-instance
 * one — in each case one instance produces the correct-looking answer by
 * itself. Every failure this story exists to prevent needs a second instance to
 * become visible, which is why this harness exists rather than a manual check.
 */
describe('Horizontal readiness — two instances (spec 012 US9)', () => {
  let ctx: MultiInstanceContext;

  beforeAll(async () => {
    ctx = await createMultiInstanceApps({ schedulerLeaseEnabled: true });
  }, 300_000);

  afterAll(async () => {
    await ctx.close();
  }, 120_000);

  describe('the scheduler lease is CONTESTED, and exactly one wins (FR-056b, FR-070)', () => {
    const uniqueSweep = (): typeof SWEEP_NAMES.PRESENCE_OFFLINE => SWEEP_NAMES.PRESENCE_OFFLINE;

    beforeEach(async () => {
      // Redis is shared across suites and across runs, so a lease left behind
      // by anything else would decide this test's outcome instead of the test.
      const redis = ctx.a.get<Redis>(REDIS_CLIENT);
      await redis.del(`scheduler:lease:${uniqueSweep()}`);
    });

    it('lets only ONE of two instances run the same sweep in one interval', async () => {
      const leaseA = ctx.a.get(SchedulerLeaseService);
      const leaseB = ctx.b.get(SchedulerLeaseService);

      let ranA = false;
      let ranB = false;
      // Started together, and each holds the lease long enough to overlap the
      // other's attempt — the failure being excluded is two instances sweeping
      // at once, which sequential calls could never reveal.
      const [wonA, wonB] = await Promise.all([
        leaseA.runExclusively(uniqueSweep(), async () => {
          ranA = true;
          await new Promise((r) => setTimeout(r, 300));
        }),
        leaseB.runExclusively(uniqueSweep(), async () => {
          ranB = true;
          await new Promise((r) => setTimeout(r, 300));
        }),
      ]);

      expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
      expect([ranA, ranB].filter(Boolean)).toHaveLength(1);
    });

    it('releases the lease afterwards, so the NEXT interval is contested fairly', async () => {
      const leaseA = ctx.a.get(SchedulerLeaseService);
      const redis = ctx.a.get<Redis>(REDIS_CLIENT);

      await leaseA.runExclusively(uniqueSweep(), async () => undefined);

      // Released rather than left to expire. Left to expire, the winner would
      // be guaranteed the lease again for the remainder of the 55 s TTL, so one
      // instance would monopolise the sweep instead of the two taking turns.
      expect(await redis.get(`scheduler:lease:${uniqueSweep()}`)).toBeNull();
    });

    it("a holder's DEATH lets the survivor run the next sweep, with no operator action (T100)", async () => {
      const redis = ctx.a.get<Redis>(REDIS_CLIENT);
      const key = `scheduler:lease:${uniqueSweep()}`;

      // A lease written by an instance that then died: the token is still
      // there, and no release will ever come for it. The expiry — set in the
      // SAME atomic SET as the acquisition, which is why acquire is not
      // SETNX-then-EXPIRE — is the only thing that recovers this.
      await redis.set(key, 'dead-instance-token', 'PX', 400);

      const leaseB = ctx.b.get(SchedulerLeaseService);
      expect(await leaseB.runExclusively(uniqueSweep(), async () => undefined)).toBe(false);

      await new Promise((r) => setTimeout(r, 700));

      expect(await leaseB.runExclusively(uniqueSweep(), async () => undefined)).toBe(true);
    });

    it('a lapsed lease is HARMLESS, because the sweep is idempotent (FR-057, T093)', async () => {
      // The lease is at-most-once, not exactly-once: a holder that pauses past
      // the TTL loses it while still believing it holds it, and both instances
      // run. Correctness therefore rests on the sweeps, not on the lease — so
      // running the same sweep concurrently on both instances must converge.
      const presenceA = ctx.a.get(PresenceService);
      const presenceB = ctx.b.get(PresenceService);
      const redis = ctx.a.get<Redis>(REDIS_CLIENT);
      await redis.del(`scheduler:lease:${uniqueSweep()}`);

      await expect(
        Promise.all([presenceA.sweepOfflineDrivers(), presenceB.sweepOfflineDrivers()]),
      ).resolves.toBeDefined();
    });
  });

  describe('rate-limit counters are SHARED across instances (FR-061)', () => {
    it('counts a client against one budget no matter which instance answers', async () => {
      const redis = ctx.a.get<Redis>(REDIS_CLIENT);
      const storageA = ctx.a.get(
        (await import('../../src/common/throttler/resilient-throttler.storage'))
          .ResilientThrottlerStorage,
      );
      const storageB = ctx.b.get(
        (await import('../../src/common/throttler/resilient-throttler.storage'))
          .ResilientThrottlerStorage,
      );
      const key = `multi-instance-shared-${Date.now()}`;
      await redis.del(key);

      const first = await storageA.increment(key, 60_000, 10, 60_000, 'default');
      const second = await storageB.increment(key, 60_000, 10, 60_000, 'default');

      // 2, not 1. Per-instance counting gives each instance its own `1`, so the
      // effective limit is silently N× the configured one — the limit APPEARS
      // to work and does not, which is the whole reason the store moved to
      // Redis.
      expect(first.totalHits).toBe(1);
      expect(second.totalHits).toBe(2);
      expect(storageA.isDegraded()).toBe(false);
    });
  });

  describe('realtime events cross instances (FR-059, FR-060, SC-013)', () => {
    let driverToken: string;
    let driverId: string;

    beforeAll(async () => {
      const users = ctx.a.get(UsersService);
      const auth = ctx.a.get(AuthService);
      const driver = await users.create({
        role: UserRole.DRIVER,
        email: `multi-instance-driver-${Date.now()}@test.local`,
        password: 'Password123!',
        fullName: 'Multi Instance Driver',
        phone: `+96650${String(Date.now()).slice(-7)}`,
        isActive: true,
      });
      driverId = String(driver._id);
      const session = await auth.login({ email: driver.email, password: 'Password123!' });
      driverToken = session.accessToken;
    }, 120_000);

    it('delivers an event emitted by instance B to a client connected to instance A', async () => {
      // THE failure this story exists to prevent, and the one that cannot be
      // seen from a single instance: without the Redis adapter, a client on A
      // simply never receives what B emitted. There is no error and no
      // exception — from B's own vantage point the emit succeeded, because it
      // did reach B's own clients. With two replicas that is roughly half of
      // all events, silently.
      const socket: Socket = io(`${ctx.urlA}/tracking`, {
        transports: ['websocket'],
        auth: { token: driverToken },
        forceNew: true,
      });

      try {
        await new Promise<void>((resolve, reject) => {
          socket.on('connect', () => resolve());
          socket.on('connect_error', reject);
          setTimeout(() => reject(new Error('connect timed out')), 15_000);
        });

        const received = new Promise<Record<string, unknown>>((resolve, reject) => {
          socket.on('order:status', resolve);
          setTimeout(() => reject(new Error('event never crossed instances')), 20_000);
        });

        // Emitted from the OTHER instance, through the same service every
        // outbound emission in the codebase funnels through.
        ctx.b
          .get(RealtimeGatewayService)
          .emitToUser(driverId, 'order:status', { orderId: 'cross-instance-probe' });

        await expect(received).resolves.toMatchObject({ orderId: 'cross-instance-probe' });
      } finally {
        socket.close();
      }
    }, 90_000);

    it('feature 013 T030: a displacement disconnect issued on instance B ends a socket connected to instance A', async () => {
      // The tidy-up half of US2 (realtime-contract §3): `disconnectUser` is a
      // room operation, so — like `emitToUser` above — it only reaches a
      // socket on another instance through the Redis adapter. This is exactly
      // the capability spec 012 found silently dead.
      const socket: Socket = io(`${ctx.urlA}/tracking`, {
        transports: ['websocket'],
        auth: { token: driverToken },
        forceNew: true,
        reconnection: false,
      });

      try {
        await new Promise<void>((resolve, reject) => {
          socket.on('connect', () => resolve());
          socket.on('connect_error', reject);
          setTimeout(() => reject(new Error('connect timed out')), 15_000);
        });

        const disconnected = new Promise<string>((resolve, reject) => {
          socket.on('disconnect', (reason: string) => resolve(reason));
          setTimeout(() => reject(new Error('disconnect never crossed instances')), 20_000);
        });

        ctx.b.get(RealtimeGatewayService).disconnectUser(driverId);

        await expect(disconnected).resolves.toBeDefined();
        expect(socket.connected).toBe(false);
      } finally {
        socket.close();
      }
    }, 90_000);
  });

  describe('both instances serve identically (FR-069)', () => {
    it('reports ready on each, with distinct instance ids', async () => {
      const request = (await import('supertest')).default;

      const a = await request(ctx.a.getHttpServer()).get('/api/v1/health/ready').expect(200);
      const b = await request(ctx.b.getHttpServer()).get('/api/v1/health/ready').expect(200);

      // Distinct ids are what make a record attributable to the instance that
      // produced it (FR-035a) — `configuration.ts` falls back to `hostname()`,
      // which on one machine would give both the same value and quietly defeat
      // every instance-scoped query in an incident.
      expect(a.body.instanceId).toBe('test-instance-a');
      expect(b.body.instanceId).toBe('test-instance-b');
    });
  });
});
