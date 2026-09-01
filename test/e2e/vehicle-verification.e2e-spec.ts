import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  DEFAULT_PASSWORD,
  DEFAULT_WAREHOUSE_LOCATION,
  resetFixtureDispatchState,
  seedTwoCompanies,
  TwoCompanyFixture,
} from '../utils/fixtures';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TrucksService } from '../../src/modules/trucks/trucks.service';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { VerificationStage } from '../../src/common/enums/verification-stage.enum';

jest.setTimeout(180_000);

/**
 * spec 008 US3 (T097-T102): the departure gate — the requirement the whole
 * feature exists to serve.
 *
 * Two properties here are security properties rather than behavioural ones,
 * and both are invisible to a passing happy path: an unknown credential and
 * a wrong-truck credential must be *indistinguishable* (T099, Principle II),
 * and no stored attempt may retain a raw credential (T101, FR-042). Each is
 * satisfied by the platform declining to be helpful, which is exactly the
 * kind of thing a later "improvement" undoes in good faith.
 */
describe('Vehicle verification — the departure gate (spec 008 US3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let server: ReturnType<INestApplication['getHttpServer']>;

  /**
   * A second truck inside company A's OWN transporter. Company B's card
   * cannot serve as "the wrong truck" here: `Truck` is tenant-scoped, so a
   * neighbour's card resolves to nothing at all rather than to a different
   * vehicle — which makes it the *unknown credential* case, not the
   * wrong-truck one. FR-018 requires both, and requires them identical.
   */
  let otherTruck: { id: string; nfcCardUid: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();
    fixtures = await seedTwoCompanies(app);

    const trucksService = app.get(TrucksService);
    const created = await trucksService.create(fixtures.companyA.transportCompanyId, {
      plateNumber: 'VERIFY-OTHER',
    });
    await trucksService.pairCard(String(created._id), 'CARD-VERIFY-OTHER');
    otherTruck = { id: String(created._id), nfcCardUid: 'CARD-VERIFY-OTHER' };
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await resetFixtureDispatchState(app, fixtures.companyA);
    // The 5-per-15-minute budget (FR-023) is shared across this file's
    // requests, so every test but the throttle one starts with it clear —
    // otherwise a later assertion gets a 429 it never asked about.
    await app.get(ResilientThrottlerStorage).reset();
  });

  function sign(payload: Record<string, unknown>, secret: string) {
    const rawBody = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  /** An order assigned to company A's driver, awaiting departure verification. */
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
        transactionId: `SDD-verify-${orderId}`,
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

  const verify = (orderId: string, credential: string, method = 'NFC_CARD', token?: string) =>
    request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${token ?? fixtures.companyA.driver.token}`)
      .send({ credential, method });

  const readOrder = async (orderId: string) =>
    (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200)
    ).body;

  // --- T097 -----------------------------------------------------------

  it('a delivery cannot start by any means until it is verified (FR-017, FR-020, SC-001)', async () => {
    const orderId = await assignedOrder();

    // Every later step of the journey, attempted early. None may work, and
    // none may partially advance the order — the gate is the only door.
    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    await request(server)
      .post(`/api/v1/orders/${orderId}/confirm-loading`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    await request(server)
      .post(`/api/v1/orders/${orderId}/request-delivery-otp`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));

    expect((await readOrder(orderId)).status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
  });

  it("the wrong truck's card is refused and leaves the order exactly where it was (FR-018, SC-002)", async () => {
    const orderId = await assignedOrder();

    const res = await verify(orderId, otherTruck.nfcCardUid).expect(403);
    expect(res.body.error).toBe(ErrorCode.VEHICLE_MISMATCH);

    const order = await readOrder(orderId);
    expect(order.status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
    // FR-019/FR-040: refused, but recorded — a refusal that vanished would
    // leave an operator unable to see a driver at the wrong vehicle.
    expect(order.verifications).toHaveLength(1);
    expect(order.verifications[0]).toMatchObject({
      stage: VerificationStage.DEPARTURE,
      matched: false,
    });
  });

  it("the assigned truck's card starts the delivery and routes it to a warehouse (FR-026)", async () => {
    const orderId = await assignedOrder();

    const res = await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
    expect(res.body.status).toBe(VerificationStage.DEPARTURE);
    expect(res.body.order.status).toBe(OrderStatus.LOADING);
    // The next destination comes back with the verification, so the app can
    // route without a second call.
    expect(res.body.warehouseSummary).toMatchObject({ name: 'Test Central Warehouse' });
  });

  // --- T098 -----------------------------------------------------------

  it('the QR path produces an identical outcome to the card path (FR-036a, SC-016)', async () => {
    const { qrToken } = await app.get(TrucksService).mintQrToken(fixtures.companyA.truck.id);
    const orderId = await assignedOrder();

    const res = await verify(orderId, qrToken, 'QR_CODE').expect(201);
    expect(res.body.order.status).toBe(OrderStatus.LOADING);

    // "Identical outcome" includes what was recorded — only `method`
    // differs, which is precisely FR-036c's point.
    const order = await readOrder(orderId);
    expect(order.verifications[0]).toMatchObject({
      stage: VerificationStage.DEPARTURE,
      method: 'QR_CODE',
      matched: true,
    });
  });

  it('a code minted for a different truck is refused exactly as a mismatched card is (FR-036b)', async () => {
    const orderId = await assignedOrder();
    const res = await verify(orderId, fixtures.companyB.truck.qrToken, 'QR_CODE').expect(403);
    expect(res.body.error).toBe(ErrorCode.VEHICLE_MISMATCH);
    expect((await readOrder(orderId)).status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
  });

  it('a revoked code stops verifying immediately, with no expiry to wait out (FR-036g, SC-027)', async () => {
    const trucksService = app.get(TrucksService);
    const { qrToken } = await trucksService.mintQrToken(fixtures.companyA.truck.id);
    const orderId = await assignedOrder();

    await trucksService.revokeQrToken(fixtures.companyA.truck.id);

    // The whole point of revocation-over-expiry (research R6): a leaked
    // code is dead the moment it is revoked, not at the end of a window.
    const res = await verify(orderId, qrToken, 'QR_CODE').expect(403);
    expect(res.body.error).toBe(ErrorCode.VEHICLE_MISMATCH);

    // The card is untouched by the revocation — the driver is not stranded.
    await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
  });

  // --- T099 -----------------------------------------------------------

  it('an unknown credential and a wrong-truck credential are indistinguishable (Principle II)', async () => {
    const orderId = await assignedOrder();

    const unknown = await verify(orderId, 'CARD-THAT-EXISTS-NOWHERE').expect(403);
    const wrongTruck = await verify(orderId, otherTruck.nfcCardUid).expect(403);

    // Same status, same code, same message. Any difference at all would let
    // a driver's device probe which cards exist by watching the responses.
    expect(unknown.status).toBe(wrongTruck.status);
    expect(unknown.body.error).toBe(ErrorCode.VEHICLE_MISMATCH);
    expect(wrongTruck.body.error).toBe(ErrorCode.VEHICLE_MISMATCH);
    expect(unknown.body.message).toBe(wrongTruck.body.message);

    // The stored attempts do differ — `presentedTruckId` is absent for the
    // unknown one — but that is the operator's audit trail, never the
    // driver's response body.
    const order = await readOrder(orderId);
    expect(order.verifications).toHaveLength(2);
    expect(order.verifications[0].presentedTruckId).toBeUndefined();
    expect(order.verifications[1].presentedTruckId).toBe(otherTruck.id);
  });

  // --- T100 -----------------------------------------------------------

  it('a repeated verification at a completed stage is refused as out-of-sequence (FR-025)', async () => {
    const orderId = await assignedOrder();
    await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);

    // The order is at LOADING now, so the departure stage is no longer
    // outstanding — the same card that just worked must not work again.
    // (It resolves to the LOADING stage instead, which refuses without a
    // position: either way, nothing re-runs and nothing advances.)
    const repeat = await verify(orderId, fixtures.companyA.truck.nfcCardUid);
    expect(repeat.status).toBeGreaterThanOrEqual(400);

    const order = await readOrder(orderId);
    expect(order.status).toBe(OrderStatus.LOADING);
    expect(
      order.verifications.filter((v: { stage: string }) => v.stage === VerificationStage.DEPARTURE),
    ).toHaveLength(1);
  });

  it('refuses a verification once the delivery has moved past both stages entirely (FR-025)', async () => {
    const orderId = await assignedOrder();
    await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({
        credential: fixtures.companyA.truck.nfcCardUid,
        method: 'NFC_CARD',
        driverLocation: DEFAULT_WAREHOUSE_LOCATION,
      })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/confirm-loading`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(201);

    // IN_TRANSIT: no stage is outstanding at all.
    await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(409);
    expect((await readOrder(orderId)).status).toBe(OrderStatus.IN_TRANSIT);
  });

  it('throttles the 6th attempt inside the window (FR-023)', async () => {
    const orderId = await assignedOrder();

    // Five refusals, each answered on its own merits…
    for (let i = 0; i < 5; i++) {
      await verify(orderId, `CARD-WRONG-${i}`).expect(403);
    }
    // …and the sixth on the rate limiter's, not the credential's.
    await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(429);

    // Crucially the delivery is still startable once the window passes —
    // throttling must not consume the gate itself.
    expect((await readOrder(orderId)).status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
  });

  // --- T101 -----------------------------------------------------------

  it('records the method used, and never the raw credential (FR-036c, FR-042)', async () => {
    // Minted fresh: the revocation test above rotated and then revoked the
    // fixture's own token, and a test that depends on another test's
    // credential state is a test that fails for the wrong reason later.
    const { qrToken } = await app.get(TrucksService).mintQrToken(fixtures.companyA.truck.id);
    const orderId = await assignedOrder();

    await verify(orderId, 'CARD-UNKNOWN-SECRET').expect(403);
    await verify(orderId, qrToken, 'QR_CODE').expect(201);

    const order = await readOrder(orderId);
    const [failed, succeeded] = order.verifications;
    expect(failed.method).toBe('NFC_CARD');
    expect(succeeded.method).toBe('QR_CODE');

    // An attempt log holding credentials would be a harvestable list of
    // every card and code presented, valid ones included.
    const serialized = JSON.stringify(order.verifications);
    expect(serialized).not.toContain('CARD-UNKNOWN-SECRET');
    expect(serialized).not.toContain(qrToken);
    expect(serialized).not.toContain(fixtures.companyA.truck.nfcCardUid);
    expect(serialized).not.toContain('credential');
  });

  // --- T102 -----------------------------------------------------------

  it('survives a session revocation — the verified stage is not lost or re-required (FR-045)', async () => {
    const orderId = await assignedOrder();
    await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);

    // spec 006: signing in again displaces the old session (one session per
    // driver, `sessionGeneration` bumped).
    const authService = app.get(AuthService);
    const reauth = await authService.login({
      email: fixtures.companyA.driver.email,
      password: DEFAULT_PASSWORD,
    });

    // The old token is genuinely dead — otherwise this test would prove
    // nothing about what a re-signed-in driver sees.
    await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(401);

    const resumed = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${reauth.accessToken}`)
      .expect(200);

    // Verification is a property of the delivery, not of the session that
    // performed it: the driver picks up exactly where they left off.
    expect(resumed.body.status).toBe(OrderStatus.LOADING);
    expect(resumed.body.verifications).toHaveLength(1);
    expect(resumed.body.verifications[0].matched).toBe(true);

    // And the departure stage is not offered again.
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${reauth.accessToken}`)
      .send({
        credential: fixtures.companyA.truck.nfcCardUid,
        method: 'NFC_CARD',
        driverLocation: DEFAULT_WAREHOUSE_LOCATION,
      })
      .expect(201)
      .then((res) => expect(res.body.status).toBe(VerificationStage.LOADING));
  });
});
