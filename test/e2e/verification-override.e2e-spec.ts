import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { resetFixtureDispatchState, seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(180_000);

/**
 * spec 008 (T126-T127): the operator's escape hatch, and the promise that
 * keeps it honest.
 *
 * An override exists because a driver at a depot with no signal cannot
 * verify and must not be stranded. What makes it safe is research R10's
 * decision that it writes **no** `VehicleVerification` record — so
 * "overridden" is structurally distinct from "verified" rather than
 * distinct by naming convention. T127 is the test most likely to regress:
 * every future change that makes an overridden delivery look "complete"
 * to a customer passes through the same field.
 */
describe('Verification override (spec 008 FR-047)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();
    fixtures = await seedTwoCompanies(app);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await resetFixtureDispatchState(app, fixtures.companyA);
    await app.get(ResilientThrottlerStorage).reset();
  });

  function sign(payload: Record<string, unknown>, secret: string) {
    const rawBody = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  async function assignedOrder(): Promise<string> {
    const { client, admin, transportAdmin, driver, truck, tank } = fixtures.companyA;
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 1000 })
      .expect(201);
    const orderId = createRes.body._id as string;

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-override-${orderId}`,
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

    await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);

    return orderId;
  }

  const override = (orderId: string, reason: string, token?: string) =>
    request(server)
      .post(`/api/v1/orders/${orderId}/override-verification`)
      .set('Authorization', `Bearer ${token ?? fixtures.companyA.transportAdmin.token}`)
      .send({ reason });

  const readAsOperator = async (orderId: string) =>
    (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
        .expect(200)
    ).body;

  // --- T126 -----------------------------------------------------------

  it('advances the outstanding stage and records reason, author and time (FR-047)', async () => {
    const orderId = await assignedOrder();
    const reason = 'Driver at Jeddah South depot, no signal; confirmed by phone';

    await override(orderId, reason).expect(201);

    const order = await readAsOperator(orderId);
    expect(order.status).toBe(OrderStatus.LOADING);

    const entry = order.statusHistory.find(
      (h: { from: string; to: string }) =>
        h.from === OrderStatus.ASSIGNED_TO_DRIVER && h.to === OrderStatus.LOADING,
    );
    // Reuses the existing manualOverride/overrideReason machinery (R10)
    // rather than inventing a parallel audit trail.
    expect(entry.manualOverride).toBe(true);
    expect(entry.overrideReason).toBe(reason);
    expect(entry.actorId).toBe(fixtures.companyA.transportAdmin.id);
    expect(entry.actorRole).toBe(UserRole.TRANSPORT_COMPANY_ADMIN);
    expect(entry.at).toBeTruthy();
  });

  it('writes no verification record — that omission IS the mechanism (FR-047c)', async () => {
    const orderId = await assignedOrder();
    await override(orderId, 'No signal at the yard').expect(201);

    const order = await readAsOperator(orderId);
    // An override that quietly wrote a `matched: true` attempt would be
    // indistinguishable from a real verification forever afterwards. The
    // empty array is the whole guarantee.
    expect(order.verifications).toHaveLength(0);
  });

  it('a reason is mandatory — an unexplained override is not an attestation (FR-047)', async () => {
    const orderId = await assignedOrder();
    await request(server)
      .post(`/api/v1/orders/${orderId}/override-verification`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({})
      .expect(400);
    expect((await readAsOperator(orderId)).status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
  });

  it("another transportation company's administrator cannot override (FR-047e)", async () => {
    const orderId = await assignedOrder();

    // 404, not 403: the multi-party plugin scopes the lookup, so a
    // neighbour's order is indistinguishable from one that never existed.
    await override(orderId, 'Not my delivery', fixtures.companyB.transportAdmin.token).expect(404);
    expect((await readAsOperator(orderId)).status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
  });

  it('neither the driver nor the fuel company can override (FR-047)', async () => {
    const orderId = await assignedOrder();
    // The point of an override is that someone OTHER than the driver
    // attests. A driver who could override their own verification would
    // have no verification at all.
    await override(orderId, 'Let me through', fixtures.companyA.driver.token).expect(403);
    await override(orderId, 'Let them through', fixtures.companyA.admin.token).expect(403);
    await override(orderId, 'Let them through', fixtures.companyA.client.token).expect(403);
    expect((await readAsOperator(orderId)).status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
  });

  it('refuses to override a stage that has not been reached (FR-047g)', async () => {
    const orderId = await assignedOrder();
    await override(orderId, 'Departure, legitimately').expect(201);
    await override(orderId, 'Loading, legitimately').expect(201);

    const order = await readAsOperator(orderId);
    expect(order.status).toBe(OrderStatus.IN_TRANSIT);

    // Nothing is outstanding now — an override cannot run ahead of the
    // delivery any more than a real verification can (FR-025).
    await override(orderId, 'And one more for luck').expect(409);
    expect((await readAsOperator(orderId)).status).toBe(OrderStatus.IN_TRANSIT);
  });

  it('overrides exactly one stage per call — it cannot skip (FR-047g)', async () => {
    const orderId = await assignedOrder();
    await override(orderId, 'Departure only').expect(201);

    // One call, one stage: the delivery is at LOADING, not IN_TRANSIT.
    // Skipping would let an operator take a delivery from assigned to
    // travelling without either stage being attested separately.
    expect((await readAsOperator(orderId)).status).toBe(OrderStatus.LOADING);
  });

  // --- T127 -----------------------------------------------------------

  it('a customer is never told an overridden vehicle was verified (FR-047d, SC-020)', async () => {
    const orderId = await assignedOrder();
    await override(orderId, 'No signal at the depot').expect(201);

    const asClient = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(200);

    // THE honesty assertion. `vehicleVerified` is computed from a matched
    // DEPARTURE record, and an override deliberately writes none — so this
    // stays false without any override-specific branch having to remember
    // to make it false.
    expect(asClient.body.vehicleVerified).toBe(false);
    // …and the customer sees no verification history to draw their own
    // conclusion from either (FR-042).
    expect(asClient.body.verifications).toBeUndefined();
  });

  it('the same field is true for a genuinely verified delivery — so false means something', async () => {
    // A test that only ever asserts `false` would still pass if the field
    // were hardcoded. This is the control.
    const orderId = await assignedOrder();
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ credential: fixtures.companyA.truck.nfcCardUid, method: 'NFC_CARD' })
      .expect(201);

    const asClient = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(200);
    expect(asClient.body.vehicleVerified).toBe(true);
  });

  it('a half-overridden delivery reports honestly: verified departure, overridden loading', async () => {
    const orderId = await assignedOrder();
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ credential: fixtures.companyA.truck.nfcCardUid, method: 'NFC_CARD' })
      .expect(201);
    await override(orderId, 'Depot has no coverage inside the loading bay').expect(201);

    const order = await readAsOperator(orderId);
    expect(order.status).toBe(OrderStatus.IN_TRANSIT);

    // The two stages are recorded through two different mechanisms, which
    // is exactly what lets an operator tell them apart afterwards.
    expect(order.verifications).toHaveLength(1);
    expect(order.verifications[0].stage).toBe('DEPARTURE');
    const loadingLeg = order.statusHistory.find(
      (h: { from: string; to: string }) =>
        h.from === OrderStatus.LOADING && h.to === OrderStatus.IN_TRANSIT,
    );
    expect(loadingLeg.manualOverride).toBe(true);

    // The customer's summary reflects the half that was real.
    const asClient = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(200);
    expect(asClient.body.vehicleVerified).toBe(true);
  });
});
