import request from 'supertest';
import { INestApplication } from '@nestjs/common';
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
import { UsersService } from '../../src/modules/users/users.service';
import { PasswordResetService } from '../../src/modules/auth/services/password-reset.service';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(120_000);

class RecordingSmsSender implements SmsSender {
  sent: { phone: string; message: string }[] = [];
  throwNext = false;
  async send(phone: string, message: string): Promise<void> {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('provider rejected');
    }
    this.sent.push({ phone, message });
  }
  reset(): void {
    this.sent = [];
    this.throwNext = false;
  }
  codeFor(phone: string): string {
    const m = [...this.sent].reverse().find((s) => s.phone === phone)?.message;
    const c = m?.match(/\d{6}/)?.[0];
    if (!c) throw new Error(`no code sent to ${phone}`);
    return c;
  }
}

/**
 * spec 015 US6 (email + password still works) and US7 (SMS recovery over an
 * administrator's phone, now that admin phones resolve).
 */
describe('Admin password sign-in & recovery (spec 015 US6/US7)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let usersService: UsersService;
  let passwordResetService: PasswordResetService;
  const sms = new RecordingSmsSender();

  beforeAll(async () => {
    ctx = await createTestApp({ smsSender: sms });
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    usersService = app.get(UsersService);
    passwordResetService = app.get(PasswordResetService);
    const redis = app.get<Redis>(REDIS_CLIENT);
    const stale = await redis.keys('password-reset:*');
    if (stale.length) await redis.del(...stale);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(() => sms.reset());

  const server = () => app.getHttpServer();

  function decode(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  }

  async function freshAdmin(): Promise<{ id: string; email: string; phone: string }> {
    const phone = uniquePhone();
    const email = `us67-${Date.now()}-${Math.random().toString(36).slice(2)}@companya.test`;
    const u = await usersService.create({
      companyId: fixtures.companyA.companyId as never,
      role: UserRole.FUEL_COMPANY_ADMIN,
      email,
      password: DEFAULT_PASSWORD,
      fullName: 'US6/7 Admin',
      phone,
    });
    return { id: String(u._id), email, phone };
  }

  // ── T095 ──────────────────────────────────────────────────────────────────
  it('an admin signing in by password gets the same response shape, a sid, and the same cap behaviour as a code sign-in', async () => {
    const admin = await freshAdmin();

    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD })
      .expect(201);

    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'refreshToken', 'user'].sort());
    expect(typeof decode(res.body.accessToken).sid).toBe('string');

    // Cap: 3 more sign-ins evict the oldest.
    const tokens = [res.body.accessToken];
    for (let i = 0; i < 3; i++) {
      const r = await request(server())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: DEFAULT_PASSWORD })
        .expect(201);
      tokens.push(r.body.accessToken);
    }
    const evicted = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(401);
    expect(evicted.body.cause).toBe('SESSION_LIMIT_EXCEEDED');
  });

  // ── T096 ──────────────────────────────────────────────────────────────────
  it('a wrong password, an unknown email and a deactivated account all return one identical generic failure', async () => {
    const admin = await freshAdmin();
    const deactivated = await freshAdmin();
    await usersService.setActive(deactivated.id, false);

    const bodies: unknown[] = [];
    for (const creds of [
      { email: admin.email, password: 'WrongPassword1!' },
      { email: `nobody-${Date.now()}@nowhere.test`, password: DEFAULT_PASSWORD },
      { email: deactivated.email, password: DEFAULT_PASSWORD },
    ]) {
      const r = await request(server()).post('/api/v1/auth/login').send(creds).expect(401);
      bodies.push(r.body);
    }
    for (const b of bodies) {
      expect(b).toEqual(bodies[0]);
      expect((b as { cause?: string }).cause).toBeUndefined();
    }
  });

  // ── T107 ──────────────────────────────────────────────────────────────────
  it('a completed SMS recovery for an admin clears activeSessions — every admin session ends (FR-072)', async () => {
    const admin = await freshAdmin();

    const s1 = (
      await request(server())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: DEFAULT_PASSWORD })
        .expect(201)
    ).body.accessToken;
    const s2 = (
      await request(server())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: DEFAULT_PASSWORD })
        .expect(201)
    ).body.accessToken;

    // Recovery over the admin's phone — resolves now (R5).
    await passwordResetService.requestReset(admin.phone);
    expect(sms.sent.map((s) => s.phone)).toContain(admin.phone);

    const verify = await request(server())
      .post('/api/v1/auth/password-reset/verify')
      .send({ phone: admin.phone, code: sms.codeFor(admin.phone) })
      .expect(200);
    await request(server())
      .post('/api/v1/auth/password-reset/complete')
      .send({ resetToken: verify.body.resetToken, newPassword: 'AdminNewPass123!' })
      .expect(204);

    for (const s of [s1, s2]) {
      const r = await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${s}`)
        .expect(401);
      expect(r.body.error).toBe('SESSION_REVOKED');
    }

    // The new password works.
    await request(server())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: 'AdminNewPass123!' })
      .expect(201);
  });

  // ── T107a ─────────────────────────────────────────────────────────────────
  it('the per-phone rate limit applies before and regardless of whether an account is found, and an SMS failure does not change the response (FR-071/FR-073)', async () => {
    // Unknown number: still rate-limited after RESET_MAX_REQUESTS (3).
    const unknown = uniquePhone();
    for (let i = 0; i < 3; i++) {
      await request(server())
        .post('/api/v1/auth/password-reset/request')
        .send({ phone: unknown })
        .expect(202);
    }
    const limited = await request(server())
      .post('/api/v1/auth/password-reset/request')
      .send({ phone: unknown })
      .expect(429);
    expect(limited.body.error).toBe('RESET_RATE_LIMITED');

    // A registered admin whose SMS send fails: identical 202 body, nothing leaked.
    const admin = await freshAdmin();
    sms.throwNext = true;
    const okBody = (
      await request(server())
        .post('/api/v1/auth/password-reset/request')
        .send({ phone: admin.phone })
        .expect(202)
    ).body;
    expect(okBody).toEqual({ expiresInMinutes: 5, attemptsAllowed: 5 });
  });
});
