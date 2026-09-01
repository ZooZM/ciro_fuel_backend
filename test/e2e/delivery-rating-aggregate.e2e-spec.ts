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
 * spec 007 US6 (T087/T088): the driver-aggregate side effect of a rating —
 * split from `delivery-rating.e2e-spec.ts` (not merged into it) because
 * these two scenarios alone need 3 delivered orders' worth of
 * `verify-arrival` calls, and `@Throttle({ limit: 5, ttl: 15 * 60_000 })`
 * is keyed per-IP for the whole app instance a file's `beforeAll` starts —
 * shared with that file's own 4 deliveries, the combined total already
 * throttles out before this one's second delivery.
 */
describe('Delivery rating — driver aggregate (spec 007 US6)', () => {
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
      {
        $set: { isAvailable: true },
        $unset: { activeOrderId: '', ratingAverage: '', ratingCount: '' },
      },
    );
    await resetFixtureDispatchState(app, fixtures.companyA, fixtures.companyB);
  });

  async function deliverOrder(company: TwoCompanyFixture['companyA']): Promise<string> {
    const server = app.getHttpServer();
    const { client, admin, transportAdmin, driver, truck, tank } = company;
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
        transactionId: `SDD-rating-agg-${orderId}`,
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
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);
    const arrivalOtp = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: arrivalOtp.body.otp })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/request-delivery-otp`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);
    const deliveryOtp = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-delivery`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: deliveryOtp.body.otp })
      .expect(201);

    return orderId;
  }

  it("the driver's aggregate moves consistently with the ratings submitted", async () => {
    const server = app.getHttpServer();
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));

    const orderId1 = await deliverOrder(fixtures.companyA);
    await request(server)
      .post(`/api/v1/orders/${orderId1}/rating`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ score: 5 })
      .expect(201);

    let driver = await userModel.findById(fixtures.companyA.driver.id).exec();
    expect(driver.ratingAverage).toBe(5);
    expect(driver.ratingCount).toBe(1);

    const orderId2 = await deliverOrder(fixtures.companyA);
    await request(server)
      .post(`/api/v1/orders/${orderId2}/rating`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ score: 3 })
      .expect(201);

    driver = await userModel.findById(fixtures.companyA.driver.id).exec();
    expect(driver.ratingAverage).toBe(4);
    expect(driver.ratingCount).toBe(2);
  });

  it("a rated driver's aggregate survives deactivation and reactivation unchanged (FR-042)", async () => {
    const server = app.getHttpServer();
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    const orderId = await deliverOrder(fixtures.companyA);
    await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ score: 4 })
      .expect(201);

    await request(server)
      .patch(`/api/v1/users/${fixtures.companyA.driver.id}/deactivate`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({})
      .expect(200);
    await request(server)
      .patch(`/api/v1/users/${fixtures.companyA.driver.id}/activate`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({})
      .expect(200);

    const driver = await userModel.findById(fixtures.companyA.driver.id).exec();
    expect(driver.ratingAverage).toBe(4);
    expect(driver.ratingCount).toBe(1);
  });
});
