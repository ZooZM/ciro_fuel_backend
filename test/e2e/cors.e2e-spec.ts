import request from 'supertest';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';

const ALLOWED = 'http://localhost:5173';
const ALSO_ALLOWED = 'https://dash.example.com';
const NOT_ALLOWED = 'https://evil.example.com';

/**
 * Spec 012 Story 3 (FR-014 – FR-020).
 *
 * This suite was IMPOSSIBLE to write before Slice 0. `test-app.factory.ts` used
 * to hand-roll its own bootstrap and never called `enableCors` at all, so no
 * test could observe cross-origin behaviour — which is exactly how the
 * production-only defect survived: CORS was granted only outside production, so
 * browsers could not reach the API in production while mobile clients, which
 * send no Origin, were unaffected.
 */
describe('Cross-origin access (spec 012 US3)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  }, 60_000);

  describe('allowlisted origins (FR-014, FR-015)', () => {
    it('permits a request from an allowlisted origin and echoes it back', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', ALLOWED)
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    });

    it('permits every origin on the list, not just the first', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', ALSO_ALLOWED)
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe(ALSO_ALLOWED);
    });

    it('allows credentials, so the existing session mechanism keeps working (FR-020)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', ALLOWED)
        .expect(200);

      // Asserted TOGETHER with the origin header: `cors` emits
      // Allow-Credentials whenever the option is on, matched origin or not, so
      // checking it alone would pass even with a completely broken allowlist.
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('non-allowlisted origins (FR-016)', () => {
    it('does not hand the response to an origin that is not on the list', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', NOT_ALLOWED);

      // The browser is what enforces this: without the header it refuses to
      // give the response to the page.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not disclose which origins ARE permitted', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', NOT_ALLOWED);

      const headers = JSON.stringify(res.headers);
      expect(headers).not.toContain(ALLOWED);
      expect(headers).not.toContain(ALSO_ALLOWED);
    });

    it('treats a trailing slash as a different origin — exact match, fails closed', async () => {
      // A near-miss must fail closed and be diagnosable, never silently permit.
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', `${ALLOWED}/`);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('treats a different scheme as a different origin', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', ALLOWED.replace('http://', 'https://'));

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('treats a different port as a different origin', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health/live')
        .set('Origin', 'http://localhost:5174');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('preflight (FR-017)', () => {
    it('succeeds without credentials and without being throttled', async () => {
      const res = await request(ctx.app.getHttpServer())
        .options('/api/v1/orders')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    });

    it('survives far more preflights than the rate limit would allow', async () => {
      // A dashboard doing real work issues a preflight per credentialed
      // request; if those consumed the budget, the limit would bite at a
      // fraction of the intended rate.
      const server = ctx.app.getHttpServer();
      const statuses = new Set<number>();

      for (let i = 0; i < 120; i += 1) {
        const res = await request(server)
          .options('/api/v1/orders')
          .set('Origin', ALLOWED)
          .set('Access-Control-Request-Method', 'GET');
        statuses.add(res.status);
      }

      expect([...statuses]).toEqual([204]);
    }, 60_000);
  });

  describe('clients that send no Origin (FR-019)', () => {
    it('is entirely unaffected — this is every mobile request', async () => {
      // The mobile apps send no Origin header at all, which is why the
      // production CORS defect was invisible to them and looked, from the
      // dashboard, like an authentication failure.
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/live').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still refuses an unauthenticated call to a protected route, unchanged', async () => {
      // CORS must not have become an accidental authorization mechanism.
      await request(ctx.app.getHttpServer()).get('/api/v1/orders').expect(401);
    });
  });
});
