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
  settleClientReview,
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

  /**
   * An order assigned to company A's driver, awaiting departure verification.
   * `truckId` defaults to the fixture tractor; pass one to assign a
   * purpose-built truck instead (used by the card-rendering block below, which
   * must not disturb the fixture truck's own card or minted token).
   */
  async function assignedOrder(truckId?: string): Promise<string> {
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

    await settleClientReview(app, orderId);
    await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truckId ?? truck.id, tankId: tank.id })
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

  /**
   * FR-023's 5-per-15-minute lockout has been REMOVED from this route, and this
   * test now pins its absence.
   *
   * It counted every outcome, not just a wrong credential — `LOCATION_REQUIRED`
   * (where nothing about the vehicle is evaluated at all) and `NOT_AT_WAREHOUSE`
   * (where the driver presented the CORRECT card and only the geofence refused)
   * both consumed attempts. A driver approaching a depot while their GPS
   * settled, or standing at the gate rather than inside the fence, could spend
   * the budget in a minute and then be unable to start work for fifteen —
   * holding the right card, at the right depot, with nothing they could do.
   *
   * The limit was aimed at credential guessing and fits that poorly here: the
   * caller is already an authenticated DRIVER already assigned to THIS order,
   * the QR token is 32 random characters, and every refusal is still recorded
   * as a `VehicleVerification` either way. Refusals remain auditable; they are
   * simply no longer rationed.
   */
  it('does NOT lock a driver out after repeated refusals (FR-023 withdrawn)', async () => {
    const orderId = await assignedOrder();

    // Well past the old 5-attempt window, each answered on its own merits.
    for (let i = 0; i < 8; i++) {
      await verify(orderId, `CARD-WRONG-${i}`).expect(403);
    }

    // The next correct read still works — the driver is never shut out of
    // starting their own delivery.
    await verify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
    expect((await readOrder(orderId)).status).toBe(OrderStatus.LOADING);

    // Every refusal is still on the record: removing the lockout removed a
    // rationing rule, not the audit trail.
    const order = await readOrder(orderId);
    expect(order.verifications.filter((v: { matched: boolean }) => !v.matched).length).toBe(8);
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

  // --- the card-rendering gap ------------------------------------------
  //
  // spec 008 assumed the identifier is opaque and so "cards of differing
  // encodings work without change". That is true of one reader and false of
  // two. The transporter pairs with a desk-mounted HID reader; the driver
  // presents the same physical card to a phone. The two render one UID
  // differently — case, separators, a decimal rather than hex reading, and
  // often the reverse byte order — so compared raw, the correct card at the
  // correct truck is refused, permanently. FR-018 makes that refusal
  // indistinguishable from an unknown card by design, so the failure arrives
  // with no thread to pull.
  describe('the same physical card, read by two different devices', () => {
    let plateSeq = 0;

    // The revocation test above signs the driver in again, which bumps
    // `sessionGeneration` and kills the fixture's stored token (spec 006 —
    // one session per driver). Everything below would fail on 401 rather than
    // on anything it means to assert, so the token is refreshed once here.
    beforeAll(async () => {
      const reauth = await app.get(AuthService).login({
        email: fixtures.companyA.driver.email,
        password: DEFAULT_PASSWORD,
      });
      fixtures.companyA.driver.token = reauth.accessToken;
    });

    /**
     * A truck of its own, paired as the desk reader rendered the card — so the
     * fixture tractor's card and minted QR token are left untouched. Each case
     * uses a DIFFERENT physical card, because `nfcCardUid` is globally unique
     * and reusing one would refuse the second pairing rather than test it.
     */
    async function truckPairedAs(pairedRendering: string): Promise<string> {
      const trucks = app.get(TrucksService);
      const created = await trucks.create(fixtures.companyA.transportCompanyId, {
        plateNumber: `RENDER-${(plateSeq += 1)}`,
      });
      await trucks.pairCard(String(created._id), pairedRendering);
      return String(created._id);
    }

    it.each([
      // [what differs, how the desk reader rendered it, how the phone renders it]
      ['decimal vs hex', '0077771716', '04:a2:b3:c4'], // 0x04A2B3C4 === 77771716
      ['separators and case', '11:aa:bb:cc', '11AABBCC'],
      ['separator style', '22ddeeff', '22-DD-EE-FF'],
      ['byte order', '3312ABCD', 'cdab1233'],
    ])(
      'one card resolves to its truck when the two devices disagree about %s',
      async (_difference, pairedRendering, presentedRendering) => {
        const truckId = await truckPairedAs(pairedRendering);
        const orderId = await assignedOrder(truckId);

        const res = await verify(orderId, presentedRendering).expect(201);
        expect(res.body.status).toBe(VerificationStage.DEPARTURE);
        expect(res.body.order.status).toBe(OrderStatus.LOADING);
      },
    );

    it('still refuses a genuinely different card (the tolerance is not a wildcard)', async () => {
      const truckId = await truckPairedAs('5566AABB');
      const orderId = await assignedOrder(truckId);

      // A real, unrelated card — not another rendering of 0x5566AABB.
      const res = await verify(orderId, '11:22:33:44').expect(403);
      expect(res.body.error).toBe(ErrorCode.VEHICLE_MISMATCH);
      expect((await readOrder(orderId)).status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
    });

    it('refuses to pair two renderings of one card to two trucks (FR-005/SC-008)', async () => {
      await truckPairedAs('0099887766');
      const second = await app
        .get(TrucksService)
        .create(fixtures.companyA.transportCompanyId, { plateNumber: 'RENDER-DUP' });

      // 99887766 decimal === 0x05F42A96. Compared raw these are different
      // strings, so BOTH pairings would have succeeded and one physical card
      // could then verify two tractors — precisely what the unique index
      // exists to prevent.
      await expect(
        app.get(TrucksService).pairCard(String(second._id), '05:f4:2a:96'),
      ).rejects.toMatchObject({ response: { error: ErrorCode.CARD_ALREADY_PAIRED } });
    });
  });
});
