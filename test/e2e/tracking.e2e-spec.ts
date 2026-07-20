import request from 'supertest';
import { createHmac } from 'node:crypto';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

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

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('Real-time tracking (US4) — displacement/heartbeat policy & authorization', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    // 3-second heartbeat for this file only, so the heartbeat-acceptance test
    // doesn't need to wait the real 3-minute production default.
    process.env.TRACKING_HEARTBEAT_MINUTES = '0.05';
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    openSockets.forEach((s) => s.disconnect());
    await ctx.close();
    delete process.env.TRACKING_HEARTBEAT_MINUTES;
  }, 30_000);

  // Each test dispatches (consumes) companyA's single fixture driver; reset
  // it to available before every test so dispatch always succeeds
  // independently of prior tests' outcomes (same pattern as other e2e files).
  beforeEach(async () => {
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
  });

  async function bringOrderToInTransit(): Promise<string> {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const orderId = createRes.body._id;
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-trk-${orderId}`,
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
    return orderId;
  }

  it('rejects a connection with an invalid token (connect_error)', async () => {
    await expect(connectSocket(ctx.url, 'not-a-real-jwt')).rejects.toBeDefined();
  });

  it('broadcasts on >50m displacement, drops sub-threshold moves, and accepts on heartbeat', async () => {
    const { driver, client } = fixtures.companyA;
    const orderId = await bringOrderToInTransit();

    const driverSocket = await connectSocket(ctx.url, driver.token);
    const clientSocket = await connectSocket(ctx.url, client.token);
    openSockets.push(driverSocket, clientSocket);

    const watchAck = await ackOf<{ ok: boolean }>(clientSocket, 'order:watch', { orderId });
    expect(watchAck.ok).toBe(true);

    // Driver's fixture location is [center, center]; ~0.001deg ≈ 111m, well over 50m.
    const baseLat = 24.7136;
    const baseLng = 46.6753;

    const bigMoveAckPromise = ackOf<{ ok: boolean; accepted: boolean }>(
      driverSocket,
      'location:update',
      {
        lat: baseLat + 0.001,
        lng: baseLng + 0.001,
        recordedAt: new Date().toISOString(),
      },
    );
    const locationEventPromise = waitForEvent<{ orderId: string; lat: number }>(
      clientSocket,
      'order:location',
    );
    const [bigMoveAck, locationEvent] = await Promise.all([
      bigMoveAckPromise,
      locationEventPromise,
    ]);
    expect(bigMoveAck).toEqual({ ok: true, accepted: true });
    expect(locationEvent?.orderId).toBe(orderId);

    // Tiny move immediately after — below both the 50m and heartbeat thresholds.
    const tinyMoveAck = await ackOf<{ ok: boolean; accepted: boolean; reason?: string }>(
      driverSocket,
      'location:update',
      { lat: baseLat + 0.001001, lng: baseLng + 0.001001, recordedAt: new Date().toISOString() },
    );
    expect(tinyMoveAck).toEqual({ ok: true, accepted: false, reason: 'BELOW_THRESHOLD' });

    // Wait past BOTH the fixed 5s abuse ceiling and the 3s test heartbeat,
    // then send the same tiny move — heartbeat alone should accept it.
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const heartbeatAck = await ackOf<{ ok: boolean; accepted: boolean }>(
      driverSocket,
      'location:update',
      {
        lat: baseLat + 0.001002,
        lng: baseLng + 0.001002,
        recordedAt: new Date().toISOString(),
      },
    );
    expect(heartbeatAck).toEqual({ ok: true, accepted: true });
  });

  it('returns NOT_FOUND when watching another company’s order', async () => {
    const orderId = await bringOrderToInTransit();
    const bSocket = await connectSocket(ctx.url, fixtures.companyB.client.token);
    openSockets.push(bSocket);

    const ack = await ackOf<{ ok: boolean; error?: string }>(bSocket, 'order:watch', { orderId });
    expect(ack).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('never emits the OTP event to the driver’s own socket', async () => {
    const { driver } = fixtures.companyA;
    const orderId = await bringOrderToInTransit();

    const driverSocket = await connectSocket(ctx.url, driver.token);
    openSockets.push(driverSocket);
    const otpEventPromise = waitForEvent(driverSocket, 'order:otp', 1500);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    const otpEvent = await otpEventPromise;
    expect(otpEvent).toBeNull();
  });
});
