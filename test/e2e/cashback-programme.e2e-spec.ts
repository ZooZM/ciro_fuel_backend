import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T151/FR-059/FR-060 — cashback accrues to a
 * company as ITS invoices are paid, only while the programme is active and only if that
 * company is targeted. Uses DEFERRED invoices throughout: settlement is performed by the
 * PAYING transporter, a different company from the beneficiary (`invoice.fuelCompanyId`)
 * — exactly the case `PlatformAccountService.createMovement`'s companyId correction
 * exists for (see billing.service.ts).
 */
describe('Cashback accrues only while active and only for a targeted company (FR-059, FR-060)', () => {
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

  async function createApproveAndSettleDeferredOrder(fixture: TwoCompanyFixture['companyA']) {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    const approved = await request(server)
      .patch(`/api/v1/orders/${created.body._id}/approve`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({})
      .expect(200);
    await request(server)
      .post(`/api/v1/invoices/${approved.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${fixture.transportAdmin.token}`)
      .send({})
      .expect(201);
    return approved.body;
  }

  it('accrues nothing while the programme is switched off, then accrues once turned on and targeted at all companies', async () => {
    const server = app.getHttpServer();
    const { admin } = fixtures.companyA;

    await request(server)
      .put('/api/v1/billing/cashback-programme')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 5, isActive: false, targetsAllCompanies: true, targetCompanyIds: [] })
      .expect(200);

    const before = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    await createApproveAndSettleDeferredOrder(fixtures.companyA);

    const whileOff = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(whileOff.body.cashbackAccrued).toBe(before.body.cashbackAccrued);

    await request(server)
      .put('/api/v1/billing/cashback-programme')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 5, isActive: true, targetsAllCompanies: true, targetCompanyIds: [] })
      .expect(200);

    // DIESEL @ 2.5/L * 100L = 250.00 -> 5% = 12.50
    await createApproveAndSettleDeferredOrder(fixtures.companyA);

    const whileOn = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(whileOn.body.cashbackAccrued).toBeCloseTo(before.body.cashbackAccrued + 12.5, 2);
  });

  it('accrues to a named company but not to one left off the target list, with the same programme active', async () => {
    const server = app.getHttpServer();

    await request(app.getHttpServer())
      .put('/api/v1/billing/cashback-programme')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({
        basis: 'PERCENTAGE',
        rate: 5,
        isActive: true,
        targetsAllCompanies: false,
        targetCompanyIds: [fixtures.companyA.companyId],
      })
      .expect(200);

    const beforeA = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    const beforeB = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(200);

    await createApproveAndSettleDeferredOrder(fixtures.companyA);
    await createApproveAndSettleDeferredOrder(fixtures.companyB);

    const afterA = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    const afterB = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(200);

    expect(afterA.body.cashbackAccrued).toBeCloseTo(beforeA.body.cashbackAccrued + 12.5, 2);
    expect(afterB.body.cashbackAccrued).toBe(beforeB.body.cashbackAccrued);
  });
});
