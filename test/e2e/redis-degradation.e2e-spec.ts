import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';

jest.setTimeout(240_000);

/**
 * Spec 012 FR-061 – FR-061c, FR-063b, Clarification Q7.
 *
 * **The finding this suite exists for.** Story 9 makes Redis load-bearing for
 * five subsystems at once (queues, cache, throttler counters, scheduler leases,
 * socket fan-out) while Q7 deliberately keeps a Redis-less instance IN rotation
 * — readiness reports Redis but never disqualifies on it — so that a Redis
 * outage degrades the platform instead of emptying nginx's upstream.
 *
 * That is only sound if every one of the five degrades gracefully, and the
 * shared throttler store does NOT: `ThrottlerStorageRedisService` fails CLOSED,
 * and the guard is global, so a storage error would have been a 500 on EVERY
 * REQUEST ON THE PLATFORM. Redis would have become a harder dependency than
 * MongoDB, and the decision taken to prevent a total outage would have caused
 * one.
 */
describe('Redis degradation (spec 012 US9)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let storage: ResilientThrottlerStorage;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    storage = app.get(ResilientThrottlerStorage);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 60_000);

  /** Makes the wrapped store unreachable without touching the real Redis. */
  const breakSharedStore = (): jest.SpyInstance => {
    const shared = (storage as unknown as { shared: { increment: unknown } }).shared;
    return jest
      .spyOn(shared as { increment: () => Promise<never> }, 'increment')
      .mockRejectedValue(new Error('redis unreachable'));
  };

  describe('requests still SUCCEED when the counter store is unavailable (FR-061a)', () => {
    it('does not turn a Redis outage into a 500 on every request', async () => {
      const spy = breakSharedStore();
      try {
        const res = await request(app.getHttpServer())
          .get('/api/v1/orders')
          .set('Authorization', `Bearer ${fixtures.companyA.client.token}`);

        // Fail-closed would make this a 500 — and since the throttler guard is
        // global, EVERY request on the platform would be a 500 for the duration
        // of a dependency the platform is explicitly designed to survive.
        expect(res.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('records ENTERING the fallback, so a degraded period is identifiable afterwards (FR-061c)', async () => {
      const spy = breakSharedStore();
      try {
        await request(app.getHttpServer())
          .get('/api/v1/orders')
          .set('Authorization', `Bearer ${fixtures.companyA.client.token}`);

        // Requests still succeed while degraded, so no error rate moves and no
        // request fails. Without this state being observable, a period of
        // loosened rate limiting leaves no trace whatsoever.
        expect(storage.isDegraded()).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('the fallback still LIMITS — it does not fail open (FR-061b)', () => {
    it('blocks a client that exceeds the budget even with the shared store down', async () => {
      const spy = breakSharedStore();
      try {
        const key = `degradation-probe-${Date.now()}`;
        const limit = 3;

        const results = [];
        for (let i = 0; i < limit + 2; i += 1) {
          results.push(await storage.increment(key, 60_000, limit, 60_000, 'default'));
        }

        // Failing OPEN here would strip brute-force protection from login,
        // refresh and the OTP paths at exactly the moment the platform is
        // already degraded and least able to absorb it. The degraded budget is
        // N× the configured limit across N instances — bounded, not absent.
        expect(results[limit - 1].isBlocked).toBe(false);
        expect(results[limit].isBlocked).toBe(true);
        expect(results[limit].totalHits).toBe(limit + 1);
        // Seconds, not milliseconds: the guard renders this straight into
        // `Retry-After`, so the wrong unit is a plausible-looking header off by
        // a factor of a thousand.
        expect(results[limit].timeToBlockExpire).toBeLessThanOrEqual(60);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('recovery is automatic (FR-061c)', () => {
    it('returns to cross-instance counting once the store answers again, with no restart', async () => {
      const spy = breakSharedStore();
      await storage.increment(`recovery-probe-${Date.now()}`, 60_000, 10, 60_000, 'default');
      expect(storage.isDegraded()).toBe(true);

      spy.mockRestore();
      await storage.increment(`recovery-probe-${Date.now()}`, 60_000, 10, 60_000, 'default');

      expect(storage.isDegraded()).toBe(false);
    });
  });

  describe('the degradation is visible from outside (FR-063b)', () => {
    it('reports it in the readiness body while STAYING in rotation', async () => {
      const spy = breakSharedStore();
      try {
        await storage.increment(`readiness-probe-${Date.now()}`, 60_000, 10, 60_000, 'default');

        const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);

        // 200 AND a `down` entry, deliberately (Q7): the proxy reads the status
        // code, monitoring reads the fields. Disqualifying here would take every
        // instance out of rotation at the same instant and leave nginx with an
        // empty upstream — a partial degradation converted into a total outage.
        expect(res.body.details.rateLimiting.status).toBe('down');
        expect(res.body.error.rateLimiting).toBeDefined();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
