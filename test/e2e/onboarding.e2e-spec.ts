import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  DEFAULT_WAREHOUSE_LOCATION,
  seedTwoCompanies,
  TwoCompanyFixture,
  settleClientReview,
} from '../utils/fixtures';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

describe('Platform & company onboarding (US5)', () => {
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

  it('registers a company end-to-end and makes a newly-created driver dispatch-eligible', async () => {
    const server = app.getHttpServer();

    // 1. SUPER_ADMIN registers a new company with its commercial register.
    const createRes = await request(server)
      .post('/api/v1/companies')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .field('name', 'Onboarding Test Co')
      .field('contactEmail', 'contact@onboardtest.test')
      .field('contactPhone', '+966500000000')
      .field('adminEmail', 'admin@onboardtest.test')
      .field('adminFullName', 'Onboarding Admin')
      .field('adminPhone', '+966500000001')
      .field('adminPassword', 'Password123!')
      .attach('commercialRegister', Buffer.from('%PDF-1.4 fake register'), {
        filename: 'register.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(createRes.body.company.name).toBe('Onboarding Test Co');
    expect(createRes.body.company.commercialRegisterFileId).toBeTruthy();
    const companyId = createRes.body.company._id;

    // 2. The new admin can log in immediately.
    const adminLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@onboardtest.test', password: 'Password123!' })
      .expect(201);
    const adminToken = adminLogin.body.accessToken;

    // 3. Admin sets fuel prices.
    await request(server)
      .put(`/api/v1/companies/${companyId}/fuel-prices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prices: [{ fuelType: 'DIESEL', basePricePerLiter: 3.0 }] })
      .expect(200);

    // 3b. …and a pricing configuration, which this walkthrough used to skip.
    // A fuel price alone does not make a company tradeable: the service fee and
    // the tax rate live here, and without them there is no lawful total to put
    // on an invoice. `POST /orders/quote` — the only path the real client app
    // takes — has always refused such a company with PRICING_NOT_CONFIGURED, so
    // an onboarding that stopped at fuel prices produced a company no customer
    // could actually order from. Order creation now refuses it the same way
    // instead of quietly pricing the fuel line alone, which is what makes this
    // step part of the sequence rather than an optional extra.
    await request(server)
      .put(`/api/v1/companies/${companyId}/pricing-config`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        deliveryFee: 30,
        serviceFeePercent: 1,
        taxRatePercent: 15,
        tankerCapacitiesLiters: [20000, 30000],
      })
      .expect(200);

    // 4. Admin creates a CLIENT with a station location.
    const clientRes = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        role: 'CLIENT',
        email: 'client@onboardtest.test',
        password: 'Password123!',
        fullName: 'Onboard Client',
        phone: '+966500000002',
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(201);
    expect(clientRes.body.role).toBe('CLIENT');

    // 5. Fuel admin creates a Transportation Company serving the client's
    // region (spec 004 US2) — only that transporter's own admin may create
    // DRIVER accounts (FR-004a's symmetric counterpart).
    const transporterRes = await request(server)
      .post(`/api/v1/companies/${companyId}/transporters`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Onboard Transport Co',
        contactEmail: 'transport@onboardtest.test',
        contactPhone: '+966500000005',
        adminEmail: 'transportadmin@onboardtest.test',
        adminFullName: 'Onboard Transport Admin',
        adminPhone: '+966500000004',
        adminPassword: 'Password123!',
      })
      .expect(201);
    const transportCompanyId = transporterRes.body.company._id;

    await request(server)
      .put(`/api/v1/companies/${transportCompanyId}/regions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ regionCodes: ['RIYADH'] })
      .expect(200);

    const transportAdminLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'transportadmin@onboardtest.test', password: 'Password123!' })
      .expect(201);
    const transportAdminToken = transportAdminLogin.body.accessToken;

    // Onboarding a transporter now takes one more step before it can be routed
    // work: it must price the areas it serves. The delivery leg is priced by
    // the company that performs it, so routing to one that has set no rate
    // would produce an order nobody can bill — the platform refuses it with
    // `TRANSPORT_PRICE_NOT_SET` rather than inventing a figure. Covering a
    // region and pricing it are now two distinct acts of onboarding.
    await request(server)
      .put(`/api/v1/companies/${transportCompanyId}/delivery-rates`)
      .set('Authorization', `Bearer ${transportAdminToken}`)
      .send({ rates: [{ regionCode: 'RIYADH', pricePerKm: 0, minPrice: 30 }] })
      .expect(200);

    const driverRes = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${transportAdminToken}`)
      .send({
        role: 'DRIVER',
        email: 'driver@onboardtest.test',
        password: 'Password123!',
        fullName: 'Onboard Driver',
        phone: '+966500000003',
      })
      .expect(201);
    expect(driverRes.body.role).toBe('DRIVER');

    // spec 008 (research R12): a vehicle is now the transporter's own
    // Truck/Tank pair, registered separately and NFC-paired, not embedded
    // on the driver — this is what onboarding a fleet actually looks like.
    const truckRes = await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${transportAdminToken}`)
      .send({ plateNumber: 'ONB-1' })
      .expect(201);
    const cardUid = 'ONB-CARD-1';
    await request(server)
      .post(`/api/v1/trucks/${truckRes.body.id}/pair-card`)
      .set('Authorization', `Bearer ${transportAdminToken}`)
      .send({ nfcCardUid: cardUid })
      .expect(201);
    const tankRes = await request(server)
      .post('/api/v1/tanks')
      .set('Authorization', `Bearer ${transportAdminToken}`)
      .send({
        code: 'ONB-TANK-1',
        material: 'ALUMINIUM',
        maxCapacityLiters: 5000,
        fuelTypes: ['DIESEL'],
      })
      .expect(201);

    // New driver starts inactive-for-dispatch (isOnline: false) until they
    // connect to tracking — mark them online directly to prove eligibility
    // (US4's presence flow is exercised separately in presence.e2e-spec.ts).
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));
    await userModel.updateOne(
      { _id: driverRes.body._id },
      { $set: { isOnline: true, location: { type: 'Point', coordinates: [46.6753, 24.7136] } } },
    );
    const driverLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'driver@onboardtest.test', password: 'Password123!' })
      .expect(201);
    const driverToken = driverLogin.body.accessToken;

    // 6. New client logs in, orders, gets approved, and dispatch reaches the new driver.
    const clientLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'client@onboardtest.test', password: 'Password123!' })
      .expect(201);

    // DEFERRED skips the billing gate (spec 004 US5) — this test is about
    // onboarding/dispatch reachability, not payment methods.
    const orderRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientLogin.body.accessToken}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);
    // Fuel line, then the 1% service fee, then 15% VAT on the two — the same
    // derivation a quoted order gets. The haul is added at routing, not here.
    const fuelLine = 3.0 * 500;
    expect(orderRes.body.estimatedPrice).toBeCloseTo(
      Math.round(fuelLine * 1.01 * 1.15 * 100) / 100,
      2,
    );

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderRes.body._id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    // Routing now prices the haul and hands the order back to the station
    // owner, so approval lands on PENDING_PAYMENT rather than going straight
    // to the transporter; the settlement step below is what releases it.
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approveRes.body.transportCompanyId).toBe(transportCompanyId);

    // The new transporter sees the new driver among their candidates and
    // assigns them, their truck and their tank (spec 004 FR-017/FR-018,
    // spec 008 FR-009).
    await settleClientReview(app, orderRes.body._id);
    const assignRes = await request(server)
      .post(`/api/v1/dispatch/orders/${orderRes.body._id}/assign`)
      .set('Authorization', `Bearer ${transportAdminToken}`)
      .send({ driverId: driverRes.body._id, truckId: truckRes.body.id, tankId: tankRes.body.id })
      .expect(201);
    expect(assignRes.body.assigned).toBe(true);
    expect(assignRes.body.driverId).toBe(driverRes.body._id);

    // Departure verification then loading confirmation (spec 008 US3/US4)
    // — the same reachability proof, carried one stage further.
    await request(server)
      .post(`/api/v1/orders/${orderRes.body._id}/verify-vehicle`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ credential: cardUid, method: 'NFC_CARD' })
      .expect(201);
    // The second read is at the depot, and is checked against it (FR-030a).
    await request(server)
      .post(`/api/v1/orders/${orderRes.body._id}/verify-vehicle`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        credential: cardUid,
        method: 'NFC_CARD',
        driverLocation: DEFAULT_WAREHOUSE_LOCATION,
      })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${orderRes.body._id}/confirm-loading`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(201);

    const finalOrder = await request(server)
      .get(`/api/v1/orders/${orderRes.body._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(finalOrder.body.status).toBe(OrderStatus.IN_TRANSIT);
    expect(finalOrder.body.driverId).toBe(driverRes.body._id);
  });

  it('rejects a disallowed file type atomically — no company is created on failure', async () => {
    const server = app.getHttpServer();
    const companiesBefore = await app.get(CompaniesService).findAll();

    await request(server)
      .post('/api/v1/companies')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .field('name', 'Should Not Exist Co')
      .field('contactEmail', 'x@x.test')
      .field('contactPhone', '+966500000000')
      .field('adminEmail', 'x-admin@x.test')
      .field('adminFullName', 'X Admin')
      .field('adminPhone', '+966500000001')
      .field('adminPassword', 'Password123!')
      .attach('commercialRegister', Buffer.from('not a real document'), {
        filename: 'register.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    const companiesAfter = await app.get(CompaniesService).findAll();
    expect(companiesAfter).toHaveLength(companiesBefore.length);
    expect(companiesAfter.some((c) => c.name === 'Should Not Exist Co')).toBe(false);
  });

  // spec 008 (research R12, FR-043): a driver's vehicle is no longer part
  // of their own account at all — creating one without a truck is now the
  // ONLY legal shape, not a rejected one. The client-without-location half
  // is unrelated to this feature and still enforced exactly as before.
  it('accepts driver creation without a truck (spec 008 cutover) and still rejects client creation without a station location', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({
        role: 'DRIVER',
        email: 'no-truck@companya.test',
        password: 'Password123!',
        fullName: 'No Truck',
        phone: '+966500000009',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        role: 'CLIENT',
        email: 'no-location@companya.test',
        password: 'Password123!',
        fullName: 'No Location',
        phone: '+966500000010',
      })
      .expect(400);
  });
});
