import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

const PLACEHOLDER_ID = '000000000000000000000000';

/**
 * spec 013 (fuel company admin dashboard) T027/FR-004: the client-side route guard
 * (`web_dashboard/src/app/router.tsx`, T018) is a UX layer over server-side authorization,
 * never a replacement (Constitution II) — this file is the server-side proof. Covers every
 * endpoint gated to `FUEL_COMPANY_ADMIN` alone that this feature's Phase 3-8 slices connect
 * on the dashboard (orders decisions, stations, credit limits, transporters, pricing).
 * Guards run before body validation/resource lookup (Nest's Guard → Pipe → Handler order), so
 * a placeholder id and an empty body are sufficient to prove a role is refused — this file
 * asserts DENIAL comprehensively; the ADMITTED-role success paths are already covered by the
 * suites each of those endpoints was built under (order-lifecycle, client-station,
 * hierarchy-onboarding, etc.).
 *
 * New endpoints this feature ADDS in later phases (credit-limit-requests, litre-balances,
 * billing, platform-account, fuel-exchange) get their own RBAC assertions inline with the
 * phase that creates them (T069, T110, T215, T246, etc.) — they do not exist yet at this
 * point in the build and cannot be tested here.
 */
describe('Fuel company RBAC — server-side denial matrix (FR-004, Constitution II)', () => {
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

  interface Endpoint {
    name: string;
    method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    path: () => string;
    body?: Record<string, unknown>;
    // Roles admitted alongside FUEL_COMPANY_ADMIN, if any — excluded from the refusal list
    // for this endpoint since they are legitimately admitted, not a leak.
    //
    // spec 017 T054/FR-020 widened the union to include SUPER_ADMIN: the platform
    // operator is now admitted to force-complete, so this matrix needs a way to say
    // "deliberately admitted" about that role too, rather than asserting a refusal the
    // platform no longer makes.
    alsoAdmits?: Array<'CLIENT' | 'DRIVER' | 'TRANSPORT_COMPANY_ADMIN' | 'SUPER_ADMIN'>;
  }

  // Every FUEL_COMPANY_ADMIN-only (or FUEL_COMPANY_ADMIN-plus-named-others) endpoint this
  // feature's early phases wire on the dashboard, as decorated today in the controllers.
  const endpoints: Endpoint[] = [
    {
      name: 'PUT /companies/:id/fuel-prices',
      method: 'put',
      path: () => `/api/v1/companies/${fixtures.companyA.companyId}/fuel-prices`,
    },
    {
      name: 'PUT /companies/:id/pricing-config',
      method: 'put',
      path: () => `/api/v1/companies/${fixtures.companyA.companyId}/pricing-config`,
    },
    {
      name: 'POST /companies/:id/transporters',
      method: 'post',
      path: () => `/api/v1/companies/${fixtures.companyA.companyId}/transporters`,
    },
    {
      name: 'PUT /companies/:id/regions',
      method: 'put',
      path: () => `/api/v1/companies/${fixtures.companyA.transportCompanyId}/regions`,
    },
    {
      name: 'PATCH /orders/:id/approve',
      method: 'patch',
      path: () => `/api/v1/orders/${PLACEHOLDER_ID}/approve`,
    },
    {
      name: 'PATCH /orders/:id/route',
      method: 'patch',
      path: () => `/api/v1/orders/${PLACEHOLDER_ID}/route`,
    },
    {
      name: 'PATCH /orders/:id/reject',
      method: 'patch',
      path: () => `/api/v1/orders/${PLACEHOLDER_ID}/reject`,
    },
    // spec 017 T054/FR-020: SUPER_ADMIN is now admitted here — the platform operator
    // can force a delivery closed, on the same three stages and with the same recorded
    // reason. The three other roles are still refused, which is what this row still
    // proves. (The operator's own admission is asserted positively by
    // `order-buckets.e2e-spec.ts` and `operator-authorization.e2e-spec.ts`.)
    {
      name: 'PATCH /orders/:id/force-complete',
      method: 'patch',
      path: () => `/api/v1/orders/${PLACEHOLDER_ID}/force-complete`,
      alsoAdmits: ['SUPER_ADMIN'],
    },
    // redispatch also admits CLIENT (spec 004) — refused list excludes it here.
    {
      name: 'POST /orders/:id/redispatch',
      method: 'post',
      path: () => `/api/v1/orders/${PLACEHOLDER_ID}/redispatch`,
      alsoAdmits: ['CLIENT'],
    },
    {
      name: 'PATCH /stations/:id',
      method: 'patch',
      path: () => `/api/v1/stations/${PLACEHOLDER_ID}`,
    },
    {
      name: 'DELETE /stations/:id',
      method: 'delete',
      path: () => `/api/v1/stations/${PLACEHOLDER_ID}`,
    },
    {
      name: 'GET /users/:id/stations',
      method: 'get',
      path: () => `/api/v1/users/${PLACEHOLDER_ID}/stations`,
    },
    {
      name: 'POST /users/:id/stations',
      method: 'post',
      path: () => `/api/v1/users/${PLACEHOLDER_ID}/stations`,
    },
    {
      name: 'PUT /users/:id/credit-limit',
      method: 'put',
      path: () => `/api/v1/users/${PLACEHOLDER_ID}/credit-limit`,
    },
    {
      name: 'GET /users/:id/credit-limit',
      method: 'get',
      path: () => `/api/v1/users/${PLACEHOLDER_ID}/credit-limit`,
    },
  ];

  const roleTokens = () => ({
    CLIENT: fixtures.companyA.client.token,
    DRIVER: fixtures.companyA.driver.token,
    TRANSPORT_COMPANY_ADMIN: fixtures.companyA.transportAdmin.token,
    SUPER_ADMIN: fixtures.superAdmin.token,
  });

  for (const endpoint of endpoints) {
    describe(endpoint.name, () => {
      const refusedRoles = (
        ['CLIENT', 'DRIVER', 'TRANSPORT_COMPANY_ADMIN', 'SUPER_ADMIN'] as const
      ).filter((role) => !endpoint.alsoAdmits?.includes(role as never));

      it.each(refusedRoles)('refuses %s', async (role) => {
        const token = roleTokens()[role];
        const req = request(app.getHttpServer())
          [endpoint.method](endpoint.path())
          .set('Authorization', `Bearer ${token}`);
        await (endpoint.body ? req.send(endpoint.body) : req.send({})).expect(403);
      });
    });
  }

  // And the inverse direction (FR-004's other half): a fuel company administrator is
  // refused every route reserved to another role. One representative per surface —
  // exhaustive coverage of the platform's whole API is out of this file's scope.
  it('FUEL_COMPANY_ADMIN is refused a TRANSPORT_COMPANY_ADMIN-only route (dispatch assignment)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${PLACEHOLDER_ID}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ driverId: PLACEHOLDER_ID })
      .expect(403);
  });

  it('FUEL_COMPANY_ADMIN is refused a SUPER_ADMIN-only route (company status)', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/companies/${fixtures.companyA.companyId}/status`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ status: 'SUSPENDED' })
      .expect(403);
  });
});
