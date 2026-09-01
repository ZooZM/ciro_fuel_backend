import request from 'supertest';
import { createHmac } from 'node:crypto';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  CompanyFixture,
  TwoCompanyFixture,
  assignAndDepart,
  resetFixtureDispatchState,
} from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

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

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * spec 007 research R1 (T004/T005): before this feature, an order status
 * change could never reach a driver by any path. `TrackingGateway.watch`
 * refuses `UserRole.DRIVER` outright with `FORBIDDEN_ROLE` — that room also
 * carries the client's live driver-position feed — so `order:status`, emitted
 * only to the order room, was unreachable for a driver no matter what they
 * did. This is the test that proves the second emit (to `user:{driverId}`)
 * actually closes that gap, not just that it doesn't throw.
 */
describe('Driver realtime — order:status reaches the assigned driver (spec 007 research R1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    openSockets.forEach((s) => s.disconnect());
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    // Both fixture drivers are shared across e2e files within this suite
    // run; reset each to available so dispatch succeeds regardless of what
    // ran before.
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    await userModel.updateMany(
      { _id: { $in: [fixtures.companyA.driver.id, fixtures.companyB.driver.id] } },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
    await resetFixtureDispatchState(app, fixtures.companyA, fixtures.companyB);
  });

  async function bringOrderToInTransit(company: CompanyFixture): Promise<string> {
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${company.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const orderId = createRes.body._id;
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${company.admin.token}`)
      .send({})
      .expect(200);
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-realtime-${orderId}`,
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
    await assignAndDepart(
      app,
      orderId,
      company.transportAdmin.token,
      company.driver.token,
      company.driver.id,
      company.truck.id,
      company.tank.id,
      company.truck.nfcCardUid,
    );
    return orderId;
  }

  it("pushes order:status into the assigned driver's own socket, and only that driver's", async () => {
    const server = app.getHttpServer();
    const orderIdA = await bringOrderToInTransit(fixtures.companyA);

    const driverASocket = await connectSocket(ctx.url, fixtures.companyA.driver.token);
    openSockets.push(driverASocket);
    const driverBSocket = await connectSocket(ctx.url, fixtures.companyB.driver.token);
    openSockets.push(driverBSocket);

    const driverAEvent = waitForEvent<{ orderId: string; from: string; to: string }>(
      driverASocket,
      'order:status',
    );
    const driverBEvent = waitForEvent(driverBSocket, 'order:status');

    // Trigger a real transition: IN_TRANSIT -> UNLOADING via the arrival
    // handover, exactly as a driver in the field would.
    await request(server)
      .post(`/api/v1/orders/${orderIdA}/arrive`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(201);
    const arrivalOtpRes = await request(server)
      .get(`/api/v1/orders/${orderIdA}/otp/current`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/orders/${orderIdA}/verify-arrival`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ otp: arrivalOtpRes.body.otp })
      .expect(201);

    const payload = await driverAEvent;
    expect(payload).not.toBeNull();
    expect(payload?.orderId).toBe(orderIdA);
    expect(payload?.from).toBe(OrderStatus.IN_TRANSIT);
    expect(payload?.to).toBe(OrderStatus.UNLOADING);

    // The other company's driver — not assigned to this order — receives
    // nothing. Before this feature this assertion would have trivially
    // passed for the wrong reason: NEITHER driver could ever receive
    // order:status. driverAEvent resolving above is what proves this
    // negative actually means something here.
    expect(await driverBEvent).toBeNull();
  });
});
