import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  DEFAULT_WAREHOUSE_LOCATION,
  resetFixtureDispatchState,
  seedTwoCompanies,
  TwoCompanyFixture,
  settleClientReview,
} from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { VerificationStage } from '../../src/common/enums/verification-stage.enum';

jest.setTimeout(180_000);

/**
 * spec 008 US5 (T132-T134): who may see the verification trail.
 *
 * The audit half (T132) is what makes a verification worth recording at
 * all — an operator must be able to answer "when, where, and by which
 * method" without phoning the driver. The secrecy half (T133/T134) is what
 * keeps that trail from becoming a leak: a customer learns *that* their
 * delivery was verified, never the evidence behind it, and a neighbouring
 * carrier learns nothing whatsoever.
 */
describe('Verification visibility (spec 008 US5)', () => {
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
        transactionId: `SDD-visible-${orderId}`,
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

    await settleClientReview(app, orderId);
    await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);

    return orderId;
  }

  /** Departure (one failure, then success), then loading — the full trail. */
  async function fullyVerifiedOrder(): Promise<string> {
    const orderId = await assignedOrder();
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ credential: 'CARD-WRONG-VISIBILITY', method: 'NFC_CARD' })
      .expect(403);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ credential: fixtures.companyA.truck.nfcCardUid, method: 'NFC_CARD' })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({
        credential: fixtures.companyA.truck.qrToken,
        method: 'QR_CODE',
        driverLocation: DEFAULT_WAREHOUSE_LOCATION,
      })
      .expect(201);
    return orderId;
  }

  // --- T132 -----------------------------------------------------------

  it('an operator sees both verifications with time, location and method (FR-039, SC-009)', async () => {
    const orderId = await fullyVerifiedOrder();

    const order = (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
        .expect(200)
    ).body;

    const matched = order.verifications.filter((v: { matched: boolean }) => v.matched);
    expect(matched).toHaveLength(2);

    const [departure, loading] = matched;
    // SC-009: everything needed to reconstruct the stage without contacting
    // the driver — including which credential type was used, so a scanned
    // code (weaker) is distinguishable from a tapped card (stronger).
    expect(departure.stage).toBe(VerificationStage.DEPARTURE);
    expect(departure.method).toBe('NFC_CARD');
    expect(departure.at).toBeTruthy();
    expect(departure.driverLocation.coordinates).toHaveLength(2);
    expect(departure.actorId).toBe(fixtures.companyA.driver.id);

    expect(loading.stage).toBe(VerificationStage.LOADING);
    expect(loading.method).toBe('QR_CODE');
    expect(loading.driverLocation.coordinates).toHaveLength(2);
    // FR-030d: and how far from the depot it was taken.
    expect(typeof loading.distanceMeters).toBe('number');
  });

  it('failed attempts sit alongside the successful ones (FR-040)', async () => {
    const orderId = await fullyVerifiedOrder();
    const order = (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
        .expect(200)
    ).body;

    // A trail that kept only successes would hide a driver repeatedly
    // presenting the wrong vehicle — the pattern most worth seeing.
    expect(order.verifications).toHaveLength(3);
    const failed = order.verifications.filter((v: { matched: boolean }) => !v.matched);
    expect(failed).toHaveLength(1);
    expect(failed[0].stage).toBe(VerificationStage.DEPARTURE);
  });

  it('the fuel company can review the trail on its own order too (FR-039)', async () => {
    const orderId = await fullyVerifiedOrder();
    const order = (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200)
    ).body;
    expect(order.verifications).toHaveLength(3);
  });

  it('a verified stage and an overridden one appear together, distinguishably (FR-047f)', async () => {
    const orderId = await assignedOrder();
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ credential: fixtures.companyA.truck.nfcCardUid, method: 'NFC_CARD' })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/override-verification`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({ reason: 'No coverage inside the loading bay' })
      .expect(201);

    const order = (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
        .expect(200)
    ).body;

    // Reviewing the delivery shows both legs, and they cannot be confused:
    // one is a verification record, the other is a status-history entry
    // carrying a human's reason. Neither can masquerade as the other.
    expect(order.verifications).toHaveLength(1);
    expect(order.verifications[0].stage).toBe(VerificationStage.DEPARTURE);
    const overridden = order.statusHistory.filter(
      (h: { manualOverride?: boolean }) => h.manualOverride,
    );
    expect(overridden).toHaveLength(1);
    expect(overridden[0]).toMatchObject({
      from: OrderStatus.LOADING,
      to: OrderStatus.IN_TRANSIT,
      overrideReason: 'No coverage inside the loading bay',
    });
  });

  // --- T133 -----------------------------------------------------------

  it("a neighbouring carrier's driver gets nothing distinguishable from non-existence (FR-041, SC-011)", async () => {
    const orderId = await fullyVerifiedOrder();

    // Company B's driver has no relationship to this delivery. 404, not
    // 403: a refusal that confirmed the order exists would already be a
    // disclosure about another carrier's operations.
    await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .expect(404);
    await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.transportAdmin.token}`)
      .expect(404);
    await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(404);

    // And it never surfaces through their own list either.
    const list = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyB.transportAdmin.token}`)
      .expect(200);
    expect(list.body.items.map((o: { _id: string }) => o._id)).not.toContain(orderId);
  });

  // --- T134 -----------------------------------------------------------

  it('no customer-facing response carries the verification trail or the tank (FR-042)', async () => {
    const orderId = await fullyVerifiedOrder();
    const clientToken = fixtures.companyA.client.token;

    // Every shape a customer can read an order through. The detail endpoint
    // strips these deliberately; a list that spreads the raw document would
    // hand back the same fields by a different door, which is exactly the
    // kind of gap a per-endpoint rule leaves behind.
    const detail = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    const list = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);

    const listed = list.body.items.find((o: { _id: string }) => o._id === orderId);
    expect(listed).toBeTruthy();

    for (const body of [detail.body, listed]) {
      expect(body.verifications).toBeUndefined();
      expect(body.tankSummary).toBeUndefined();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('nfcCardUid');
      expect(serialized).not.toContain('qrToken');
      expect(serialized).not.toContain(fixtures.companyA.truck.nfcCardUid);
      expect(serialized).not.toContain(fixtures.companyA.truck.qrToken);
    }

    // What the customer DOES get is the conclusion, not the evidence.
    expect(detail.body.vehicleVerified).toBe(true);
    expect(detail.body.driverSummary.plateNumber).toBe(fixtures.companyA.truck.plateNumber);
  });

  it('the driver keeps their own trail — the strip is about customers, not secrecy for its own sake', async () => {
    const orderId = await fullyVerifiedOrder();
    const order = (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
        .expect(200)
    ).body;

    // A driver must see the tank they are hauling (FR-033a) and their own
    // attempts — stripping by role, not by field name everywhere.
    expect(order.verifications).toHaveLength(3);
    expect(order.tankSummary).toMatchObject({ code: fixtures.companyA.tank.code });
  });
});
