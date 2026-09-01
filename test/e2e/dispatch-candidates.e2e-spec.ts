import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, uniquePhone, TwoCompanyFixture } from '../utils/fixtures';
import { UsersService } from '../../src/modules/users/users.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { RegionCode } from '../../src/common/enums/region.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { DriverEligibility } from '../../src/common/enums/driver-eligibility.enum';

jest.setTimeout(120_000);

const PASSWORD = 'Password123!';

/**
 * spec 010 T009/T010 (FR-001, FR-002, FR-006, SC-001): the candidate list now
 * shows every driver, not only online-and-available ones. `seedTwoCompanies`
 * already gives each company one online+available driver and its own
 * transporter/admin/client — this file adds the other three eligibility
 * states directly, and uses company B purely to prove isolation.
 */
describe('Dispatch candidates (spec 010 US1) — every driver, correctly classified', () => {
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

  async function routeAnOrder(): Promise<string> {
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);
    const orderId = createRes.body._id;
    await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(200);
    return orderId;
  }

  it("includes offline, busy, never-connected and deactivated drivers, each correctly classified, and never another company's driver (FR-001, FR-002, FR-006, tenant isolation)", async () => {
    const usersService = app.get(UsersService);
    const transportCompanyId = fixtures.companyA.transportCompanyId;
    const center = fixtures.companyA.driver.location;

    const offline = await usersService.create({
      companyId: transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `offline-${Date.now()}@candidatestest.test`,
      password: PASSWORD,
      fullName: 'Offline Driver',
      phone: uniquePhone(),
      isActive: true,
      isOnline: false,
      isAvailable: true,
      lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      location: { type: 'Point', coordinates: [center[0] + 0.02, center[1]] } as never,
    });

    const busy = await usersService.create({
      companyId: transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `busy-${Date.now()}@candidatestest.test`,
      password: PASSWORD,
      fullName: 'Busy Driver',
      phone: uniquePhone(),
      isActive: true,
      isOnline: true,
      isAvailable: false,
      lastSeenAt: new Date(),
      location: { type: 'Point', coordinates: [center[0] + 0.03, center[1]] } as never,
    });

    // Never connected: no `location` at all — the case `$geoNear` alone
    // would silently omit (research R1). Deliberately not passed here.
    const neverConnected = await usersService.create({
      companyId: transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `never-connected-${Date.now()}@candidatestest.test`,
      password: PASSWORD,
      fullName: 'Never Connected Driver',
      phone: uniquePhone(),
      isActive: true,
      isOnline: false,
      isAvailable: true,
    });

    const deactivated = await usersService.create({
      companyId: transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `deactivated-${Date.now()}@candidatestest.test`,
      password: PASSWORD,
      fullName: 'Deactivated Driver',
      phone: uniquePhone(),
      isActive: false,
      isOnline: false,
      isAvailable: true,
      location: { type: 'Point', coordinates: [center[0] + 0.04, center[1]] } as never,
    });

    const orderId = await routeAnOrder();
    const res = await request(app.getHttpServer())
      .get(`/api/v1/dispatch/orders/${orderId}/candidates`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);

    const byId = new Map<string, { eligibility: string; lastSeenAt: string | null }>(
      res.body.map((c: { _id: string; eligibility: string; lastSeenAt: string | null }) => [
        c._id,
        { eligibility: c.eligibility, lastSeenAt: c.lastSeenAt },
      ]),
    );

    expect(byId.get(String(fixtures.companyA.driver.id))?.eligibility).toBe(
      DriverEligibility.ELIGIBLE,
    );
    expect(byId.get(String(offline._id))?.eligibility).toBe(DriverEligibility.OFFLINE);
    expect(byId.get(String(offline._id))?.lastSeenAt).not.toBeNull();
    expect(byId.get(String(busy._id))?.eligibility).toBe(DriverEligibility.BUSY);
    expect(byId.get(String(neverConnected._id))?.eligibility).toBe(DriverEligibility.OFFLINE);
    expect(byId.get(String(neverConnected._id))?.lastSeenAt).toBeNull();
    expect(byId.get(String(deactivated._id))?.eligibility).toBe(DriverEligibility.INACTIVE);

    // Tenant isolation: company B's own driver must never appear here.
    expect(byId.has(String(fixtures.companyB.driver.id))).toBe(false);

    // Ordering: the ELIGIBLE driver ranks ahead of every non-eligible one.
    const eligibleIndex = res.body.findIndex(
      (c: { _id: string }) => c._id === String(fixtures.companyA.driver.id),
    );
    const firstNonEligibleIndex = res.body.findIndex(
      (c: { eligibility: string }) => c.eligibility !== DriverEligibility.ELIGIBLE,
    );
    expect(eligibleIndex).toBeLessThan(firstNonEligibleIndex);
  });

  it('returns an empty array only when the company has zero drivers on file, never merely because none are online (FR-006, SC-001)', async () => {
    const authService = app.get(AuthService);
    const usersService = app.get(UsersService);
    const companiesService = app.get(CompaniesService);

    // A brand-new transport company under company A's own fuel company —
    // zero drivers, genuinely, not merely zero online ones.
    const emptyTransportCompany = await companiesService.createTransportCompany(
      fixtures.companyA.companyId,
      {
        name: `Empty Transport ${Date.now()}`,
        contactEmail: `empty-${Date.now()}@candidatestest.test`,
        contactPhone: '+966500000099',
        status: CompanyStatus.ACTIVE,
      },
    );
    await companiesService.assignRegions(
      fixtures.companyA.companyId,
      String(emptyTransportCompany._id),
      [RegionCode.RIYADH],
    );
    const emptyTransportAdmin = await usersService.create({
      companyId: emptyTransportCompany._id as never,
      role: UserRole.TRANSPORT_COMPANY_ADMIN,
      email: `empty-admin-${Date.now()}@candidatestest.test`,
      password: PASSWORD,
      fullName: 'Empty Transport Admin',
      phone: uniquePhone(),
      isActive: true,
    });
    const emptyTransportAdminAuth = await authService.login({
      email: emptyTransportAdmin.email,
      password: PASSWORD,
    });

    // Company A's fuel company now has TWO transporters serving RIYADH (its
    // own from `seedTwoCompanies`, plus this new empty one) — approval
    // without a chosen `transportCompanyId` therefore lands in
    // AWAITING_ROUTING deterministically (spec 004 FR-014), letting this
    // test route to the empty one explicitly rather than guessing.
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);
    const orderId = createRes.body._id;
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.AWAITING_ROUTING);

    await request(server)
      .patch(`/api/v1/orders/${orderId}/route`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ transportCompanyId: String(emptyTransportCompany._id) })
      .expect(200);

    const res = await request(server)
      .get(`/api/v1/dispatch/orders/${orderId}/candidates`)
      .set('Authorization', `Bearer ${emptyTransportAdminAuth.accessToken}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });
});
