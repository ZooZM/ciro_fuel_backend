import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, uniquePhone, TwoCompanyFixture } from '../utils/fixtures';
import { UsersService } from '../../src/modules/users/users.service';
import { TrucksService } from '../../src/modules/trucks/trucks.service';
import { TanksService } from '../../src/modules/tanks/tanks.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { TankMaterial } from '../../src/common/enums/tank-material.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';

jest.setTimeout(120_000);

const PASSWORD = 'Password123!';

/**
 * spec 010 T011 (FR-007/FR-008, corrected during implementation): only an
 * OFFLINE driver is ever assignable without already being ELIGIBLE, and only
 * with a reason. BUSY and INACTIVE stay refused unconditionally — the
 * platform's one-active-order-per-driver invariant is not something a reason
 * can override.
 */
describe('Assignment reason gate (spec 010 US1 — FR-007/FR-008)', () => {
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
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
    return orderId;
  }

  /** Every `it` block below assigns a driver, so each needs its own free
   *  truck/tank — reusing the fixture's shared ones across tests would have
   *  the second test's assignment fail on an already-committed VEHICLE,
   *  masking whatever the test actually means to check about the driver. */
  async function freshVehicle(): Promise<{ truckId: string; tankId: string }> {
    const trucksService = app.get(TrucksService);
    const tanksService = app.get(TanksService);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const truck = await trucksService.create(fixtures.companyA.transportCompanyId, {
      plateNumber: `RSN-${suffix}`,
    });
    const tank = await tanksService.create(fixtures.companyA.transportCompanyId, {
      code: `RSN-TANK-${suffix}`,
      material: TankMaterial.ALUMINIUM,
      maxCapacityLiters: 5000,
      fuelTypes: [FuelType.DIESEL],
    });
    return { truckId: String(truck._id), tankId: String(tank._id) };
  }

  it('refuses assigning an OFFLINE driver without a reason, and succeeds with one, recording it', async () => {
    const usersService = app.get(UsersService);
    const offline = await usersService.create({
      companyId: fixtures.companyA.transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `offline-${Date.now()}@reasontest.test`,
      password: PASSWORD,
      fullName: 'Offline Reason Driver',
      phone: uniquePhone(),
      isActive: true,
      isOnline: false,
      isAvailable: true,
      location: {
        type: 'Point',
        coordinates: fixtures.companyA.driver.location,
      } as never,
    });

    const orderId = await routeAnOrder();
    const server = app.getHttpServer();
    const { truckId, tankId } = await freshVehicle();

    const refused = await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({ driverId: String(offline._id), truckId, tankId })
      .expect(400);
    expect(refused.body.error).toBe(ErrorCode.ASSIGNMENT_REASON_REQUIRED);

    const accepted = await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({
        driverId: String(offline._id),
        truckId,
        tankId,
        reason: 'Nearest driver, will be reachable by SMS shortly',
      })
      .expect(201);
    expect(accepted.body.assigned).toBe(true);

    const order = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    expect(order.body.assignedWhileIneligible).toBe(true);
    expect(order.body.assignedWhileIneligibleReason).toBe(
      'Nearest driver, will be reachable by SMS shortly',
    );
  });

  it('refuses assigning a BUSY driver regardless of any reason supplied', async () => {
    const usersService = app.get(UsersService);
    // First order books a fresh driver + vehicle, making that driver BUSY.
    const busy = await usersService.create({
      companyId: fixtures.companyA.transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `busy-${Date.now()}@reasontest.test`,
      password: PASSWORD,
      fullName: 'Busy Reason Driver',
      phone: uniquePhone(),
      isActive: true,
      isOnline: true,
      isAvailable: true,
      location: { type: 'Point', coordinates: fixtures.companyA.driver.location } as never,
    });
    const firstOrderId = await routeAnOrder();
    const firstVehicle = await freshVehicle();
    await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${firstOrderId}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({ driverId: String(busy._id), truckId: firstVehicle.truckId, tankId: firstVehicle.tankId })
      .expect(201);

    const secondOrderId = await routeAnOrder();
    const secondVehicle = await freshVehicle();
    const refused = await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${secondOrderId}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({
        driverId: String(busy._id),
        truckId: secondVehicle.truckId,
        tankId: secondVehicle.tankId,
        reason: 'Trying to double-book anyway',
      })
      .expect(409);
    expect(refused.body.error).not.toBe(ErrorCode.ASSIGNMENT_REASON_REQUIRED);

    // Sanity: still booked to the first order only, unaffected by the
    // refused attempt above.
    const driverDoc = await usersService.findById(String(busy._id));
    expect(String(driverDoc.activeOrderId)).toBe(firstOrderId);
  });

  it('refuses assigning an INACTIVE (deactivated) driver regardless of any reason supplied', async () => {
    const usersService = app.get(UsersService);
    const deactivated = await usersService.create({
      companyId: fixtures.companyA.transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `inactive-${Date.now()}@reasontest.test`,
      password: PASSWORD,
      fullName: 'Inactive Reason Driver',
      phone: uniquePhone(),
      isActive: false,
      isOnline: false,
      isAvailable: true,
      location: {
        type: 'Point',
        coordinates: fixtures.companyA.driver.location,
      } as never,
    });

    const orderId = await routeAnOrder();
    const { truckId, tankId } = await freshVehicle();
    const refused = await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({ driverId: String(deactivated._id), truckId, tankId, reason: 'Trying anyway' })
      .expect(409);
    expect(refused.body.error).not.toBe(ErrorCode.ASSIGNMENT_REASON_REQUIRED);
  });
});
