import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T150/FR-057/FR-058/SC-011 — commission accrues
 * against a company as invoices are raised, at the rate in force when EACH invoice was
 * raised; a later rate change never alters what already accrued.
 */
describe('Commission accrual matches the rate in force, including across a rate change (FR-057, FR-058, SC-011)', () => {
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

  async function createAndApproveOrder(
    clientToken: string,
    adminToken: string,
    method: 'DEFERRED' | 'CREDIT',
    quantityLiters: number,
  ) {
    const created = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ fuelType: 'DIESEL', quantityLiters, paymentMethod: method })
      .expect(201);
    const approved = await request(app.getHttpServer())
      .patch(`/api/v1/orders/${created.body._id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    return approved.body;
  }

  it('accrues at the PERCENTAGE rate in force, and a later rate change never alters the earlier accrual', async () => {
    const server = app.getHttpServer();
    const { admin, client } = fixtures.companyA;

    await request(server)
      .put(`/api/v1/users/${client.id}/credit-limit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ creditLimit: 100000 })
      .expect(200);

    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 10 })
      .expect(200);

    const before = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    // The platform's cut is a percentage of the INVOICE, so the expectation is
    // derived from the order's own `finalPrice` rather than restating the
    // arithmetic here. That total is fuel + service fee + haul + VAT; a literal
    // would have to be rewritten every time any one of those moves, and a
    // literal that drifts silently tests nothing.
    const firstOrder = await createAndApproveOrder(client.token, admin.token, 'CREDIT', 200);
    const firstCommission = Math.round(firstOrder.finalPrice * 10) / 100;

    const afterFirst = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(afterFirst.body.commissionAccrued).toBeCloseTo(
      before.body.commissionAccrued + firstCommission,
      2,
    );

    // Rate changes to 20% — must not touch what already accrued.
    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 20 })
      .expect(200);

    const afterRateChangeAlone = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(afterRateChangeAlone.body.commissionAccrued).toBeCloseTo(afterFirst.body.commissionAccrued, 2);

    // A NEW invoice at the new 20% rate, again derived from its own total.
    const secondOrder = await createAndApproveOrder(client.token, admin.token, 'CREDIT', 200);
    const secondCommission = Math.round(secondOrder.finalPrice * 20) / 100;

    const afterSecond = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(afterSecond.body.commissionAccrued).toBeCloseTo(
      afterFirst.body.commissionAccrued + secondCommission,
      2,
    );
  });

  it('accrues at the PER_UNIT rate, and states which basis is in force (FR-055)', async () => {
    const server = app.getHttpServer();
    const { admin, client, transportAdmin } = fixtures.companyB;

    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ basis: 'PER_UNIT', rate: 0.05 })
      .expect(200);

    const current = await request(server)
      .get('/api/v1/billing/commission-terms/current')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(current.body.basis).toBe('PER_UNIT');
    expect(current.body.rate).toBe(0.05);

    const before = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    // DEFERRED — no credit-limit setup needed. DIESEL @ 2.5/L (fixture) * 100L
    // = 250.00 of fuel + 30.00 haul = 280.00 -> 0.05 per unit of invoice value
    // = 14.00. The order amount now includes the transporter's 30 SAR haul, so the platform's cut is taken on fuel + delivery.
    await createAndApproveOrder(client.token, admin.token, 'DEFERRED', 100);

    const after = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(after.body.commissionAccrued).toBeCloseTo(before.body.commissionAccrued + 14, 2);

    // A FUEL_COMPANY_ADMIN sees the terms read-only — no PUT access at all (FR-056).
    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 1 })
      .expect(403);
    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 1 })
      .expect(403);
  });
});
