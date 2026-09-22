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
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { VerificationStage } from '../../src/common/enums/verification-stage.enum';

jest.setTimeout(120_000);

/** ~4.5 km east of the fixture warehouse — well outside the 500 m default. */
const FAR_FROM_WAREHOUSE = {
  longitude: DEFAULT_WAREHOUSE_LOCATION.longitude + 0.045,
  latitude: DEFAULT_WAREHOUSE_LOCATION.latitude,
};

/** Inside the yard: ~55 m north of the recorded warehouse point. */
const AT_WAREHOUSE = {
  longitude: DEFAULT_WAREHOUSE_LOCATION.longitude,
  latitude: DEFAULT_WAREHOUSE_LOCATION.latitude + 0.0005,
};

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/**
 * spec 008 US4 (FR-030/FR-030a-d): the loading-stage read is the same card
 * as the departure read, so on its own it re-proves something already
 * proven. What makes it worth asking for is WHERE it is presented — this
 * file covers the geofence that turns the second tap into evidence the
 * driver reached the depot, and the two refusals it introduces.
 *
 * Departure's own non-geofenced behaviour is asserted here too (the same
 * request body that is refused at loading is accepted at departure), since
 * that asymmetry is the whole design and nothing else pins it down.
 */
describe('Loading verification geofence (spec 008 US4)', () => {
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

  beforeEach(async () => {
    await resetFixtureDispatchState(app, fixtures.companyA);
    // Every test here spends part of verify-vehicle's 5-per-15-minute budget
    // (FR-023) on setup alone; without this the last `it()` would be
    // throttled rather than answered on its merits.
    await app.get(ResilientThrottlerStorage).reset();
  });

  /**
   * Leaves the order at LOADING with the departure stage already verified —
   * deliberately NOT via `assignAndDepart`, which runs the geofenced step
   * this file is here to exercise.
   */
  async function orderAwaitingLoading(): Promise<string> {
    const server = app.getHttpServer();
    const { client, admin, transportAdmin, driver, truck, tank } = fixtures.companyA;

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const orderId = createRes.body._id as string;

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-geofence-${orderId}`,
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

    // FR-030a does not apply to departure: the truck is wherever the shift
    // starts, and this call carries no position at all.
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ credential: truck.nfcCardUid, method: 'NFC_CARD' })
      .expect(201)
      .then((res) => expect(res.body.order.status).toBe(OrderStatus.LOADING));

    return orderId;
  }

  async function readOrder(orderId: string) {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    return res.body;
  }

  it('accepts the assigned truck read inside the warehouse geofence and records the distance (FR-030/FR-030d)', async () => {
    const server = app.getHttpServer();
    const { driver, truck } = fixtures.companyA;
    const orderId = await orderAwaitingLoading();

    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ credential: truck.nfcCardUid, method: 'NFC_CARD', driverLocation: AT_WAREHOUSE })
      .expect(201);

    expect(res.body.status).toBe(VerificationStage.LOADING);
    // ~55 m: measured and returned, not merely thresholded.
    expect(res.body.distanceMeters).toBeGreaterThan(0);
    expect(res.body.distanceMeters).toBeLessThan(500);

    const order = await readOrder(orderId);
    const loading = order.verifications.filter(
      (v: { stage: string }) => v.stage === VerificationStage.LOADING,
    );
    expect(loading).toHaveLength(1);
    expect(loading[0].matched).toBe(true);
    expect(loading[0].distanceMeters).toBeLessThan(500);
    // The position recorded is the one sent with the read, not the driver's
    // last streamed point (which the fixture put at the company centre).
    expect(loading[0].driverLocation.coordinates[1]).toBeCloseTo(AT_WAREHOUSE.latitude, 4);

    // FR-031/FR-032: and only now does loading confirm.
    await request(server)
      .post(`/api/v1/orders/${orderId}/confirm-loading`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201)
      .then((r) => expect(r.body.status).toBe(OrderStatus.IN_TRANSIT));
  });

  it('refuses the right truck read from outside the geofence, records the failed attempt, and leaves loading unconfirmable (FR-030a)', async () => {
    const server = app.getHttpServer();
    const { driver, truck } = fixtures.companyA;
    const orderId = await orderAwaitingLoading();

    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({
        credential: truck.nfcCardUid,
        method: 'NFC_CARD',
        driverLocation: FAR_FROM_WAREHOUSE,
      })
      .expect(403);
    expect(res.body.error).toBe(ErrorCode.NOT_AT_WAREHOUSE);
    expect(res.body.distanceMeters).toBeGreaterThan(4_000);
    expect(res.body.radiusMeters).toBe(500);

    // FR-019/FR-040: refused, but not erased — with the distance that
    // refused it, which is the part an operator reviewing an override needs.
    const order = await readOrder(orderId);
    expect(order.status).toBe(OrderStatus.LOADING);
    const loading = order.verifications.filter(
      (v: { stage: string }) => v.stage === VerificationStage.LOADING,
    );
    expect(loading).toHaveLength(1);
    expect(loading[0].matched).toBe(false);
    expect(loading[0].distanceMeters).toBeGreaterThan(4_000);

    await request(server)
      .post(`/api/v1/orders/${orderId}/confirm-loading`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(409)
      .then((r) => expect(r.body.error).toBe(ErrorCode.VEHICLE_NOT_VERIFIED));
  });

  it('refuses a loading read that carries no position, recording nothing (FR-030c)', async () => {
    const server = app.getHttpServer();
    const { driver, truck } = fixtures.companyA;
    const orderId = await orderAwaitingLoading();

    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ credential: truck.nfcCardUid, method: 'NFC_CARD' })
      .expect(400);
    expect(res.body.error).toBe(ErrorCode.LOCATION_REQUIRED);

    // Unjudgeable, so unrecorded — the same treatment as an out-of-sequence
    // attempt, and distinct from the refusal above, which IS recorded.
    const order = await readOrder(orderId);
    expect(
      order.verifications.filter((v: { stage: string }) => v.stage === VerificationStage.LOADING),
    ).toHaveLength(0);
  });

  it('still answers a wrong card with VEHICLE_MISMATCH, even at the warehouse (FR-018)', async () => {
    const server = app.getHttpServer();
    const { driver } = fixtures.companyA;
    const orderId = await orderAwaitingLoading();

    // Company B's truck: a real card, resolving to a real truck, that is not
    // this order's. Standing in the right place must not soften that answer,
    // and must not hint that the location half would otherwise have passed.
    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({
        credential: fixtures.companyB.truck.nfcCardUid,
        method: 'NFC_CARD',
        driverLocation: AT_WAREHOUSE,
      })
      .expect(403);
    expect(res.body.error).toBe(ErrorCode.VEHICLE_MISMATCH);
    expect(res.body.distanceMeters).toBeUndefined();
  });
});
