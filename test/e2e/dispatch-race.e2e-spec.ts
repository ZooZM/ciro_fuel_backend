import request from 'supertest';
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
const DELIVERY = [46.6753, 24.7136];

describe('Smart driver dispatch (US3) — concurrency safety', () => {
  let ctx: TestAppContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('assigns exactly one of two simultaneously-approved orders to the single eligible driver', async () => {
    const companiesService = app.get(CompaniesService);
    const usersService = app.get(UsersService);
    const authService = app.get(AuthService);

    const company = await companiesService.create({
      name: 'Race Test Co',
      status: CompanyStatus.ACTIVE,
      contactEmail: 'contact@racetest.test',
      contactPhone: '+966500000000',
      fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
    });

    const admin = await usersService.create({
      companyId: company._id as never,
      role: UserRole.COMPANY_ADMIN,
      email: 'admin@racetest.test',
      password: PASSWORD,
      fullName: 'Race Admin',
      phone: '+966500000001',
      isActive: true,
    });

    const client = await usersService.create({
      companyId: company._id as never,
      role: UserRole.CLIENT,
      email: 'client@racetest.test',
      password: PASSWORD,
      fullName: 'Race Client',
      phone: '+966500000002',
      isActive: true,
      stationLocation: { type: 'Point', coordinates: DELIVERY } as never,
    });

    // Exactly one eligible driver — the whole point of this test.
    const driver = await usersService.create({
      companyId: company._id as never,
      role: UserRole.DRIVER,
      email: 'driver@racetest.test',
      password: PASSWORD,
      fullName: 'Race Driver',
      phone: '+966500000003',
      isActive: true,
      isOnline: true,
      isAvailable: true,
      lastSeenAt: new Date(),
      location: { type: 'Point', coordinates: DELIVERY } as never,
      truck: {
        plateNumber: 'RACE-1',
        maxCapacityLiters: 5000,
        fuelTypes: [FuelType.DIESEL],
      } as never,
    });

    const adminAuth = await authService.login(admin.email, PASSWORD);
    const clientAuth = await authService.login(client.email, PASSWORD);
    const server = app.getHttpServer();

    const [order1, order2] = await Promise.all([
      request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${clientAuth.accessToken}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 500 })
        .expect(201),
      request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${clientAuth.accessToken}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 500 })
        .expect(201),
    ]);

    // Approve both concurrently — both trigger auto-dispatch racing for the
    // one available driver (FR-012). No serialization on the test's part.
    const [approve1, approve2] = await Promise.all([
      request(server)
        .patch(`/api/v1/orders/${order1.body._id}/approve`)
        .set('Authorization', `Bearer ${adminAuth.accessToken}`)
        .send({})
        .expect(200),
      request(server)
        .patch(`/api/v1/orders/${order2.body._id}/approve`)
        .set('Authorization', `Bearer ${adminAuth.accessToken}`)
        .send({})
        .expect(200),
    ]);

    const statuses = [approve1.body.status, approve2.body.status].sort();
    // Exactly one order got the driver (PENDING_PAYMENT); the other stayed
    // APPROVED with no eligible driver — never both, never neither.
    expect(statuses).toEqual([OrderStatus.APPROVED, OrderStatus.PENDING_PAYMENT]);

    const assignedOrder =
      approve1.body.status === OrderStatus.PENDING_PAYMENT ? approve1.body : approve2.body;
    const unassignedOrder =
      approve1.body.status === OrderStatus.PENDING_PAYMENT ? approve2.body : approve1.body;
    expect(assignedOrder.driverId).toBe(String(driver._id));
    expect(unassignedOrder.driverId).toBeFalsy();

    // The driver-side invariant: never double-booked, activeOrderId points
    // at exactly the one order that won, enforced by the partial unique
    // index as a DB-level backstop behind the transactional conditional update.
    const driverDoc = await usersService.findById(String(driver._id));
    expect(driverDoc.isAvailable).toBe(false);
    expect(String(driverDoc.activeOrderId)).toBe(assignedOrder._id);

    // The loser was notified that no driver was available.
    const notifications = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(200);
    expect(
      notifications.body.some(
        (n: { type: string; orderId: string }) =>
          n.type === 'NO_DRIVER_AVAILABLE' && n.orderId === unassignedOrder._id,
      ),
    ).toBe(true);
  });
});
