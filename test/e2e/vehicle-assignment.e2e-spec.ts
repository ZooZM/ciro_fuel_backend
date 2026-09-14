import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  DEFAULT_PASSWORD,
  seedTwoCompanies,
  TwoCompanyFixture,
  uniquePhone, settleClientReview } from '../utils/fixtures';
import { UsersService } from '../../src/modules/users/users.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TrucksService } from '../../src/modules/trucks/trucks.service';
import { TanksService } from '../../src/modules/tanks/tanks.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { RegionCode } from '../../src/common/enums/region.enum';
import { Company, CompanyDocument } from '../../src/modules/companies/schemas/company.schema';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { Truck, TruckDocument } from '../../src/modules/trucks/schemas/truck.schema';
import { Tank, TankDocument } from '../../src/modules/tanks/schemas/tank.schema';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { TankMaterial } from '../../src/common/enums/tank-material.enum';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(180_000);

/**
 * spec 008 US2 (T060, T073-T077): the operator commits a driver, a truck and
 * a tank in one transaction — and the delivery stops at
 * `ASSIGNED_TO_DRIVER` rather than advancing itself.
 *
 * T073 is the load-bearing one: the removal of the automatic
 * `→ IN_TRANSIT` edge is what makes the departure gate exist at all. If
 * assignment ever resumes advancing on its own, every verification
 * requirement in US3 becomes unreachable while still appearing to pass.
 */
describe('Vehicle assignment — driver, truck, tank (spec 008 US2)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let userModel: Model<UserDocument>;
  let truckModel: Model<TruckDocument>;
  let tankModel: Model<TankDocument>;

  // A second full set inside company A's transporter, so two assignments
  // can genuinely race for one shared resource.
  let driver2: { id: string; token: string };
  let truck2: string;
  let tank2: string;
  let tankTooSmall: string;
  let tankWrongGrade: string;
  /** A transporter that has registered nothing at all (FR-043c). */
  let emptyFleetAdminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();
    fixtures = await seedTwoCompanies(app);

    userModel = app.get(getModelToken(User.name));
    truckModel = app.get(getModelToken(Truck.name));
    tankModel = app.get(getModelToken(Tank.name));

    const usersService = app.get(UsersService);
    const authService = app.get(AuthService);
    const trucksService = app.get(TrucksService);
    const tanksService = app.get(TanksService);
    const companiesService = app.get(CompaniesService);
    const transportCompanyId = fixtures.companyA.transportCompanyId;

    const d2 = await usersService.create({
      companyId: transportCompanyId as never,
      role: UserRole.DRIVER,
      email: 'driver2@companya.test',
      password: DEFAULT_PASSWORD,
      fullName: 'CompanyA Driver Two',
      phone: uniquePhone(),
      isActive: true,
      isAvailable: true,
      isOnline: true,
      lastSeenAt: new Date(),
      location: { type: 'Point', coordinates: fixtures.companyA.driver.location } as never,
    });
    const d2Auth = await authService.login({ email: d2.email, password: DEFAULT_PASSWORD });
    driver2 = { id: String(d2._id), token: d2Auth.accessToken };

    truck2 = String(
      (await trucksService.create(transportCompanyId, { plateNumber: 'ASSIGN-T2' }))._id,
    );
    tank2 = String(
      (
        await tanksService.create(transportCompanyId, {
          code: 'ASSIGN-TANK-2',
          material: TankMaterial.IRON,
          maxCapacityLiters: 30_000,
          fuelTypes: [FuelType.DIESEL, FuelType.PETROL_91],
        })
      )._id,
    );
    tankTooSmall = String(
      (
        await tanksService.create(transportCompanyId, {
          code: 'ASSIGN-TANK-SMALL',
          material: TankMaterial.IRON,
          maxCapacityLiters: 50,
          fuelTypes: [FuelType.DIESEL],
        })
      )._id,
    );
    tankWrongGrade = String(
      (
        await tanksService.create(transportCompanyId, {
          code: 'ASSIGN-TANK-KERO',
          material: TankMaterial.IRON,
          maxCapacityLiters: 30_000,
          fuelTypes: [FuelType.KEROSENE],
        })
      )._id,
    );

    // FR-043c needs a transporter that has registered NOTHING — the normal
    // starting state for every carrier after cutover.
    const emptyTransport = await companiesService.createTransportCompany(
      fixtures.companyA.companyId,
      {
        name: 'Empty Fleet Transport',
        contactEmail: 'empty@transport.test',
        contactPhone: '+966500000077',
        status: CompanyStatus.ACTIVE,
      },
    );
    const emptyAdmin = await usersService.create({
      companyId: emptyTransport._id as never,
      role: UserRole.TRANSPORT_COMPANY_ADMIN,
      email: 'admin@emptyfleet.test',
      password: DEFAULT_PASSWORD,
      fullName: 'Empty Fleet Admin',
      phone: uniquePhone(),
      isActive: true,
    });
    emptyFleetAdminToken = (
      await authService.login({ email: emptyAdmin.email, password: DEFAULT_PASSWORD })
    ).accessToken;

    // Routing to a transporter that has priced no area is refused — the
    // delivery leg is priced by the company that performs it. This one has an
    // empty FLEET, which is the point of the fixture; it still needs a rate,
    // or the order never reaches the assignment refusal under test.
    await companiesService.setDeliveryRates(String(emptyTransport._id), [
      { regionCode: RegionCode.RIYADH, pricePerKm: 0, minPrice: 30 },
    ]);

    // T077 needs a grade the fuel company can PRICE but no warehouse can
    // SUPPLY — two independent gates that the fixture happens to fail at
    // the first one. Without this, a PETROL_95 order is refused at creation
    // and the assignment-time refusal under test is never reached.
    const companyModel = app.get<Model<CompanyDocument>>(getModelToken(Company.name));
    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      { $push: { fuelPrices: { fuelType: FuelType.PETROL_95, basePricePerLiter: 2.9 } } },
    );
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    // Every actor this file touches, released — research R13 books three
    // resources, so resetting only the driver would leave a later test
    // failing on a booking an earlier one never gave back.
    await Promise.all([
      userModel.updateMany(
        { _id: { $in: [fixtures.companyA.driver.id, driver2.id] } },
        { $set: { isAvailable: true, isOnline: true }, $unset: { activeOrderId: '' } },
      ),
      truckModel.updateMany(
        { _id: { $in: [fixtures.companyA.truck.id, truck2] } },
        { $set: { isActive: true }, $unset: { activeOrderId: '' } },
      ),
      tankModel.updateMany(
        { _id: { $in: [fixtures.companyA.tank.id, tank2, tankTooSmall, tankWrongGrade] } },
        { $set: { isActive: true }, $unset: { activeOrderId: '' } },
      ),
    ]);
  });

  function sign(payload: Record<string, unknown>, secret: string) {
    const rawBody = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  /** An order of company A's client, paid and routed, awaiting assignment. */
  async function routedOrder(
    quantityLiters = 1000,
    fuelType: FuelType = FuelType.DIESEL,
  ): Promise<string> {
    const { client, admin } = fixtures.companyA;
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType, quantityLiters })
      .expect(201);
    const orderId = createRes.body._id as string;

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-assign-${orderId}`,
        orderId,
        amount: approveRes.body.finalPrice,
        currency: 'SAR',
        status: 'PAID',
        paidAt: new Date().toISOString(),
      },
      'sadad-test-secret',
    );
    await settleClientReview(app, orderId);
    await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);

    return orderId;
  }

  const assign = (orderId: string, driverId: string, truckId: string, tankId: string) =>
    request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .send({ driverId, truckId, tankId });

  // --- T060 -----------------------------------------------------------

  it('distinguishes "no fleet registered" from "fleet exists but nothing is free" (FR-043c)', async () => {
    // Both cases return an empty `items`. Inferring the difference from that
    // alone is impossible, which is exactly why `fleetRegistered` exists:
    // one operator needs to register vehicles, the other needs to wait.
    const empty = await request(server)
      .get('/api/v1/trucks?available=true')
      .set('Authorization', `Bearer ${emptyFleetAdminToken}`)
      .expect(200);
    expect(empty.body.items).toHaveLength(0);
    expect(empty.body.fleetRegistered).toBe(false);

    await truckModel.updateMany(
      { _id: { $in: [fixtures.companyA.truck.id, truck2] } },
      { $set: { isActive: false } },
    );
    const withdrawn = await request(server)
      .get('/api/v1/trucks?available=true')
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(withdrawn.body.items).toHaveLength(0);
    expect(withdrawn.body.fleetRegistered).toBe(true);
  });

  // --- T073 -----------------------------------------------------------

  it('records driver, truck, tank and warehouse — and stops at ASSIGNED_TO_DRIVER, not IN_TRANSIT (FR-046a)', async () => {
    const orderId = await routedOrder();
    const res = await assign(
      orderId,
      fixtures.companyA.driver.id,
      fixtures.companyA.truck.id,
      fixtures.companyA.tank.id,
    ).expect(201);
    expect(res.body.assigned).toBe(true);

    const order = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);

    // THE assertion of this file. Before spec 008 this same call landed on
    // IN_TRANSIT in one transaction; the departure gate exists only because
    // it no longer does.
    expect(order.body.status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);
    expect(order.body.driverId).toBe(fixtures.companyA.driver.id);
    expect(order.body.truckId).toBe(fixtures.companyA.truck.id);
    expect(order.body.tankId).toBe(fixtures.companyA.tank.id);
    expect(order.body.warehouseId).toBeTruthy();
    expect(order.body.warehouseSummary).toMatchObject({ name: 'Test Central Warehouse' });
    // Snapshotted at assignment, never re-derived (FR-008/FR-028).
    expect(order.body.tankSummary).toEqual({
      code: fixtures.companyA.tank.code,
      material: 'ALUMINIUM',
    });
    expect(order.body.driverSummary.plateNumber).toBe(fixtures.companyA.truck.plateNumber);

    // All three resources are now committed together.
    const [driver, truck, tank] = await Promise.all([
      userModel.findById(fixtures.companyA.driver.id).exec(),
      truckModel.findById(fixtures.companyA.truck.id).exec(),
      tankModel.findById(fixtures.companyA.tank.id).exec(),
    ]);
    expect(String(driver?.activeOrderId)).toBe(orderId);
    expect(String(truck?.activeOrderId)).toBe(orderId);
    expect(String(tank?.activeOrderId)).toBe(orderId);
  });

  // --- T074 -----------------------------------------------------------

  it('refuses a tank below the ordered quantity and one that cannot carry the grade (SC-025, SC-026)', async () => {
    const smallOrder = await routedOrder(1000, FuelType.DIESEL);
    await assign(smallOrder, fixtures.companyA.driver.id, fixtures.companyA.truck.id, tankTooSmall)
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.TANK_CAPACITY_EXCEEDED));

    const gradeOrder = await routedOrder(1000, FuelType.DIESEL);
    await assign(
      gradeOrder,
      fixtures.companyA.driver.id,
      fixtures.companyA.truck.id,
      tankWrongGrade,
    )
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.TANK_GRADE_UNSUPPORTED));
  });

  it('never offers a tank it would then refuse (FR-016a)', async () => {
    // The offered list and the acceptable set must agree, or an operator is
    // invited to pick something that cannot work.
    const offered = await app
      .get(TanksService)
      .forOrderId(fixtures.companyA.transportCompanyId, 1000, FuelType.DIESEL);
    const offeredIds = offered.map((t) => String(t._id));
    expect(offeredIds).not.toContain(tankTooSmall);
    expect(offeredIds).not.toContain(tankWrongGrade);
    expect(offeredIds).toContain(tank2);
  });

  // --- T075 -----------------------------------------------------------

  it('two simultaneous assignments naming the same TRUCK: exactly one succeeds (SC-007)', async () => {
    const [orderA, orderB] = await Promise.all([routedOrder(), routedOrder()]);

    const [resA, resB] = await Promise.all([
      assign(
        orderA,
        fixtures.companyA.driver.id,
        fixtures.companyA.truck.id,
        fixtures.companyA.tank.id,
      ),
      assign(orderB, driver2.id, fixtures.companyA.truck.id, tank2),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = resA.status === 409 ? resA : resB;
    expect(loser.body.error).toBe(ErrorCode.TRUCK_UNAVAILABLE);

    const truck = await truckModel.findById(fixtures.companyA.truck.id).exec();
    expect(truck?.activeOrderId).toBeTruthy();
  });

  it('a refused assignment strands no resource it had already booked (research R13)', async () => {
    // The failure path books the driver first, the truck second, the tank
    // third. A refusal at step two or three must give back what step one
    // took — otherwise a driver is left committed to an order that was
    // never assigned, with no release path to free them.
    const orderA = await routedOrder();
    const orderB = await routedOrder();

    await assign(
      orderA,
      fixtures.companyA.driver.id,
      fixtures.companyA.truck.id,
      fixtures.companyA.tank.id,
    ).expect(201);

    // driver2 is free; the truck is not. The refusal is about the truck.
    await assign(orderB, driver2.id, fixtures.companyA.truck.id, tank2)
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.TRUCK_UNAVAILABLE));

    const stranded = await userModel.findById(driver2.id).exec();
    expect(stranded?.activeOrderId).toBeUndefined();
    expect(stranded?.isAvailable).toBe(true);
  });

  it('two simultaneous assignments naming the same TANK: exactly one succeeds (SC-024)', async () => {
    const [orderA, orderB] = await Promise.all([routedOrder(), routedOrder()]);

    const [resA, resB] = await Promise.all([
      assign(
        orderA,
        fixtures.companyA.driver.id,
        fixtures.companyA.truck.id,
        fixtures.companyA.tank.id,
      ),
      assign(orderB, driver2.id, truck2, fixtures.companyA.tank.id),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = resA.status === 409 ? resA : resB;
    expect(loser.body.error).toBe(ErrorCode.TANK_UNAVAILABLE);
  });

  // --- T076 -----------------------------------------------------------

  it("suggests the driver's last operated truck, and nothing when there is none (FR-009c)", async () => {
    const first = await routedOrder();
    await assign(first, fixtures.companyA.driver.id, truck2, fixtures.companyA.tank.id).expect(201);

    // Release everything so the same driver is a candidate again.
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
    await truckModel.updateOne({ _id: truck2 }, { $unset: { activeOrderId: '' } });
    await tankModel.updateOne(
      { _id: fixtures.companyA.tank.id },
      { $unset: { activeOrderId: '' } },
    );

    const next = await routedOrder();
    await settleClientReview(app, next);
    const candidates = await request(server)
      .get(`/api/v1/dispatch/orders/${next}/candidates`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);

    const experienced = candidates.body.find(
      (c: { _id: string }) => c._id === fixtures.companyA.driver.id,
    );
    // Derived from order history — research R4 forbids a stored lastTruckId.
    // `id`, not `_id`: this is now mapped through the same safe truck shape as
    // `GET /trucks`, which is what stops it carrying the vehicle's NFC card id
    // and QR token to the assignment screen (FR-042).
    expect(String(experienced.suggestedTruck?.id)).toBe(truck2);

    // A driver who has never driven gets an empty suggestion, not a guess.
    //
    // A FRESH driver is created here rather than reusing driver2. Two earlier
    // tests in this file assign an order to driver2 inside a CONCURRENT race
    // where exactly one of two requests wins (the TRUCK_UNAVAILABLE and
    // TANK_UNAVAILABLE cases). Whether driver2 has a truck in their order
    // history therefore depends on which request won that race — so asserting
    // "driver2 has never driven" failed roughly one run in three and blamed the
    // suggestion logic for a fixture problem. A driver created in this test has
    // no history by construction, which is what the assertion actually means.
    const rookieUser = await app.get(UsersService).create({
      companyId: fixtures.companyA.transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `rookie-${Date.now()}@companya.test`,
      password: DEFAULT_PASSWORD,
      fullName: 'CompanyA Rookie',
      phone: uniquePhone(),
      isActive: true,
      isAvailable: true,
      isOnline: true,
      lastSeenAt: new Date(),
      location: { type: 'Point', coordinates: fixtures.companyA.driver.location } as never,
    });

    await settleClientReview(app, next);
    const withRookie = await request(server)
      .get(`/api/v1/dispatch/orders/${next}/candidates`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);

    const rookie = withRookie.body.find((c: { _id: string }) => c._id === String(rookieUser._id));
    expect(rookie).toBeDefined();
    expect(rookie.suggestedTruck).toBeNull();
  });

  it('suppresses the suggestion when that truck is withdrawn or busy (FR-009d, SC-023)', async () => {
    const first = await routedOrder();
    await assign(first, fixtures.companyA.driver.id, truck2, fixtures.companyA.tank.id).expect(201);
    await userModel.updateOne(
      { _id: fixtures.companyA.driver.id },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    );
    await tankModel.updateOne(
      { _id: fixtures.companyA.tank.id },
      { $unset: { activeOrderId: '' } },
    );

    // truck2 stays committed to `first`. Offering it would invite a pick
    // that assignment would then refuse.
    const next = await routedOrder();
    await settleClientReview(app, next);
    const busy = await request(server)
      .get(`/api/v1/dispatch/orders/${next}/candidates`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(
      busy.body.find((c: { _id: string }) => c._id === fixtures.companyA.driver.id).suggestedTruck,
    ).toBeNull();

    // Same suppression for a withdrawn truck, a different reason with the
    // same consequence for the operator.
    await truckModel.updateOne({ _id: truck2 }, { $unset: { activeOrderId: '' } });
    await truckModel.updateOne({ _id: truck2 }, { $set: { isActive: false } });
    await settleClientReview(app, next);
    const withdrawn = await request(server)
      .get(`/api/v1/dispatch/orders/${next}/candidates`)
      .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
      .expect(200);
    expect(
      withdrawn.body.find((c: { _id: string }) => c._id === fixtures.companyA.driver.id)
        .suggestedTruck,
    ).toBeNull();
  });

  // --- T077 -----------------------------------------------------------

  it('refuses an order no warehouse can supply, before booking anything (FR-035f)', async () => {
    // The fixture warehouse supplies DIESEL and PETROL_91 only.
    //
    // The refusal now arrives EARLIER than it used to — at routing rather than
    // at assignment. Routing has to price the haul, the haul is priced per
    // kilometre from the supplying warehouse, and there is no such warehouse:
    // the same `NO_WAREHOUSE_FOR_GRADE` that assignment used to raise is now
    // raised before a transporter is committed at all.
    //
    // FR-035f's actual guarantee — "before booking anything" — holds a fortiori:
    // nothing can have been booked, because the order never left APPROVED.
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: FuelType.PETROL_95, quantityLiters: 1000, paymentMethod: 'DEFERRED' })
      .expect(201);

    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.NO_WAREHOUSE_FOR_GRADE));

    // "Before any resource is booked" is the part that matters: the driver
    // must not be committed to a delivery that cannot start.
    const [driver, truck, tank] = await Promise.all([
      userModel.findById(fixtures.companyA.driver.id).exec(),
      truckModel.findById(fixtures.companyA.truck.id).exec(),
      tankModel.findById(tank2).exec(),
    ]);
    expect(driver?.activeOrderId).toBeUndefined();
    expect(driver?.isAvailable).toBe(true);
    expect(truck?.activeOrderId).toBeUndefined();
    expect(tank?.activeOrderId).toBeUndefined();
  });
});
