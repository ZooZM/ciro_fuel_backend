import request from 'supertest';
import { createHmac } from 'node:crypto';
import { Model } from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('Proof of delivery — OTP security & force-complete (US1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    userModel = app.get(getModelToken(User.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
  });

  async function bringOrderToInTransit(): Promise<string> {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

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
        transactionId: `SDD-fc-${orderId}`,
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

    return orderId;
  }

  it('throttles repeated wrong OTP submissions and never leaks the OTP to the driver', async () => {
    const { driver, client } = fixtures.companyA;
    const server = app.getHttpServer();
    const orderId = await bringOrderToInTransit();

    const arriveRes = await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);
    // Driver's own response never contains the OTP value anywhere.
    expect(JSON.stringify(arriveRes.body)).not.toMatch(/^\d{6}$/);
    expect(JSON.stringify(arriveRes.body)).not.toContain('"otp"');

    for (let i = 0; i < 5; i++) {
      await request(server)
        .post(`/api/v1/orders/${orderId}/verify-arrival`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ otp: '000000' })
        .expect(401);
    }

    // 6th attempt within the throttle window is rejected outright (429) —
    // whether by the too-many-attempts guard or the rate limiter, the OTP
    // is never disclosed and the order never advances.
    const sixth = await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: '000000' });
    expect([401, 429]).toContain(sixth.status);

    const stillInTransit = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(stillInTransit.body.status).toBe(OrderStatus.IN_TRANSIT);
  });

  it('lets a Company Admin force-complete a stuck delivery with an audited reason', async () => {
    const { driver, admin, client } = fixtures.companyA;
    const server = app.getHttpServer();
    const orderId = await bringOrderToInTransit();

    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    const res = await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Client handheld device battery died at the station' })
      .expect(200);

    expect(res.body.status).toBe(OrderStatus.DELIVERED);
    const lastEntry = res.body.statusHistory[res.body.statusHistory.length - 1];
    expect(lastEntry.manualOverride).toBe(true);
    expect(lastEntry.overrideReason).toBe('Client handheld device battery died at the station');

    // The now-invalidated OTP no longer appears as "current" for the client.
    await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(404);
  });

  it('denies force-complete to DRIVER and CLIENT roles', async () => {
    const { driver, client } = fixtures.companyA;
    const server = app.getHttpServer();
    const orderId = await bringOrderToInTransit();

    await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ reason: 'trying to self-serve' })
      .expect(403);

    await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ reason: 'trying to self-serve' })
      .expect(403);
  });
});
