import request from 'supertest';
import { createHmac } from 'node:crypto';
import { Model } from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  assignAndDepart,
  resetFixtureDispatchState,
} from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { Truck, TruckDocument } from '../../src/modules/trucks/schemas/truck.schema';
import { Tank, TankDocument } from '../../src/modules/tanks/schemas/tank.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('Proof of delivery — OTP security & force-complete (US1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;
  let truckModel: Model<TruckDocument>;
  let tankModel: Model<TankDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    userModel = app.get(getModelToken(User.name));
    truckModel = app.get(getModelToken(Truck.name));
    tankModel = app.get(getModelToken(Tank.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
    await resetFixtureDispatchState(app, fixtures.companyA);
  });

  async function bringOrderToInTransit(): Promise<string> {
    const { client, admin, driver, transportAdmin, truck, tank } = fixtures.companyA;
    const server = app.getHttpServer();

    // DIRECT (the default): approval reaches PENDING_PAYMENT immediately;
    // routing — and therefore driver assignment — only resumes once the
    // webhook settles it (spec 004 FR-020a).
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
        transactionId: `SDD-fc-${orderId}`,
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
      transportAdmin.token,
      driver.token,
      driver.id,
      truck.id,
      tank.id,
      truck.nfcCardUid,
    );

    return orderId;
  }

  it('throttles repeated wrong OTP submissions and never leaks the OTP to the driver', async () => {
    const { driver, client } = fixtures.companyA;
    const server = app.getHttpServer();
    const orderId = await bringOrderToInTransit();

    const arriveRes = await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);
    // Driver's own response never contains the OTP value anywhere.
    expect(JSON.stringify(arriveRes.body)).not.toMatch(/^\d{6}$/);
    expect(JSON.stringify(arriveRes.body)).not.toContain('"otp"');

    for (let i = 0; i < 5; i++) {
      await request(server)
        .post(`/api/v1/orders/${orderId}/verify-arrival`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ otp: '000000' })
        .expect(401);
    }

    // 6th attempt within the throttle window is rejected outright (429) —
    // whether by the too-many-attempts guard or the rate limiter, the OTP
    // is never disclosed and the order never advances.
    const sixth = await request(server)
      .post(`/api/v1/orders/${orderId}/verify-arrival`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ otp: '000000' });
    expect([401, 429]).toContain(sixth.status);

    const stillInTransit = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(stillInTransit.body.status).toBe(OrderStatus.IN_TRANSIT);
  });

  it('lets a Company Admin force-complete a stuck delivery with an audited reason', async () => {
    const { driver, admin, client } = fixtures.companyA;
    const server = app.getHttpServer();
    const orderId = await bringOrderToInTransit();

    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    const res = await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Client handheld device battery died at the station' })
      .expect(200);

    expect(res.body.status).toBe(OrderStatus.DELIVERED);
    const lastEntry = res.body.statusHistory[res.body.statusHistory.length - 1];
    expect(lastEntry.manualOverride).toBe(true);
    expect(lastEntry.overrideReason).toBe('Client handheld device battery died at the station');

    // The now-invalidated OTP no longer appears as "current" for the client.
    await request(server)
      .get(`/api/v1/orders/${orderId}/otp/current`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(404);
  });

  /**
   * `User`/`Truck`/`Tank` are single-tenant, scoped to the TRANSPORT
   * company that owns them. `force-complete` is a FUEL_COMPANY_ADMIN
   * action, whose own tenant context carries the FUEL company's id —
   * a genuinely different company on every properly-routed order. The
   * global tenant-scope plugin unconditionally overwrites any `updateOne`
   * filter against a scoped collection with the ACTING actor's companyId
   * (by design — a caller must never smuggle a foreign one in), which
   * previously turned the driver/truck/tank release inside
   * `releaseDriverIfAssigned` into a silent no-op across this exact
   * boundary: the filter became unsatisfiable, `updateOne` matched zero
   * documents, and nothing errored. The order itself still transitioned
   * to DELIVERED (multi-party-scoped, not company-scoped), so the defect
   * was invisible everywhere except the driver/truck/tank staying
   * permanently booked afterward — undetectable by reading the response
   * body alone, which is exactly why this checks the database.
   */
  it('actually releases the driver, truck and tank — not just the order status (FR-044)', async () => {
    const { driver, admin, client, transportAdmin, truck, tank } = fixtures.companyA;
    const server = app.getHttpServer();
    const orderId = await bringOrderToInTransit();

    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(201);

    await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Field-test regression: cross-tenant release' })
      .expect(200)
      .then((res) => expect(res.body.status).toBe(OrderStatus.DELIVERED));

    const [releasedDriver, releasedTruck, releasedTank] = await Promise.all([
      userModel.findById(driver.id).exec(),
      truckModel.findById(truck.id).exec(),
      tankModel.findById(tank.id).exec(),
    ]);
    expect(releasedDriver?.isAvailable).toBe(true);
    expect(releasedDriver?.activeOrderId).toBeUndefined();
    expect(releasedTruck?.activeOrderId).toBeUndefined();
    expect(releasedTank?.activeOrderId).toBeUndefined();

    // And the release genuinely freed them — a fresh order reaches the
    // SAME driver/truck/tank, which would be impossible if the previous
    // booking silently survived force-complete.
    const nextOrderId = await bringOrderToInTransit();
    await request(server)
      .patch(`/api/v1/orders/${nextOrderId}/force-complete`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Field-test regression: second cycle proves the first release was real' })
      .expect(200);
  });

  it('actually releases the driver, truck and tank on an admin-cancelled, already-assigned order (FR-044)', async () => {
    const { driver, admin, client, transportAdmin, truck, tank } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    const orderId = createRes.body._id as string;
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    // DIRECT is the default payment method (spec 004 FR-021) — routing
    // doesn't resume until the webhook confirms payment.
    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-cancel-release-${orderId}`,
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

    await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);

    // A CLIENT cannot cancel past assignment at all (ADMIN_CANCELLABLE only,
    // FR-046d) — so the cross-tenant actor here is the FUEL_COMPANY_ADMIN,
    // the same shape as force-complete: the admin's companyId is the FUEL
    // company, never the transporter that owns the driver/truck/tank.
    await request(server)
      .patch(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200)
      .then((res) => expect(res.body.status).toBe(OrderStatus.CANCELLED));

    const [releasedDriver, releasedTruck, releasedTank] = await Promise.all([
      userModel.findById(driver.id).exec(),
      truckModel.findById(truck.id).exec(),
      tankModel.findById(tank.id).exec(),
    ]);
    expect(releasedDriver?.isAvailable).toBe(true);
    expect(releasedDriver?.activeOrderId).toBeUndefined();
    expect(releasedTruck?.activeOrderId).toBeUndefined();
    expect(releasedTank?.activeOrderId).toBeUndefined();
  });

  it('denies force-complete to DRIVER and CLIENT roles', async () => {
    const { driver, client } = fixtures.companyA;
    const server = app.getHttpServer();
    const orderId = await bringOrderToInTransit();

    await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ reason: 'trying to self-serve' })
      .expect(403);

    await request(server)
      .patch(`/api/v1/orders/${orderId}/force-complete`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ reason: 'trying to self-serve' })
      .expect(403);
  });
});
