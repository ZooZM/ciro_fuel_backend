import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { PresenceService } from '../../src/modules/tracking/presence/presence.service';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

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
  });

  it('marks a silent driver offline (sweep, no waiting) and excludes them from dispatch', async () => {
    const { driver, client, admin } = fixtures.companyA;

    // Simulate 7 minutes of silence directly — no real waiting.
    await userModel.updateOne(
      { _id: driver.id },
      { $set: { lastSeenAt: new Date(Date.now() - 7 * 60_000) } },
    );

    await app.get(PresenceService).sweepOfflineDrivers();

    const afterSweep = await userModel.findById(driver.id).exec();
    expect(afterSweep?.isOnline).toBe(false);

    // With the only driver now offline, dispatch has nobody eligible.
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.APPROVED);
    expect(approveRes.body.driverId).toBeFalsy();
  });

  it('restores dispatch eligibility automatically the moment the driver reconnects', async () => {
    const { driver, client, admin } = fixtures.companyA;

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
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approveRes.body.driverId).toBe(driver.id);
  });

  it('does not disturb an in-progress order when its driver goes silent', async () => {
    const { driver, client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
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
    expect(orderAfterSweep.body.status).toBe(OrderStatus.PENDING_PAYMENT);
  });
});
