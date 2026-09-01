import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  uniquePhone,
  DEFAULT_PASSWORD,
} from '../utils/fixtures';
import { SmsSender } from '../../src/common/sms/sms-sender.port';

jest.setTimeout(120_000);

class RecordingSmsSender implements SmsSender {
  sent: { phone: string; message: string }[] = [];
  shouldFail = false;

  async send(phone: string, message: string): Promise<void> {
    if (this.shouldFail) {
      throw new Error('simulated provider rejection');
    }
    this.sent.push({ phone, message });
  }

  reset(): void {
    this.sent = [];
    this.shouldFail = false;
  }

  /** The 6-digit code embedded in the last message sent. */
  lastCode(): string {
    const message = this.sent[this.sent.length - 1]?.message;
    const match = message?.match(/\d{6}/);
    if (!match) throw new Error('no code found in the last sent message');
    return match[0];
  }
}

describe('Phone verification (spec 005 US7/FR-035)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  const sms = new RecordingSmsSender();

  beforeAll(async () => {
    ctx = await createTestApp({ smsSender: sms });
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(() => sms.reset());

  /** A fresh CLIENT under companyA, isolated per test — the request
   * endpoint's per-user throttle (3/15min) would otherwise accumulate
   * across tests that share one client, since the guard counts every hit
   * regardless of what the handler then does with it. */
  async function createFreshClient(): Promise<{ id: string; token: string; phone: string }> {
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const email = `phone-verify-${Date.now()}-${Math.random()}@companya.test`;
    const phone = uniquePhone();

    const createRes = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        role: 'CLIENT',
        email,
        password: DEFAULT_PASSWORD,
        fullName: 'Phone Verify Client',
        phone,
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(201);

    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: DEFAULT_PASSWORD })
      .expect(201);

    return { id: createRes.body._id, token: login.body.accessToken, phone };
  }

  it(
    'the phone is unchanged until a correct code is submitted, and an abandoned ' +
      'verification leaves the original phone in force (FR-035c)',
    async () => {
      const client = await createFreshClient();
      const server = app.getHttpServer();
      const newPhone = uniquePhone();

      await request(server)
        .post('/api/v1/users/me/phone/verification')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ newPhone })
        .expect(202);

      // Abandoned — never confirmed.
      const stillOriginal = await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);
      expect(stillOriginal.body.phone).toBe(client.phone);

      // Confirming now applies the change.
      await request(server)
        .post('/api/v1/users/me/phone/verification/confirm')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ code: sms.lastCode() })
        .expect(201);

      const after = await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);
      expect(after.body.phone).toBe(newPhone);
    },
  );

  it(
    'a number already registered to another account yields 409 PHONE_IN_USE and ' +
      'no SMS is sent (FR-035e)',
    async () => {
      const client = await createFreshClient();
      const { client: existingOwner } = fixtures.companyB;
      const server = app.getHttpServer();

      const ownerProfile = await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${existingOwner.token}`)
        .expect(200);

      const res = await request(server)
        .post('/api/v1/users/me/phone/verification')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ newPhone: ownerProfile.body.phone })
        .expect(409);
      expect(res.body.error).toBe('PHONE_IN_USE');
      expect(sms.sent).toHaveLength(0);
    },
  );

  it(
    "dispatches the code to the new number and never to the caller's existing " + 'one (FR-035b)',
    async () => {
      const client = await createFreshClient();
      const server = app.getHttpServer();
      const newPhone = uniquePhone();

      await request(server)
        .post('/api/v1/users/me/phone/verification')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ newPhone })
        .expect(202);

      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0].phone).toBe(newPhone);
      expect(sms.sent[0].phone).not.toBe(client.phone);
    },
  );

  it('never returns 202 when the provider rejects the send (SMS_SEND_FAILED)', async () => {
    const client = await createFreshClient();
    const server = app.getHttpServer();
    sms.shouldFail = true;

    const res = await request(server)
      .post('/api/v1/users/me/phone/verification')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ newPhone: uniquePhone() })
      .expect(502);
    expect(res.body.error).toBe('SMS_SEND_FAILED');

    sms.shouldFail = false;
  });

  it('the code appears in no response body, in either endpoint (FR-035g)', async () => {
    const client = await createFreshClient();
    const server = app.getHttpServer();
    const newPhone = uniquePhone();

    const requestRes = await request(server)
      .post('/api/v1/users/me/phone/verification')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ newPhone })
      .expect(202);
    expect(JSON.stringify(requestRes.body)).not.toMatch(/\d{6}/);

    const code = sms.lastCode();
    const confirmRes = await request(server)
      .post('/api/v1/users/me/phone/verification/confirm')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ code })
      .expect(201);
    expect(JSON.stringify(confirmRes.body)).not.toContain(code);
  });

  it('5 confirm attempts against one code lock it out with 429 and retryAfterSeconds', async () => {
    const client = await createFreshClient();
    const server = app.getHttpServer();

    await request(server)
      .post('/api/v1/users/me/phone/verification')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ newPhone: uniquePhone() })
      .expect(202);

    for (let i = 0; i < 5; i++) {
      await request(server)
        .post('/api/v1/users/me/phone/verification/confirm')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ code: '000000' }) // never matches the real code
        .expect(401);
    }

    const lockedOut = await request(server)
      .post('/api/v1/users/me/phone/verification/confirm')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ code: sms.lastCode() }) // even the real code is refused once locked out
      .expect(429);
    expect(lockedOut.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('3 verification requests per 15 minutes throttles with 429 and retryAfterSeconds', async () => {
    const client = await createFreshClient();
    const server = app.getHttpServer();

    for (let i = 0; i < 3; i++) {
      await request(server)
        .post('/api/v1/users/me/phone/verification')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ newPhone: uniquePhone() })
        .expect(202);
    }

    const throttled = await request(server)
      .post('/api/v1/users/me/phone/verification')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ newPhone: uniquePhone() })
      .expect(429);
    expect(throttled.body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
