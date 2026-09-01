import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, assignAndDepart } from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/**
 * spec 007 US2 (T038/T039): the four-step handover — arrive, verify-arrival,
 * request-delivery-otp, verify-delivery — already has a happy-path e2e
 * covering it end to end (`order-lifecycle.e2e-spec.ts`'s "drives an order
 * through the full lifecycle" test, including the statusHistory and
 * driver-released assertions T038 also asks for), so it is not duplicated
 * here. This file covers what that one does not: a wrong code leaves the
 * order exactly where it was (FR-013), and the verify endpoints'
 * `@Throttle({ limit: 5, ttl: 15 * 60_000 })` actually rejects a 6th attempt
 * inside the window (FR-017).
 */
describe('Driver handover — wrong codes and throttling (spec 007 US2)', () => {
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
  });

  /** Lands the order on IN_TRANSIT, assigned to companyA's sole driver. */
  async function assignOrder(): Promise<string> {
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
        transactionId: `SDD-handover-${orderId}`,
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

    return orderId;
  }

  // A single test, not two: `@Throttle`'s window is shared across requests
  // from this driver regardless of which order they target, so a second
  // `it()` making its own "one wrong code" call would silently borrow from
  // the same 5-request budget this one needs for its 6th-attempt assertion.
  it('a wrong code never advances the order (FR-013), and the 6th attempt in 15 minutes is throttled (FR-017)', async () => {
    const server = app.getHttpServer();
    const { driver, admin } = fixtures.companyA;
    const orderId = await assignOrder();

    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    // 5 wrong codes are each rejected on their own merits (401: incorrect
    // OTP, or — once the OTP's own 5-attempt lockout is reached — "too many
    // incorrect attempts"), never by the rate limiter itself — and the
    // order never moves off IN_TRANSIT for any of them.
    for (let i = 0; i < 5; i++) {
      await request(server)
        .post(`/api/v1/orders/${orderId}/verify-arrival`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ otp: '000000' })
        .expect(401);
    }

    const order = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(order.body.status).toBe(OrderStatus.IN_TRANSIT);

    // The 6th request in the window never reaches the handler at all.
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: '000000' })
      .expect(429);
  });
});
