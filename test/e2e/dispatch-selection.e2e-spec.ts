import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { uniquePhone } from '../utils/fixtures';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { UsersService } from '../../src/modules/users/users.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { GovernorateCode, RegionCode } from '../../src/common/enums/region.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { TrucksService } from '../../src/modules/trucks/trucks.service';
import { TanksService } from '../../src/modules/tanks/tanks.service';
import { TankMaterial } from '../../src/common/enums/tank-material.enum';
import { WarehousesService } from '../../src/modules/warehouses/warehouses.service';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { DriverEligibility } from '../../src/common/enums/driver-eligibility.enum';

jest.setTimeout(120_000);

const PASSWORD = 'Password123!';
// Delivery target near Riyadh; driver locations vary distance from here (roughly, degrees).
const DELIVERY = [46.6753, 24.7136];

/**
 * spec 004: drivers belong to a Transportation Company, ranked and picked
 * by that company's own admin — not auto-assigned by the Fuel Company's
 * approval anymore. This seeds one Fuel Company + one Transportation
 * Company serving RIYADH (so approval always routes there unambiguously,
 * keeping these tests focused on driver *selection*, not routing).
 */
async function seedCompanyWithDrivers(app: INestApplication) {
  const companiesService = app.get(CompaniesService);
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);
  const trucksService = app.get(TrucksService);
  const tanksService = app.get(TanksService);
  const warehousesService = app.get(WarehousesService);

  // spec 008 FR-035f: assignment refuses without a warehouse supplying the
  // order's grade — every order in this file is DIESEL.
  await warehousesService.create({
    name: 'Dispatch Test Warehouse ' + randomUUID(),
    location: { longitude: DELIVERY[0], latitude: DELIVERY[1] },
    addressText: 'Dispatch test warehouse',
    region: RegionCode.RIYADH,
    governorate: GovernorateCode.RIYADH_CITY,
    fuelTypes: [FuelType.DIESEL],
  });

  const company = await companiesService.create({
    name: 'Dispatch Test Co ' + randomUUID(),
    type: CompanyType.FUEL,
    status: CompanyStatus.ACTIVE,
    contactEmail: 'contact@dispatchtest.test',
    contactPhone: '+966500000000',
    fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
  });
  const companyId = String(company._id);

  const admin = await usersService.create({
    companyId: company._id as never,
    role: UserRole.FUEL_COMPANY_ADMIN,
    email: `admin-${randomUUID()}@dispatchtest.test`,
    password: PASSWORD,
    fullName: 'Dispatch Admin',
    // spec 015 put FUEL_COMPANY_ADMIN under the partial unique phone index, so a literal
    // here collides on the SECOND of this helper's six calls — the client below was
    // already switched to `uniquePhone()`, this line was missed.
    phone: uniquePhone(),
    isActive: true,
  });

  const client = await usersService.create({
    companyId: company._id as never,
    role: UserRole.CLIENT,
    email: `client-${randomUUID()}@dispatchtest.test`,
    password: PASSWORD,
    fullName: 'Dispatch Client',
    phone: uniquePhone(),
    isActive: true,
    station: {
      regionCode: RegionCode.RIYADH,
      governorateCode: GovernorateCode.RIYADH_CITY,
      location: { type: 'Point', coordinates: DELIVERY },
      addressText: '',
    } as never,
  });

  const transportCompany = await companiesService.createTransportCompany(companyId, {
    name: 'Dispatch Test Transport ' + randomUUID(),
    contactEmail: 'transport@dispatchtest.test',
    contactPhone: '+966500000002',
    status: CompanyStatus.ACTIVE,
  });
  await companiesService.assignRegions(companyId, String(transportCompany._id), [
    RegionCode.RIYADH,
  ]);
  const transportAdmin = await usersService.create({
    companyId: transportCompany._id as never,
    role: UserRole.TRANSPORT_COMPANY_ADMIN,
    email: `transportadmin-${randomUUID()}@dispatchtest.test`,
    password: PASSWORD,
    fullName: 'Dispatch Transport Admin',
    phone: uniquePhone(),
    isActive: true,
  });

  async function makeDriver(opts: {
    label: string;
    offsetDegrees: number;
    maxCapacityLiters?: number;
    fuelTypes?: FuelType[];
    isActive?: boolean;
    isOnline?: boolean;
    isAvailable?: boolean;
    activeOrderId?: string;
  }) {
    const driver = await usersService.create({
      companyId: transportCompany._id as never,
      role: UserRole.DRIVER,
      email: `driver-${opts.label}-${randomUUID()}@dispatchtest.test`,
      password: PASSWORD,
      fullName: `Driver ${opts.label}`,
      phone: uniquePhone(),
      isActive: opts.isActive ?? true,
      isOnline: opts.isOnline ?? true,
      isAvailable: opts.isAvailable ?? true,
      lastSeenAt: new Date(),
      location: {
        type: 'Point',
        coordinates: [DELIVERY[0] + opts.offsetDegrees, DELIVERY[1] + opts.offsetDegrees],
      } as never,
      ...(opts.activeOrderId ? { activeOrderId: opts.activeOrderId as never } : {}),
    });
    // Deactivated drivers can't log in (by design) — these fixtures exist
    // purely to prove exclusion from dispatch, no token is needed for them.
    const token =
      opts.isActive === false
        ? undefined
        : (await authService.login({ email: driver.email, password: PASSWORD })).accessToken;

    // spec 008 (research R3/R12): capacity/fuelType now live on a real
    // Tank, checked at assignment — not on the driver, not in the
    // candidate query. Every driver here still gets one, so a test can
    // assign them without extra setup, but it no longer affects whether
    // they appear as a candidate at all.
    const truck = await trucksService.create(String(transportCompany._id), {
      plateNumber: `DT-${opts.label}`,
    });
    const tank = await tanksService.create(String(transportCompany._id), {
      code: `DT-TANK-${opts.label}`,
      material: TankMaterial.ALUMINIUM,
      maxCapacityLiters: opts.maxCapacityLiters ?? 5000,
      fuelTypes: opts.fuelTypes ?? [FuelType.DIESEL],
    });

    return {
      id: String(driver._id),
      email: driver.email,
      token,
      truckId: String(truck._id),
      tankId: String(tank._id),
    };
  }

  const adminAuth = await authService.login({ email: admin.email, password: PASSWORD });
  const clientAuth = await authService.login({ email: client.email, password: PASSWORD });
  const transportAdminAuth = await authService.login({
    email: transportAdmin.email,
    password: PASSWORD,
  });

  return {
    companyId,
    admin: { id: String(admin._id), token: adminAuth.accessToken },
    client: { id: String(client._id), token: clientAuth.accessToken },
    transportAdmin: { id: String(transportAdmin._id), token: transportAdminAuth.accessToken },
    makeDriver,
  };
}

describe('Smart driver dispatch (US3) — selection rules', () => {
  let ctx: TestAppContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  /** Approves (which auto-routes to the sole transporter, spec 004 FR-014)
   * and returns the ranked candidate list the transport admin sees. */
  async function createApproveAndGetCandidates(
    fixture: Awaited<ReturnType<typeof seedCompanyWithDrivers>>,
    quantityLiters = 500,
  ) {
    const server = app.getHttpServer();
    // DEFERRED skips the billing gate (spec 004 US5) so approval routes
    // immediately, unrelated to what this file actually tests: driver
    // *selection* once ROUTED_TO_TRANSPORT.
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters, paymentMethod: 'DEFERRED' })
      .expect(201);
    const orderId = createRes.body._id;

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);

    const candidatesRes = await request(server)
      .get(`/api/v1/dispatch/orders/${orderId}/candidates`)
      .set('Authorization', `Bearer ${fixture.transportAdmin.token}`)
      .expect(200);

    return { orderId, candidates: candidatesRes.body as Array<{ _id: string }> };
  }

  async function assign(
    fixture: Awaited<ReturnType<typeof seedCompanyWithDrivers>>,
    orderId: string,
    driverId: string,
    truckId: string,
    tankId: string,
  ) {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixture.transportAdmin.token}`)
      .send({ driverId, truckId, tankId })
      .expect(201);
    return res.body as { assigned: boolean; driverId?: string };
  }

  it('ranks the nearest eligible driver first among several candidates', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    const far = await fixture.makeDriver({ label: 'far', offsetDegrees: 2 });
    const near = await fixture.makeDriver({ label: 'near', offsetDegrees: 0.01 });
    const medium = await fixture.makeDriver({ label: 'medium', offsetDegrees: 0.5 });

    const { orderId, candidates } = await createApproveAndGetCandidates(fixture);
    expect(candidates[0]._id).toBe(near.id);
    expect(candidates.map((c) => c._id)).toEqual(
      expect.arrayContaining([far.id, near.id, medium.id]),
    );

    const result = await assign(fixture, orderId, near.id, near.truckId, near.tankId);
    expect(result.assigned).toBe(true);
    expect(result.driverId).toBe(near.id);

    const order = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .expect(200);
    // spec 008 FR-046a: stops at ASSIGNED_TO_DRIVER now, not IN_TRANSIT.
    expect(order.body.status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
    expect(order.body.driverId).toBe(near.id);
  });

  // spec 008 research R3: capacity moved off the driver entirely, onto the
  // Tank — a driver with a too-small tank is now a full CANDIDATE (nothing
  // about them individually is ineligible), and is refused only at
  // assignment, once a specific tank is named.
  it('includes a driver regardless of their tank’s capacity, and refuses assignment against an undersized tank', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    const nearButSmall = await fixture.makeDriver({
      label: 'near-small',
      offsetDegrees: 0.01,
      maxCapacityLiters: 100,
    });
    const fartherButBig = await fixture.makeDriver({
      label: 'far-big',
      offsetDegrees: 0.3,
      maxCapacityLiters: 10000,
    });

    const { orderId, candidates } = await createApproveAndGetCandidates(fixture, 2000);
    const ids = candidates.map((c) => c._id);
    expect(ids).toContain(fartherButBig.id);
    expect(ids).toContain(nearButSmall.id);

    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixture.transportAdmin.token}`)
      .send({
        driverId: nearButSmall.id,
        truckId: nearButSmall.truckId,
        tankId: nearButSmall.tankId,
      })
      .expect(409);
    expect(rejected.body.error).toBe(ErrorCode.TANK_CAPACITY_EXCEEDED);

    const result = await assign(
      fixture,
      orderId,
      fartherButBig.id,
      fartherButBig.truckId,
      fartherButBig.tankId,
    );
    expect(result.assigned).toBe(true);
  });

  // As above (research R3): grade support moved to the Tank — a driver
  // whose tank cannot carry the ordered grade is still a candidate, and is
  // refused only once that specific tank is named at assignment.
  it('includes a driver regardless of their tank’s fuel grade, and refuses assignment against an unsupported grade', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    const wrongFuel = await fixture.makeDriver({
      label: 'wrong-fuel',
      offsetDegrees: 0.01,
      fuelTypes: [FuelType.PETROL_91],
    });
    const rightFuel = await fixture.makeDriver({
      label: 'right-fuel',
      offsetDegrees: 0.2,
      fuelTypes: [FuelType.DIESEL],
    });

    const { orderId, candidates } = await createApproveAndGetCandidates(fixture);
    const ids = candidates.map((c) => c._id);
    expect(ids).toContain(rightFuel.id);
    expect(ids).toContain(wrongFuel.id);

    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixture.transportAdmin.token}`)
      .send({ driverId: wrongFuel.id, truckId: wrongFuel.truckId, tankId: wrongFuel.tankId })
      .expect(409);
    expect(rejected.body.error).toBe(ErrorCode.TANK_GRADE_UNSUPPORTED);

    const result = await assign(
      fixture,
      orderId,
      rightFuel.id,
      rightFuel.truckId,
      rightFuel.tankId,
    );
    expect(result.assigned).toBe(true);
  });

  // spec 010 FR-001/FR-002 (corrected during implementation): the candidate
  // list now shows every driver, not an eligible-only subset — this test
  // used to assert exclusion; it now asserts inclusion with the correct
  // classification, and that ELIGIBLE still ranks first (FR-003).
  it('includes inactive, offline and busy drivers too, each correctly classified, with ELIGIBLE ranked first', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    const inactive = await fixture.makeDriver({
      label: 'inactive',
      offsetDegrees: 0.01,
      isActive: false,
    });
    const offline = await fixture.makeDriver({
      label: 'offline',
      offsetDegrees: 0.02,
      isOnline: false,
    });
    const busy = await fixture.makeDriver({
      label: 'busy',
      offsetDegrees: 0.03,
      isAvailable: false,
    });
    const eligible = await fixture.makeDriver({ label: 'eligible', offsetDegrees: 1 });

    const { candidates } = await createApproveAndGetCandidates(fixture);
    const byId = new Map(
      candidates.map((c: { _id: string; eligibility: string }) => [c._id, c.eligibility]),
    );
    expect(byId.get(inactive.id)).toBe(DriverEligibility.INACTIVE);
    expect(byId.get(offline.id)).toBe(DriverEligibility.OFFLINE);
    expect(byId.get(busy.id)).toBe(DriverEligibility.BUSY);
    expect(byId.get(eligible.id)).toBe(DriverEligibility.ELIGIBLE);
    expect(candidates[0]._id).toBe(eligible.id);
  });

  // spec 010 FR-006 (corrected during implementation): "no candidates" now
  // means zero driver accounts, never merely zero eligible ones — a
  // BUSY-only roster shows that one driver, marked BUSY, not an empty list.
  it('shows a BUSY-only driver rather than an empty list, and the order stays ROUTED_TO_TRANSPORT since nothing auto-assigns', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    const busyOnly = await fixture.makeDriver({
      label: 'busy-only',
      offsetDegrees: 0.01,
      isAvailable: false,
    });

    const { orderId, candidates } = await createApproveAndGetCandidates(fixture);
    expect(candidates.map((c: { _id: string; eligibility: string }) => c.eligibility)).toEqual([
      DriverEligibility.BUSY,
    ]);
    expect(candidates[0]._id).toBe(busyOnly.id);

    const order = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .expect(200);
    expect(order.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
  });

  it('rejects assigning a driver that is no longer eligible, with a clear conflict', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    const driver = await fixture.makeDriver({ label: 'raced', offsetDegrees: 0.01 });
    const { orderId } = await createApproveAndGetCandidates(fixture);

    // A second order books the same (sole) driver first.
    const secondOrder = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${secondOrder.body._id}/approve`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({})
      .expect(200);
    await assign(fixture, secondOrder.body._id, driver.id, driver.truckId, driver.tankId);

    await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixture.transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: driver.truckId, tankId: driver.tankId })
      .expect(409);
  });
});
