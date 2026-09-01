import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { DEFAULT_PASSWORD, seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { User } from '../../src/modules/users/schemas/user.schema';

jest.setTimeout(120_000);

/**
 * Spec 004 User Story 1: CIRO onboards an isolated Fuel Company. Covers what
 * `onboarding.e2e-spec.ts` (feature 001) does not, because the hierarchy
 * didn't exist yet: that a created company is unambiguously typed `FUEL`,
 * and that isolation holds for the new company-level surfaces (`GET
 * /companies` listing, `GET /companies/:id`) — not just orders.
 */
describe('Hierarchy onboarding (spec 004 US1) — CIRO creates an isolated Fuel Company', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('creates a company typed FUEL, with an admin who can sign in and sees only their own company', async () => {
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/companies')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .field('name', 'Hierarchy Test Fuel Co')
      .field('contactEmail', 'contact@hierarchytest.test')
      .field('contactPhone', '+966500000000')
      .field('adminEmail', 'admin@hierarchytest.test')
      .field('adminFullName', 'Hierarchy Admin')
      .field('adminPhone', '+966500000009')
      .field('adminPassword', 'Password123!')
      .attach('commercialRegister', Buffer.from('%PDF-1.4 fake register'), {
        filename: 'register.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(createRes.body.company.type).toBe('FUEL');
    const companyId = createRes.body.company._id;

    const adminLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@hierarchytest.test', password: 'Password123!' })
      .expect(201);
    expect(adminLogin.body.user.role).toBe('FUEL_COMPANY_ADMIN');
    const adminToken = adminLogin.body.accessToken;

    // Sees exactly their own company via GET /companies (the FUEL_COMPANY_ADMIN
    // scoping added in T022) — one item, and it is themselves.
    const list = await request(server)
      .get('/api/v1/companies')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]._id).toBe(companyId);
  });

  it("CIRO lists every Fuel Company; a Fuel Company admin's list excludes every other tenant", async () => {
    const server = app.getHttpServer();

    const ciroList = await request(server)
      .get('/api/v1/companies')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    const ciroIds = ciroList.body.map((c: { _id: string }) => c._id);
    expect(ciroIds).toEqual(
      expect.arrayContaining([fixtures.companyA.companyId, fixtures.companyB.companyId]),
    );

    const aList = await request(server)
      .get('/api/v1/companies')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    const aIds = aList.body.map((c: { _id: string }) => c._id);
    expect(aIds).toEqual([fixtures.companyA.companyId]);
    expect(aIds).not.toContain(fixtures.companyB.companyId);
  });

  it('fetching another Fuel Company by id is indistinguishable from it not existing (404, never 403)', async () => {
    const server = app.getHttpServer();

    await request(server)
      .get(`/api/v1/companies/${fixtures.companyB.companyId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);

    await request(server)
      .get(`/api/v1/companies/${fixtures.companyB.companyId}/fuel-prices`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);

    await request(server)
      .put(`/api/v1/companies/${fixtures.companyB.companyId}/fuel-prices`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ prices: [{ fuelType: 'DIESEL', basePricePerLiter: 9.99 }] })
      .expect(404);
  });

  it("a Fuel Company admin cannot use another tenant's suspension endpoint (SUPER_ADMIN-only, not just tenant-scoped)", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/companies/${fixtures.companyB.companyId}/status`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ status: 'SUSPENDED' })
      .expect(403);
  });

  // --- Spec 004 FR-005 / plan.md §1: fails closed, never runs unscoped ----

  it('rejects a scoped role whose stored companyId is missing, rather than listing every tenant', async () => {
    // `AuthenticatedUser.role`/`companyId` are re-derived from the DB on every
    // request (JwtStrategy never trusts the JWT's own claims for these), so a
    // forged token claim can't reach this path — only genuinely corrupted
    // data can. That's exactly what this reproduces: a real admin whose
    // stored companyId has gone missing, driven through the real HTTP
    // pipeline (JwtStrategy → TenantIsolationInterceptor → this controller).
    const server = app.getHttpServer();
    const userModel = app.get(getModelToken(User.name));

    await userModel.updateOne({ _id: fixtures.companyA.admin.id }, { $unset: { companyId: '' } });

    try {
      // Must log in again: validateActiveSessionWithScoping (and therefore
      // the AuthenticatedUser this endpoint sees) is re-derived per request,
      // but a still-valid existing access token needs no new login to reach
      // it — refreshing here just keeps the test independent of token TTL.
      const relogin = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@companya.test', password: DEFAULT_PASSWORD });

      // A FUEL_COMPANY_ADMIN with no phone-login identity still authenticates
      // by email; if login itself now fails closed that also satisfies this
      // guarantee (no session is issued for a corrupted account either).
      if (relogin.status === 201) {
        const res = await request(server)
          .get('/api/v1/companies')
          .set('Authorization', `Bearer ${relogin.body.accessToken}`);
        expect(res.status).not.toBe(200);
        expect(res.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(relogin.status).toBeGreaterThanOrEqual(400);
      }
    } finally {
      // Restore so this corruption can never leak into a later test.
      await userModel.updateOne(
        { _id: fixtures.companyA.admin.id },
        { $set: { companyId: fixtures.companyA.companyId } },
      );
    }
  });
});
