import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, resetFixtureDispatchState, settleClientReview } from '../utils/fixtures';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/**
 * spec 007 FR-003a/FR-003b (pulled forward from Phase 6 to unblock US1's
 * FR-003, which requires the driver's active-delivery card to show the
 * customer's contact name — the mobile Order entity has no such field
 * without this): the platform records a driver's contact details for the
 * customer's benefit (`driverSummary`), but kept no mirror, so a driver had
 * no way to identify or reach the customer they were delivering to.
 */
describe('Driver order — customer contact mirror (spec 007 FR-003a/b)', () => {
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

  beforeEach(async () => {
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    await userModel.updateMany(
      { _id: { $in: [fixtures.companyA.driver.id, fixtures.companyB.driver.id] } },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
    await resetFixtureDispatchState(app, fixtures.companyA, fixtures.companyB);
  });

  async function assignOrder(company: TwoCompanyFixture['companyA']): Promise<string> {
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${company.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const orderId = createRes.body._id;
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${company.admin.token}`)
      .send({})
      .expect(200);
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-contact-${orderId}`,
        orderId,
        amount: approveRes.body.finalPrice,
        currency: 'SAR',
        status: 'PAID',
        paidAt: new Date().toISOString(),
      },
      'sadad-test-secret',
    );
    await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);
    await settleClientReview(app, orderId);
    await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${company.transportAdmin.token}`)
      .send({ driverId: company.driver.id, truckId: company.truck.id, tankId: company.tank.id })
      .expect(201);
    return orderId;
  }

  it("is present on the assigned driver's own view of their order", async () => {
    const server = app.getHttpServer();
    const orderId = await assignOrder(fixtures.companyA);

    const res = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    expect(res.body.clientSummary).toEqual({
      fullName: expect.any(String),
      phone: expect.any(String),
    });
  });

  it("is present in the assigned driver's own list", async () => {
    const server = app.getHttpServer();
    const orderId = await assignOrder(fixtures.companyA);

    const res = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    const item = res.body.items.find((o: { _id: string }) => o._id === orderId);
    expect(item.clientSummary).toEqual({
      fullName: expect.any(String),
      phone: expect.any(String),
    });
  });

  it("is absent from another driver's view — a different company's order is 404, never leaked", async () => {
    const server = app.getHttpServer();
    const orderId = await assignOrder(fixtures.companyA);

    await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .expect(404);
  });

  it('an order assigned before this feature (no clientSummary) still serialises cleanly', async () => {
    const server = app.getHttpServer();
    const orderId = await assignOrder(fixtures.companyA);

    // Simulate a pre-migration order: the field never existed on documents
    // written before this feature.
    const { getModelToken } = await import('@nestjs/mongoose');
    const { Order } = await import('../../src/modules/orders/schemas/order.schema');
    const orderModel = app.get(getModelToken(Order.name));
    await orderModel.updateOne({ _id: orderId }, { $unset: { clientSummary: '' } }).exec();

    const res = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    expect(res.body.clientSummary).toBeUndefined();
  });
});
