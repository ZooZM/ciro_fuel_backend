import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  assignAndDepart,
  resetFixtureDispatchState,
  DEFAULT_PASSWORD,
} from '../utils/fixtures';
import { RealtimeGatewayService } from '../../src/common/realtime/realtime-gateway.service';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { Order, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import {
  SessionEvent,
  SessionEventDocument,
} from '../../src/modules/sessions/schemas/session-event.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function connectSocket(url: string, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${url}/tracking`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function ackOf<T>(
  socket: ClientSocket,
  event: string,
  payload: unknown,
  timeoutMs = 3000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.emit(event, payload, (ack: T) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

/**
 * feature 013 US2 (research R2, R11, R12): a displaced device cannot report a
 * truck's position or feed the movement bookkeeping behind stop detection —
 * enforced by the platform, per frame, not by the device's cooperation.
 *
 * **The trap (research R12).** A displaced device reporting the *same*
 * position proves nothing: the 50 m displacement threshold rejects that
 * frame regardless. Every refused-frame case here reports from a materially
 * different location, and asserts the truck's recorded position AND
 * `lastMovedAt` are both unchanged.
 */
describe('Session displacement enforcement (feature 013 US2)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;
  let orderModel: Model<OrderDocument>;
  let sessionEventModel: Model<SessionEventDocument>;
  let realtimeGateway: RealtimeGatewayService;
  const openSockets: ClientSocket[] = [];

  const BASE: [number, number] = [46.6753, 24.7136]; // [lng, lat]
  const FAR: [number, number] = [46.9, 24.95]; // ~30 km away — unambiguously "moved"

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    userModel = app.get(getModelToken(User.name));
    orderModel = app.get(getModelToken(Order.name));
    sessionEventModel = app.get(getModelToken(SessionEvent.name));
    realtimeGateway = app.get(RealtimeGatewayService);
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
    fixtures.companyA.driver.token = await signInAgain();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function signInAgain(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);
    return res.body.accessToken as string;
  }

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

  function driverState() {
    return userModel.findById(fixtures.companyA.driver.id).lean().exec();
  }

  it('refuses a location:update from a displaced device reporting from a MATERIALLY DIFFERENT location, and changes nothing', async () => {
    // Keep the first socket alive past the displacement so the per-frame
    // check is what we observe — not the tidy-up disconnect (asserted
    // separately below).
    const disconnectSpy = jest
      .spyOn(realtimeGateway, 'disconnectUser')
      .mockImplementation(() => undefined);

    await inTransitOrder();
    const socketA = await connectSocket(ctx.url, fixtures.companyA.driver.token);
    openSockets.push(socketA);

    // One accepted frame so there is a real position to protect.
    const firstAck = await ackOf<{ ok: boolean; accepted: boolean }>(socketA, 'location:update', {
      lat: BASE[1] + 0.001,
      lng: BASE[0] + 0.001,
      recordedAt: new Date().toISOString(),
    });
    expect(firstAck).toMatchObject({ ok: true, accepted: true });

    // Device B signs in — device A is now displaced. Snapshot the account
    // AFTER the displacement, BEFORE the refused frame, so the frame's
    // effect (none) is isolated.
    await signInAgain();
    const before = await driverState();

    const refusedAck = await ackOf<{ ok: boolean; error?: string }>(socketA, 'location:update', {
      lat: FAR[1],
      lng: FAR[0],
      recordedAt: new Date().toISOString(),
    });
    expect(refusedAck).toEqual({ ok: false, error: 'SESSION_REVOKED' });

    const after = await driverState();
    // T025: position untouched.
    expect(after!.location).toEqual(before!.location);
    expect(after!.locationUpdatedAt?.getTime()).toBe(before!.locationUpdatedAt?.getTime());
    // T026: movement bookkeeping untouched — a refused frame must not feed
    // spec 011's stop detection.
    expect(after!.lastMovedAt?.getTime()).toBe(before!.lastMovedAt?.getTime());
    expect(after!.lastMovedLocation).toEqual(before!.lastMovedLocation);
    // T027: presence untouched — proving the touch() reordering landed (the
    // sgen check now runs before it).
    expect(after!.isOnline).toBe(before!.isOnline);
    expect(after!.lastSeenAt?.getTime()).toBe(before!.lastSeenAt?.getTime());

    expect(disconnectSpy).toHaveBeenCalledWith(fixtures.companyA.driver.id);
  });

  it('T029: a displaced device reconnecting is refused at the handshake (UNAUTHORIZED)', async () => {
    const staleToken = fixtures.companyA.driver.token;
    await signInAgain(); // displaces staleToken

    await expect(connectSocket(ctx.url, staleToken)).rejects.toBeDefined();
  });

  it('T031: displacement writes a REVOKED (SIGNED_IN_ELSEWHERE) row and a SIGNED_IN row — existing behaviour, no new audit machinery', async () => {
    const driverId = new Types.ObjectId(fixtures.companyA.driver.id);
    const countBefore = await sessionEventModel.countDocuments({ userId: driverId }).exec();

    await signInAgain();

    const rows = await sessionEventModel
      .find({ userId: driverId })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    expect(rows.length).toBe(countBefore + 2);
    const added = rows.slice(-2);
    expect(added.map((r) => r.type).sort()).toEqual(['REVOKED', 'SIGNED_IN']);
    const revoked = added.find((r) => r.type === 'REVOKED')!;
    expect(revoked.cause).toBe('SIGNED_IN_ELSEWHERE');
  });

  it('T031a / FR-020: with both sessions live, the current session always wins — even when the displaced frame arrives LAST', async () => {
    // Both sockets stay open: bump the generation directly rather than
    // through login, so no tidy-up disconnect fires and the ordering is
    // what is actually under test.
    jest.spyOn(realtimeGateway, 'disconnectUser').mockImplementation(() => undefined);
    await inTransitOrder();

    const staleToken = fixtures.companyA.driver.token;
    const socketOld = await connectSocket(ctx.url, staleToken);
    openSockets.push(socketOld);

    const freshToken = await signInAgain();
    const socketNew = await connectSocket(ctx.url, freshToken);
    openSockets.push(socketNew);

    // Current session establishes the truck's position P1. Retry past the
    // fixed 5 s abuse ceiling until a frame is accepted, so this is not
    // sensitive to whatever the driver's last `locationUpdatedAt` was.
    const p1: [number, number] = [BASE[0] + 0.01, BASE[1] + 0.01];
    const p2: [number, number] = FAR;
    let accepted = false;
    for (let i = 0; i < 4 && !accepted; i++) {
      const ack = await ackOf<{ ok: boolean; accepted: boolean }>(socketNew, 'location:update', {
        lat: p1[1],
        lng: p1[0],
        recordedAt: new Date().toISOString(),
      });
      accepted = ack?.accepted === true;
      if (!accepted) await new Promise((r) => setTimeout(r, 5500));
    }
    expect(accepted).toBe(true);
    const afterP1 = await driverState();

    // Now the displaced session reports a very different position, arriving
    // LAST — past the abuse ceiling, so nothing but the sgen check stops it.
    await new Promise((r) => setTimeout(r, 5500));
    const staleAck = await ackOf<{ ok: boolean; error?: string }>(socketOld, 'location:update', {
      lat: p2[1],
      lng: p2[0],
      recordedAt: new Date().toISOString(),
    });
    expect(staleAck).toEqual({ ok: false, error: 'SESSION_REVOKED' });

    const state = await driverState();
    // The truck's recorded position is still the CURRENT session's — the
    // most recent frame received did not win.
    expect(state!.location).toEqual(afterP1!.location);
    expect(state!.location?.coordinates[0]).toBeCloseTo(p1[0], 4);
    expect(state!.location?.coordinates[1]).toBeCloseTo(p1[1], 4);
  });
});
