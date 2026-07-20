import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
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
        stationLocation: { longitude: 46.6753, latitude: 24.7136 },
      })
      .expect(201);
    expect(clientRes.body.role).toBe('CLIENT');

    // 5. Admin creates a DRIVER with a truck.
    const driverRes = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        role: 'DRIVER',
        email: 'driver@onboardtest.test',
        password: 'Password123!',
        fullName: 'Onboard Driver',
        phone: '+966500000003',
        truck: { plateNumber: 'ONB-1', maxCapacityLiters: 5000, fuelTypes: ['DIESEL'] },
      })
      .expect(201);
    expect(driverRes.body.role).toBe('DRIVER');

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

    // 6. New client logs in, orders, gets approved, and dispatch reaches the new driver.
    const clientLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'client@onboardtest.test', password: 'Password123!' })
      .expect(201);

    const orderRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientLogin.body.accessToken}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500 })
      .expect(201);
    expect(orderRes.body.estimatedPrice).toBeCloseTo(3.0 * 500, 2);

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderRes.body._id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approveRes.body.driverId).toBe(driverRes.body._id);
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

  it('rejects driver creation without a truck and client creation without a station location', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        role: 'DRIVER',
        email: 'no-truck@companya.test',
        password: 'Password123!',
        fullName: 'No Truck',
        phone: '+966500000009',
      })
      .expect(400);

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
