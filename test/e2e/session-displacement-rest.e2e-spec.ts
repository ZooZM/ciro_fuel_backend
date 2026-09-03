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
  DEFAULT_PASSWORD,
} from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { Order, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

/**
 * feature 013 T028 (FR-015, research R11): a displaced device's delivery
 * actions over REST are already refused with the structured `SESSION_REVOKED`
 * shape and its `cause` — `validateActiveSessionWithScoping` compares `sgen`
 * on every authenticated request. **This asserts existing behaviour.** The
 * feature adds a test here, not an implementation; the hole was on the
 * socket, closed by `session-displacement.e2e-spec.ts`.
 */
describe('Session displacement — REST delivery actions (feature 013 US2, existing behaviour)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;
  let orderModel: Model<OrderDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
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
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);
    fixtures.companyA.driver.token = res.body.accessToken;
  });

  it('a delivery action from a displaced token is refused with the structured SESSION_REVOKED shape and cause', async () => {
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

    const staleToken = driver.token;

    // Device B signs in — staleToken is now displaced.
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email: driver.email, password: DEFAULT_PASSWORD })
      .expect(201);

    // A delivery action on the stale token: refused, and the body states the
    // session ended — not a generic 401.
    const refused = await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${staleToken}`)
      .expect(401);

    expect(refused.body.error).toBe('SESSION_REVOKED');
    expect(refused.body.cause).toBeDefined();
  });
});
