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
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { StopOrigin } from '../../src/common/enums/stop-origin.enum';
import { StopReason } from '../../src/common/enums/stop-reason.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(120_000);

/**
 * spec 011 T029-T031 (FR-005 to FR-008d, FR-010, FR-016): the driver's own
 * two actions — answering a stop they were asked about, and declaring one
 * before anyone asked.
 */
describe('Driver stop reasons (spec 011 US2)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let sweep: StopDetectionService;
  let userModel: Model<UserDocument>;
  let orderModel: Model<OrderDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    sweep = app.get(StopDetectionService);
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

  /** Raises a real DETECTED stop through the sweep — never by writing the
   *  event directly, so these tests exercise the same shape production makes. */
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
  });

  it('records a reason, resolves the stop, and shows it on the order (FR-007)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ reason: StopReason.TRAFFIC })
      .expect(201);

    const order = await orderModel.findById(orderId).exec();
    const stop = order!.stopEvents[0];
    expect(stop.reason).toBe(StopReason.TRAFFIC);
    expect(stop.reasonGivenAt).toBeInstanceOf(Date);
    // An explained stop needs no administrator action, so answering resolves
    // it — and `resolvedBy` stays absent, which is what distinguishes the
    // driver answering from an admin marking it handled.
    expect(stop.resolvedAt).toBeInstanceOf(Date);
    expect(stop.resolvedBy).toBeUndefined();
  });

  it('refuses a reason for an order that is not this driver’s, indistinguishably from absent (FR-007)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);

    // Another company's driver. A 403 here would confirm the order exists
    // and belongs to someone — the platform's standing discipline is that
    // not-yours and not-found are the same answer.
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .send({ reason: StopReason.TRAFFIC })
      .expect(404);
  });

  it('requires reasonText only for OTHER (FR-006)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);
    const server = app.getHttpServer();
    const auth = `Bearer ${fixtures.companyA.driver.token}`;

    await request(server)
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', auth)
      .send({ reason: StopReason.OTHER })
      .expect(400);

    await request(server)
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', auth)
      .send({ reason: StopReason.OTHER, reasonText: 'Blocked by a police checkpoint' })
      .expect(201);
  });

  it('refuses a second reason for a stop already answered (STOP_ALREADY_ANSWERED)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);
    const server = app.getHttpServer();
    const auth = `Bearer ${fixtures.companyA.driver.token}`;

    await request(server)
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', auth)
      .send({ reason: StopReason.TRAFFIC })
      .expect(201);

    const res = await request(server)
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', auth)
      .send({ reason: StopReason.ACCIDENT })
      .expect(409);
    expect(res.body.error).toBe(ErrorCode.STOP_ALREADY_ANSWERED);
  });

  it('records a reason submitted AFTER escalation as an ordinary success (FR-010)', async () => {
    const orderId = await inTransitOrder();
    const stopId = await raiseStop(orderId);

    // The response window elapsed and the transporter was told.
    await orderModel
      .updateOne({ _id: orderId }, { $set: { 'stopEvents.0.escalatedAt': new Date() } })
      .exec();

    // This is the case most likely to be coded as a rejection by reflex. It
    // is not one: the driver answering late is still the driver answering.
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/${stopId}/reason`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ reason: StopReason.VEHICLE_PROBLEM })
      .expect(201);

    const order = await orderModel.findById(orderId).exec();
    const stop = order!.stopEvents[0];
    expect(stop.reason).toBe(StopReason.VEHICLE_PROBLEM);
    expect(stop.resolvedAt).toBeInstanceOf(Date);
    // Left in place deliberately: the transporter WAS alerted, and erasing
    // that would make the delivery's record lie about what happened.
    expect(stop.escalatedAt).toBeInstanceOf(Date);
  });

  it('creates an already-answered DECLARED stop that never prompts (FR-008a-c)', async () => {
    const orderId = await inTransitOrder();

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/declare`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ reason: StopReason.REST_OR_PRAYER, expectedDurationMinutes: 20 })
      .expect(201);

    const order = await orderModel.findById(orderId).exec();
    const stop = order!.stopEvents[0];
    expect(stop.origin).toBe(StopOrigin.DECLARED);
    // It arrives carrying its own answer — which is exactly why nothing ever
    // prompts for it and nothing ever escalates it.
    expect(stop.reasonGivenAt).toBeInstanceOf(Date);
    expect(stop.resolvedAt).toBeInstanceOf(Date);
    expect(stop.suppressedUntil).toBeInstanceOf(Date);

    // And the sweep leaves it alone while the declared window holds, even
    // though the driver is, by definition, not moving.
    await userModel
      .updateOne(
        { _id: fixtures.companyA.driver.id },
        { $set: { lastMovedAt: new Date(Date.now() - 30 * 60_000) } },
      )
      .exec();
    await sweep.sweepStalledDeliveries();
    const after = await orderModel.findById(orderId).exec();
    expect(after!.stopEvents).toHaveLength(1);
  });

  it('refuses a declaration while a detected stop is still open (FR-016)', async () => {
    const orderId = await inTransitOrder();
    await raiseStop(orderId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/declare`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ reason: StopReason.TRAFFIC, expectedDurationMinutes: 15 })
      .expect(409);
    expect(res.body.error).toBe(ErrorCode.STOP_ALREADY_OPEN);
  });

  it('refuses a declaration outside IN_TRANSIT (FR-002)', async () => {
    const orderId = await inTransitOrder();
    // A truck parked at the customer's gate is where it is meant to be.
    await orderModel
      .updateOne({ _id: orderId }, { $set: { status: OrderStatus.UNLOADING } })
      .exec();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/declare`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ reason: StopReason.TRAFFIC, expectedDurationMinutes: 15 })
      .expect(409);
    expect(res.body.error).toBe(ErrorCode.STOP_NOT_IN_TRANSIT);
  });

  // T059: the privacy boundary data-model.md's closing note names. Framed as
  // safety and delivery visibility for the transporter who EMPLOYS the driver
  // — widening the audience to the customer would change what this feature
  // is. Asserted on both client-facing shapes, because the strip lives in one
  // shared helper precisely so a second endpoint cannot quietly lack it (the
  // spec 008 leak that taught this lesson).
  it('never shows a CLIENT the stop trail, on detail or on their own list (FR-018a)', async () => {
    const orderId = await inTransitOrder();
    await raiseStop(orderId);
    const server = app.getHttpServer();
    const clientAuth = `Bearer ${fixtures.companyA.client.token}`;

    const detail = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', clientAuth)
      .expect(200);
    expect(detail.body.stopEvents).toBeUndefined();

    const list = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', clientAuth)
      .expect(200);
    for (const item of list.body.items) {
      expect(item.stopEvents).toBeUndefined();
    }

    // And the transporter, who is the intended audience, does see it.
    const operator = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(operator.body.stopEvents).toHaveLength(1);
  });

  it('refuses a declaration on another driver’s order as not found (FR-007)', async () => {
    const orderId = await inTransitOrder();

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/stops/declare`)
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .send({ reason: StopReason.TRAFFIC, expectedDurationMinutes: 15 })
      .expect(404);
  });
});
