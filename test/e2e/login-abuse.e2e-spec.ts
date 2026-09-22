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
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';
import { UsersService } from '../../src/modules/users/users.service';
import { LoginCodeService } from '../../src/modules/auth/services/login-code.service';

jest.setTimeout(150_000);

class RecordingSmsSender implements SmsSender {
  sent: { phone: string; message: string }[] = [];
  async send(phone: string, message: string): Promise<void> {
    this.sent.push({ phone, message });
  }
  reset(): void {
    this.sent = [];
  }
}

const OVERRIDES: Record<string, string> = {
  LOGIN_OTP_MAX_REQUESTS: '3',
  LOGIN_OTP_CHALLENGE_AFTER: '2',
  LOGIN_OTP_MAX_ATTEMPTS: '5',
  LOGIN_OTP_FAIL_THRESHOLD: '4',
  LOGIN_OTP_WINDOW_MINUTES: '15',
  LOGIN_OTP_BLOCK_MINUTES: '60',
  LOGIN_POW_DIFFICULTY_BITS: '0',
};

/**
 * spec 015 US3 — the code endpoints survive contact with the internet:
 * per-number rate limiting, a proof-of-work challenge, per-code lockout, a
 * cross-code temporary block, fail-closed on a counter-store outage, and
 * none of it distinguishable between a registered and an unregistered number.
 */
describe('Login abuse containment (spec 015 US3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let redis: Redis;
  let usersService: UsersService;
  let loginCodeService: LoginCodeService;
  const sms = new RecordingSmsSender();
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries(OVERRIDES)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    ctx = await createTestApp({ smsSender: sms });
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    redis = app.get<Redis>(REDIS_CLIENT);
    usersService = app.get(UsersService);
    loginCodeService = app.get(LoginCodeService);
  }, 180_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    sms.reset();
    await app.get(ResilientThrottlerStorage).reset(); // fresh IP-throttle budget per test
    const keys = await redis.keys('login-otp:*');
    if (keys.length) await redis.del(...keys);
  });

  const server = () => app.getHttpServer();
  const reqCode = (phone: string, challenge?: unknown) =>
    request(server()).post('/api/v1/auth/login/code/request').send({ phone, challenge });
  const verify = (phone: string, code: string) =>
    request(server()).post('/api/v1/auth/login/code/verify').send({ phone, code });

  async function freshAdmin(): Promise<{ id: string; phone: string; email: string }> {
    const phone = uniquePhone();
    const email = `us3-${Date.now()}-${Math.random().toString(36).slice(2)}@companya.test`;
    const u = await usersService.create({
      companyId: fixtures.companyA.companyId as never,
      role: 'FUEL_COMPANY_ADMIN' as never,
      email,
      password: DEFAULT_PASSWORD,
      fullName: 'US3 Admin',
      phone,
    });
    return { id: String(u._id), phone, email };
  }

  function codeSentTo(phone: string): string {
    const m = [...sms.sent].reverse().find((s) => s.phone === phone)?.message;
    const c = m?.match(/\d{6}/)?.[0];
    if (!c) throw new Error(`no code sent to ${phone}`);
    return c;
  }

  // ── T069 ──────────────────────────────────────────────────────────────────
  it('rate-limits after MAX_REQUESTS, then demands a challenge; SMS is sent exactly MAX_REQUESTS times', async () => {
    const { phone } = await freshAdmin();

    const statuses: number[] = [];
    let challengeBody: Record<string, unknown> | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await reqCode(phone);
      statuses.push(res.status);
      if (res.body?.error === 'CHALLENGE_REQUIRED') challengeBody = res.body;
    }

    expect(statuses.slice(0, 3)).toEqual([202, 202, 202]);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
    expect(statuses[5]).toBe(400);
    expect(challengeBody?.error).toBe('CHALLENGE_REQUIRED');
    expect(challengeBody?.challenge).toEqual(
      expect.objectContaining({ seed: expect.any(String), difficultyBits: 0 }),
    );

    expect(sms.sent.filter((s) => s.phone === phone)).toHaveLength(3);
  });

  // ── T070 ──────────────────────────────────────────────────────────────────
  it('a code is permanently unusable after MAX_ATTEMPTS, even when the correct value is then submitted', async () => {
    const { phone } = await freshAdmin();
    await reqCode(phone).expect(202);
    const real = codeSentTo(phone);

    for (let i = 0; i < 5; i++) {
      await verify(phone, '000000').expect(400);
    }
    const afterLockout = await verify(phone, real).expect(400);
    expect(afterLockout.body.error).toBe('LOGIN_CODE_INVALID');
  });

  // ── T071 ──────────────────────────────────────────────────────────────────
  it('failures accumulate across separately-issued codes into a temporary block whose 429 is byte-identical to the rate-limit 429', async () => {
    const { phone } = await freshAdmin();

    // Capture a rate-limit 429 body for comparison (fresh phone, exceed the limit).
    const rl = await freshAdmin();
    for (let i = 0; i < 3; i++) await reqCode(rl.phone).expect(202);
    const rateLimit429 = await reqCode(rl.phone).expect(429);

    // FAIL_THRESHOLD=4 failures spread across 2 issued codes.
    await loginCodeService.requestCode(phone);
    for (let i = 0; i < 2; i++) {
      await expect(loginCodeService.verifyCode(phone, '000000')).rejects.toBeDefined();
    }
    await loginCodeService.requestCode(phone);
    for (let i = 0; i < 2; i++) {
      await expect(loginCodeService.verifyCode(phone, '000000')).rejects.toBeDefined();
    }

    // Now blocked — the request endpoint refuses with the SAME 429 shape.
    const blocked = await reqCode(phone).expect(429);
    expect(blocked.body).toEqual(rateLimit429.body);
    expect(blocked.body.error).toBe('LOGIN_RATE_LIMITED');

    // And so does verify.
    await verify(phone, '123456').expect(429);
  });

  // ── T071a ─────────────────────────────────────────────────────────────────
  it('a temporary block expires on its own — the number signs in normally afterwards with no operator action', async () => {
    const { phone } = await freshAdmin();
    await loginCodeService.requestCode(phone);
    for (let i = 0; i < 4; i++) {
      await expect(loginCodeService.verifyCode(phone, '000000')).rejects.toBeDefined();
    }
    await reqCode(phone).expect(429); // blocked

    // Simulate the block window elapsing.
    await redis.del(
      `login-otp:blocked:${phone}`,
      `login-otp:fails:${phone}`,
      `login-otp:rate:${phone}`,
      `login-otp:rlhits:${phone}`,
    );

    await reqCode(phone).expect(202);
    const res = await verify(phone, codeSentTo(phone)).expect(200);
    expect(res.body.accessToken).toBeDefined();
  });

  // ── T072 ──────────────────────────────────────────────────────────────────
  it('every refusal sequence is byte-identical for a registered and an unregistered number', async () => {
    const registered = (await freshAdmin()).phone;
    const unregistered = uniquePhone();

    const run = async (phone: string) => {
      await app.get(ResilientThrottlerStorage).reset();
      const keys = await redis.keys(`login-otp:*${phone}*`);
      if (keys.length) await redis.del(...keys);
      const seq: { status: number; body: unknown }[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await reqCode(phone);
        seq.push({ status: r.status, body: r.body });
      }
      // and a couple of verify refusals
      for (const code of ['000000', '111111']) {
        const r = await verify(phone, code);
        seq.push({ status: r.status, body: r.body });
      }
      return seq;
    };

    const a = await run(registered);
    const b = await run(unregistered);
    // Drop the challenge `seed` (random by construction) before comparing.
    const norm = (s: typeof a) =>
      s.map((e) => ({
        status: e.status,
        body: JSON.parse(JSON.stringify(e.body).replace(/"seed":"[a-f0-9]+"/g, '"seed":"<seed>"')),
      }));
    expect(norm(a)).toEqual(norm(b));
  });

  // ── T073 ──────────────────────────────────────────────────────────────────
  it('with the counter store unavailable both endpoints return 503, not 202', async () => {
    const { phone } = await freshAdmin();
    const incrSpy = jest
      .spyOn(redis, 'ttl')
      .mockRejectedValueOnce(new Error('redis down'))
      .mockRejectedValueOnce(new Error('redis down'));

    await reqCode(phone).expect(503);
    await verify(phone, '123456').expect(503);

    incrSpy.mockRestore();
  });

  // ── T074 ──────────────────────────────────────────────────────────────────
  it('a successful sign-in clears the number rate and failure counters', async () => {
    const { phone } = await freshAdmin();
    await reqCode(phone).expect(202);
    await verify(phone, '000000').expect(400); // one failure recorded
    expect(await redis.get(`login-otp:fails:${phone}`)).not.toBeNull();

    await reqCode(phone).expect(202);
    await verify(phone, codeSentTo(phone)).expect(200);

    expect(await redis.get(`login-otp:fails:${phone}`)).toBeNull();
    expect(await redis.get(`login-otp:rate:${phone}`)).toBeNull();
  });
});
