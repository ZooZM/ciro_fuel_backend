import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { InvoiceState } from '../../src/common/enums/invoice-state.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/**
 * Spec 004 US5/FR-027 (T078): invoice settlement and the order's own
 * PENDING_PAYMENT -> APPROVED transition happen in ONE transaction
 * (`payments.service.ts`). This proves that guarantee for real, not just
 * its happy path — by forcing the order-transition half of that same
 * transaction to fail (a payment-timeout reversion committed moments
 * earlier, so the order is no longer PENDING_PAYMENT by the time the
 * webhook's transaction runs) and confirming the invoice write that ran
 * FIRST in program order never actually persisted: it comes back ISSUED,
 * not SETTLED, exactly as if the settlement attempt had never happened.
 */
describe('Billing — settlement/order-transition atomicity (spec 004 US5/FR-027)', () => {
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

  it('a webhook racing a just-committed payment timeout leaves the invoice unsettled — the mid-transaction write never persists', async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 }) // DIRECT
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    const issuedInvoice = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(issuedInvoice.body.state).toBe(InvoiceState.ISSUED);

    // The payment window expires and fully commits FIRST (deterministic,
    // not a real race — same technique payment-idempotency.e2e-spec.ts
    // uses to exercise the processor without waiting 30 real minutes):
    // the order moves PENDING_PAYMENT -> APPROVED before the webhook below
    // ever starts its own transaction.
    const { PaymentTimeoutProcessor } =
      await import('../../src/modules/payments/queues/payment-timeout.processor');
    const processor = app.get(PaymentTimeoutProcessor);
    await processor.process({ data: { orderId: createRes.body._id } } as never);

    const reverted = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(reverted.body.status).toBe(OrderStatus.APPROVED);

    // A confirmation for the ORIGINAL payment window arrives after the
    // timeout already committed. Inside its transaction, settling the
    // invoice runs first (it would succeed in isolation — the invoice is
    // still ISSUED) but the order-transition half fails (current status is
    // APPROVED, not PENDING_PAYMENT) — aborting the WHOLE transaction.
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-race-${createRes.body._id}`,
        orderId: createRes.body._id,
        amount: approveRes.body.finalPrice,
        currency: 'SAR',
        status: 'PAID',
        paidAt: new Date().toISOString(),
      },
      'sadad-test-secret',
    );
    const webhookRes = await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);
    expect(webhookRes.body).toEqual({ received: true, accepted: false });

    // The invoice write that ran first inside that aborted transaction never
    // persisted — it comes back exactly as it was before the webhook, not
    // "SETTLED and then somehow un-settled": genuinely still ISSUED.
    const stillIssued = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillIssued.body.state).toBe(InvoiceState.ISSUED);
    expect(stillIssued.body.settledAt).toBeFalsy();
    expect(stillIssued.body.paymentReference).toBeFalsy();

    // The order itself is likewise untouched by the failed webhook — still
    // exactly where the timeout left it, not a hybrid of both attempts.
    const stillApproved = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillApproved.body.status).toBe(OrderStatus.APPROVED);
    expect(stillApproved.body.paymentConfirmationId).toBeFalsy();
  });
});
