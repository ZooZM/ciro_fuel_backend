import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, DEFAULT_PASSWORD } from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { UsersService } from '../../src/modules/users/users.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(120_000);

/**
 * spec 015 US4 (Slice 0) — an administrator holds up to `auth.maxAdminSessions`
 * concurrent, independently-revocable sessions; the oldest is evicted beyond
 * the cap; and every "end everything" path (a single device's own sign-out
 * excepted) still ends every session. Default cap in the test environment is 3.
 */
describe('Admin multi-session (spec 015 US4)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;
  let connection: Connection;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    userModel = app.get(getModelToken(User.name));
    connection = app.get(getConnectionToken());
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const server = () => app.getHttpServer();

  async function login(email = fixtures.companyA.admin.email): Promise<{
    access: string;
    refresh: string;
  }> {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: DEFAULT_PASSWORD })
      .expect(201);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    return { access: res.body.accessToken, refresh: res.body.refreshToken };
  }

  function meStatus(access: string): Promise<request.Response> {
    return request(server()).get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`);
  }

  function decode(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  }

  // Reset the admin to a clean, un-suspended, empty-session state before each
  // test — earlier tests suspend the company and fill the session array.
  beforeEach(async () => {
    await userModel.updateOne(
      { _id: fixtures.companyA.admin.id },
      { $set: { activeSessions: [], isActive: true } },
    );
    await app.get(CompaniesService).setStatus(fixtures.companyA.companyId, CompanyStatus.ACTIVE);
  });

  // ── T013 ──────────────────────────────────────────────────────────────────
  it('three concurrent sessions all authorise; a fourth evicts exactly the oldest with cause SESSION_LIMIT_EXCEEDED', async () => {
    const s1 = await login();
    const s2 = await login();
    const s3 = await login();

    for (const s of [s1, s2, s3]) {
      expect((await meStatus(s.access)).status).toBe(200);
    }

    const s4 = await login();

    const evicted = await meStatus(s1.access);
    expect(evicted.status).toBe(401);
    expect(evicted.body.error).toBe('SESSION_REVOKED');
    expect(evicted.body.cause).toBe('SESSION_LIMIT_EXCEEDED');
    expect(evicted.body.cause).not.toBe('SIGNED_IN_ELSEWHERE');

    for (const s of [s2, s3, s4]) {
      expect((await meStatus(s.access)).status).toBe(200);
    }
  });

  // ── T014 ──────────────────────────────────────────────────────────────────
  it('sign-out closes only the calling sid; other sessions keep working and the signed-out refresh token is refused', async () => {
    const s1 = await login();
    const s2 = await login();
    const s3 = await login();

    await request(server())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${s2.access}`)
      .expect(204);

    expect((await meStatus(s2.access)).status).toBe(401);
    expect((await meStatus(s1.access)).status).toBe(200);
    expect((await meStatus(s3.access)).status).toBe(200);

    await request(server())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: s2.refresh })
      .expect(401);

    await request(server())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: s1.refresh })
      .expect(201);
  });

  // ── T015 (deactivation half) ──────────────────────────────────────────────
  it('account deactivation ends every admin session', async () => {
    const s1 = await login();
    const s2 = await login();

    // A second FUEL_COMPANY_ADMIN in the same company performs the deactivation.
    const peer = await app.get(UsersService).create({
      companyId: fixtures.companyA.companyId as never,
      role: UserRole.FUEL_COMPANY_ADMIN,
      email: `peer-admin-${Date.now()}@companya.test`,
      password: DEFAULT_PASSWORD,
      fullName: 'Peer Admin',
      phone: `+96650${Date.now().toString().slice(-7)}`,
    });
    const peerLogin = await login(peer.email);

    await request(server())
      .patch(`/api/v1/users/${fixtures.companyA.admin.id}/deactivate`)
      .set('Authorization', `Bearer ${peerLogin.access}`)
      .expect(200);

    for (const s of [s1, s2]) {
      const res = await meStatus(s.access);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('SESSION_REVOKED');
    }
  });

  // ── T015 (password-reset half) ────────────────────────────────────────────
  it('revokeAndSetPassword clears activeSessions — every admin session ends', async () => {
    const s1 = await login();
    const s2 = await login();
    const s3 = await login();

    const users = app.get(UsersService);
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await users.revokeAndSetPassword(
          fixtures.companyA.admin.id,
          await UsersService.hashPassword('BrandNewPass123!'),
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    for (const s of [s1, s2, s3]) {
      expect((await meStatus(s.access)).status).toBe(401);
    }
    const doc = await userModel.findById(fixtures.companyA.admin.id).exec();
    expect(doc?.activeSessions ?? []).toHaveLength(0);
  });

  // ── T015a ─────────────────────────────────────────────────────────────────
  it('company suspension refuses every session — including the admin sid path — with cause COMPANY_SUSPENDED', async () => {
    const s1 = await login();
    const s2 = await login();

    await app
      .get(CompaniesService)
      .setStatus(fixtures.companyA.companyId, CompanyStatus.SUSPENDED);

    for (const s of [s1, s2]) {
      const res = await meStatus(s.access);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('SESSION_REVOKED');
      expect(res.body.cause).toBe('COMPANY_SUSPENDED');
    }
  });

  // ── T015b ─────────────────────────────────────────────────────────────────
  it('an admin session survives 20 consecutive refreshes, every renewed token carrying the SAME sid (SC-014)', async () => {
    const first = await login();
    const originalSid = decode(first.access).sid as string;
    expect(typeof originalSid).toBe('string');
    expect(originalSid).toHaveLength(64);

    let refresh = first.refresh;
    let lastAccess = first.access;
    for (let i = 0; i < 20; i++) {
      const res = await request(server())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: refresh })
        .expect(201);
      expect(decode(res.body.accessToken).sid).toBe(originalSid);
      expect(decode(res.body.refreshToken).sid).toBe(originalSid);
      refresh = res.body.refreshToken;
      lastAccess = res.body.accessToken;
    }

    expect((await meStatus(lastAccess)).status).toBe(200);
  });
});
