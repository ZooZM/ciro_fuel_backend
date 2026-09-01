import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, DEFAULT_PASSWORD } from '../utils/fixtures';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { UsersService } from '../../src/modules/users/users.service';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';

jest.setTimeout(120_000);

describe('Role-based access control (US2) — denial matrix', () => {
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

  it('denies CLIENT from creating orders for another CLIENT (role mismatch on write paths)', async () => {
    // DRIVER attempting the CLIENT-only create-order action.
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(403);
  });

  it('denies DRIVER and CLIENT from approving orders (COMPANY_ADMIN only)', async () => {
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 50 })
      .expect(201);

    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({})
      .expect(403);

    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({})
      .expect(403);
  });

  it('denies CLIENT, DRIVER, and FUEL_COMPANY_ADMIN from assigning a driver (TRANSPORT_COMPANY_ADMIN only, spec 004 FR-017)', async () => {
    const body = { driverId: '000000000000000000000000' };

    await request(app.getHttpServer())
      .post('/api/v1/dispatch/orders/000000000000000000000000/assign')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send(body)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/dispatch/orders/000000000000000000000000/assign')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send(body)
      .expect(403);

    // Driver assignment moved from the Fuel Company to the Transportation
    // Company (spec 004 US4) — the Fuel Company admin is no longer permitted
    // on this specific route, even though they still approve/reject orders.
    await request(app.getHttpServer())
      .post('/api/v1/dispatch/orders/000000000000000000000000/assign')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send(body)
      .expect(403);
  });

  it('denies an unauthenticated request entirely (401)', async () => {
    await request(app.getHttpServer()).get('/api/v1/orders').expect(401);
  });

  it('denies access with a malformed/garbage bearer token', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
  });

  it('blocks login for a deactivated user with the same generic message as bad credentials', async () => {
    const usersService = app.get(UsersService);
    await usersService.setActive(fixtures.companyA.client.id, false);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.client.email, password: DEFAULT_PASSWORD })
      .expect(401);
    expect(res.body.message).toBe('Invalid credentials');

    // restore for any tests that might run after (defensive; each file gets a fresh app anyway)
    await usersService.setActive(fixtures.companyA.client.id, true);
  });

  it('blocks login for every user of a suspended company, and blocks an already-issued token on the next request', async () => {
    const companiesService = app.get(CompaniesService);

    // Admin still holds a valid token from fixture setup — suspend the company now.
    await companiesService.setStatus(fixtures.companyB.companyId, CompanyStatus.SUSPENDED);

    // Fresh login is blocked.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyB.admin.email, password: DEFAULT_PASSWORD })
      .expect(401);

    // An already-issued token is rejected on the very next authenticated
    // request too — access revocation is immediate, not just at next login.
    await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(401);

    await companiesService.setStatus(fixtures.companyB.companyId, CompanyStatus.ACTIVE);
  });
});
