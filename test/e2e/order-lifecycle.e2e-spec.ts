import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { UsersService } from '../../src/modules/users/users.service';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function signedWebhookBody(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('Order lifecycle (US1) — happy path', () => {
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

  it('drives an order through the full lifecycle and rejects out-of-order transitions', async () => {
    const server = app.getHttpServer();
    const { client, admin, driver } = fixtures.companyA;

    // 1. Client creates an order
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500 })
      .expect(201);

    expect(createRes.body.status).toBe(OrderStatus.PENDING_APPROVAL);
    expect(createRes.body.estimatedPrice).toBeCloseTo(2.5 * 500, 2);
    const orderId = createRes.body._id;

    // 2. Admin approves — auto-dispatch should immediately book the only driver
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approveRes.body.finalPrice).toBeCloseTo(2.5 * 500, 2);
    expect(approveRes.body.driverId).toBeTruthy();

    // 3. Simulate a confirmed Sadad payment webhook
    const { rawBody, signature } = signedWebhookBody(
      {
        transactionId: `SDD-${orderId}`,
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

    const afterPayment = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(afterPayment.body.status).toBe(OrderStatus.IN_TRANSIT);

    // 4. Driver arrives; client reads the arrival OTP; driver verifies it
    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    const arrivalOtpRes = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(arrivalOtpRes.body.purpose).toBe('ARRIVAL');
    expect(arrivalOtpRes.body.otp).toMatch(/^\d{6}$/);

    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: arrivalOtpRes.body.otp })
      .expect(201)
      .then((res) => expect(res.body.status).toBe(OrderStatus.UNLOADING));

    // 5. Driver requests delivery OTP; client reads it; driver verifies it
    await request(server)
      .post(`/api/v1/orders/${orderId}/request-delivery-otp`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    const deliveryOtpRes = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(deliveryOtpRes.body.purpose).toBe('DELIVERY');

    const deliveredRes = await request(server)
      .post(`/api/v1/orders/${orderId}/verify-delivery`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: deliveryOtpRes.body.otp })
      .expect(201);
    expect(deliveredRes.body.status).toBe(OrderStatus.DELIVERED);

    // 6. statusHistory records every actor + timestamp (FR-010)
    const finalOrder = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const transitions = finalOrder.body.statusHistory.map((h: { from: string; to: string }) => [
      h.from,
      h.to,
    ]);
    expect(transitions).toEqual([
      [OrderStatus.PENDING_APPROVAL, OrderStatus.APPROVED],
      [OrderStatus.APPROVED, OrderStatus.ASSIGNED_TO_DRIVER],
      [OrderStatus.ASSIGNED_TO_DRIVER, OrderStatus.PENDING_PAYMENT],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.IN_TRANSIT],
      [OrderStatus.IN_TRANSIT, OrderStatus.UNLOADING],
      [OrderStatus.UNLOADING, OrderStatus.DELIVERED],
    ]);

    // 7. Driver is released and dispatch-eligible again
    const driverDoc = await app.get(UsersService).findById(driver.id);
    expect(driverDoc.isAvailable).toBe(true);
    expect(driverDoc.activeOrderId).toBeUndefined();

    // 8. Invalid transition: verifying arrival again on a DELIVERED order is rejected
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: '000000' })
      .expect(400);
  });

  it('rejects order creation for an unpriced fuel type', async () => {
    const { client } = fixtures.companyA;
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'KEROSENE', quantityLiters: 100 })
      .expect(400);
  });
});
