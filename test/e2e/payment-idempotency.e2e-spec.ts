import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('Payment webhook idempotency & timeout (US1)', () => {
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

  // Each test dispatches (consumes) companyA's single fixture driver; reset it
  // to available before every test so dispatch always succeeds independently
  // of prior tests' outcomes.
  beforeEach(async () => {
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
  });

  /** Approves a DIRECT order (the default), reaching PENDING_PAYMENT right
   * away (spec 004 FR-020a) — no driver exists yet at this point, since
   * routing itself only resumes once this payment settles. This is the
   * precondition every payment-webhook test in this file assumes. */
  async function createApprovedOrder(): Promise<{ orderId: string; finalPrice: number }> {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 200 })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    return { orderId: createRes.body._id, finalPrice: approveRes.body.finalPrice };
  }

  it('rejects a webhook with a bad signature', async () => {
    const { orderId, finalPrice } = await createApprovedOrder();
    const { rawBody } = sign(
      {
        transactionId: `SDD-bad-${orderId}`,
        orderId,
        amount: finalPrice,
        currency: 'SAR',
        status: 'PAID',
        paidAt: new Date().toISOString(),
      },
      'sadad-test-secret',
    );

    await request(app.getHttpServer())
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 'deadbeef'.repeat(8))
      .send(rawBody)
      .expect(401);
  });

  it('processes a duplicate webhook exactly once (second call is a no-op)', async () => {
    const { orderId, finalPrice } = await createApprovedOrder();
    const payload = {
      transactionId: `SDD-dup-${orderId}`,
      orderId,
      amount: finalPrice,
      currency: 'SAR',
      status: 'PAID',
      paidAt: new Date().toISOString(),
    };
    const { rawBody, signature } = sign(payload, 'sadad-test-secret');
    const server = app.getHttpServer();

    const first = await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);
    expect(first.body).toEqual({ received: true, accepted: true });

    const second = await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);
    expect(second.body).toEqual({ received: true, duplicate: true });

    const order = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    // Settlement unblocks routing (FR-020a) — auto-routes to the fixture's
    // sole transporter, same as a DEFERRED/CREDIT order's approval always did.
    expect(order.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
  });

  it('flags an amount mismatch without changing order state', async () => {
    const { orderId, finalPrice } = await createApprovedOrder();
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-mismatch-${orderId}`,
        orderId,
        amount: finalPrice + 500,
        currency: 'SAR',
        status: 'PAID',
        paidAt: new Date().toISOString(),
      },
      'sadad-test-secret',
    );

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);
    expect(res.body).toEqual({ received: true, accepted: false });

    const order = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    expect(order.body.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('reverts to APPROVED when the payment deadline expires (no driver ever assigned)', async () => {
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();

    // DIRECT (the default): approval alone reaches PENDING_PAYMENT — routing,
    // and therefore driver assignment, hasn't happened yet (spec 004 FR-020a).
    const { orderId } = await createApprovedOrder();

    // Manually fire the BullMQ processor logic by waiting for the deadline is
    // impractical in a test (30 min default); instead exercise the processor
    // directly against this order to prove the reversion + notification wiring.
    const { PaymentTimeoutProcessor } =
      await import('../../src/modules/payments/queues/payment-timeout.processor');
    const processor = app.get(PaymentTimeoutProcessor);
    await processor.process({ data: { orderId } } as never);

    const reverted = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(reverted.body.status).toBe(OrderStatus.APPROVED);
    expect(reverted.body.paymentTimeoutCount).toBe(1);
    expect(reverted.body.driverId).toBeFalsy();

    // A late webhook after the timeout is treated as out-of-sequence, not applied.
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-late-${orderId}`,
        orderId,
        amount: reverted.body.finalPrice,
        currency: 'SAR',
        status: 'PAID',
        paidAt: new Date().toISOString(),
      },
      'sadad-test-secret',
    );
    const lateRes = await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);
    expect(lateRes.body).toEqual({ received: true, accepted: false });

    const stillApproved = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillApproved.body.status).toBe(OrderStatus.APPROVED);
  });
});
