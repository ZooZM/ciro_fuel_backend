import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type Redis from 'ioredis';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  DEFAULT_PASSWORD,
  uniquePhone,
} from '../utils/fixtures';
import { SmsSender } from '../../src/common/sms/sms-sender.port';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { PasswordResetService } from '../../src/modules/auth/services/password-reset.service';
import {
  PasswordReset,
  PasswordResetDocument,
} from '../../src/modules/auth/schemas/password-reset.schema';

jest.setTimeout(120_000);

class RecordingSmsSender implements SmsSender {
  sent: { phone: string; message: string }[] = [];

  async send(phone: string, message: string): Promise<void> {
    this.sent.push({ phone, message });
  }

  reset(): void {
    this.sent = [];
  }

  codeAt(index: number): string {
    const message = this.sent[index]?.message;
    const match = message?.match(/\d{6}/);
    if (!match) throw new Error(`no code found in message at index ${index}`);
    return match[0];
  }

  lastCode(): string {
    return this.codeAt(this.sent.length - 1);
  }
}

describe('Password recovery (spec 006 US3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let passwordResetModel: Model<PasswordResetDocument>;
  let passwordResetService: PasswordResetService;
  const sms = new RecordingSmsSender();

  beforeAll(async () => {
    ctx = await createTestApp({ smsSender: sms });
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    passwordResetModel = app.get(getModelToken(PasswordReset.name));
    passwordResetService = app.get(PasswordResetService);

    // Redis (unlike the in-memory Mongo replica set) is a real, persistent
    // instance shared across separate test-process runs, while
    // `uniquePhone()`'s counter restarts at 0 every run — so a rate-limit
    // key from a previous run's identical phone sequence can still be
    // sitting there with time left on its TTL. Clearing this feature's own
    // keys up front keeps the rate-limit tests deterministic regardless of
    // what an earlier run left behind.
    const redis = app.get<Redis>(REDIS_CLIENT);
    const staleKeys = await redis.keys('password-reset:rate:*');
    if (staleKeys.length > 0) {
      await redis.del(...staleKeys);
    }
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(() => sms.reset());

  /** A fresh DRIVER under companyA's transport company, isolated per test
   * that actually changes a password — mutating the shared fixture driver
   * and restoring it afterward would make every test fragile to another
   * test's ordering or a mid-test failure. */
  async function createFreshDriver(): Promise<{ id: string; phone: string }> {
    const { transportAdmin } = fixtures.companyA;
    const phone = uniquePhone();

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({
        role: 'DRIVER',
        email: `password-reset-${Date.now()}-${Math.random()}@companya.test`,
        password: DEFAULT_PASSWORD,
        fullName: 'Password Reset Driver',
        phone,
      })
      .expect(201);

    return { id: createRes.body._id, phone };
  }

  /**
   * Issues a code via the service directly, bypassing the HTTP layer.
   *
   * `POST /auth/password-reset/request` carries the same per-IP
   * `@Throttle({limit: 10, ttl: 60s})` `/auth/login` does (deliberately —
   * see rest-api-delta.md), and every test in this file shares one
   * "IP" (supertest against one in-process server). A file that genuinely
   * needs more than 10 real requests to that route across ~10 seconds of
   * wall-clock test time would trip that guard for reasons that have
   * nothing to do with what most of these tests actually check — the
   * per-*phone* limiter `checkRateLimit` enforces inside the service,
   * which this direct call still exercises identically, since the guard
   * sits in front of the controller, not inside the service method. Only
   * the tests whose actual subject is the HTTP-level contract (enumeration
   * parity, and the IP-adjacent phone rate limit itself) call the real
   * route.
   */
  function issueCodeDirect(phone: string) {
    return passwordResetService.requestReset(phone);
  }

  // ==========================================================================
  // FR-021 — enumeration parity. This is the single most important property
  // of the request endpoint: everything else is secondary to it never
  // leaking which phone numbers have accounts. Real HTTP throughout: the
  // whole point is comparing the two actual responses.
  // ==========================================================================
  it(
    'returns an identical response for a registered and an unregistered ' +
      'phone number — status, body shape, and no code leaked either way',
    async () => {
      const { phone: registeredPhone } = await createFreshDriver();
      const unregisteredPhone = uniquePhone();

      const registeredRes = await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset/request')
        .send({ phone: registeredPhone })
        .expect(202);

      const unregisteredRes = await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset/request')
        .send({ phone: unregisteredPhone })
        .expect(202);

      expect(registeredRes.body).toEqual(unregisteredRes.body);
      expect(registeredRes.body).toEqual({ expiresInMinutes: 5, attemptsAllowed: 5 });

      // An SMS is sent only for the registered number — but that fact
      // never surfaces in either HTTP response.
      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0].phone).toBe(registeredPhone);
      expect(JSON.stringify(registeredRes.body)).not.toMatch(/\d{6}/);
      expect(JSON.stringify(unregisteredRes.body)).not.toMatch(/\d{6}/);
    },
  );

  it('verifying a code for a number that was never registered is also RESET_CODE_INVALID, not a different error', async () => {
    const unregisteredPhone = uniquePhone();
    await issueCodeDirect(unregisteredPhone);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone: unregisteredPhone, code: '123456' })
      .expect(400);
    expect(res.body.error).toBe('RESET_CODE_INVALID');
  });

  // ==========================================================================
  // FR-024 — attempts and lockout
  // ==========================================================================
  it('a wrong code is refused, and 5 wrong attempts lock the code out entirely', async () => {
    const { phone } = await createFreshDriver();
    await issueCodeDirect(phone);

    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset/verify')
        .send({ phone, code: '000000' })
        .expect(400);
      expect(res.body.error).toBe('RESET_CODE_INVALID');
    }

    // Even the real code is refused once locked out.
    const lockedOut = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: sms.lastCode() })
      .expect(400);
    expect(lockedOut.body.error).toBe('RESET_CODE_INVALID');
  });

  it('never returns attemptsRemaining on the verify endpoint (no per-attempt oracle)', async () => {
    const { phone } = await createFreshDriver();
    await issueCodeDirect(phone);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: '000000' })
      .expect(400);
    expect(res.body.attemptsRemaining).toBeUndefined();
  });

  // ==========================================================================
  // FR-023 — reissue supersedes
  // ==========================================================================
  it('requesting a new code invalidates the previous one — only the most recent works', async () => {
    const { phone } = await createFreshDriver();

    await issueCodeDirect(phone);
    const firstCode = sms.codeAt(0);

    await issueCodeDirect(phone);
    const secondCode = sms.codeAt(1);

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: firstCode })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: secondCode })
      .expect(200);
  });

  // ==========================================================================
  // FR-022 — expiry
  // ==========================================================================
  it('an expired code is refused', async () => {
    const { phone } = await createFreshDriver();
    await issueCodeDirect(phone);

    // Force expiry directly rather than waiting 5 real minutes.
    await passwordResetModel
      .updateOne({ phone }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
      .exec();

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: sms.lastCode() })
      .expect(400);
    expect(res.body.error).toBe('RESET_CODE_INVALID');
  });

  // ==========================================================================
  // FR-025 — per-account rate limit. The first 3 calls go straight through
  // the service (see issueCodeDirect) — the per-phone counter it enforces
  // is identical either way — and only the 4th, the one actually under
  // test, goes over real HTTP to confirm the controller surfaces it as a
  // 429 with the documented body.
  // ==========================================================================
  it('the 4th request within 15 minutes is rate-limited with a stated wait', async () => {
    const phone = uniquePhone(); // no account needed — the limiter is keyed by phone alone
    for (let i = 0; i < 3; i++) {
      await issueCodeDirect(phone);
    }

    const throttled = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ phone })
      .expect(429);
    expect(throttled.body.error).toBe('RESET_RATE_LIMITED');
    expect(throttled.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  // ==========================================================================
  // FR-026 — the completed reset
  // ==========================================================================
  it('a verified code lets the driver set a new password and sign in with it', async () => {
    const { phone } = await createFreshDriver();
    await issueCodeDirect(phone);

    const verifyRes = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: sms.lastCode() })
      .expect(200);
    const { resetToken } = verifyRes.body;
    expect(typeof resetToken).toBe('string');

    const newPassword = 'NewPassword456!';
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/complete')
      .send({ resetToken, newPassword })
      .expect(204);

    // Signs in with the new password — not signed in automatically by
    // `complete` itself.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phone, password: newPassword })
      .expect(201);

    // The old password no longer works.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phone, password: DEFAULT_PASSWORD })
      .expect(401);
  });

  it('a resetToken cannot be reused — the record is consumed on completion', async () => {
    const { phone } = await createFreshDriver();
    await issueCodeDirect(phone);
    const verifyRes = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: sms.lastCode() })
      .expect(200);
    const { resetToken } = verifyRes.body;

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/complete')
      .send({ resetToken, newPassword: 'FirstNewPassword1!' })
      .expect(204);

    const reused = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/complete')
      .send({ resetToken, newPassword: 'SecondNewPassword2!' })
      .expect(400);
    expect(reused.body.error).toBe('RESET_CODE_INVALID');
  });

  // ==========================================================================
  // FR-027 — a completed reset ends every session that predates it
  // ==========================================================================
  it('a session live on another device before the reset can no longer refresh afterwards', async () => {
    const { phone } = await createFreshDriver();

    // "Another device": a sign-in whose refresh token we capture before
    // the reset.
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phone, password: DEFAULT_PASSWORD })
      .expect(201);
    const staleRefreshToken = loginRes.body.refreshToken;
    expect(typeof staleRefreshToken).toBe('string');

    // Confirm it works before the reset.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: staleRefreshToken })
      .expect(201);

    await issueCodeDirect(phone);
    const verifyRes = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone, code: sms.lastCode() })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/complete')
      .send({ resetToken: verifyRes.body.resetToken, newPassword: 'PostResetPassword789!' })
      .expect(204);

    // The pre-reset refresh token is now dead.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: staleRefreshToken })
      .expect(401);
  });
});
