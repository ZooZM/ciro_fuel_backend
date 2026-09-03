import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  assignAndDepart,
  resetFixtureDispatchState,
} from '../utils/fixtures';
import { StopDetectionService } from '../../src/modules/stop-detection/stop-detection.service';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { Order, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import {
  Notification,
  NotificationDocument,
} from '../../src/modules/notifications/schemas/notification.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

/**
 * feature 013 US5a (FR-039a, FR-039b, research R5): a driver who cannot reach
 * the destination files a report, the transporter is told immediately, and
 * stop detection stays armed — the three things filing it as a plain
 * declaration would each get wrong.
 */
describe('Driver blocked report (feature 013 US5a)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let sweep: StopDetectionService;
  let userModel: Model<UserDocument>;
  let orderModel: Model<OrderDocument>;
  let notificationModel: Model<NotificationDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    sweep = app.get(StopDetectionService);
    userModel = app.get(getModelToken(User.name));
    orderModel = app.get(getModelToken(Order.name));
    notificationModel = app.get(getModelToken(Notification.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await userModel.updateMany(
      { _id: { $in: [fixtures.companyA.driver.id, fixtures.companyB.driver.id] } },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '', lastMovedAt: '' } },
    );
    await resetFixtureDispatchState(app, fixtures.companyA, fixtures.companyB);
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
    expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.IN_TRANSIT);
    return orderId;
  }

  function reportBlocked(orderId: string, token: string, reason = 'ROAD_CLOSURE') {
    return request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/blocked`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason });
  }

  it('T054: appends a BLOCKED stop — reasonGivenAt + escalatedAt set, resolvedAt null, NO suppressedUntil', async () => {
    const { driver } = fixtures.companyA;
    const orderId = await inTransitOrder();

    await reportBlocked(orderId, driver.token).expect(201);

    const order = await orderModel.findById(orderId).lean().exec();
    expect(order!.stopEvents).toHaveLength(1);
    const stop = order!.stopEvents[0] as unknown as Record<string, unknown>;
    expect(stop.origin).toBe('BLOCKED');
    expect(stop.reason).toBe('ROAD_CLOSURE');
    expect(stop.reasonGivenAt).toBeTruthy();
    expect(stop.escalatedAt).toBeTruthy();
    expect(stop.resolvedAt ?? null).toBeNull();
    expect(stop.suppressedUntil ?? undefined).toBeUndefined();
  });

  it("T055: the transport company's admins are notified immediately — no response window", async () => {
    const { driver, transportAdmin } = fixtures.companyA;
    const orderId = await inTransitOrder();

    await reportBlocked(orderId, driver.token).expect(201);

    const notes = await notificationModel
      .find({ recipientUserId: transportAdmin.id, type: 'ORDER_DRIVER_BLOCKED' })
      .lean()
      .exec();
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].orderId?.toString()).toBe(orderId);
    expect((notes[0].payload as Record<string, unknown>).reason).toBe('ROAD_CLOSURE');
  });

  it('T056: detection is NOT suppressed — a still-stalled truck gets a fresh DETECTED stop once the block is resolved', async () => {
    const { driver, transportAdmin } = fixtures.companyA;
    const orderId = await inTransitOrder();

    await reportBlocked(orderId, driver.token).expect(201);

    // Age the movement clock well past the window and sweep. The BLOCKED
    // stop is still open, so the one-open-stop invariant (correctly) stops a
    // duplicate — but nothing was *switched off*.
    await userModel.updateOne(
      { _id: driver.id },
      {
        $set: {
          lastMovedAt: new Date(Date.now() - 60 * 60_000),
          lastMovedLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
        },
      },
    );
    await sweep.sweepStalledDeliveries();
    let order = await orderModel.findById(orderId).lean().exec();
    expect(order!.stopEvents).toHaveLength(1);

    // Transporter resolves the block. The truck is still parked.
    const stopId = String((order!.stopEvents[0] as unknown as { _id: unknown })._id);
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/stops/${stopId}/resolve`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .expect(200);

    await sweep.sweepStalledDeliveries();
    order = await orderModel.findById(orderId).lean().exec();
    // A brand-new DETECTED stop — detection was armed the whole time. Filing
    // the report as a declaration would have left `suppressedUntil` in place
    // and this second stop would never appear (research R5, FR-039b).
    expect(order!.stopEvents).toHaveLength(2);
    expect((order!.stopEvents[1] as unknown as { origin: string }).origin).toBe('DETECTED');
  });

  it("T057: a second report while a stop is open is 409 STOP_ALREADY_OPEN and creates no second open stop; non-IN_TRANSIT is refused; another driver's order is 404 not 403", async () => {
    const { driver } = fixtures.companyA;
    const { driver: otherDriver } = fixtures.companyB;
    const orderId = await inTransitOrder();

    await reportBlocked(orderId, driver.token).expect(201);

    const dup = await reportBlocked(orderId, driver.token).expect(409);
    expect(dup.body.error).toBe('STOP_ALREADY_OPEN');
    const order = await orderModel.findById(orderId).lean().exec();
    expect(order!.stopEvents).toHaveLength(1);

    // Another driver's order — indistinguishable from "no such order".
    await reportBlocked(orderId, otherDriver.token).expect(404);

    // A non-IN_TRANSIT order (a fresh, unassigned one) is refused.
    const freshRes = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);
    await reportBlocked(freshRes.body._id, driver.token).expect(404);
  });

  it('T058: the existing resolve endpoint closes a BLOCKED stop for a TRANSPORT_COMPANY_ADMIN and no other role', async () => {
    const { driver, transportAdmin, admin, client } = fixtures.companyA;
    const orderId = await inTransitOrder();
    await reportBlocked(orderId, driver.token).expect(201);
    const order = await orderModel.findById(orderId).lean().exec();
    const stopId = String((order!.stopEvents[0] as unknown as { _id: unknown })._id);
    const path = `/api/v1/orders/${orderId}/stops/${stopId}/resolve`;

    // Not the driver, the fuel-company admin, or the client.
    await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(403);
    await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403);
    await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(403);

    await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .expect(200);

    const after = await orderModel.findById(orderId).lean().exec();
    expect((after!.stopEvents[0] as unknown as { resolvedAt: unknown }).resolvedAt).toBeTruthy();
  });
});
