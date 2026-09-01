import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { getQueueToken } from '@nestjs/bullmq';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  assignAndDepart,
  resetFixtureDispatchState,
} from '../utils/fixtures';
import { StopDetectionService } from '../../src/modules/stop-detection/stop-detection.service';
import { STOP_ESCALATION_QUEUE } from '../../src/modules/stop-detection/queues/stop-escalation-queue.service';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { Order, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { StopReason } from '../../src/common/enums/stop-reason.enum';

jest.setTimeout(120_000);

/**
 * spec 011 T045 (FR-009, FR-014): the escalation timer's lifecycle against
 * real Redis — that it is armed when a stop is raised, and disarmed the
 * moment the stop stops mattering.
 *
 * Cancellation is the half that fails silently. A timer that is never
 * cancelled still fires, and the transporter is alerted about a delivery
 * that was cancelled or completed minutes earlier — an alarm about a
 * problem that no longer exists, which is how people learn to ignore
 * alarms.
 */
describe('Stop escalation lifecycle (spec 011 US3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let sweep: StopDetectionService;
  let escalationQueue: Queue;
  let userModel: Model<UserDocument>;
  let orderModel: Model<OrderDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    sweep = app.get(StopDetectionService);
    escalationQueue = app.get(getQueueToken(STOP_ESCALATION_QUEUE));
    userModel = app.get(getModelToken(User.name));
    orderModel = app.get(getModelToken(Order.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

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
    return orderId;
  }

  async function raiseStop(orderId: string): Promise<string> {
    await userModel
      .updateOne(
        { _id: fixtures.companyA.driver.id },
        { $set: { lastMovedAt: new Date(Date.now() - 30 * 60_000) } },
      )
      .exec();
    await sweep.sweepStalledDeliveries();
    const order = await orderModel.findById(orderId).exec();
    expect(order?.stopEvents).toHaveLength(1);
    return String((order!.stopEvents[0] as never as { _id: unknown })._id);
  }

  afterEach(async () => {
    await resetFixtureDispatchState(app, fixtures.companyA);
    await orderModel.updateMany({}, { $set: { stopEvents: [] } }).exec();
    await escalationQueue.obliterate({ force: true }).catch(() => undefined);
  });

  it('arms the timer when a stop is raised, keyed by the stop id', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);

    // `jobId = stopId` is the reason `StopEvent` keeps its `_id` while every
    // other embedded sub-schema on Order disables it.
    expect(await escalationQueue.getJob(stopId)).toBeDefined();
  });

  it('cancels the timer when the driver answers (FR-009)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);
    expect(await escalationQueue.getJob(stopId)).toBeDefined();

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ reason: StopReason.TRAFFIC })
      .expect(201);

    expect(await escalationQueue.getJob(stopId)).toBeUndefined();
  });

  it('cancels the timer when the delivery completes normally (FR-014)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);
    expect(await escalationQueue.getJob(stopId)).toBeDefined();

    // The driver was stopped, then drove on and delivered without ever
    // answering — entirely plausible, and the case where a stale timer does
    // the most damage: the transporter would be alerted about an unexplained
    // stop on a delivery that had already finished.
    const server = app.getHttpServer();
    const { client, driver } = fixtures.companyA;
    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);
    const arrivalOtp = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: arrivalOtp.body.otp })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderId}/request-delivery-otp`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);
    const deliveryOtp = await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/orders/${orderId}/verify-delivery`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: deliveryOtp.body.otp })
      .expect(201);

    const order = await orderModel.findById(orderId).exec();
    expect(order?.status).toBe(OrderStatus.DELIVERED);
    expect(await escalationQueue.getJob(stopId)).toBeUndefined();
  });

  it('cancels the timer when the delivery is force-completed (FR-014)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);
    expect(await escalationQueue.getJob(stopId)).toBeDefined();

    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ reason: 'Confirmed delivered by phone' })
      .expect(200);

    expect(await escalationQueue.getJob(stopId)).toBeUndefined();
  });
});
