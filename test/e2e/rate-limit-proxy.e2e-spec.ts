import request from 'supertest';
import * as jwtLib from 'jsonwebtoken';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { GlobalThrottlerGuard } from '../../src/common/guards/global-throttler.guard';
import { UserRole } from '../../src/common/enums/user-role.enum';

/**
 * Spec 012 Story 4 (FR-021 – FR-027).
 *
 * The assertion that matters is that the tracker actually KEYS BY USER. The
 * naive implementation — `req.user?.userId ?? req.ip` — compiles, passes review
 * and silently keys everything by address, because `common.module.ts` runs the
 * throttler guard BEFORE `JwtAuthGuard` and `req.user` does not exist yet. A
 * test that only checked "requests eventually 429" would pass against that
 * broken version, so these reach into the tracker directly.
 */
describe('Rate limiting behind a proxy (spec 012 US4)', () => {
  let ctx: TestAppContext;
  let guard: GlobalThrottlerGuard;

  // `getTracker` is protected; exercising it directly is the only way to prove
  // the key, and the key is the whole behaviour under test.
  const sign = (payload: object, opts: { secret?: string; expiresIn?: string }): string =>
    jwtLib.sign(
      payload,
      opts.secret as string,
      opts.expiresIn ? { expiresIn: opts.expiresIn as jwtLib.SignOptions['expiresIn'] } : {},
    );

  const track = (req: Record<string, unknown>): Promise<string> =>
    (guard as unknown as { getTracker(r: Record<string, unknown>): Promise<string> }).getTracker(
      req,
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    guard = ctx.app.get(GlobalThrottlerGuard);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  }, 60_000);

  describe('attribution (FR-021, FR-023)', () => {
    it('keys an authenticated request by USER, not by address', async () => {
      const token = sign(
        { sub: '652f1a2b3c4d5e6f70819200', role: UserRole.CLIENT },
        { secret: process.env.JWT_SECRET },
      );

      const key = await track({
        ip: '203.0.113.10',
        headers: { authorization: `Bearer ${token}` },
      });

      // If this returns the address, the tracker fell through — which is what
      // the obvious `req.user` implementation does, silently, on every request.
      expect(key).toBe('user:652f1a2b3c4d5e6f70819200');
    });

    it('gives the SAME user one budget across two different addresses', async () => {
      const token = sign(
        { sub: '652f1a2b3c4d5e6f70819201', role: UserRole.CLIENT },
        { secret: process.env.JWT_SECRET },
      );
      const auth = { authorization: `Bearer ${token}` };

      const fromOffice = await track({ ip: '203.0.113.10', headers: auth });
      const fromMobile = await track({ ip: '198.51.100.55', headers: auth });

      // A user must not get a fresh budget by changing networks.
      expect(fromOffice).toBe(fromMobile);
    });

    it('gives two users on ONE address separate budgets', async () => {
      const mk = (sub: string) => ({
        ip: '203.0.113.10',
        headers: {
          authorization: `Bearer ${sign({ sub, role: UserRole.CLIENT }, { secret: process.env.JWT_SECRET })}`,
        },
      });

      const a = await track(mk('652f1a2b3c4d5e6f70819202'));
      const b = await track(mk('652f1a2b3c4d5e6f70819203'));

      // Everyone in one office must not share a bucket.
      expect(a).not.toBe(b);
    });

    it('keys an unauthenticated request by originating address', async () => {
      const key = await track({ ip: '203.0.113.10', headers: {} });

      expect(key).toBe('203.0.113.10');
    });
  });

  describe('an unverified claim is never trusted (FR-023)', () => {
    it('IGNORES a forged token and falls back to the address', async () => {
      // Signed with the wrong key: if the tracker decoded without verifying,
      // this would let anyone exhaust a named user's budget — a targeted denial
      // of service introduced by the rate-limit fix itself.
      const forged = sign(
        { sub: 'victim-user-id', role: UserRole.CLIENT },
        { secret: 'not-the-platform-signing-key-0123456789' },
      );

      const key = await track({
        ip: '203.0.113.99',
        headers: { authorization: `Bearer ${forged}` },
      });

      expect(key).toBe('203.0.113.99');
      expect(key).not.toContain('victim-user-id');
    });

    it('ignores an expired token and falls back to the address', async () => {
      const expired = sign(
        { sub: '652f1a2b3c4d5e6f70819204', role: UserRole.CLIENT },
        { secret: process.env.JWT_SECRET, expiresIn: '-1s' },
      );

      const key = await track({
        ip: '203.0.113.98',
        headers: { authorization: `Bearer ${expired}` },
      });

      expect(key).toBe('203.0.113.98');
    });

    it('ignores a malformed authorization header', async () => {
      for (const authorization of ['Bearer not-a-jwt', 'Basic abc123', 'Bearer ', 'garbage']) {
        const key = await track({ ip: '203.0.113.97', headers: { authorization } });
        expect(key).toBe('203.0.113.97');
      }
    });
  });

  describe('the 429 body is unchanged (FR-027)', () => {
    it('keeps statusCode, message, error and retryAfterSeconds', async () => {
      const server = ctx.app.getHttpServer();
      let throttled: request.Response | undefined;

      // Login is decorated `@Throttle({ default: { limit: 10, ttl: 60s } })`,
      // read by THIS guard. Behind a proxy before this feature, all five such
      // routes shared one platform-wide bucket — ten failed logins from any one
      // client would have locked every user out of logging in.
      for (let i = 0; i < 15; i += 1) {
        const res = await request(server)
          .post('/api/v1/auth/login')
          .send({ email: 'nobody@example.com', password: 'wrong-password-123' });
        if (res.status === 429) {
          throttled = res;
          break;
        }
      }

      expect(throttled).toBeDefined();
      expect(throttled!.body.statusCode).toBe(429);
      expect(throttled!.body.message).toBe('Too many requests');
      expect(throttled!.body.error).toBe('ThrottlerException');
      expect(typeof throttled!.body.retryAfterSeconds).toBe('number');
      expect(throttled!.body.retryAfterSeconds).toBeGreaterThan(0);
    }, 60_000);
  });
});
