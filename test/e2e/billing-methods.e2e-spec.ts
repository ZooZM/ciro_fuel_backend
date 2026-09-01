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

  it('DIRECT: gates routing behind settlement, then the webhook-settled invoice is exposed to the client', async () => {
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
    expect(approveRes.body.transportCompanyId).toBeFalsy();

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
    expect(approveRes.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
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

    // Order status is unaffected by settlement (FR-022's table) — it was
    // already routed and continues its normal delivery lifecycle from here.
    const orderAfterSettle = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(orderAfterSettle.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
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
    expect(approveRes.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);

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
});
