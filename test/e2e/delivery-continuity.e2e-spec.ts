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
  resetFixtureDispatchState,
  DEFAULT_PASSWORD,
} from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { Order, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function connectSocket(url: string, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${url}/tracking`, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function ackOf<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, (ack: T) => resolve(ack)));
}

/**
 * feature 013 US1 (FR-004, FR-010, and the general "the delivery belongs to
 * the driver, not the handset" claim): an in-flight delivery — including an
 * OTP already issued to the customer and the movement bookkeeping behind
 * stop detection — is fully carried by the account, so a replacement device
 * signing in resumes it with nothing lost and nothing repeated.
 */
describe('Delivery continuity across a device switch (feature 013 US1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;
  let orderModel: Model<OrderDocument>;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    userModel = app.get(getModelToken(User.name));
    orderModel = app.get(getModelToken(Order.name));
  }, 180_000);

  afterAll(async () => {
    openSockets.forEach((s) => s.disconnect());
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await userModel.updateMany(
      { _id: { $in: [fixtures.companyA.driver.id, fixtures.companyB.driver.id] } },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
    await resetFixtureDispatchState(app, fixtures.companyA, fixtures.companyB);
    // These tests deliberately sign the driver in again, which bumps
    // `sessionGeneration` and stales the fixture's shared token. Re-issue it
    // so each test starts from a valid session.
    fixtures.companyA.driver.token = await signInAgain();
  });

  async function inTransitOrder(): Promise<string> {
    const { client, admin, transportAdmin, driver, truck, tank } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);
    const orderId = createRes.body._id;

    await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    await assignAndDepart(
      app,
      orderId,
      transportAdmin.token,
      driver.token,
      driver.id,
      truck.id,
      tank.id,
      truck.nfcCardUid,
    );

    const after = await orderModel.findById(orderId).exec();
    expect(after?.status).toBe(OrderStatus.IN_TRANSIT);
    return orderId;
  }

  /** Signs the fixture driver in again, returning the fresh access token —
   *  which bumps `sessionGeneration` and stales every prior token. */
  async function signInAgain(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);
    return res.body.accessToken as string;
  }

  it('a fresh read after departure + loading returns the same stage and the same frozen summaries — nothing is device-held', async () => {
    const { driver } = fixtures.companyA;
    const orderId = await inTransitOrder();

    const first = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    const second = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    expect(second.body.status).toBe(OrderStatus.IN_TRANSIT);
    expect(second.body.status).toBe(first.body.status);
    expect(second.body.tankSummary).toEqual(first.body.tankSummary);
    expect(second.body.warehouseSummary).toEqual(first.body.warehouseSummary);
    expect(second.body.verifications ?? []).toEqual(first.body.verifications ?? []);
    expect(second.body.loadingConfirmedAt).toBe(first.body.loadingConfirmedAt);
    // The stage-defining facts are all present, i.e. server-held.
    expect(second.body.tankSummary).toBeTruthy();
    expect(second.body.warehouseSummary).toBeTruthy();
    expect(second.body.loadingConfirmedAt).toBeTruthy();
  });

  it('FR-004: an OTP issued to the customer before the switch still verifies afterwards, and no second OTP is issued', async () => {
    const { driver, client } = fixtures.companyA;
    const orderId = await inTransitOrder();

    // Device A: arrive -> issues the ARRIVAL OTP to the customer.
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    const otpRes = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const code = otpRes.body.otp as string;
    expect(code).toMatch(/^\d{6}$/);

    const beforeSwitch = await orderModel.findById(orderId).lean().exec();
    const arrivalOtpsBefore = beforeSwitch!.otps.filter(
      (o: { purpose: string }) => o.purpose === 'ARRIVAL',
    );
    expect(arrivalOtpsBefore).toHaveLength(1);

    // Device B signs in — device A's token is now stale.
    const newToken = await signInAgain();
    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(401);

    // Device B verifies with the code the customer already holds — it works,
    // the order advances, and NO new OTP was minted for that to happen.
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${newToken}`)
      .send({ otp: code })
      .expect(201);

    const afterSwitch = await orderModel.findById(orderId).lean().exec();
    expect(afterSwitch!.status).toBe(OrderStatus.UNLOADING);
    const arrivalOtpsAfter = afterSwitch!.otps.filter(
      (o: { purpose: string }) => o.purpose === 'ARRIVAL',
    );
    expect(arrivalOtpsAfter).toHaveLength(1);
    expect(arrivalOtpsAfter[0].usedAt).toBeTruthy();
  });

  it("FR-010: the replacement session's first fix at the truck's existing position does not advance lastMovedAt — the movement baseline is per-driver and survives the switch", async () => {
    const { driver } = fixtures.companyA;
    await inTransitOrder();

    const baseLat = 24.7136;
    const baseLng = 46.6753;

    // Device A establishes a movement baseline: one accepted fix.
    const socketA = await connectSocket(ctx.url, driver.token);
    openSockets.push(socketA);
    const moveAck = await ackOf<{ ok: boolean; accepted: boolean }>(socketA, 'location:update', {
      lat: baseLat + 0.002,
      lng: baseLng + 0.002,
      recordedAt: new Date().toISOString(),
    });
    expect(moveAck).toMatchObject({ ok: true, accepted: true });

    const afterBaseline = await userModel.findById(driver.id).lean().exec();
    const lastMovedAtBaseline = afterBaseline!.lastMovedAt;
    const lastMovedLocationBaseline = afterBaseline!.lastMovedLocation;
    expect(lastMovedAtBaseline).toBeTruthy();
    socketA.disconnect();

    // Device B signs in and, over its own connection, reports the SAME
    // position the truck already holds — the truck has not moved.
    const newToken = await signInAgain();
    const socketB = await connectSocket(ctx.url, newToken);
    openSockets.push(socketB);

    // Past the 5s abuse ceiling and the 3s test heartbeat, so the frame is
    // accepted on heartbeat — but at an unchanged position.
    await new Promise((r) => setTimeout(r, 5500));
    const sameSpotAck = await ackOf<{ ok: boolean; accepted: boolean }>(
      socketB,
      'location:update',
      {
        lat: baseLat + 0.002,
        lng: baseLng + 0.002,
        recordedAt: new Date().toISOString(),
      },
    );
    expect(sameSpotAck.ok).toBe(true);

    const afterSwitch = await userModel.findById(driver.id).lean().exec();
    // Whether the truck moved is a property of the truck, not the handset:
    // the baseline did not reset, and an unchanged position did not count as
    // movement.
    expect(afterSwitch!.lastMovedAt?.getTime()).toBe(lastMovedAtBaseline?.getTime());
    expect(afterSwitch!.lastMovedLocation).toEqual(lastMovedLocationBaseline);

    socketB.disconnect();
  });

  it('FR-013: every delivery fact the driver acts on comes from the platform — customer, destination, vehicle, tank, warehouse, quantity and fuel grade all survive a device switch', async () => {
    const { driver } = fixtures.companyA;
    const orderId = await inTransitOrder();

    const before = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    // The replacement device: a genuinely new session, not a re-read on the
    // same token. This is the switch FR-013 has to survive.
    const replacementToken = await signInAgain();
    const after = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${replacementToken}`)
      .expect(200);

    // FR-013 names seven facts. The first test in this suite covers the three
    // that define the *stage*; these are the four it did not assert — and
    // quantity and fuel grade are the two a driver acts on most directly at
    // the depot, where getting them from a stale handset cache would load the
    // wrong product.
    expect(after.body.quantityLiters).toBe(before.body.quantityLiters);
    expect(after.body.quantityLiters).toBe(500);
    expect(after.body.fuelType).toBe(before.body.fuelType);
    expect(after.body.fuelType).toBe('DIESEL');
    expect(after.body.clientSummary).toEqual(before.body.clientSummary);
    expect(after.body.driverSummary).toEqual(before.body.driverSummary);
    expect(after.body.tankSummary).toEqual(before.body.tankSummary);
    expect(after.body.warehouseSummary).toEqual(before.body.warehouseSummary);
    // The destination the driver actually navigates to is the point, not the
    // label: this fixture's station is seeded with `addressText: ''`, so an
    // empty string here is the platform's honest answer and asserting it
    // truthy would be asserting the fixture rather than the requirement.
    expect(after.body.deliveryLocation).toEqual(before.body.deliveryLocation);
    expect(after.body.deliveryAddressText).toBe(before.body.deliveryAddressText);

    // "Absence shown as absence" is the other half of FR-013: a field the
    // platform does not hold must be absent, never a fabricated stand-in.
    // These three are genuinely held, so a silently-empty response — which
    // every `toEqual` above would still pass — cannot pass this test.
    expect(after.body.clientSummary).toBeTruthy();
    expect(after.body.driverSummary).toBeTruthy();
    expect(after.body.deliveryLocation).toBeTruthy();
  });

  it('FR-012: the customer keeps receiving the truck position AND its age across the switch, so a frozen dot is never presentable as current', async () => {
    const { driver, client } = fixtures.companyA;
    const orderId = await inTransitOrder();

    // Device A reports one fix, then goes away — the device-change gap.
    const socketA = await connectSocket(ctx.url, driver.token);
    openSockets.push(socketA);
    const ack = await ackOf<{ ok: boolean; accepted: boolean }>(socketA, 'location:update', {
      lat: 24.7136,
      lng: 46.6753,
      recordedAt: new Date().toISOString(),
    });
    expect(ack).toMatchObject({ ok: true, accepted: true });
    socketA.disconnect();

    const duringGap = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    // The position is still served — FR-019: displacement discards no history.
    expect(duringGap.body.driverLocation).toBeTruthy();
    // …and it is served WITH its age. This is the whole of FR-012: without
    // `driverLocationAt` the client has no way to tell a frozen dot from a
    // live one, and spec 011 FR-017a's staleness treatment has no input. A
    // response that dropped this field would still render a truck on the
    // customer's map — which is exactly the failure that makes it worth
    // asserting here rather than trusting.
    expect(duringGap.body.driverLocationAt).toBeTruthy();
    expect(new Date(duringGap.body.driverLocationAt).getTime()).not.toBeNaN();

    // The replacement device reports, and the customer's view advances — the
    // age moves forward rather than the position merely reappearing.
    const replacementToken = await signInAgain();
    const socketB = await connectSocket(ctx.url, replacementToken);
    openSockets.push(socketB);
    await new Promise((r) => setTimeout(r, 5500));
    const resumed = await ackOf<{ ok: boolean; accepted: boolean }>(socketB, 'location:update', {
      lat: 24.7236,
      lng: 46.6853,
      recordedAt: new Date().toISOString(),
    });
    expect(resumed.ok).toBe(true);

    const afterResume = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    expect(new Date(afterResume.body.driverLocationAt).getTime()).toBeGreaterThan(
      new Date(duringGap.body.driverLocationAt).getTime(),
    );

    socketB.disconnect();
  });
});
