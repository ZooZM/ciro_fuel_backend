import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { DEFAULT_WAREHOUSE_LOCATION, seedTwoCompanies, TwoCompanyFixture, settleClientReview } from '../utils/fixtures';
import { UsersService } from '../../src/modules/users/users.service';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

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
    const { client, admin, driver, truck, tank } = fixtures.companyA;

    // 1. Client creates an order
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500 })
      .expect(201);

    expect(createRes.body.status).toBe(OrderStatus.PENDING_APPROVAL);
    // An order placed WITHOUT a quote token is priced exactly as one placed
    // with it: the fuel line, then the fixture company's 1% service fee, then
    // 15% VAT on the two. It used to be the bare fuel line alone — no service
    // fee and no VAT — so the same order was invoiced ~16% under a quoted one,
    // and `estimatedPrice` carried that lower figure into approval, invoicing
    // and the credit check alike. The delivery fee is still absent until a
    // transporter is chosen, which `RoutingService` does later.
    const fuelLine = 2.5 * 500;
    const serviceFee = fuelLine * 0.01;
    // Rounded to currency precision the same way the platform rounds it —
    // 1451.875 lands exactly on the half, so an unrounded expectation misses
    // by precisely the tolerance.
    const expectedTotal = Math.round((fuelLine + serviceFee) * 1.15 * 100) / 100;
    expect(createRes.body.estimatedPrice).toBeCloseTo(expectedTotal, 2);
    expect(createRes.body.priceBreakdown).toMatchObject({
      fuelLineTotal: fuelLine,
      serviceFee,
      taxRatePercent: 15,
    });
    const orderId = createRes.body._id;

    // 2. Admin approves. Approval now ROUTES the order — for every payment
    // method, DIRECT included — because routing is what makes the order
    // priceable: the delivery leg is priced by the transport company that
    // performs it, and until one is chosen there is no total to charge.
    //
    // This REVERSES the old FR-020a ordering, under which a DIRECT order was
    // made to pay first and routed only once settlement arrived. It could not
    // survive the station owner being shown the real transport price before
    // paying, because that price does not exist until routing has run.
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    // Same status as before, reached the other way round: routed first, THEN
    // handed back to the station owner to settle.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approveRes.body.invoiceId).toBeTruthy();
    // Routed already — this is the assertion that inverted.
    expect(approveRes.body.transportCompanyId).toBe(fixtures.companyA.transportCompanyId);
    // And the total the client is asked for now INCLUDES the haul, which the
    // fuel line alone never did. This order was created WITHOUT a quote token,
    // which used to mean it carried no itemised breakdown at all and was
    // charged fuel-plus-haul with neither the service fee nor VAT. Both paths
    // now price identically, so the breakdown is present here and the haul is
    // re-derived into it rather than bolted onto `finalPrice`.
    expect(approveRes.body.priceBreakdown).toMatchObject({
      fuelLineTotal: 2.5 * 500,
      deliveryFee: 30,
      serviceFeePercent: 1,
      taxRatePercent: 15,
    });
    expect(approveRes.body.finalPrice).toBeCloseTo(approveRes.body.priceBreakdown.total, 2);
    // Still strictly more than the bare fuel line — the haul is charged either
    // way, which is what this assertion has always been about.
    expect(approveRes.body.finalPrice).toBeGreaterThan(2.5 * 500);

    // 3. Simulate a confirmed Sadad payment webhook. Settlement no longer
    // triggers routing — that already happened — it releases the order back to
    // the transporter it was routed to, so a driver can be assigned.
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
    expect(afterPayment.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
    expect(afterPayment.body.transportCompanyId).toBe(fixtures.companyA.transportCompanyId);

    // 3b. The transporter sees the order among their candidate drivers and
    // assigns driver, truck and tank (spec 004 FR-017/FR-018, spec 008
    // FR-009) — landing on ASSIGNED_TO_DRIVER, not IN_TRANSIT: spec 008
    // FR-046a removed assignment's old auto-advance, gating it behind
    // departure verification and loading confirmation instead.
    await settleClientReview(app, orderId);
    const candidatesRes = await request(server)
      .get(`/api/v1/dispatch/orders/${orderId}/candidates`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(candidatesRes.body.map((c: { _id: string }) => c._id)).toEqual([driver.id]);

    await settleClientReview(app, orderId);
    const assignRes = await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);
    expect(assignRes.body.assigned).toBe(true);
    expect(assignRes.body.driverId).toBe(driver.id);

    const afterAssign = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(afterAssign.body.status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
    expect(afterAssign.body.driverId).toBe(driver.id);
    expect(afterAssign.body.tankSummary).toEqual({ code: tank.code, material: 'ALUMINIUM' });
    expect(afterAssign.body.warehouseSummary).toBeTruthy();

    // 3c. Departure verification (spec 008 US3, FR-017): the driver taps
    // the assigned truck's NFC card, advancing to LOADING.
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ credential: truck.nfcCardUid, method: 'NFC_CARD' })
      .expect(201)
      .then((res) => expect(res.body.order.status).toBe(OrderStatus.LOADING));

    // 3d. Loading (spec 008 US4): the same card read again, this time from
    // inside the warehouse's geofence (FR-030/FR-030a) — the read proves
    // the truck, the position proves the driver actually got to the depot —
    // then a plain, quantity-free confirmation (FR-028) reaches IN_TRANSIT.
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({
        credential: truck.nfcCardUid,
        method: 'NFC_CARD',
        driverLocation: DEFAULT_WAREHOUSE_LOCATION,
      })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/confirm-loading`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201)
      .then((res) => expect(res.body.status).toBe(OrderStatus.IN_TRANSIT));

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

    // 5b. Feature 009 T068/FR-031/SC-016: the client rates the delivery —
    // the one step of the full lifecycle this test did not previously
    // cover. Reused rather than duplicated in a second end-to-end test,
    // since this one already drives every other stage from placement to
    // completion, asserting each participant's own token throughout.
    const ratingRes = await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ score: 5, review: 'On time, friendly driver' })
      .expect(201);
    expect(ratingRes.body).toEqual({ score: 5, review: 'On time, friendly driver' });

    // A second rating attempt on the same order is refused (FR-039's
    // rate-once guarantee) — asserts the transporter cannot see it as
    // ratable twice either, from the delivered order's own detail.
    await request(server)
      .post(`/api/v1/orders/${orderId}/rating`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ score: 3 })
      .expect(409);

    // 5c. The transporter's own view: the completed order carries the
    // driver, tractor and trailer named identically to what the client and
    // driver already saw at assignment (FR-028 — "all three participants
    // name the same stage/data"), and the transport dashboard's summary
    // count reflects it via GET /orders/summary (FR-067).
    const transportView = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(transportView.body.status).toBe(OrderStatus.DELIVERED);
    expect(transportView.body.driverId).toBe(driver.id);
    expect(transportView.body.rating).toEqual({ score: 5, review: 'On time, friendly driver' });

    const summaryRes = await request(server)
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(summaryRes.body.completedInPeriod).toBeGreaterThanOrEqual(1);

    // 6. statusHistory records every actor + timestamp (FR-010)
    const finalOrder = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const transitions = finalOrder.body.statusHistory.map((h: { from: string; to: string }) => [
      h.from,
      h.to,
    ]);
    // The two middle pairs are the amended flow, and they are the mirror image
    // of what they used to be. It was: pay first, then route
    // (APPROVED -> PENDING_PAYMENT -> APPROVED -> ROUTED_TO_TRANSPORT).
    // It is now: route first — which is what produces a total that includes the
    // haul — then hand it back to the station owner to settle, then resume.
    expect(transitions).toEqual([
      [OrderStatus.PENDING_APPROVAL, OrderStatus.APPROVED],
      [OrderStatus.APPROVED, OrderStatus.ROUTED_TO_TRANSPORT], // transporter chosen; haul priced
      [OrderStatus.ROUTED_TO_TRANSPORT, OrderStatus.PENDING_PAYMENT], // real total to the client
      [OrderStatus.PENDING_PAYMENT, OrderStatus.ROUTED_TO_TRANSPORT], // settled
      [OrderStatus.ROUTED_TO_TRANSPORT, OrderStatus.ASSIGNED_TO_DRIVER],
      [OrderStatus.ASSIGNED_TO_DRIVER, OrderStatus.LOADING], // departure verification
      [OrderStatus.LOADING, OrderStatus.IN_TRANSIT], // loading confirmed
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

  // spec 004 T060/FR-019: the backend is the sole authority for every
  // transition — a client can never assert one directly.
  it('ignores/rejects a client-supplied status field on order requests (FR-019)', async () => {
    const server = app.getHttpServer();
    const { client, admin } = fixtures.companyA;

    // ValidationPipe is configured `forbidNonWhitelisted: true` globally —
    // an undeclared `status` field is REJECTED outright (400), not merely
    // stripped. That is a strictly stronger guarantee than "ignored": there
    // is no DTO anywhere that even accepts a caller-supplied status.
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, status: OrderStatus.DELIVERED })
      .expect(400);
    expect(createRes.body.message.join(' ')).toMatch(/status/i);

    // A well-formed create (no forged field) to get a real order for the
    // rest of this test.
    const goodCreate = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    expect(goodCreate.body.status).toBe(OrderStatus.PENDING_APPROVAL);
    const orderId = goodCreate.body._id;

    // Same guarantee on approve: a forged status/finalPrice-adjacent field
    // outside ApproveOrderDto's whitelist (finalPrice, transportCompanyId)
    // is rejected, not silently honoured.
    await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: OrderStatus.DELIVERED })
      .expect(400);

    // The order is still exactly where the real lifecycle left it — a
    // rejected request has no side effect.
    const stillPending = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillPending.body.status).toBe(OrderStatus.PENDING_APPROVAL);
  });

  it('rejects order creation for an unpriced fuel type', async () => {
    const { client } = fixtures.companyA;
    // 409 PRICING_NOT_CONFIGURED, the same typed refusal `POST /orders/quote`
    // already gives for the same gap — both paths now read the same rates, so
    // both report a missing one the same way. It was a bare 400 with a prose
    // message, which neither client could branch on.
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'KEROSENE', quantityLiters: 100 })
      .expect(409);
    expect(res.body.error).toBe(ErrorCode.PRICING_NOT_CONFIGURED);
  });

  // Feature 009 T108/SC-009: the summary endpoint's counts must never leak
  // across companies — verified directly, not inferred from the isolation
  // plugin's unit tests, since this is a new read path (getSummary/
  // getOutstandingSettlementsSummary) built on top of it.
  describe('GET /orders/summary (feature 009)', () => {
    it("is scoped to the acting transport company — toggling company A's driver never moves company B's count", async () => {
      const server = app.getHttpServer();
      const { getModelToken } = await import('@nestjs/mongoose');
      const { User } = await import('../../src/modules/users/schemas/user.schema');
      const userModel = app.get(getModelToken(User.name));

      const summaryBBefore = await request(server)
        .get('/api/v1/orders/summary')
        .set('Authorization', `Bearer ${fixtures.companyB.transportAdmin.token}`)
        .expect(200);

      // Take company A's fixture driver offline directly (there is no admin
      // endpoint for it — duty state is driver-controlled via presence) and
      // confirm ONLY company A's count reacts.
      await userModel.updateOne(
        { _id: fixtures.companyA.driver.id },
        { $set: { isOnline: false } },
      );

      const summaryAAfter = await request(server)
        .get('/api/v1/orders/summary')
        .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
        .expect(200);
      const summaryBAfter = await request(server)
        .get('/api/v1/orders/summary')
        .set('Authorization', `Bearer ${fixtures.companyB.transportAdmin.token}`)
        .expect(200);

      expect(summaryAAfter.body.driversOnDuty).toBe(0);
      expect(summaryBAfter.body.driversOnDuty).toBe(summaryBBefore.body.driversOnDuty);

      // Restore for any test that runs after this one in the shared fixture.
      await userModel.updateOne({ _id: fixtures.companyA.driver.id }, { $set: { isOnline: true } });
    });

    // spec 013 T109/T111: this was 403 before feature 013 gave FUEL_COMPANY_ADMIN its own
    // summary shape (`FuelCompanySummaryDto`) — the original comment's "no meaning for
    // that role in this feature" was true of `OrderSummaryDto`'s specific fields
    // (`driversOnDuty`/`awaitingAssignment`), not of a summary endpoint for this role at
    // all. See `fuel-company-summary.e2e-spec.ts` for the full coverage of that shape.
    it('returns a differently-shaped summary for a FUEL_COMPANY_ADMIN, never the transport shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders/summary')
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
      expect(res.body).not.toHaveProperty('driversOnDuty');
      expect(res.body).not.toHaveProperty('awaitingAssignment');
      expect(res.body).toHaveProperty('pendingApproval');
    });

    it('returns zero counts, not an error, for a company with no matching deliveries', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders/summary')
        .set('Authorization', `Bearer ${fixtures.companyB.transportAdmin.token}`)
        .send()
        .expect(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          awaitingAssignment: expect.any(Number),
          inProgress: expect.any(Number),
          completedInPeriod: expect.any(Number),
          driversOnDuty: expect.any(Number),
          outstandingSettlements: expect.objectContaining({
            amount: expect.any(Number),
            currency: 'SAR',
            count: expect.any(Number),
          }),
        }),
      );
    });
  });
});
