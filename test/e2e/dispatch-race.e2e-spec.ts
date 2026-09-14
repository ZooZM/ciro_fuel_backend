import request from 'supertest';
import { settleClientReview } from '../utils/fixtures';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
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

  it('assigns exactly one of two simultaneously-requested orders to the single eligible driver (spec 004 SC-003)', async () => {
    const companiesService = app.get(CompaniesService);
    const usersService = app.get(UsersService);
    const authService = app.get(AuthService);
    const trucksService = app.get(TrucksService);
    const tanksService = app.get(TanksService);
    const warehousesService = app.get(WarehousesService);

    // spec 008 FR-035f: assignment refuses without a warehouse supplying
    // the order's grade.
    await warehousesService.create({
      name: 'Race Test Warehouse',
      location: { longitude: DELIVERY[0], latitude: DELIVERY[1] },
      addressText: 'Race test warehouse',
      region: RegionCode.RIYADH,
      governorate: GovernorateCode.RIYADH_CITY,
      fuelTypes: [FuelType.DIESEL],
    });

    const company = await companiesService.create({
      name: 'Race Test Co',
      type: CompanyType.FUEL,
      status: CompanyStatus.ACTIVE,
      contactEmail: 'contact@racetest.test',
      contactPhone: '+966500000000',
      fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
      // Required since order creation stopped accepting a fuel price on its
      // own: the service fee and the tax rate live here, and without them the
      // platform refuses PRICING_NOT_CONFIGURED rather than quietly pricing
      // the fuel line alone.
      pricingConfig: {
        deliveryFee: 30,
        serviceFeePercent: 1,
        taxRatePercent: 15,
        tankerCapacitiesLiters: [20000, 30000],
        updatedAt: new Date(),
      },
    });
    const companyId = String(company._id);

    const admin = await usersService.create({
      companyId: company._id as never,
      role: UserRole.FUEL_COMPANY_ADMIN,
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
      station: {
        regionCode: RegionCode.RIYADH,
        governorateCode: GovernorateCode.RIYADH_CITY,
        location: { type: 'Point', coordinates: DELIVERY },
        addressText: '',
      } as never,
    });

    // spec 004: the driver belongs to a Transportation Company, which must
    // serve the client's region for approval to auto-route to it.
    const transportCompany = await companiesService.createTransportCompany(companyId, {
      name: 'Race Test Transport',
      contactEmail: 'transport@racetest.test',
      contactPhone: '+966500000005',
      status: CompanyStatus.ACTIVE,
    });
    await companiesService.assignRegions(companyId, String(transportCompany._id), [
      RegionCode.RIYADH,
    ]);
    // A transporter must price the areas it serves before it can be routed
    // work — the delivery leg is priced by the company that performs it.
    await companiesService.setDeliveryRates(String(transportCompany._id), [
      { regionCode: RegionCode.RIYADH, pricePerKm: 0, minPrice: 30 },
    ]);
    const transportAdmin = await usersService.create({
      companyId: transportCompany._id as never,
      role: UserRole.TRANSPORT_COMPANY_ADMIN,
      email: 'transportadmin@racetest.test',
      password: PASSWORD,
      fullName: 'Race Transport Admin',
      phone: '+966500000004',
      isActive: true,
    });

    // Exactly one eligible driver — the whole point of this test.
    const driver = await usersService.create({
      companyId: transportCompany._id as never,
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
    });
    const driverId = String(driver._id);

    // spec 008 (research R12): a real Truck/Tank pair, since the race is
    // over the driver AND their vehicle booking alike.
    const truck = await trucksService.create(String(transportCompany._id), {
      plateNumber: 'RACE-1',
    });
    const tank = await tanksService.create(String(transportCompany._id), {
      code: 'RACE-TANK-1',
      material: TankMaterial.ALUMINIUM,
      maxCapacityLiters: 5000,
      fuelTypes: [FuelType.DIESEL],
    });
    const truckId = String(truck._id);
    const tankId = String(tank._id);

    const adminAuth = await authService.login({ email: admin.email, password: PASSWORD });
    const clientAuth = await authService.login({ email: client.email, password: PASSWORD });
    const transportAdminAuth = await authService.login({
      email: transportAdmin.email,
      password: PASSWORD,
    });
    const server = app.getHttpServer();

    // DEFERRED skips the billing gate (spec 004 US5) — this test is about
    // the driver-assignment race, not payment.
    const [order1, order2] = await Promise.all([
      request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${clientAuth.accessToken}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
        .expect(201),
      request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${clientAuth.accessToken}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
        .expect(201),
    ]);

    // Both approve cleanly — routing has no scarce resource to race over,
    // both orders route to the same (only) transporter (spec 004 FR-014).
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
    expect(approve1.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approve2.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Both orders are waiting on their station owner's review of the real
    // total; a driver cannot be assigned until that is settled. Settled
    // sequentially, BEFORE the race — the race under test is the two
    // assignments, not the two settlements.
    await settleClientReview(app, order1.body._id);
    await settleClientReview(app, order2.body._id);

    // The actual race (spec 004 FR-018/SC-003): the transporter assigns the
    // SAME single driver to BOTH orders concurrently. Exactly one must win.
    const [assign1, assign2] = await Promise.all([
      request(server)
        .post(`/api/v1/dispatch/orders/${order1.body._id}/assign`)
        .set('Authorization', `Bearer ${transportAdminAuth.accessToken}`)
        .send({ driverId, truckId, tankId }),
      request(server)
        .post(`/api/v1/dispatch/orders/${order2.body._id}/assign`)
        .set('Authorization', `Bearer ${transportAdminAuth.accessToken}`)
        .send({ driverId, truckId, tankId }),
    ]);

    const statuses = [assign1.status, assign2.status].sort();
    // Exactly one assignment succeeds (201); the other loses the race (409)
    // — never both, never neither.
    expect(statuses).toEqual([201, 409]);

    const winningOrderId = assign1.status === 201 ? order1.body._id : order2.body._id;
    const losingOrderId = assign1.status === 201 ? order2.body._id : order1.body._id;

    const winningOrder = await request(server)
      .get(`/api/v1/orders/${winningOrderId}`)
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(200);
    // spec 008 FR-046a: assignment stops at ASSIGNED_TO_DRIVER now, pending
    // departure verification — not IN_TRANSIT.
    expect(winningOrder.body.status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
    expect(winningOrder.body.driverId).toBe(driverId);

    const losingOrder = await request(server)
      .get(`/api/v1/orders/${losingOrderId}`)
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(200);
    // The loser was settled along with the winner, so it is back with its
    // transporter awaiting a driver — it simply did not get this one.
    expect(losingOrder.body.status).toBe(OrderStatus.ROUTED_TO_TRANSPORT);
    expect(losingOrder.body.driverId).toBeFalsy();

    // The driver-side invariant: never double-booked, activeOrderId points
    // at exactly the one order that won, enforced by the partial unique
    // index as a DB-level backstop behind the transactional conditional update.
    const driverDoc = await usersService.findById(driverId);
    expect(driverDoc.isAvailable).toBe(false);
    expect(String(driverDoc.activeOrderId)).toBe(winningOrderId);
  });

  /**
   * Feature 009 T041/FR-008/SC-008 (quickstart.md Part 3 step 3c): the transport
   * dashboard's own race — two admins, or two browser tabs, submitting assignment for
   * the SAME order at once. Distinct from the test above (two orders racing over one
   * driver): here one order is targeted by two concurrent `assign` calls, each with its
   * own otherwise-valid driver/truck/tank combination, and exactly one must win.
   */
  it('assigns exactly one of two simultaneous assignment attempts on the SAME order (feature 009 FR-008, SC-008)', async () => {
    const companiesService = app.get(CompaniesService);
    const usersService = app.get(UsersService);
    const authService = app.get(AuthService);
    const trucksService = app.get(TrucksService);
    const tanksService = app.get(TanksService);
    const warehousesService = app.get(WarehousesService);

    await warehousesService.create({
      name: 'Same-Order Race Warehouse',
      location: { longitude: DELIVERY[0], latitude: DELIVERY[1] },
      addressText: 'Same-order race warehouse',
      region: RegionCode.RIYADH,
      governorate: GovernorateCode.RIYADH_CITY,
      fuelTypes: [FuelType.DIESEL],
    });

    const company = await companiesService.create({
      name: 'Same-Order Race Co',
      type: CompanyType.FUEL,
      status: CompanyStatus.ACTIVE,
      contactEmail: 'contact@sameorderrace.test',
      contactPhone: '+966500000010',
      fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
      // Required since order creation stopped accepting a fuel price on its
      // own: the service fee and the tax rate live here, and without them the
      // platform refuses PRICING_NOT_CONFIGURED rather than quietly pricing
      // the fuel line alone.
      pricingConfig: {
        deliveryFee: 30,
        serviceFeePercent: 1,
        taxRatePercent: 15,
        tankerCapacitiesLiters: [20000, 30000],
        updatedAt: new Date(),
      },
    });
    const companyId = String(company._id);

    const admin = await usersService.create({
      companyId: company._id as never,
      role: UserRole.FUEL_COMPANY_ADMIN,
      email: 'admin@sameorderrace.test',
      password: PASSWORD,
      fullName: 'Same-Order Race Admin',
      phone: '+966500000011',
      isActive: true,
    });

    const client = await usersService.create({
      companyId: company._id as never,
      role: UserRole.CLIENT,
      email: 'client@sameorderrace.test',
      password: PASSWORD,
      fullName: 'Same-Order Race Client',
      phone: '+966500000012',
      isActive: true,
      station: {
        regionCode: RegionCode.RIYADH,
        governorateCode: GovernorateCode.RIYADH_CITY,
        location: { type: 'Point', coordinates: DELIVERY },
        addressText: '',
      } as never,
    });

    const transportCompany = await companiesService.createTransportCompany(companyId, {
      name: 'Same-Order Race Transport',
      contactEmail: 'transport@sameorderrace.test',
      contactPhone: '+966500000015',
      status: CompanyStatus.ACTIVE,
    });
    await companiesService.assignRegions(companyId, String(transportCompany._id), [
      RegionCode.RIYADH,
    ]);
    // A transporter must price the areas it serves before it can be routed
    // work — the delivery leg is priced by the company that performs it.
    await companiesService.setDeliveryRates(String(transportCompany._id), [
      { regionCode: RegionCode.RIYADH, pricePerKm: 0, minPrice: 30 },
    ]);
    const transportAdmin = await usersService.create({
      companyId: transportCompany._id as never,
      role: UserRole.TRANSPORT_COMPANY_ADMIN,
      email: 'transportadmin@sameorderrace.test',
      password: PASSWORD,
      fullName: 'Same-Order Race Transport Admin',
      phone: '+966500000014',
      isActive: true,
    });

    // Two independently-eligible driver/truck/tank combinations — each attempt targets
    // a different resource, so only the ORDER's own status transition can decide the
    // winner, isolating this test from the driver-scarcity race covered above.
    const driverA = await usersService.create({
      companyId: transportCompany._id as never,
      role: UserRole.DRIVER,
      email: 'driverA@sameorderrace.test',
      password: PASSWORD,
      fullName: 'Race Driver A',
      phone: '+966500000013',
      isActive: true,
      isOnline: true,
      isAvailable: true,
      lastSeenAt: new Date(),
      location: { type: 'Point', coordinates: DELIVERY } as never,
    });
    const driverB = await usersService.create({
      companyId: transportCompany._id as never,
      role: UserRole.DRIVER,
      email: 'driverB@sameorderrace.test',
      password: PASSWORD,
      fullName: 'Race Driver B',
      phone: '+966500000016',
      isActive: true,
      isOnline: true,
      isAvailable: true,
      lastSeenAt: new Date(),
      location: { type: 'Point', coordinates: DELIVERY } as never,
    });

    const truckA = await trucksService.create(String(transportCompany._id), {
      plateNumber: 'SAME-RACE-A',
    });
    const tankA = await tanksService.create(String(transportCompany._id), {
      code: 'SAME-RACE-TANK-A',
      material: TankMaterial.ALUMINIUM,
      maxCapacityLiters: 5000,
      fuelTypes: [FuelType.DIESEL],
    });
    const truckB = await trucksService.create(String(transportCompany._id), {
      plateNumber: 'SAME-RACE-B',
    });
    const tankB = await tanksService.create(String(transportCompany._id), {
      code: 'SAME-RACE-TANK-B',
      material: TankMaterial.ALUMINIUM,
      maxCapacityLiters: 5000,
      fuelTypes: [FuelType.DIESEL],
    });

    const adminAuth = await authService.login({ email: admin.email, password: PASSWORD });
    const clientAuth = await authService.login({ email: client.email, password: PASSWORD });
    const transportAdminAuth = await authService.login({
      email: transportAdmin.email,
      password: PASSWORD,
    });
    const server = app.getHttpServer();

    const order = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientAuth.accessToken}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);

    const approved = await request(server)
      .patch(`/api/v1/orders/${order.body._id}/approve`)
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .send({})
      .expect(200);
    expect(approved.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Settled BEFORE the race, so the only thing the two assignments contend
    // for is the order's own ROUTED_TO_TRANSPORT -> ASSIGNED_TO_DRIVER edge.
    await settleClientReview(app, order.body._id);

    // The race: the SAME order, two concurrent assign calls, each naming a different
    // driver/truck/tank. Exactly one must win — the order's own ROUTED_TO_TRANSPORT →
    // ASSIGNED_TO_DRIVER transition is the only thing that can arbitrate, since neither
    // resource is contested on its own.
    const [assignA, assignB] = await Promise.all([
      request(server)
        .post(`/api/v1/dispatch/orders/${order.body._id}/assign`)
        .set('Authorization', `Bearer ${transportAdminAuth.accessToken}`)
        .send({
          driverId: String(driverA._id),
          truckId: String(truckA._id),
          tankId: String(tankA._id),
        }),
      request(server)
        .post(`/api/v1/dispatch/orders/${order.body._id}/assign`)
        .set('Authorization', `Bearer ${transportAdminAuth.accessToken}`)
        .send({
          driverId: String(driverB._id),
          truckId: String(truckB._id),
          tankId: String(tankB._id),
        }),
    ]);

    const statuses = [assignA.status, assignB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const finalOrder = await request(server)
      .get(`/api/v1/orders/${order.body._id}`)
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(200);
    expect(finalOrder.body.status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);

    // Whichever attempt won, the LOSING driver/truck/tank must remain untouched —
    // proof the loser's side effects never partially applied.
    const winningDriverId = assignA.status === 201 ? String(driverA._id) : String(driverB._id);
    const losingDriverId = assignA.status === 201 ? String(driverB._id) : String(driverA._id);
    expect(finalOrder.body.driverId).toBe(winningDriverId);

    const winningDriverDoc = await usersService.findById(winningDriverId);
    expect(winningDriverDoc.isAvailable).toBe(false);
    expect(String(winningDriverDoc.activeOrderId)).toBe(String(order.body._id));

    const losingDriverDoc = await usersService.findById(losingDriverId);
    expect(losingDriverDoc.isAvailable).toBe(true);
    expect(losingDriverDoc.activeOrderId).toBeFalsy();
  });
});
