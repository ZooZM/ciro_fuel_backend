import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { UsersService } from '../../src/modules/users/users.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

const PASSWORD = 'Password123!';
// Delivery target near Riyadh; driver locations vary distance from here (roughly, degrees).
const DELIVERY = [46.6753, 24.7136];

async function seedCompanyWithDrivers(app: INestApplication) {
  const companiesService = app.get(CompaniesService);
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);

  const company = await companiesService.create({
    name: 'Dispatch Test Co ' + randomUUID(),
    status: CompanyStatus.ACTIVE,
    contactEmail: 'contact@dispatchtest.test',
    contactPhone: '+966500000000',
    fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
  });

  const admin = await usersService.create({
    companyId: company._id as never,
    role: UserRole.COMPANY_ADMIN,
    email: `admin-${randomUUID()}@dispatchtest.test`,
    password: PASSWORD,
    fullName: 'Dispatch Admin',
    phone: '+966500000001',
    isActive: true,
  });

  const client = await usersService.create({
    companyId: company._id as never,
    role: UserRole.CLIENT,
    email: `client-${randomUUID()}@dispatchtest.test`,
    password: PASSWORD,
    fullName: 'Dispatch Client',
    phone: '+966500000002',
    isActive: true,
    stationLocation: { type: 'Point', coordinates: DELIVERY } as never,
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
      companyId: company._id as never,
      role: UserRole.DRIVER,
      email: `driver-${opts.label}-${randomUUID()}@dispatchtest.test`,
      password: PASSWORD,
      fullName: `Driver ${opts.label}`,
      phone: '+966500000003',
      isActive: opts.isActive ?? true,
      isOnline: opts.isOnline ?? true,
      isAvailable: opts.isAvailable ?? true,
      lastSeenAt: new Date(),
      location: {
        type: 'Point',
        coordinates: [DELIVERY[0] + opts.offsetDegrees, DELIVERY[1] + opts.offsetDegrees],
      } as never,
      ...(opts.activeOrderId ? { activeOrderId: opts.activeOrderId as never } : {}),
      truck: {
        plateNumber: `DT-${opts.label}`,
        maxCapacityLiters: opts.maxCapacityLiters ?? 5000,
        fuelTypes: opts.fuelTypes ?? [FuelType.DIESEL],
      } as never,
    });
    // Deactivated drivers can't log in (by design) — these fixtures exist
    // purely to prove exclusion from dispatch, no token is needed for them.
    const token =
      opts.isActive === false
        ? undefined
        : (await authService.login(driver.email, PASSWORD)).accessToken;
    return { id: String(driver._id), email: driver.email, token };
  }

  const adminAuth = await authService.login(admin.email, PASSWORD);
  const clientAuth = await authService.login(client.email, PASSWORD);

  return {
    companyId: String(company._id),
    admin: { id: String(admin._id), token: adminAuth.accessToken },
    client: { id: String(client._id), token: clientAuth.accessToken },
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

  async function createAndApprove(
    fixture: Awaited<ReturnType<typeof seedCompanyWithDrivers>>,
    quantityLiters = 500,
  ) {
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({})
      .expect(200);
    return { orderId: createRes.body._id, order: approveRes.body };
  }

  it('assigns the nearest eligible driver among several candidates', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    const far = await fixture.makeDriver({ label: 'far', offsetDegrees: 2 });
    const near = await fixture.makeDriver({ label: 'near', offsetDegrees: 0.01 });
    const medium = await fixture.makeDriver({ label: 'medium', offsetDegrees: 0.5 });

    const { order } = await createAndApprove(fixture);
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.driverId).toBe(near.id);
    expect([far.id, medium.id]).not.toContain(order.driverId);
  });

  it('skips a nearer driver whose truck lacks sufficient capacity', async () => {
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

    const { order } = await createAndApprove(fixture, 2000);
    expect(order.driverId).toBe(fartherButBig.id);
    expect(order.driverId).not.toBe(nearButSmall.id);
  });

  it('skips a driver whose truck does not support the ordered fuel type', async () => {
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

    const { order } = await createAndApprove(fixture);
    expect(order.driverId).toBe(rightFuel.id);
    expect(order.driverId).not.toBe(wrongFuel.id);
  });

  it('excludes inactive, offline, and already-busy drivers', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    await fixture.makeDriver({ label: 'inactive', offsetDegrees: 0.01, isActive: false });
    await fixture.makeDriver({ label: 'offline', offsetDegrees: 0.02, isOnline: false });
    await fixture.makeDriver({ label: 'busy', offsetDegrees: 0.03, isAvailable: false });
    const eligible = await fixture.makeDriver({ label: 'eligible', offsetDegrees: 1 });

    const { order } = await createAndApprove(fixture);
    expect(order.driverId).toBe(eligible.id);
  });

  it('leaves the order APPROVED and notifies admins when no driver is eligible', async () => {
    const fixture = await seedCompanyWithDrivers(app);
    await fixture.makeDriver({ label: 'busy-only', offsetDegrees: 0.01, isAvailable: false });

    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500 })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({})
      .expect(200);

    expect(approveRes.body.status).toBe(OrderStatus.APPROVED);
    expect(approveRes.body.driverId).toBeFalsy();

    const notifications = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .expect(200);
    expect(notifications.body.some((n: { type: string }) => n.type === 'NO_DRIVER_AVAILABLE')).toBe(
      true,
    );
  });
});
