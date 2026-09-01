import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(240_000);

/**
 * Spec 012 Story 8 (FR-050 – FR-055).
 *
 * The situation: the driver's DEFAULTS are the problem. `serverSelectionTimeoutMS`
 * is 30 s and `waitQueueTimeoutMS` is unbounded, so a brief interruption does
 * not fail requests — it PARKS them. Work piles up behind an unavailable
 * server, the event loop fills, and the instance stops answering anything at
 * all including its own readiness probe. The outage then presents as an
 * application hang rather than a database blip.
 *
 * The database is interrupted here by closing the app's connection rather than
 * by stopping the replica set: stopping `MongoMemoryReplSet` and restarting it
 * on the same port is not something the harness supports, and the property
 * under test — bounded failure and unattended recovery — is a property of the
 * connection, which is what is manipulated.
 */
describe('Database resilience (spec 012 US8)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 60_000);

  describe('the configured bounds are actually applied (FR-050, FR-051, FR-055)', () => {
    it('sets explicit pool and timeout options on the live connection', () => {
      const opts = connection.getClient().options as unknown as Record<string, number>;

      expect(opts.maxPoolSize).toBe(20);
      expect(opts.minPoolSize).toBe(2);
      // Bounded, and far below the driver's 30 s default — this is what turns a
      // pile-up into a prompt failure.
      expect(opts.serverSelectionTimeoutMS).toBe(5000);
      expect(opts.waitQueueTimeoutMS).toBe(10000);
    });

    it('keeps the socket timeout ABOVE the longest legitimate transaction (FR-054, T081)', () => {
      const opts = connection.getClient().options as unknown as Record<string, number>;

      // The dispatch assignment (a multi-document driver/truck/tank booking)
      // and the payment webhook are the two longest boundaries in the platform.
      // Set the socket timeout below either and this story's resilience work
      // becomes this story's DATA-INTEGRITY BUG: the socket is torn down
      // mid-commit and the transaction's outcome is decided by a timeout rather
      // than by the application.
      //
      // Asserted as an ordering, not just a number: a socket timeout is a
      // backstop against a hung connection, never a request deadline, so it
      // must stay comfortably above the selection and wait-queue bounds too.
      expect(opts.socketTimeoutMS).toBe(45000);
      expect(opts.socketTimeoutMS).toBeGreaterThan(opts.serverSelectionTimeoutMS);
      expect(opts.socketTimeoutMS).toBeGreaterThan(opts.waitQueueTimeoutMS);
    });
  });

  describe('an unreachable database fails promptly, in the standard shape (FR-052)', () => {
    it('does not pile requests up, and answers each one in the platform error envelope', async () => {
      await connection.close();
      try {
        const started = Date.now();
        // Concurrent, deliberately: the failure mode being excluded is that
        // requests QUEUE rather than fail, which only shows up under more than
        // one of them.
        const responses = await Promise.all(
          Array.from({ length: 8 }, () =>
            request(app.getHttpServer())
              .get('/api/v1/orders')
              .set('Authorization', `Bearer ${fixtures.companyA.client.token}`),
          ),
        );
        const elapsed = Date.now() - started;

        // Well inside serverSelectionTimeoutMS × 8, which is what serialised
        // pile-up would cost.
        expect(elapsed).toBeLessThan(30_000);
        for (const res of responses) {
          expect(res.status).toBeGreaterThanOrEqual(500);
          // Through HttpExceptionFilter, so a database failure is reported the
          // same way as every other failure — not as a raw driver error or a
          // hung socket.
          expect(res.body).toMatchObject({
            statusCode: expect.any(Number),
            message: expect.anything(),
            error: expect.any(String),
          });
        }
      } finally {
        await connection.openUri(process.env.MONGODB_URI!);
      }
    }, 120_000);
  });

  describe('readiness follows the database, in both directions (FR-005, FR-053)', () => {
    it('reports not-ready while unreachable and recovers on its own, with no restart', async () => {
      // Liveness must stay 200 throughout: an instance whose database is down
      // is not an instance that should be killed. Wiring liveness to dependency
      // health turns a database incident into a restart storm on top of one.
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

      await connection.close();
      try {
        await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
        await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      } finally {
        await connection.openUri(process.env.MONGODB_URI!);
      }

      // No restart, no operator action, no permanent condemnation from a single
      // failed probe — the instance returns to rotation by itself once the
      // dependency is back.
      let ready = false;
      const deadline = Date.now() + 60_000;
      while (!ready && Date.now() < deadline) {
        const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
        ready = res.status === 200;
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      expect(ready).toBe(true);
    }, 180_000);
  });
});
