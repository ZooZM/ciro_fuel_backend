import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, settleClientReview } from '../utils/fixtures';

jest.setTimeout(120_000);

describe('Tenant data isolation (US2) — company A vs company B', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let orderAId: string;
  let orderBId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    const server = app.getHttpServer();

    const createA = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    orderAId = createA.body._id;

    const createB = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyB.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    orderBId = createB.body._id;
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('never leaks company B orders into company A admin listings', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    // spec 005: GET /orders returns { items, nextCursor } now, not a bare array.
    const ids = res.body.items.map((o: { _id: string }) => o._id);
    expect(ids).toContain(orderAId);
    expect(ids).not.toContain(orderBId);
  });

  it('returns 404 (never 403) when company A admin fetches company B order by id directly', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);
  });

  it('returns 404 when company A admin attempts to approve a company B order', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(404);
  });

  it('returns 404 when company A admin attempts to reject a company B order', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/reject`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ reason: 'not mine to reject' })
      .expect(404);
  });

  it('returns 404 when company A admin attempts to cancel a company B order', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/cancel`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(404);
  });

  it('returns 404 when company A admin attempts to manually dispatch a company B order', async () => {
    // First approve within company B so the order is a valid dispatch target for someone.
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({})
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);
  });

  it('company A client cannot see or act on company B client’s order', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/cancel`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({})
      .expect(404);
  });

  it('company A driver cannot see company B’s order or fake-arrive on it', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderBId}/arrive`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(404);
  });

  it('SUPER_ADMIN can read across both companies', async () => {
    const resA = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderAId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(resA.body._id).toBe(orderAId);

    const resB = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(resB.body._id).toBe(orderBId);
  });

  // --- spec 004 US2 / T034: a Transportation Company is as isolated as a Fuel Company ---

  it('a Transportation Company created under Fuel Company A is invisible to Fuel Company B', async () => {
    const server = app.getHttpServer();

    const created = await request(server)
      .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        name: 'Isolation Test Transporter',
        contactEmail: 'contact@isolationtransporter.test',
        contactPhone: '+966500000007',
        adminEmail: 'admin@isolationtransporter.test',
        adminFullName: 'Isolation Transporter Admin',
        adminPhone: '+966500000008',
        adminPassword: 'Password123!',
      })
      .expect(201);
    const transporterId = created.body.company._id;

    // Fuel Company B cannot read it directly (404, never 403 — FR-002)...
    await request(server)
      .get(`/api/v1/companies/${transporterId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(404);

    // ...nor assign it regions...
    await request(server)
      .put(`/api/v1/companies/${transporterId}/regions`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({ regionCodes: ['JAZAN'] })
      .expect(404);

    // ...nor does it appear in Fuel Company B's own company listing.
    const bList = await request(server)
      .get('/api/v1/companies')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(200);
    expect(bList.body.map((c: { _id: string }) => c._id)).not.toContain(transporterId);

    // CIRO, unlike either Fuel Company, can still read it directly.
    await request(server)
      .get(`/api/v1/companies/${transporterId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
  });

  it('company A admin cannot mark company B’s notifications as read', async () => {
    const server = app.getHttpServer();
    // Approving generates an ORDER_APPROVED_FINAL_PRICE notification for the B client.
    const bNotifications = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${fixtures.companyB.client.token}`)
      .expect(200);
    expect(bNotifications.body.items.length).toBeGreaterThan(0);
    const notificationId = bNotifications.body.items[0]._id;

    await request(server)
      .patch(`/api/v1/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);
  });

  // --- spec 004 T059: multi-party isolation on Order (fuelCompanyId,
  // transportCompanyId, clientId, driverId) — a leak here is not just
  // between Fuel Companies but between tenants sharing ONE Fuel Company. ---

  it('a sibling Transportation Company under the SAME Fuel Company cannot see an order routed to a different transporter', async () => {
    const server = app.getHttpServer();

    // A second transporter under Fuel Company A, deliberately NOT serving
    // any region — it must never see orders routed to the fixture transporter.
    const sibling = await request(server)
      .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        name: 'Sibling Transporter ' + Date.now(),
        contactEmail: `sibling-${Date.now()}@isolationtest.test`,
        contactPhone: '+966500000010',
        adminEmail: `sibling-admin-${Date.now()}@isolationtest.test`,
        adminFullName: 'Sibling Transport Admin',
        adminPhone: '+966500000011',
        adminPassword: 'Password123!',
      })
      .expect(201);
    const siblingLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: sibling.body.admin.email, password: 'Password123!' })
      .expect(201);

    // DEFERRED skips the billing gate (spec 004 US5) — this test is about
    // routing/dispatch isolation, not payment.
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(200);
    // Routed to the fixture transporter (the only one serving RIYADH) —
    // never the sibling, which serves no region at all.
    expect(approveRes.body.transportCompanyId).toBe(fixtures.companyA.transportCompanyId);
    expect(approveRes.body.transportCompanyId).not.toBe(String(sibling.body.company._id));

    // The sibling cannot read it directly (404, never 403 — FR-002)...
    await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${siblingLogin.body.accessToken}`)
      .expect(404);

    // ...nor does it appear in the sibling's own order listing...
    const siblingOrders = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${siblingLogin.body.accessToken}`)
      .expect(200);
    expect(siblingOrders.body.items.map((o: { _id: string }) => o._id)).not.toContain(
      createRes.body._id,
    );

    // ...nor can the sibling see it among dispatch candidates or assign a driver to it.
    await settleClientReview(app, createRes.body._id);
    await request(server)
      .get(`/api/v1/dispatch/orders/${createRes.body._id}/candidates`)
      .set('Authorization', `Bearer ${siblingLogin.body.accessToken}`)
      .expect(404);

    // The GENUINE transporter, by contrast, sees it correctly.
    const genuineOrders = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(genuineOrders.body.items.map((o: { _id: string }) => o._id)).toContain(
      createRes.body._id,
    );
  });

  it('a driver sees only trips assigned to them, not another driver’s — even within the same transporter', async () => {
    const server = app.getHttpServer();
    const { client, admin, transportAdmin, driver, truck, tank } = fixtures.companyA;

    // A second driver under the SAME transporter, never assigned anything.
    // spec 008 (research R12): a driver no longer carries an embedded
    // truck at all — this driver needs none, they're never dispatched.
    const secondDriver = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({
        role: 'DRIVER',
        email: `second-driver-${Date.now()}@isolationtest.test`,
        password: 'Password123!',
        fullName: 'Second Driver',
        phone: `+96659${String(Date.now()).slice(-7)}`,
      })
      .expect(201);
    const secondDriverLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ phone: secondDriver.body.phone, password: 'Password123!' })
      .expect(201);

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
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);

    // The assigned driver sees it in their own list and by id.
    const assignedDriverOrders = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    expect(assignedDriverOrders.body.items.map((o: { _id: string }) => o._id)).toContain(
      createRes.body._id,
    );

    // The second driver — same transporter, uninvolved in this order — sees
    // neither the listing entry nor the direct lookup (404, never 403).
    const secondDriverOrders = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${secondDriverLogin.body.accessToken}`)
      .expect(200);
    expect(secondDriverOrders.body.items.map((o: { _id: string }) => o._id)).not.toContain(
      createRes.body._id,
    );
    await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${secondDriverLogin.body.accessToken}`)
      .expect(404);
  });
});
