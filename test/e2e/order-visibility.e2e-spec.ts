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
  settleClientReview,
} from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';

jest.setTimeout(120_000);

/** Spec 004 US6/T083: the client sees the assigned driver's name and plate
 * (FR-028) and an ETA (FR-029) directly on the order, but can never read
 * the driver's own user record — driverSummary is their only window in. */
describe('Order visibility — driver summary & ETA (spec 004 US6)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  // Each test dispatches (consumes) companyA's single fixture driver; reset
  // it to available before every test so dispatch always succeeds
  // independently of prior tests' outcomes (same pattern as other e2e files).
  beforeEach(async () => {
    const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
    await resetFixtureDispatchState(app, fixtures.companyA);
  });

  it("exposes driverSummary + etaMinutes on GET /orders/:id and /orders, but 403s the client reading the driver's own record", async () => {
    const { client, admin, driver, truck, tank } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    // Routing now prices the haul and hands the order back to the station
    // owner, so approval lands on PENDING_PAYMENT rather than going straight
    // to the transporter; the settlement step below is what releases it.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Before assignment: no driver yet, so no summary and no ETA (never fabricated).
    const beforeAssign = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(beforeAssign.body.driverSummary).toBeFalsy();
    expect(beforeAssign.body.etaMinutes).toBeUndefined();
    // No driver, so no position to disclose — never a fabricated one.
    expect(beforeAssign.body.driverLocation).toBeUndefined();

    await assignAndDepart(
      app,
      createRes.body._id,
      fixtures.companyA.transportAdmin.token,
      driver.token,
      driver.id,
      truck.id,
      tank.id,
      truck.nfcCardUid,
    );

    const afterAssign = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(afterAssign.body.status).toBe(OrderStatus.IN_TRANSIT);
    expect(afterAssign.body.driverSummary).toMatchObject({
      fullName: expect.any(String),
      phone: expect.any(String),
      plateNumber: expect.any(String),
    });
    // The fixture driver has a location on file — a real, non-fabricated ETA.
    expect(typeof afterAssign.body.etaMinutes).toBe('number');

    // The position the ETA was derived from travels with it, so the client's
    // tracking map can draw the truck on open rather than waiting for the
    // driver's next throttled socket ping (spec 005).
    expect(afterAssign.body.driverLocation).toMatchObject({
      type: 'Point',
      coordinates: [expect.any(Number), expect.any(Number)],
    });

    // The same summary appears in the list endpoint, not just the single-order read.
    const listRes = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    // spec 005: GET /orders returns { items, nextCursor } now, not a bare array.
    const listed = listRes.body.items.find((o: { _id: string }) => o._id === createRes.body._id);
    expect(listed.driverSummary.fullName).toBe(afterAssign.body.driverSummary.fullName);
    expect(typeof listed.etaMinutes).toBe('number');

    // The client can never read the driver's own user record directly —
    // driverSummary on the order is their only legitimate window into it.
    await request(server)
      .get(`/api/v1/users/${driver.id}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(403);
  });

  it('SC-007: reading orders (list and single) makes zero external address-lookup calls', async () => {
    const { client, admin, driver, truck, tank } = fixtures.companyA;
    const server = app.getHttpServer();

    // GeocodingService (src/modules/geocoding/geocoding.service.ts) is the
    // ONLY caller of the platform's native `fetch` anywhere in this
    // codebase, and it is wired to exactly one endpoint
    // (`POST /geocoding/reverse`, client registration) — order reads always
    // use the stored `deliveryAddressText` snapshot (FR-012), never
    // re-deriving it. Spying on `fetch` directly is therefore a reliable
    // proxy for "no external address lookup happened".
    const fetchSpy = jest.spyOn(global, 'fetch');

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    await settleClientReview(app, createRes.body._id);
    await request(server)
      .post(`/api/v1/dispatch/orders/${createRes.body._id}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);

    // The read paths under test: list and single-order reads, by every
    // role that can legitimately see this order.
    await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // spec 005 T032/FR-048: pagination must not create a new leakage surface —
  // a CLIENT paging through GET /orders, cursor after cursor, must never
  // receive another client's order, on any page.
  it("a CLIENT paging GET /orders never receives another client's order, including across page boundaries", async () => {
    const server = app.getHttpServer();
    const { client: clientA } = fixtures.companyA;
    const { client: clientB } = fixtures.companyB;

    // Enough of company A's client's own orders to force multiple pages.
    for (let i = 0; i < 22; i++) {
      await request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${clientA.token}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
        .expect(201);
    }
    // Company B's client places one too — must never surface for A.
    const bOrder = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientB.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);

    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await request(server)
        .get('/api/v1/orders')
        .query(cursor ? { cursor } : {})
        .set('Authorization', `Bearer ${clientA.token}`)
        .expect(200);
      const ids = page.body.items.map((o: { _id: string }) => o._id);
      expect(ids).not.toContain(bOrder.body._id);
      cursor = page.body.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBeGreaterThan(1); // actually crossed a page boundary
  });
});
