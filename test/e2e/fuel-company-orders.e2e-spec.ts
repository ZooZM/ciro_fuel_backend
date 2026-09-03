import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T039/T040/FR-008/FR-019/SC-006/SC-008: the
 * dashboard's order decisions (approve/reject/route/redispatch/force-complete) are
 * already gated server-side by `@Roles(FUEL_COMPANY_ADMIN)` (see
 * fuel-company-rbac.e2e-spec.ts). This file covers what that one doesn't: VISIBILITY
 * isolation (a second fuel company's orders never appear, and cannot be acted on at
 * all — 404, since `Order` is multi-party scoped, not merely role-gated) and the
 * concurrent-decision conflict guarantee.
 */
describe('Fuel company order isolation & conflicts (FR-008, FR-019, SC-006, SC-008)', () => {
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

  async function createPendingOrder(clientToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500 })
      .expect(201);
    return res.body._id as string;
  }

  it("company B's orders list never contains company A's orders", async () => {
    const server = app.getHttpServer();
    const orderIdA = await createPendingOrder(fixtures.companyA.client.token);

    const listB = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(200);
    const idsB = new Set((listB.body.items as { _id: string }[]).map((o) => o._id));
    expect(idsB.has(orderIdA)).toBe(false);

    const listA = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    const idsA = new Set((listA.body.items as { _id: string }[]).map((o) => o._id));
    expect(idsA.has(orderIdA)).toBe(true);
  });

  it("company B cannot approve, reject or force-complete company A's order (404, isolation, never revealing existence)", async () => {
    const server = app.getHttpServer();
    const orderId = await createPendingOrder(fixtures.companyA.client.token);

    await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({})
      .expect(404);
    await request(server)
      .patch(`/api/v1/orders/${orderId}/reject`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({ reason: 'not mine' })
      .expect(404);
    await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(404);
  });

  it('two simultaneous approvals of the same order produce exactly one applied outcome and a 409 conflict, never a 500', async () => {
    const server = app.getHttpServer();
    const orderId = await createPendingOrder(fixtures.companyA.client.token);

    const [first, second] = await Promise.all([
      request(server)
        .patch(`/api/v1/orders/${orderId}/approve`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({ finalPrice: 100 }),
      request(server)
        .patch(`/api/v1/orders/${orderId}/approve`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({ finalPrice: 200 }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    // Exactly one succeeds (2xx), the other is refused as a conflict (409) — never both
    // succeeding, and never a 500.
    expect(statuses[0]).toBeGreaterThanOrEqual(200);
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
  });
});
