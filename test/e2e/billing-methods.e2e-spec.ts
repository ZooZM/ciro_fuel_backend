import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { PaymentMethod } from '../../src/common/enums/payment-method.enum';
import { InvoiceState } from '../../src/common/enums/invoice-state.enum';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/** Spec 004 US5 — all three payment methods end to end (T074). */
describe('Billing — three payment methods (spec 004 US5)', () => {
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

  it('DIRECT: routes and prices FIRST, then gates the driver behind settlement, and the webhook-settled invoice is exposed to the client', async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 }) // paymentMethod omitted -> DIRECT
      .expect(201);

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    // ROUTED ALREADY — the inversion this flow turns on. The delivery leg is
    // priced by the company that performs it, so the order has to reach a
    // transporter before there is any total to charge for. Payment now gates
    // the DRIVER, not the routing.
    expect(approveRes.body.transportCompanyId).toBe(fixtures.companyA.transportCompanyId);
    expect(approveRes.body.finalPrice).toBeGreaterThan(2.5 * 100);

    const issuedInvoice = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(issuedInvoice.body.method).toBe(PaymentMethod.DIRECT);
    expect(issuedInvoice.body.state).toBe(InvoiceState.ISSUED);
    expect(issuedInvoice.body.amount).toBeCloseTo(approveRes.body.finalPrice, 2);

    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-direct-${createRes.body._id}`,
        orderId: createRes.body._id,
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

    const settledInvoice = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(settledInvoice.body.state).toBe(InvoiceState.SETTLED);
    expect(settledInvoice.body.settledAt).toBeTruthy();

    const routedOrder = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(routedOrder.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);

    // DIRECT invoices are never settleable through the manual endpoint —
    // only the signed webhook may settle one.
    await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(403);
  });

  it('DEFERRED: routes immediately, is client-visible read-only, and settleable only by the transporter it names (FR-022)', async () => {
    const { client, admin, transportAdmin, transportCompanyId } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    // No payment gate — routes on the same call as any other DEFERRED order.
    // Routed AND priced, then handed back to the station owner: every payment
    // method now goes through that review, because until a transporter is
    // chosen nobody can say what the delivery costs. DEFERRED and CREDIT have
    // no gateway payment to make, so they confirm with POST :id/accept.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approveRes.body.transportCompanyId).toBe(transportCompanyId);

    const invoice = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .expect(200);
    expect(invoice.body.method).toBe(PaymentMethod.DEFERRED);
    expect(invoice.body.transportCompanyId).toBe(transportCompanyId);
    expect(invoice.body.state).toBe(InvoiceState.ISSUED);

    // Read-only for the client (FR-022) — visible, but cannot settle it.
    await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({})
      .expect(403);

    // The Fuel Company (who issued it) isn't the payer either — only the transporter is.
    await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(403);

    const settled = await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ paymentReference: 'offline-transfer-1' })
      .expect(201);
    expect(settled.body.state).toBe(InvoiceState.SETTLED);
    expect(settled.body.paymentReference).toBe('offline-transfer-1');

    // Order status is unaffected by settlement (FR-022's table) — and that is
    // now visible more sharply than before: the TRANSPORTER settling its
    // DEFERRED invoice is a different act from the STATION OWNER accepting the
    // total, and only the latter moves the order. It is still waiting on its
    // customer.
    const orderAfterSettle = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(orderAfterSettle.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    // The station owner accepts, and only then does it go back to the
    // transporter for a driver.
    const accepted = await request(server)
      .post(`/api/v1/orders/${createRes.body._id}/accept`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(201);
    expect(accepted.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
  });

  it('CREDIT: routes immediately, consumes credit at approval, and is settleable only by the Fuel Company', async () => {
    const { client, admin, transportAdmin } = fixtures.companyA;
    const server = app.getHttpServer();

    await request(server)
      .put(`/api/v1/users/${client.id}/credit-limit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ creditLimit: 1000 })
      .expect(200);

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'CREDIT' })
      .expect(201);

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    // Routed and priced, then awaiting the station owner's acceptance — a
    // CREDIT order has no gateway payment to make, so its confirmation is
    // `POST :id/accept` rather than a webhook.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    const invoice = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(invoice.body.method).toBe(PaymentMethod.CREDIT);
    expect(invoice.body.state).toBe(InvoiceState.ISSUED);
    expect(invoice.body.amount).toBeCloseTo(approveRes.body.finalPrice, 2);

    // The transporter never even sees a CREDIT invoice (it never names a
    // transporter — the multi-party scope filters it out entirely, 404
    // rather than 403, same as any other cross-boundary id — FR-002).
    await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({})
      .expect(404);
    // The client sees it (it's their own bill) but may not settle it.
    await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({})
      .expect(403);

    const settled = await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ paymentReference: 'account-topup-1' })
      .expect(201);
    expect(settled.body.state).toBe(InvoiceState.SETTLED);
  });

  /**
   * FR-020b: a deadline is recorded only where one is enforced.
   *
   * Only a DIRECT order can lapse — it is the only method with a payment window
   * and a timeout job behind it. DEFERRED and CREDIT are settled against an
   * invoice, so they wait for their station owner indefinitely; stamping a
   * `paymentDeadline` on them would put a countdown in front of a customer that
   * nothing would ever act on, which is worse than showing no clock at all.
   */
  it('records a payment deadline for DIRECT only — DEFERRED and CREDIT wait with none (FR-020b)', async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    const place = async (paymentMethod?: string) => {
      const created = await request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 10, ...(paymentMethod ? { paymentMethod } : {}) })
        .expect(201);
      const approved = await request(server)
        .patch(`/api/v1/orders/${created.body._id}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({})
        .expect(200);
      expect(approved.body.status).toBe(OrderStatus.PENDING_PAYMENT);
      return approved.body;
    };

    // DIRECT: a real window, so a real deadline.
    const direct = await place();
    expect(direct.paymentMethod).toBe(PaymentMethod.DIRECT);
    expect(direct.paymentDeadline).toBeTruthy();

    // DEFERRED: awaiting acceptance, with nothing counting down.
    const deferred = await place('DEFERRED');
    expect(deferred.paymentMethod).toBe(PaymentMethod.DEFERRED);
    expect(deferred.paymentDeadline).toBeUndefined();
  });
});
