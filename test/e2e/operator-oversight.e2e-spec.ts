import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 Phase 16 (US13) — the operator's per-company drill-down needed genuine new
 * backend capability (T238), not just dashboard wiring: `GET /users`, `GET
 * /stations/all`, `GET /invoices` and `GET /platform-account/movements` all relied
 * entirely on their isolation plugin's ambient scoping with no explicit filter, which
 * silently returns EVERY company's rows mixed together for `SUPER_ADMIN` (who bypasses
 * every plugin) rather than one company's. Each gained an explicit `companyId`/
 * `fuelCompanyId` filter, safe to accept from any role because the owning plugin
 * overwrites it for a tenant-scoped caller regardless of what is passed (T238's own
 * comments explain why, in each service file). `GET /billing/balances/:companyId` is a
 * genuinely new route (SA only) alongside the pre-existing `balances/me`.
 *
 * Also covers T246: a `FUEL_COMPANY_ADMIN` is refused every operator-only endpoint added
 * across Phases 12-16.
 */
describe('Operator oversight: per-company drill-down and operator-only refusals (US13)', () => {
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

  it("the operator's per-company user list matches exactly what that company's own admin sees for itself (T238, quickstart 4.3)", async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyA;

    const asOwnAdmin = await request(server)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const asOperator = await request(server)
      .get(`/api/v1/users?companyId=${companyId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(asOperator.body.map((u: { _id: string }) => u._id).sort()).toEqual(
      asOwnAdmin.body.map((u: { _id: string }) => u._id).sort(),
    );

    // An unfiltered operator call is NOT scoped to one company (bypasses every plugin) —
    // confirming the filter, not the endpoint's role guard, is what narrows the result.
    const unfiltered = await request(server)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(unfiltered.body.length).toBeGreaterThanOrEqual(asOperator.body.length);
  });

  it("the operator's per-company station list matches that company's own admin view", async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyA;

    const asOwnAdmin = await request(server)
      .get('/api/v1/stations/all')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const asOperator = await request(server)
      .get(`/api/v1/stations/all?companyId=${companyId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(asOperator.body.items.map((s: { _id: string }) => s._id).sort()).toEqual(
      asOwnAdmin.body.items.map((s: { _id: string }) => s._id).sort(),
    );
  });

  it("the operator's per-company invoice list matches that company's own admin view", async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyA;

    const asOwnAdmin = await request(server)
      .get('/api/v1/invoices')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const asOperator = await request(server)
      .get(`/api/v1/invoices?fuelCompanyId=${companyId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(asOperator.body.items.map((i: { _id: string }) => i._id).sort()).toEqual(
      asOwnAdmin.body.items.map((i: { _id: string }) => i._id).sort(),
    );
  });

  it("the operator's per-company platform-account ledger matches that company's own admin view", async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyA;

    const asOwnAdmin = await request(server)
      .get('/api/v1/platform-account/movements')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const asOperator = await request(server)
      .get(`/api/v1/platform-account/movements?companyId=${companyId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(asOperator.body.items.map((m: { _id: string }) => m._id).sort()).toEqual(
      asOwnAdmin.body.items.map((m: { _id: string }) => m._id).sort(),
    );
  });

  it("the operator's per-company billing balances match that company's own admin view (GET /billing/balances/:companyId)", async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyA;

    const asOwnAdmin = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const asOperator = await request(server)
      .get(`/api/v1/billing/balances/${companyId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(asOperator.body).toEqual(asOwnAdmin.body);

    // FCA is refused the operator-only route entirely (T246).
    await request(server)
      .get(`/api/v1/billing/balances/${companyId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403);
  });

  it('a FUEL_COMPANY_ADMIN is refused every operator-only endpoint added across Phases 12-15 (T246, FR-005/056/062a/067a)', async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyA;

    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 5 })
      .expect(403);

    await request(server)
      .put('/api/v1/billing/cashback-programme')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        basis: 'PERCENTAGE',
        rate: 5,
        isActive: true,
        targetsAllCompanies: true,
        targetCompanyIds: [],
      })
      .expect(403);

    await request(server)
      .put(`/api/v1/companies/${companyId}/commission-ceiling`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ commissionCeiling: 1000 })
      .expect(403);

    const payment = await request(server)
      .post('/api/v1/platform-account/payments')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 10, method: 'BANK_TRANSFER', reference: 'x' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/platform-account/payments/${payment.body._id}/confirm`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403);

    await request(server)
      .patch(`/api/v1/companies/${companyId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'SUSPENDED' })
      .expect(403);
  });
});
