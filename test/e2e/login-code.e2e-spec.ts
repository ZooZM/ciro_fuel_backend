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
import { UsersService } from '../../src/modules/users/users.service';
import { LoginCodeService } from '../../src/modules/auth/services/login-code.service';
import { LoginCode, LoginCodeDocument } from '../../src/modules/auth/schemas/login-code.schema';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(120_000);

class RecordingSmsSender implements SmsSender {
  sent: { phone: string; message: string }[] = [];
  async send(phone: string, message: string): Promise<void> {
    this.sent.push({ phone, message });
  }
  reset(): void {
    this.sent = [];
  }
  codeFor(phone: string): string {
    const m = [...this.sent].reverse().find((s) => s.phone === phone)?.message;
    const code = m?.match(/\d{6}/)?.[0];
    if (!code) throw new Error(`no code sent to ${phone}`);
    return code;
  }
}

/**
 * spec 015 US2 — passwordless administrator sign-in. The enumeration-safety
 * suite: code requests for every kind of number return an identical 202, and
 * ONLY an exactly-one-active-admin match creates a LoginCode or sends an SMS.
 */
describe('Login code sign-in (spec 015 US2)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let loginCodeModel: Model<LoginCodeDocument>;
  let loginCodeService: LoginCodeService;
  let usersService: UsersService;
  const sms = new RecordingSmsSender();

  beforeAll(async () => {
    ctx = await createTestApp({ smsSender: sms });
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    loginCodeModel = app.get(getModelToken(LoginCode.name));
    loginCodeService = app.get(LoginCodeService);
    usersService = app.get(UsersService);

    const redis = app.get<Redis>(REDIS_CLIENT);
    const stale = await redis.keys('login-otp:*');
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

  async function freshAdmin(role = UserRole.FUEL_COMPANY_ADMIN): Promise<{
    id: string;
    phone: string;
    email: string;
  }> {
    const phone = uniquePhone();
    const email = `us2-${Date.now()}-${Math.random().toString(36).slice(2)}@companya.test`;
    const u = await usersService.create({
      companyId: fixtures.companyA.companyId as never,
      role,
      email,
      password: DEFAULT_PASSWORD,
      fullName: 'US2 Admin',
      phone,
    });
    return { id: String(u._id), phone, email };
  }

  function requestCode(phone: string) {
    return request(server())
      .post('/api/v1/auth/login/code/request')
      .send({ phone })
      .expect(202);
  }

  // ── T046 ──────────────────────────────────────────────────────────────────
  it('every kind of number gets an identical 202; only an active-admin match creates a code / SMS', async () => {
    const admin = await freshAdmin();
    const inactiveAdmin = await freshAdmin();
    await usersService.setActive(inactiveAdmin.id, false);

    const cases: { label: string; phone: string }[] = [
      { label: 'admin', phone: admin.phone },
      { label: 'driver', phone: fixtures.companyA.driver.phone },
      { label: 'client', phone: fixtures.companyA.client.phone },
      { label: 'unregistered', phone: uniquePhone() },
      { label: 'inactive admin', phone: inactiveAdmin.phone },
    ];

    const bodies: unknown[] = [];
    for (const c of cases) {
      const res = await requestCode(c.phone);
      bodies.push(res.body);
    }
    for (const b of bodies) {
      expect(b).toEqual(bodies[0]);
      expect(b).toEqual({ expiresInMinutes: 5, attemptsAllowed: 5 });
    }

    // Only the admin number produced a record and an SMS.
    expect(sms.sent.map((s) => s.phone)).toEqual([admin.phone]);
    const codes = await loginCodeModel.find({}).exec();
    expect(codes).toHaveLength(1);
    expect(String(codes[0].userId)).toBe(admin.id);
  });

  // ── T047 ──────────────────────────────────────────────────────────────────
  it('a correct code returns the /auth/login shape with a sid; replay is LOGIN_CODE_INVALID', async () => {
    const admin = await freshAdmin();
    await requestCode(admin.phone);

    const res = await request(server())
      .post('/api/v1/auth/login/code/verify')
      .send({ phone: admin.phone, code: sms.codeFor(admin.phone) })
      .expect(200);

    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'refreshToken', 'user'].sort());
    expect(res.body.user).toEqual(
      expect.objectContaining({ id: admin.id, role: UserRole.FUEL_COMPANY_ADMIN }),
    );
    expect(typeof decode(res.body.accessToken).sid).toBe('string');
    expect(decode(res.body.refreshToken).sid).toBe(decode(res.body.accessToken).sid);

    // Single use.
    const replay = await request(server())
      .post('/api/v1/auth/login/code/verify')
      .send({ phone: admin.phone, code: sms.codeFor(admin.phone) })
      .expect(400);
    expect(replay.body.error).toBe('LOGIN_CODE_INVALID');
  });

  // ── T048 ──────────────────────────────────────────────────────────────────
  it('wrong / expired / superseded / attempt-locked all produce one identical LOGIN_CODE_INVALID, no attempt count', async () => {
    const bad: request.Response[] = [];

    // wrong code
    const a = await freshAdmin();
    await requestCode(a.phone);
    bad.push(
      await request(server())
        .post('/api/v1/auth/login/code/verify')
        .send({ phone: a.phone, code: '000000' })
        .expect(400),
    );

    // expired code
    const b = await freshAdmin();
    await requestCode(b.phone);
    await loginCodeModel
      .updateOne({ phone: b.phone }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
      .exec();
    bad.push(
      await request(server())
        .post('/api/v1/auth/login/code/verify')
        .send({ phone: b.phone, code: sms.codeFor(b.phone) })
        .expect(400),
    );

    // superseded — request twice, use the first
    const c = await freshAdmin();
    await loginCodeService.requestCode(c.phone);
    const firstCode = sms.codeFor(c.phone);
    await loginCodeService.requestCode(c.phone);
    bad.push(
      await request(server())
        .post('/api/v1/auth/login/code/verify')
        .send({ phone: c.phone, code: firstCode })
        .expect(400),
    );

    // attempt-locked — exhaust attempts then submit the real code
    const d = await freshAdmin();
    await requestCode(d.phone);
    for (let i = 0; i < 5; i++) {
      await request(server())
        .post('/api/v1/auth/login/code/verify')
        .send({ phone: d.phone, code: '111111' })
        .expect(400);
    }
    bad.push(
      await request(server())
        .post('/api/v1/auth/login/code/verify')
        .send({ phone: d.phone, code: sms.codeFor(d.phone) })
        .expect(400),
    );

    for (const r of bad) {
      expect(r.body.error).toBe('LOGIN_CODE_INVALID');
      expect(r.body.message).toBe(bad[0].body.message);
      expect(r.body.attempts).toBeUndefined();
      expect(r.body.attemptsRemaining).toBeUndefined();
    }
  });

  // ── T049 ──────────────────────────────────────────────────────────────────
  it('a code sign-in participates in the US4 session cap', async () => {
    const admin = await freshAdmin();

    // 3 sessions: 2 by password, 1 by code.
    const p1 = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD })
      .expect(201);
    await request(server())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD })
      .expect(201);
    await loginCodeService.requestCode(admin.phone);
    await request(server())
      .post('/api/v1/auth/login/code/verify')
      .send({ phone: admin.phone, code: sms.codeFor(admin.phone) })
      .expect(200);

    // All three authorise.
    expect(
      (
        await request(server())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${p1.body.accessToken}`)
      ).status,
    ).toBe(200);

    // A 4th sign-in (code) evicts the oldest (p1).
    await loginCodeService.requestCode(admin.phone);
    await request(server())
      .post('/api/v1/auth/login/code/verify')
      .send({ phone: admin.phone, code: sms.codeFor(admin.phone) })
      .expect(200);

    const evicted = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${p1.body.accessToken}`)
      .expect(401);
    expect(evicted.body.cause).toBe('SESSION_LIMIT_EXCEEDED');
  });

  // ── T050 ──────────────────────────────────────────────────────────────────
  it('no code is ever returned in a response body', async () => {
    const admin = await freshAdmin();
    const reqRes = await requestCode(admin.phone);
    expect(JSON.stringify(reqRes.body)).not.toMatch(/\d{6}/);

    const verRes = await request(server())
      .post('/api/v1/auth/login/code/verify')
      .send({ phone: admin.phone, code: sms.codeFor(admin.phone) })
      .expect(200);
    // The tokens are JWTs (dot-separated base64) — the assertion is that no
    // plaintext 6-digit code leaks as its own field.
    expect(verRes.body.expiresInMinutes).toBeUndefined();
    expect(verRes.body.code).toBeUndefined();
  });
});
