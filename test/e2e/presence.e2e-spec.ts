import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  assignAndDepart,
  resetFixtureDispatchState, settleClientReview } from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { PresenceService } from '../../src/modules/tracking/presence/presence.service';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { DriverEligibility } from '../../src/common/enums/driver-eligibility.enum';

jest.setTimeout(120_000);

function connectSocket(url: string, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${url}/tracking`, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

describe('Driver presence (US4) — offline detection & recovery', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    userModel = app.get(getModelToken(User.name));
  }, 180_000);

  afterAll(async () => {
    openSockets.forEach((s) => s.disconnect());
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      {
        $set: { isAvailable: true, isOnline: true, lastSeenAt: new Date() },
        $unset: { activeOrderId: '' },
      },
    );
    await resetFixtureDispatchState(app, fixtures.companyA);
  });

  // spec 010 FR-001/FR-002 (corrected during implementation): a silent
  // driver is no longer excluded from the candidate list — they now appear,
  // classified OFFLINE, rather than vanishing. This test used to assert
  // exclusion; it now asserts the classification, which is what actually
  // matters here (the sweep's own effect is `isOnline: false`, asserted
  // directly below regardless of dispatch's presentation of it).
  it('marks a silent driver offline (sweep, no waiting), shown as OFFLINE in candidates rather than excluded', async () => {
    const { driver, client, admin, transportAdmin } = fixtures.companyA;

    // Simulate 7 minutes of silence directly — no real waiting.
    await userModel.updateOne(
      { _id: driver.id },
      { $set: { lastSeenAt: new Date(Date.now() - 7 * 60_000) } },
    );

    await app.get(PresenceService).sweepOfflineDrivers();

    const afterSweep = await userModel.findById(driver.id).exec();
    expect(afterSweep?.isOnline).toBe(false);

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

    await settleClientReview(app, createRes.body._id);
    const candidates = await request(server)
      .get(`/api/v1/dispatch/orders/${createRes.body._id}/candidates`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .expect(200);
    expect(candidates.body).toHaveLength(1);
    expect(candidates.body[0]._id).toBe(driver.id);
    expect(candidates.body[0].eligibility).toBe(DriverEligibility.OFFLINE);
  });

  it('restores dispatch eligibility automatically the moment the driver reconnects', async () => {
    const { driver, client, admin, transportAdmin, truck, tank } = fixtures.companyA;

    await userModel.updateOne(
      { _id: driver.id },
      { $set: { isOnline: false, lastSeenAt: new Date(Date.now() - 7 * 60_000) } },
    );

    const socket = await connectSocket(ctx.url, driver.token);
    openSockets.push(socket);

    // handleConnection() touches presence synchronously on connect; give the
    // event loop one tick to let the DB write land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterReconnect = await userModel.findById(driver.id).exec();
    expect(afterReconnect?.isOnline).toBe(true);

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

    await settleClientReview(app, createRes.body._id);
    const candidates = await request(server)
      .get(`/api/v1/dispatch/orders/${createRes.body._id}/candidates`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .expect(200);
    expect(candidates.body.map((c: { _id: string }) => c._id)).toEqual([driver.id]);

    await settleClientReview(app, createRes.body._id);
    const assignRes = await request(server)
      .post(`/api/v1/dispatch/orders/${createRes.body._id}/assign`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);
    expect(assignRes.body.driverId).toBe(driver.id);
  });

  it('does not disturb an in-progress order when its driver goes silent', async () => {
    const { driver, client, admin, transportAdmin, truck, tank } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    await assignAndDepart(
      app,
      createRes.body._id,
      transportAdmin.token,
      driver.token,
      driver.id,
      truck.id,
      tank.id,
      truck.nfcCardUid,
    );
    const orderId = createRes.body._id;

    // Driver goes silent mid-delivery.
    await userModel.updateOne(
      { _id: driver.id },
      { $set: { lastSeenAt: new Date(Date.now() - 7 * 60_000) } },
    );
    await app.get(PresenceService).sweepOfflineDrivers();

    const driverDoc = await userModel.findById(driver.id).exec();
    expect(driverDoc?.isOnline).toBe(false);
    // Presence sweep must never touch order state or the driver's assignment.
    expect(String(driverDoc?.activeOrderId)).toBe(orderId);

    const orderAfterSweep = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(orderAfterSweep.body.status).toBe(OrderStatus.IN_TRANSIT);
  });
});
