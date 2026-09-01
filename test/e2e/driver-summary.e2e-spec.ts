import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  assignAndDepart,
  resetFixtureDispatchState,
} from '../utils/fixtures';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/**
 * spec 007 US5 (T070/T071): `GET /drivers/me/summary` — the header's real
 * data source, replacing the hard-coded `4.8` rating and `5` orders-today
 * count. `ratingAverage`/`ratingCount` are set directly on the driver's
 * document here (the rating endpoint itself is Phase 8/US6's own feature,
 * not yet built) — this file only proves the summary reads them correctly.
 */
describe('Driver summary (spec 007 US5)', () => {
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
    const { Order } = await import('../../src/modules/orders/schemas/order.schema');
    const userModel = app.get(getModelToken(User.name));
    const orderModel = app.get(getModelToken(Order.name));
    await userModel.updateMany(
      { _id: { $in: [fixtures.companyA.driver.id, fixtures.companyB.driver.id] } },
      {
        $set: { isAvailable: true },
        $unset: { activeOrderId: '', ratingAverage: '', ratingCount: '' },
      },
    );
    await orderModel.deleteMany({}).exec();
    await resetFixtureDispatchState(app, fixtures.companyA, fixtures.companyB);
  });

  async function assignAndDeliver(company: TwoCompanyFixture['companyA']): Promise<string> {
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
        transactionId: `SDD-summary-${orderId}`,
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
    await assignAndDepart(
      app,
      orderId,
      company.transportAdmin.token,
      company.driver.token,
      company.driver.id,
      company.truck.id,
      company.tank.id,
      company.truck.nfcCardUid,
    );

    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${company.driver.token}`)
      .expect(201);
    const arrivalOtp = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${company.client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${company.driver.token}`)
      .send({ otp: arrivalOtp.body.otp })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/request-delivery-otp`)
      .set('Authorization', `Bearer ${company.driver.token}`)
      .expect(201);
    const deliveryOtp = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${company.client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-delivery`)
      .set('Authorization', `Bearer ${company.driver.token}`)
      .send({ otp: deliveryOtp.body.otp })
      .expect(201);

    return orderId;
  }

  it("a rated driver's average and count are returned", async () => {
    const server = app.getHttpServer();
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    await userModel
      .updateOne(
        { _id: fixtures.companyA.driver.id },
        { $set: { ratingAverage: 4.5, ratingCount: 12 } },
      )
      .exec();

    const res = await request(server)
      .get('/api/v1/drivers/me/summary')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    expect(res.body.ratingAverage).toBe(4.5);
    expect(res.body.ratingCount).toBe(12);
  });

  it("a never-rated driver's response omits ratingAverage entirely", async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .get('/api/v1/drivers/me/summary')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    expect(res.body).not.toHaveProperty('ratingAverage');
    expect(res.body.ratingCount).toBe(0);
  });

  it('deliveriesToday matches deliveries actually completed today', async () => {
    const server = app.getHttpServer();
    await assignAndDeliver(fixtures.companyA);

    const res = await request(server)
      .get('/api/v1/drivers/me/summary')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    expect(res.body.deliveriesToday).toBe(1);
  });

  it("deliveredAt is set on normal completion, counting toward the driver's day", async () => {
    const server = app.getHttpServer();
    const orderId = await assignAndDeliver(fixtures.companyA);
    const { getModelToken } = await import('@nestjs/mongoose');
    const { Order } = await import('../../src/modules/orders/schemas/order.schema');
    const orderModel = app.get(getModelToken(Order.name));
    const order = await orderModel.findById(orderId).exec();
    expect(order.deliveredAt).toBeInstanceOf(Date);
  });

  it('deliveredAt is set on an admin force-complete override too (research R8)', async () => {
    const server = app.getHttpServer();
    const { client, admin, transportAdmin, driver, truck, tank } = fixtures.companyA;
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const orderId = createRes.body._id;
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-force-${orderId}`,
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
    await assignAndDepart(
      app,
      orderId,
      transportAdmin.token,
      driver.token,
      driver.id,
      truck.id,
      tank.id,
      truck.nfcCardUid,
    );

    await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Customer confirmed by phone; driver app offline' })
      .expect(200);

    const res = await request(server)
      .get('/api/v1/drivers/me/summary')
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    expect(res.body.deliveriesToday).toBe(1);
  });

  it("a driver cannot obtain another driver's figures", async () => {
    const server = app.getHttpServer();
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    await userModel
      .updateOne(
        { _id: fixtures.companyA.driver.id },
        { $set: { ratingAverage: 5, ratingCount: 3 } },
      )
      .exec();

    const res = await request(server)
      .get('/api/v1/drivers/me/summary')
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .expect(200);

    // "me" scoping (FR-034): companyB's driver always reads their own
    // record — there is no id parameter through which A's could leak.
    expect(res.body.ratingAverage).toBeUndefined();
  });
});
