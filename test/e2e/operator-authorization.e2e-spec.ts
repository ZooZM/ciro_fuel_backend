import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) T149 / FR-074 / SC-012.
 *
 * **SC-012 requires authorization verified PER CAPABILITY, not once for the
 * feature.** Each story's own suite asserts its own refusals; this one is the
 * checklist against `contracts/rest-api-delta.md` §9's matrix, so a route added
 * to this feature without a `@Roles(SUPER_ADMIN)` decorator fails here even if
 * its story's suite forgot to check.
 *
 * The distinction it is really testing is between 403 and 404/empty. Every
 * route below belongs to the operator alone and must REFUSE the other four
 * roles outright — not quietly return an empty result, which would leave a
 * company administrator unable to tell "you may not ask this" from "there is
 * nothing to see".
 */
describe('Every operator-only route refuses every other role (SC-012)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  /**
   * The four roles that must never reach an operator route.
   *
   * The table lists role NAMES and the token is resolved inside each test:
   * `it.each` evaluates its table at COLLECTION time, before `beforeAll` has
   * run, so a table holding tokens would be built from an undefined fixture.
   */
  const OTHER_ROLES = [
    UserRole.FUEL_COMPANY_ADMIN,
    UserRole.TRANSPORT_COMPANY_ADMIN,
    UserRole.CLIENT,
    UserRole.DRIVER,
  ] as const;

  function tokenFor(role: (typeof OTHER_ROLES)[number]): string {
    switch (role) {
      case UserRole.FUEL_COMPANY_ADMIN:
        return fixtures.companyA.admin.token;
      case UserRole.TRANSPORT_COMPANY_ADMIN:
        return fixtures.companyA.transportAdmin.token;
      case UserRole.CLIENT:
        return fixtures.companyA.client.token;
      case UserRole.DRIVER:
        return fixtures.companyA.driver.token;
    }
  }

  const someCompanyId = () => fixtures.companyA.companyId;
  const someId = () => new Types.ObjectId().toString();

  /**
   * Every route §9's matrix marks `SUPER_ADMIN`, with the method and a body
   * where one is needed. The body must be VALID: a route that refuses on
   * validation before it refuses on role would return 400 and hide the very
   * thing this suite exists to prove.
   */
  const operatorOnlyRoutes: {
    name: string;
    method: 'get' | 'post' | 'patch';
    path: () => string;
    body?: () => Record<string, unknown>;
  }[] = [
    { name: 'GET /platform/overview', method: 'get', path: () => '/api/v1/platform/overview' },
    {
      name: 'GET /platform/transport-company-volumes',
      method: 'get',
      path: () => `/api/v1/platform/transport-company-volumes?companyIds=${someCompanyId()}`,
    },
    { name: 'GET /drivers/roster', method: 'get', path: () => '/api/v1/drivers/roster' },
    { name: 'GET /auth/me/account', method: 'get', path: () => '/api/v1/auth/me/account' },
    { name: 'GET /announcements', method: 'get', path: () => '/api/v1/announcements' },
    {
      name: 'GET /announcements/:id',
      method: 'get',
      path: () => `/api/v1/announcements/${someId()}`,
    },
    {
      name: 'POST /announcements',
      method: 'post',
      path: () => '/api/v1/announcements',
      body: () => ({ title: 'Title', body: 'Body of the announcement' }),
    },
    {
      name: 'POST /companies/transporters',
      method: 'post',
      path: () => '/api/v1/companies/transporters',
      body: () => ({
        name: 'Refused Transporter',
        contactEmail: 'refused@platform.test',
        contactPhone: '+966500000002',
        parentFuelCompanyId: someCompanyId(),
        adminEmail: 'refused-admin@platform.test',
        adminFullName: 'Refused Admin',
        adminPhone: '+966590000099',
        adminPassword: 'Password123!',
      }),
    },
    {
      name: 'GET /platform-account/cashback/:companyId/owed',
      method: 'get',
      path: () => `/api/v1/platform-account/cashback/${someCompanyId()}/owed`,
    },
    {
      name: 'POST /platform-account/cashback/:companyId/payouts',
      method: 'post',
      path: () => `/api/v1/platform-account/cashback/${someCompanyId()}/payouts`,
      body: () => ({ amount: 1, method: 'BANK_TRANSFER', reference: 'REFUSED-1' }),
    },
  ];

  describe.each(operatorOnlyRoutes)('$name', (route) => {
    it.each(OTHER_ROLES)('refuses a %s with 403', async (role) => {
      const call = request(app.getHttpServer())
        [route.method](route.path())
        .set('Authorization', `Bearer ${tokenFor(role)}`);
      const res = route.body ? await call.send(route.body()) : await call;
      expect(res.status).toBe(403);
    });

    it('refuses an unauthenticated caller with 401', async () => {
      const call = request(app.getHttpServer())[route.method](route.path());
      const res = route.body ? await call.send(route.body()) : await call;
      expect(res.status).toBe(401);
    });

    it('admits the operator (not 401/403)', async () => {
      // Proves the refusals above are about the ROLE, not about a route that
      // simply does not exist or a body that fails validation for everyone.
      const call = request(app.getHttpServer())
        [route.method](route.path())
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`);
      const res = route.body ? await call.send(route.body()) : await call;
      expect([401, 403]).not.toContain(res.status);
    });
  });

  /**
   * The CHANGED routes: these already admitted other roles and must keep doing
   * so (FR-075). A 403 here would be a regression, not a success.
   */
  describe('changed routes keep admitting the roles they already admitted (FR-075)', () => {
    it('GET /companies still serves a FUEL_COMPANY_ADMIN', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/companies')
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
    });

    it('GET /orders still serves every role that could already call it', async () => {
      for (const token of [
        fixtures.companyA.admin.token,
        fixtures.companyA.transportAdmin.token,
        fixtures.companyA.client.token,
        fixtures.companyA.driver.token,
      ]) {
        await request(app.getHttpServer())
          .get('/api/v1/orders')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      }
    });

    it('GET /orders/summary still serves both administrator roles', async () => {
      for (const token of [
        fixtures.companyA.admin.token,
        fixtures.companyA.transportAdmin.token,
      ]) {
        await request(app.getHttpServer())
          .get('/api/v1/orders/summary')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      }
    });

    it('GET /platform-account/movements still serves a FUEL_COMPANY_ADMIN', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/platform-account/movements')
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
    });

    it('PATCH /orders/:id/force-complete still admits a FUEL_COMPANY_ADMIN', async () => {
      // Reaches the stage check (409), not the role guard (403) — which is the
      // point: the role widening added SUPER_ADMIN without removing anyone.
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${created.body._id}/force-complete`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({ reason: 'Not at a completable stage' })
        .expect(409);
    });
  });
});
