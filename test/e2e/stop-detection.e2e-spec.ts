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
import { Notification, NotificationDocument } from '../../src/modules/notifications/schemas/notification.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { StopOrigin } from '../../src/common/enums/stop-origin.enum';
import { NotificationType } from '../../src/common/enums/notification-type.enum';

jest.setTimeout(120_000);

/**
 * spec 011 T013-T015 (FR-001, FR-002, FR-004, FR-017): the sweep's own
 * decisions, against a real in-transit delivery.
 *
 * Time is manipulated by writing `lastMovedAt` directly rather than by
 * waiting — the window is ten minutes in production and the point under
 * test is the rule, not the clock.
 */
describe('Stop detection sweep (spec 011 US1)', () => {
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

  /** Drives a delivery all the way to IN_TRANSIT — the only leg this
   *  feature covers. `assignAndDepart` is the existing fixture helper that
   *  assigns, verifies the vehicle and confirms loading. */
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

  /** Puts the driver in the state the sweep looks for: holding this
   *  delivery, last genuine movement `minutesAgo` in the past. */
  async function setDriverLastMoved(minutesAgo: number | null): Promise<void> {
    const { driver } = fixtures.companyA;
    if (minutesAgo === null) {
      await userModel.updateOne({ _id: driver.id }, { $unset: { lastMovedAt: '' } }).exec();
      return;
    }
    await userModel
      .updateOne(
        { _id: driver.id },
        { $set: { lastMovedAt: new Date(Date.now() - minutesAgo * 60_000) } },
      )
      .exec();
  }

  afterEach(async () => {
    // The fixture's driver/truck/tank stay committed to the delivery each
    // test creates, so without this the next test's assignment 409s — the
    // shared-fixture hazard this repo's other dispatch suites hit too.
    await resetFixtureDispatchState(app, fixtures.companyA);
    await orderModel.updateMany({}, { $set: { stopEvents: [] } }).exec();
    await notificationModel.deleteMany({ type: NotificationType.DRIVER_STOP_DETECTED }).exec();
  });

  it('raises a DETECTED stop and notifies the driver when the truck has not moved past the window (FR-001, FR-004)', async () => {
    const orderId = await inTransitOrder();
    await setDriverLastMoved(30);

    await sweep.sweepStalledDeliveries();

    const order = await orderModel.findById(orderId).exec();
    expect(order?.stopEvents).toHaveLength(1);
    expect(order?.stopEvents[0].origin).toBe(StopOrigin.DETECTED);
    expect(order?.stopEvents[0].reasonGivenAt).toBeUndefined();

    const notification = await notificationModel
      .findOne({
        recipientUserId: fixtures.companyA.driver.id,
        type: NotificationType.DRIVER_STOP_DETECTED,
        orderId,
      })
      .exec();
    expect(notification).not.toBeNull();
    // The app needs this to open the prompt for the right stop, and to
    // answer it — the reason endpoint is addressed by stopId.
    expect(notification?.payload.stopId).toBe(String((order?.stopEvents[0] as never as { _id: unknown })._id));
  });

  it('raises nothing for a driver who is still moving (SC-002)', async () => {
    const orderId = await inTransitOrder();
    await setDriverLastMoved(1); // well inside the 10-minute window

    await sweep.sweepStalledDeliveries();

    const order = await orderModel.findById(orderId).exec();
    expect(order?.stopEvents).toHaveLength(0);
  });

  it('raises nothing for a stationary truck outside the in-transit leg (FR-002)', async () => {
    const orderId = await inTransitOrder();
    await setDriverLastMoved(30);
    // A truck parked at the warehouse or the customer's gate is expected,
    // not an incident — only IN_TRANSIT is this feature's business.
    for (const status of [OrderStatus.LOADING, OrderStatus.UNLOADING, OrderStatus.DELIVERED]) {
      await orderModel.updateOne({ _id: orderId }, { $set: { status } }).exec();
      await sweep.sweepStalledDeliveries();
      const order = await orderModel.findById(orderId).exec();
      expect(order?.stopEvents).toHaveLength(0);
    }
  });

  it('raises nothing for a driver whose device has gone silent entirely (FR-017)', async () => {
    const orderId = await inTransitOrder();
    // Never sent a fix at all: no lastMovedAt, and no lastSeenAt either.
    // Silence is not stillness — the platform cannot tell a stopped truck
    // from a dead phone, so it must not claim to.
    await setDriverLastMoved(null);
    await userModel
      .updateOne({ _id: fixtures.companyA.driver.id }, { $unset: { lastSeenAt: '' } })
      .exec();

    await sweep.sweepStalledDeliveries();

    const order = await orderModel.findById(orderId).exec();
    expect(order?.stopEvents).toHaveLength(0);
  });

  it('never opens a second stop while one is already unresolved (FR-016, SC-008)', async () => {
    const orderId = await inTransitOrder();
    await setDriverLastMoved(30);

    // Three sweeps against the same stalled delivery — a stop stays stopped,
    // so this is the ordinary case, not an edge one.
    await sweep.sweepStalledDeliveries();
    await sweep.sweepStalledDeliveries();
    await sweep.sweepStalledDeliveries();

    const order = await orderModel.findById(orderId).exec();
    expect(order?.stopEvents).toHaveLength(1);
  });

  it('raises a NEW stop after the driver resolves one, moves again, and stops again (FR-015)', async () => {
    const orderId = await inTransitOrder();
    await setDriverLastMoved(30);
    await sweep.sweepStalledDeliveries();

    // The driver answers, which resolves the first stop.
    await orderModel
      .updateOne(
        { _id: orderId },
        { $set: { 'stopEvents.0.reasonGivenAt': new Date(), 'stopEvents.0.resolvedAt': new Date() } },
      )
      .exec();

    // They drive on, then stall again somewhere else entirely.
    await setDriverLastMoved(30);
    await sweep.sweepStalledDeliveries();

    const order = await orderModel.findById(orderId).exec();
    expect(order?.stopEvents).toHaveLength(2);
    expect(order?.stopEvents[1].resolvedAt).toBeUndefined();
  });
});
