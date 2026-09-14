import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { InvoiceState } from '../../src/common/enums/invoice-state.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { PaymentMethod } from '../../src/common/enums/payment-method.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { Invoice, InvoiceDocument } from '../../src/modules/invoices/schemas/invoice.schema';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/** Spec 004 US5 (T077): cancelling an order voids its invoice, and
 * settlement can never silently apply to a voided one afterward — a late
 * DIRECT webhook is recorded (out-of-sequence) but never settles it, and a
 * CREDIT cancellation restores the client's available credit. */
describe('Billing — cancellation & settlement edge cases (spec 004 US5)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let invoiceModel: Model<InvoiceDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    invoiceModel = app.get(getModelToken(Invoice.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('a DIRECT order cancelled while PENDING_PAYMENT voids its invoice; a late webhook never settles it', async () => {
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

    // Client declines the final price (FR-009) — a PENDING_PAYMENT cancel.
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/cancel`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ reason: 'too expensive' })
      .expect(200);

    const voidedInvoice = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(voidedInvoice.body.state).toBe(InvoiceState.VOID);

    // A late confirmation arrives after cancellation — recorded, but never applied.
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-cancelled-${createRes.body._id}`,
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

    const stillVoid = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillVoid.body.state).toBe(InvoiceState.VOID);
    expect(stillVoid.body.settledAt).toBeFalsy();

    const stillCancelled = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillCancelled.body.status).toBe(OrderStatus.CANCELLED);
  });

  it('cancelling a routed CREDIT order voids its invoice and restores available credit', async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    await request(server)
      .put(`/api/v1/users/${client.id}/credit-limit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ creditLimit: 500 })
      .expect(200);

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'CREDIT' }) // 250 SAR
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    // Routing now prices the haul and hands the order back to the station
    // owner, so approval lands on PENDING_PAYMENT rather than going straight
    // to the transporter; the settlement step below is what releases it.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    // A second credit order — refused while the first's 250 is still outstanding.
    const secondOrder = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 150, paymentMethod: 'CREDIT' }) // 375 SAR > (500-250)=250
      .expect(201);
    await request(server)
      .patch(`/api/v1/orders/${secondOrder.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(400);

    // Cancelling the first restores its 250 — the second now fits.
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/cancel`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'client changed mind' })
      .expect(200);

    const firstInvoice = await request(server)
      .get(`/api/v1/invoices/${approveRes.body.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(firstInvoice.body.state).toBe(InvoiceState.VOID);

    // The retry is PATCH :id/route, not a second :id/approve.
    //
    // The credit check lives in invoice issuance, and the invoice is issued at
    // ROUTING now — the first moment the total includes the haul. So the
    // earlier refusal did not undo the approval, only the routing it was part
    // of: that order is sitting at APPROVED, un-routed and uninvoiced, and
    // approving it again is the one transition the state machine will not make
    // twice. Routing it is what retries the part that actually failed.
    const stillApproved = await request(server)
      .get(`/api/v1/orders/${secondOrder.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillApproved.body.status).toBe(OrderStatus.APPROVED);
    expect(stillApproved.body.transportCompanyId).toBeFalsy();
    expect(stillApproved.body.invoiceId).toBeFalsy();

    const retryRoute = await request(server)
      .patch(`/api/v1/orders/${secondOrder.body._id}/route`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ transportCompanyId: fixtures.companyA.transportCompanyId })
      .expect(200);
    expect(retryRoute.body.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('settling an already-voided DEFERRED invoice is a no-op, never resurrected to SETTLED', async () => {
    const { client, admin, transportAdmin } = fixtures.companyA;
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
    // Routing now prices the haul and hands the order back to the station
    // owner, so approval lands on PENDING_PAYMENT rather than going straight
    // to the transporter; the settlement step below is what releases it.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Cancellable pre-assignment, same as any other ROUTED_TO_TRANSPORT order.
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/cancel`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'no longer needed' })
      .expect(200);

    const settleAttempt = await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ paymentReference: 'should-not-apply' })
      .expect(201);
    // No-op (idempotent guard: only an ISSUED invoice can be settled) — never
    // silently resurrected to SETTLED by a stale/late settlement attempt.
    expect(settleAttempt.body.state).toBe(InvoiceState.VOID);
    expect(settleAttempt.body.paymentReference).toBeFalsy();
  });

  it('settling an already-settled invoice is a no-op — no double payment (spec 005 T072)', async () => {
    const { client, admin, transportAdmin } = fixtures.companyA;
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
    // Routing now prices the haul and hands the order back to the station
    // owner, so approval lands on PENDING_PAYMENT rather than going straight
    // to the transporter; the settlement step below is what releases it.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    const firstSettle = await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ paymentReference: 'first-payment' })
      .expect(201);
    expect(firstSettle.body.state).toBe(InvoiceState.SETTLED);
    expect(firstSettle.body.paymentReference).toBe('first-payment');
    const firstSettledAt = firstSettle.body.settledAt;

    // A second settlement attempt — whether a retried client request or a
    // stray duplicate — must not re-apply: the reference and timestamp from
    // the first (and only) real settlement are what a payer's records still
    // have to agree with afterward.
    const secondSettle = await request(server)
      .post(`/api/v1/invoices/${approveRes.body.invoiceId}/settle`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ paymentReference: 'second-payment-should-not-apply' })
      .expect(201);
    expect(secondSettle.body.state).toBe(InvoiceState.SETTLED);
    expect(secondSettle.body.paymentReference).toBe('first-payment');
    expect(secondSettle.body.settledAt).toBe(firstSettledAt);
  });

  it(
    'with 30+ settled invoices newer than one outstanding invoice, the outstanding one ' +
      'still appears on the first page (spec 005 T072a/FR-048f)',
    async () => {
      const { client, admin } = fixtures.companyB;
      const server = app.getHttpServer();

      const outstanding = await invoiceModel.create({
        orderId: new Types.ObjectId(),
        fuelCompanyId: new Types.ObjectId(fixtures.companyB.companyId),
        clientId: new Types.ObjectId(client.id),
        amount: 500,
        method: PaymentMethod.CREDIT,
        state: InvoiceState.ISSUED,
        payerRole: UserRole.CLIENT,
      });
      // Oldest of the lot — newest-first alone would bury it past page one.
      await invoiceModel.updateOne(
        { _id: outstanding._id },
        { $set: { createdAt: new Date(2020, 0, 1) } },
      );

      for (let i = 0; i < 30; i++) {
        const settled = await invoiceModel.create({
          orderId: new Types.ObjectId(),
          fuelCompanyId: new Types.ObjectId(fixtures.companyB.companyId),
          clientId: new Types.ObjectId(client.id),
          amount: 100,
          method: PaymentMethod.DIRECT,
          state: InvoiceState.SETTLED,
          payerRole: UserRole.CLIENT,
        });
        await invoiceModel.updateOne(
          { _id: settled._id },
          { $set: { createdAt: new Date(2026, 0, 1, 10, i, 0, 0) } },
        );
      }

      const firstPage = await request(server)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(
        firstPage.body.items.some((inv: { _id: string }) => inv._id === String(outstanding._id)),
      ).toBe(true);
      // Outstanding-before-settled: it isn't just present, it leads the page.
      expect(firstPage.body.items[0]._id).toBe(String(outstanding._id));
    },
  );
});
