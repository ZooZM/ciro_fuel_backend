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

jest.setTimeout(120_000);

/**
 * feature 013 T013 (FR-005, FR-006, and the spec 011 privacy boundary):
 * `GET /orders/:id` returns `stopEvents` to the assigned DRIVER and never to
 * the CLIENT. The gap FR-005/FR-006 describe is entirely on the mobile side
 * (no field to receive it); the platform already sends it. This asserts the
 * existing boundary is not disturbed.
 */
describe('Driver stop visibility (feature 013 US1)', () => {
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

  beforeEach(async () => {
    await userModel.updateMany(
      { _id: { $in: [fixtures.companyA.driver.id, fixtures.companyB.driver.id] } },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
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

    const after = await orderModel.findById(orderId).exec();
    expect(after?.status).toBe(OrderStatus.IN_TRANSIT);
    return orderId;
  }

  /** Raises a real DETECTED stop by ageing `lastMovedAt` and running the sweep. */
  async function raiseStop(orderId: string): Promise<void> {
    const { driver } = fixtures.companyA;
    await userModel.updateOne(
      { _id: driver.id },
      {
        $set: {
          lastMovedAt: new Date(Date.now() - 60 * 60_000),
          lastMovedLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
          location: { type: 'Point', coordinates: [46.6753, 24.7136] },
        },
      },
    );
    await sweep.sweepStalledDeliveries();
    const order = await orderModel.findById(orderId).exec();
    expect(order?.stopEvents?.length).toBeGreaterThan(0);
  }

  it('returns stopEvents to the assigned DRIVER', async () => {
    const { driver } = fixtures.companyA;
    const orderId = await inTransitOrder();
    await raiseStop(orderId);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    expect(Array.isArray(res.body.stopEvents)).toBe(true);
    expect(res.body.stopEvents.length).toBeGreaterThan(0);
    const stop = res.body.stopEvents[0];
    expect(stop._id).toBeDefined();
    expect(stop.origin).toBe('DETECTED');
    expect(stop.detectedAt).toBeDefined();
  });

  it('never returns stopEvents to the CLIENT — the spec 011 privacy boundary holds', async () => {
    const { client } = fixtures.companyA;
    const orderId = await inTransitOrder();
    await raiseStop(orderId);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    expect(res.body).not.toHaveProperty('stopEvents');
  });
});
