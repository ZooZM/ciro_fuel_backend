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
 * spec 007 US6 (T087/T087a): `POST /orders/:id/rating` — the customer's own
 * action and its authorization boundaries. The aggregate side effect
 * (T088, `research R6`) lives in `delivery-rating-aggregate.e2e-spec.ts`
 * instead — kept separate so the two files' `verify-arrival` calls don't
 * share one `@Throttle({ limit: 5 })` bucket (per-IP, scoped to the app
 * instance each file's own `beforeAll` starts).
 */
describe('Delivery rating (spec 007 US6)', () => {
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
        transactionId: `SDD-rating-${orderId}`,
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

  it('a delivered order can be rated once', async () => {
    const server = app.getHttpServer();
    const orderId = await deliverOrder(fixtures.companyA);

    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ score: 5, review: 'Great service, on time.' })
      .expect(201);

    expect(res.body).toEqual({ score: 5, review: 'Great service, on time.' });
  });

  it('a second rating attempt on the same order returns ALREADY_RATED', async () => {
    const server = app.getHttpServer();
    const orderId = await deliverOrder(fixtures.companyA);
    const { client } = fixtures.companyA;

    await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ score: 4 })
      .expect(201);

    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ score: 2 })
      .expect(409);
    expect(res.body.error).toBe('ALREADY_RATED');
  });

  it('an undelivered order returns ORDER_NOT_DELIVERED', async () => {
    const server = app.getHttpServer();
    const { client, admin } = fixtures.companyA;
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 50 })
      .expect(201);
    const orderId = createRes.body._id;
    await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ score: 3 })
      .expect(409);
    expect(res.body.error).toBe('ORDER_NOT_DELIVERED');
  });

  it("another client's order returns 404", async () => {
    const server = app.getHttpServer();
    const orderId = await deliverOrder(fixtures.companyA);

    await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${fixtures.companyB.client.token}`)
      .send({ score: 5 })
      .expect(404);
  });

  it("driver B cannot read the rating or review attached to driver A's delivery (FR-041b/SC-012)", async () => {
    const server = app.getHttpServer();
    const orderId = await deliverOrder(fixtures.companyA);
    await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ score: 5, review: 'private feedback for driver A' })
      .expect(201);

    await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .expect(404);
  });
});
