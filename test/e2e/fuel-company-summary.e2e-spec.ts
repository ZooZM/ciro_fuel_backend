import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T110/FR-044/FR-046/FR-048, R2, SC-006 —
 * `GET /orders/summary` for a `FUEL_COMPANY_ADMIN`: (a) isolated from a second fuel
 * company's activity, and (b) shaped as `FuelCompanySummaryDto`, never the
 * `TRANSPORT_COMPANY_ADMIN`/`SUPER_ADMIN` shape with the meaningless fields left in at
 * zero (T111's finding: `driversOnDuty` and `awaitingAssignment` name concepts that don't
 * apply to this role at all).
 */
describe('Fuel company dashboard summary (T109-T111, FR-044, FR-046, SC-006)', () => {
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

  it('never carries driversOnDuty or awaitingAssignment — the transporter-shaped fields (FR-048)', async () => {
    const server = app.getHttpServer();
    const summary = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    expect(summary.body).not.toHaveProperty('driversOnDuty');
    expect(summary.body).not.toHaveProperty('awaitingAssignment');
    expect(summary.body).toHaveProperty('pendingApproval');
    expect(summary.body).toHaveProperty('stationOwnersCount');
    expect(summary.body).toHaveProperty('stationsCount');
    expect(summary.body).toHaveProperty('creditOutstanding');
  });

  it("counts only this company's own activity — a second fuel company's orders, clients and credit never inflate it (SC-006)", async () => {
    const server = app.getHttpServer();
    const { admin: adminA, client: clientA } = fixtures.companyA;
    const { admin: adminB, client: clientB } = fixtures.companyB;

    const before = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);

    // Activity on company B: a pending order, a credit-financed order, and its own
    // station-owner client — none of this should move company A's numbers.
    await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientB.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    await request(server)
      .put(`/api/v1/users/${clientB.id}/credit-limit`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ creditLimit: 5000 })
      .expect(200);
    const creditOrderB = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientB.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'CREDIT' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/orders/${creditOrderB.body._id}/approve`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({})
      .expect(200);

    const afterB = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(afterB.body.pendingApproval).toBe(before.body.pendingApproval);
    expect(afterB.body.stationOwnersCount).toBe(before.body.stationOwnersCount);
    expect(afterB.body.creditOutstanding.count).toBe(before.body.creditOutstanding.count);

    // Now the same activity on company A moves its own numbers by exactly one each.
    await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientA.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    await request(server)
      .put(`/api/v1/users/${clientA.id}/credit-limit`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ creditLimit: 5000 })
      .expect(200);
    const creditOrderA = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientA.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'CREDIT' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/orders/${creditOrderA.body._id}/approve`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({})
      .expect(200);

    const afterA = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(afterA.body.pendingApproval).toBe(before.body.pendingApproval + 1);
    expect(afterA.body.creditOutstanding.count).toBe(before.body.creditOutstanding.count + 1);

    // Company B's own summary reflects its own new activity, not company A's.
    const summaryB = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(summaryB.body.pendingApproval).toBeGreaterThanOrEqual(1);
    expect(summaryB.body.creditOutstanding.count).toBeGreaterThanOrEqual(1);
  });

  it('stationsCount reflects a newly registered station immediately', async () => {
    const server = app.getHttpServer();
    const { admin, client } = fixtures.companyA;

    const before = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    await request(server)
      .post(`/api/v1/users/${client.id}/stations`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        regionCode: 'RIYADH',
        governorateCode: 'RIYADH_CITY',
        location: { latitude: 24.7136, longitude: 46.6753 },
      })
      .expect(201);

    const after = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(after.body.stationsCount).toBe(before.body.stationsCount + 1);
  });
});
