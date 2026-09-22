import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UsersService } from '../../src/modules/users/users.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { GovernorateCode, RegionCode } from '../../src/common/enums/region.enum';
import { StationsService } from '../../src/modules/stations/stations.service';
import { TrucksService } from '../../src/modules/trucks/trucks.service';
import { TanksService } from '../../src/modules/tanks/tanks.service';
import { TankMaterial } from '../../src/common/enums/tank-material.enum';
import { WarehousesService } from '../../src/modules/warehouses/warehouses.service';
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';

export const DEFAULT_PASSWORD = 'Password123!';

// Phone is a login identifier for CLIENT/DRIVER and unique platform-wide, so
// fixtures must vary it per user just as they already do for email. The `+96659`
// prefix is reserved for generated numbers so they can never collide with the
// hand-written `+9665000000XX` literals used elsewhere in the suite.
let phoneSeq = 0;
export function uniquePhone(): string {
  phoneSeq += 1;
  return `+96659${String(phoneSeq).padStart(7, '0')}`;
}

export interface CompanyFixture {
  companyId: string;
  admin: { id: string; email: string; token: string; phone: string };
  client: {
    id: string;
    email: string;
    token: string;
    phone: string;
    stationLocation: [number, number];
  };
  // spec 004: drivers belong to a Transportation Company, not the Fuel
  // Company directly. transportCompanyId serves RegionCode.RIYADH — the
  // same region every fixture client's station is tagged with — so routing
  // resolves this transporter automatically (the single-candidate case) in
  // every test that approves an order without extra setup.
  transportCompanyId: string;
  transportAdmin: { id: string; email: string; token: string; phone: string };
  driver: {
    id: string;
    email: string;
    token: string;
    phone: string;
    location: [number, number];
    maxCapacityLiters: number;
  };
  // spec 008 (cutover, research R12): a real, company-owned Truck/Tank pair
  // replacing the driver's deleted embedded truck — every fixture transport
  // company gets one of each, pre-paired with an NFC card and a minted QR
  // token, so a test can assign a driver + truck + tank without its own setup.
  truck: { id: string; plateNumber: string; nfcCardUid: string; qrToken: string };
  tank: { id: string; code: string; maxCapacityLiters: number };
}

export interface TwoCompanyFixture {
  superAdmin: { id: string; email: string; token: string; phone: string };
  companyA: CompanyFixture;
  companyB: CompanyFixture;
}

async function createCompanyFixture(
  app: INestApplication,
  name: string,
  center: [number, number],
): Promise<CompanyFixture> {
  const companiesService = app.get(CompaniesService);
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);
  const stationsService = app.get(StationsService);

  const company = await companiesService.create({
    name,
    type: CompanyType.FUEL,
    status: CompanyStatus.ACTIVE,
    contactEmail: `contact@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    contactPhone: '+966500000000',
    fuelPrices: [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 },
      { fuelType: FuelType.PETROL_91, basePricePerLiter: 2.2 },
    ],
    // spec 005 D3: every fixture company is priced-and-quotable by default,
    // so tests that exercise POST /orders/quote or the quoteToken path
    // don't need their own setup. Safe alongside every pre-existing test —
    // nothing outside this feature reads pricingConfig at all.
    pricingConfig: {
      deliveryFee: 30,
      serviceFeePercent: 1,
      taxRatePercent: 15,
      tankerCapacitiesLiters: [20000, 22000, 32000, 33000, 36000, 42000, 46000],
      updatedAt: new Date(),
    },
  });
  const companyId = (company._id as { toString(): string }).toString();

  // spec 015 R5: an administrator's phone is now a login identifier and the
  // partial unique index covers admin roles — it must vary per fixture, the
  // same as the CLIENT/DRIVER/transportAdmin phones already do.
  const adminPhone = uniquePhone();
  const admin = await usersService.create({
    companyId: company._id as never,
    role: UserRole.FUEL_COMPANY_ADMIN,
    email: `admin@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Admin`,
    phone: adminPhone,
    isActive: true,
  });

  const stationLocation: [number, number] = [center[0] + 0.01, center[1] + 0.01];
  const clientPhone = uniquePhone();
  const client = await usersService.create({
    companyId: company._id as never,
    role: UserRole.CLIENT,
    email: `client@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Client`,
    phone: clientPhone,
    isActive: true,
    station: {
      regionCode: RegionCode.RIYADH,
      governorateCode: GovernorateCode.RIYADH_CITY,
      location: { type: 'Point', coordinates: stationLocation },
      addressText: '',
    } as never,
  });

  // spec 005: `usersService.create` (called directly here, not through
  // `POST /users`) writes only the legacy embedded `station` field — the
  // real `Station` document is created by `UsersController.create`'s own
  // side effect, which this bypasses. Every fixture client needs a real
  // Station for GET /stations and order creation to have anything to
  // return, so it's created explicitly here instead.
  await stationsService.create(String(client._id), String(company._id), {
    regionCode: RegionCode.RIYADH,
    governorateCode: GovernorateCode.RIYADH_CITY,
    location: { type: 'Point', coordinates: stationLocation } as never,
    addressText: '',
  });

  // A Transportation Company under this Fuel Company, serving the same
  // region the client's station is tagged with, so routing always resolves
  // it as the single candidate (spec 004 FR-014).
  const transportCompany = await companiesService.createTransportCompany(companyId, {
    name: `${name} Transport`,
    contactEmail: `transport@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    contactPhone: '+966500000002',
    status: CompanyStatus.ACTIVE,
  });
  await companiesService.assignRegions(companyId, String(transportCompany._id), [
    RegionCode.RIYADH,
  ]);
  // The delivery leg is priced by the transporter that performs it, so a transporter
  // serving a region with NO rate for it now refuses the quote outright
  // (TRANSPORT_PRICE_NOT_SET) — a configured platform must set one, and so must a
  // fixture that represents one.
  //
  // `pricePerKm: 0` with `minPrice` equal to the fuel company's former
  // `pricingConfig.deliveryFee` (30) is deliberate: every pre-existing suite that
  // asserts an exact order total keeps asserting the same numbers, so those
  // assertions still mean what they meant — while the 30 now travels the new path,
  // out of the transporter's own rate rather than the fuel company's config. A
  // distance-dependent fixture rate would have rewritten dozens of expected totals
  // and told us nothing extra.
  await companiesService.setDeliveryRates(String(transportCompany._id), [
    { regionCode: RegionCode.RIYADH, pricePerKm: 0, minPrice: 30 },
  ]);
  const transportAdminPhone = uniquePhone();
  const transportAdmin = await usersService.create({
    companyId: transportCompany._id as never,
    role: UserRole.TRANSPORT_COMPANY_ADMIN,
    email: `transportadmin@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Transport Admin`,
    phone: transportAdminPhone,
    isActive: true,
  });

  const driverLocation: [number, number] = [center[0], center[1]];
  const maxCapacityLiters = 5000;
  const driverPhone = uniquePhone();
  const driver = await usersService.create({
    companyId: transportCompany._id as never,
    role: UserRole.DRIVER,
    email: `driver@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Driver`,
    phone: driverPhone,
    isActive: true,
    isAvailable: true,
    isOnline: true,
    lastSeenAt: new Date(),
    location: { type: 'Point', coordinates: driverLocation } as never,
  });

  // spec 008 (research R12): a real Truck/Tank pair on the transport
  // company, replacing the driver's deleted embedded truck. Pre-paired
  // with a card and a minted QR token so a test can verify departure/
  // loading without its own credential setup.
  const trucksService = app.get(TrucksService);
  const tanksService = app.get(TanksService);
  const truck = await trucksService.create(String(transportCompany._id), {
    plateNumber: `${name.slice(0, 3).toUpperCase()}-001`,
  });
  const nfcCardUid = `CARD-${name.toUpperCase()}-001`;
  await trucksService.pairCard(String(truck._id), nfcCardUid);
  const { qrToken } = await trucksService.mintQrToken(String(truck._id));
  const tank = await tanksService.create(String(transportCompany._id), {
    code: `TANK-${name.toUpperCase()}-001`,
    material: TankMaterial.ALUMINIUM,
    maxCapacityLiters,
    fuelTypes: [FuelType.DIESEL, FuelType.PETROL_91],
  });

  const [adminAuth, clientAuth, driverAuth, transportAdminAuth] = await Promise.all([
    authService.login({ email: admin.email, password: DEFAULT_PASSWORD }),
    authService.login({ email: client.email, password: DEFAULT_PASSWORD }),
    authService.login({ email: driver.email, password: DEFAULT_PASSWORD }),
    authService.login({ email: transportAdmin.email, password: DEFAULT_PASSWORD }),
  ]);

  return {
    companyId,
    admin: {
      id: String(admin._id),
      email: admin.email,
      token: adminAuth.accessToken,
      phone: adminPhone,
    },
    client: {
      id: String(client._id),
      email: client.email,
      token: clientAuth.accessToken,
      phone: clientPhone,
      stationLocation,
    },
    transportCompanyId: String(transportCompany._id),
    transportAdmin: {
      id: String(transportAdmin._id),
      email: transportAdmin.email,
      token: transportAdminAuth.accessToken,
      phone: transportAdminPhone,
    },
    driver: {
      id: String(driver._id),
      email: driver.email,
      token: driverAuth.accessToken,
      phone: driverPhone,
      location: driverLocation,
      maxCapacityLiters,
    },
    truck: {
      id: String(truck._id),
      plateNumber: truck.plateNumber,
      nfcCardUid,
      qrToken,
    },
    tank: { id: String(tank._id), code: tank.code, maxCapacityLiters },
  };
}

/**
 * spec 008 FR-035f: `DispatchService.assignDriver` refuses to assign unless
 * a warehouse supplies the order's grade — deliberately covers only
 * DIESEL/PETROL_91 (what every fixture driver's tank already carries), so a
 * test that needs `NO_WAREHOUSE_FOR_GRADE` can reach it for free with
 * PETROL_95/KEROSENE, with no warehouse of its own to set up first.
 * Position is irrelevant: `findNearestSupplying` has no distance cap.
 */
/**
 * The one warehouse every fixture order routes to. Exported because spec
 * 008 FR-030a geofences the loading-stage verification against it — a test
 * driver now has to be standing HERE for that step to pass, so its
 * coordinates stopped being an implementation detail of the seeder.
 */
export const DEFAULT_WAREHOUSE_LOCATION = { longitude: 46.6753, latitude: 24.7136 };

async function seedDefaultWarehouse(app: INestApplication): Promise<void> {
  const warehousesService = app.get(WarehousesService);
  await warehousesService.create({
    name: 'Test Central Warehouse',
    location: DEFAULT_WAREHOUSE_LOCATION,
    addressText: 'Test warehouse — riyadh',
    region: RegionCode.RIYADH,
    governorate: GovernorateCode.RIYADH_CITY,
    fuelTypes: [FuelType.DIESEL, FuelType.PETROL_91],
  });
}

/**
 * spec 008 (research R13): `Truck`/`Tank` are booked exactly like the
 * driver — a unique partial index on `activeOrderId` — so a test file that
 * assigns the SAME fixture driver/truck/tank across several `it()` blocks
 * must release all three between tests, not just the driver. Many
 * pre-existing files already reset the driver alone in `beforeEach`; this
 * extends that to the vehicle pair so a later test's assignment doesn't
 * fail with `TRUCK_UNAVAILABLE`/`TANK_UNAVAILABLE` against a booking an
 * earlier, non-completing test left behind.
 */
export async function resetFixtureDispatchState(
  app: INestApplication,
  ...companies: CompanyFixture[]
): Promise<void> {
  const { getModelToken } = await import('@nestjs/mongoose');
  const { User } = await import('../../src/modules/users/schemas/user.schema');
  const { Truck } = await import('../../src/modules/trucks/schemas/truck.schema');
  const { Tank } = await import('../../src/modules/tanks/schemas/tank.schema');
  const userModel = app.get(getModelToken(User.name));
  const truckModel = app.get(getModelToken(Truck.name));
  const tankModel = app.get(getModelToken(Tank.name));
  const driverIds = companies.map((c) => c.driver.id);
  const truckIds = companies.map((c) => c.truck.id);
  const tankIds = companies.map((c) => c.tank.id);
  await Promise.all([
    userModel.updateMany(
      { _id: { $in: driverIds } },
      { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
    ),
    truckModel.updateMany({ _id: { $in: truckIds } }, { $unset: { activeOrderId: '' } }),
    tankModel.updateMany({ _id: { $in: tankIds } }, { $unset: { activeOrderId: '' } }),
  ]);
}

/**
 * Settles the station owner's review of the final total, if the order is
 * waiting on it — the fixture stand-in for "the customer looked at the real
 * price and went ahead".
 *
 * Routing now prices the haul and hands the order back to the station owner
 * before any driver can be assigned, so an order that used to sit at
 * ROUTED_TO_TRANSPORT straight after approval now sits at PENDING_PAYMENT.
 * Every test that approves an order and then assigns a driver needs this step
 * in between; without it the assignment is refused with a 409, which is the
 * platform behaving correctly.
 *
 * Driven through `OrdersService` rather than over HTTP deliberately: the real
 * confirmation is a gateway webhook for DIRECT and `POST /orders/:id/accept`
 * for DEFERRED/CREDIT, and a fixture that had to branch on payment method (and
 * hold a client token, and sign a webhook body) would be re-testing the
 * settlement path in every suite that merely needs to get past it. The suites
 * that are ABOUT settlement — `order-lifecycle`, `billing-methods` — exercise
 * the real routes instead.
 *
 * A no-op unless the order is actually awaiting the client, so it is safe to
 * call unconditionally.
 */
export async function settleClientReview(app: INestApplication, orderId: string): Promise<void> {
  const { OrdersService } = await import('../../src/modules/orders/orders.service');
  const { OrderStatus } = await import('../../src/common/enums/order-status.enum');
  const { SYSTEM_ACTOR } = await import('../../src/common/constants/system-actor');
  const ordersService = app.get(OrdersService);
  const order = await ordersService.findById(orderId);
  if (order.status !== OrderStatus.PENDING_PAYMENT) return;
  await ordersService.settleAndResume(order, SYSTEM_ACTOR);
}

/**
 * spec 008: assignment alone no longer reaches IN_TRANSIT — it stops at
 * ASSIGNED_TO_DRIVER pending departure verification, then LOADING pending
 * loading confirmation (FR-046a). Every pre-existing e2e test that used to
 * assign a driver and immediately call a step gated on IN_TRANSIT (arrive,
 * verify-arrival, etc.) needs that full sequence run first — this bundles
 * it into the one call those tests used to make: assign, then verify the
 * assigned truck's NFC card twice (departure, then loading) and confirm
 * loading, landing the order on IN_TRANSIT exactly where it used to land
 * right after assignment.
 */
export async function assignAndDepart(
  app: INestApplication,
  orderId: string,
  transportAdminToken: string,
  driverToken: string,
  driverId: string,
  truckId: string,
  tankId: string,
  nfcCardUid: string,
): Promise<void> {
  const server = app.getHttpServer();
  // This helper is a fixture, not a throttle test — its own two verify calls
  // must never be the ones that trip `verify-vehicle`'s 5-per-15-minute
  // limit (FR-023) just because a test file calls it several times. Cleared
  // wholesale (not just this route) is safe: it only ever runs BEFORE
  // whatever throttle-specific assertions a test makes afterward, on a
  // fresh per-file app/storage instance — see driver-handover.e2e-spec.ts's
  // own "shared budget" comment for why this collision is real.
  await app.get(ResilientThrottlerStorage).reset();
  // The order may be waiting on the station owner's review of the real total
  // (routing prices the haul, then hands it back) — a no-op if it is not.
  await settleClientReview(app, orderId);
  await request(server)
    .post(`/api/v1/dispatch/orders/${orderId}/assign`)
    .set('Authorization', `Bearer ${transportAdminToken}`)
    .send({ driverId, truckId, tankId })
    .expect(201);
  await request(server)
    .post(`/api/v1/orders/${orderId}/verify-vehicle`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send({ credential: nfcCardUid, method: 'NFC_CARD' })
    .expect(201);
  // The loading re-read is geofenced (FR-030a): the same card, presented at
  // the warehouse. Fixture drivers teleport there.
  await request(server)
    .post(`/api/v1/orders/${orderId}/verify-vehicle`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send({
      credential: nfcCardUid,
      method: 'NFC_CARD',
      driverLocation: DEFAULT_WAREHOUSE_LOCATION,
    })
    .expect(201);
  await request(server)
    .post(`/api/v1/orders/${orderId}/confirm-loading`)
    .set('Authorization', `Bearer ${driverToken}`)
    .expect(201);
}

export async function seedTwoCompanies(app: INestApplication): Promise<TwoCompanyFixture> {
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);
  await seedDefaultWarehouse(app);

  const superAdminPhone = '+966500000099';
  const superAdminUser = await usersService.create({
    role: UserRole.SUPER_ADMIN,
    email: 'owner@platform.test',
    password: DEFAULT_PASSWORD,
    fullName: 'Platform Owner',
    phone: superAdminPhone,
    isActive: true,
  });
  const superAdminAuth = await authService.login({
    email: superAdminUser.email,
    password: DEFAULT_PASSWORD,
  });

  const [companyA, companyB] = await Promise.all([
    createCompanyFixture(app, 'CompanyA', [46.6753, 24.7136]),
    createCompanyFixture(app, 'CompanyB', [39.1925, 21.4858]),
  ]);

  return {
    superAdmin: {
      id: String(superAdminUser._id),
      email: superAdminUser.email,
      token: superAdminAuth.accessToken,
      phone: superAdminPhone,
    },
    companyA,
    companyB,
  };
}

export interface FuelCompanyOnlyFixture {
  companyId: string;
  admin: { id: string; email: string; token: string; phone: string };
}

export interface ThreeFuelCompanyFixture {
  superAdmin: { id: string; email: string; token: string; phone: string };
  /** Sells PETROL_95. */
  companyA: FuelCompanyOnlyFixture;
  /** Also sells PETROL_95 — A and B are the pair every proposal/blindness/award test
   * needs to prove one company's answer is invisible to the OTHER eligible company,
   * not merely to an ineligible one. */
  companyB: FuelCompanyOnlyFixture;
  /** Sells only DIESEL — the company every eligibility/relevance-filter test proves
   * does NOT see a PETROL_95 market offer. */
  companyC: FuelCompanyOnlyFixture;
}

/**
 * spec 016 (broadcast fuel exchange offers) research R11/T005 — every guarantee this
 * feature makes is invisible with two companies: blindness needs a SECOND eligible
 * company whose proposal the first must never see (not just an ineligible third party),
 * and the grade relevance filter needs a company that genuinely does not sell the
 * offered grade. Deliberately lighter than {@link createCompanyFixture}: no client,
 * transporter, driver, truck or tank — nothing this feature's tests exercise reads any
 * of that, and building three of them would triple fixture setup time for no coverage
 * gained.
 */
async function createFuelCompanyOnly(
  app: INestApplication,
  name: string,
  fuelPrices: { fuelType: FuelType; basePricePerLiter: number }[],
): Promise<FuelCompanyOnlyFixture> {
  const companiesService = app.get(CompaniesService);
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);

  const company = await companiesService.create({
    name,
    type: CompanyType.FUEL,
    status: CompanyStatus.ACTIVE,
    contactEmail: `contact@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    contactPhone: '+966500000000',
    fuelPrices,
  });

  const adminPhone = uniquePhone();
  const admin = await usersService.create({
    companyId: company._id as never,
    role: UserRole.FUEL_COMPANY_ADMIN,
    email: `admin@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Admin`,
    phone: adminPhone,
    isActive: true,
  });
  const adminAuth = await authService.login({ email: admin.email, password: DEFAULT_PASSWORD });

  return {
    companyId: String(company._id),
    admin: {
      id: String(admin._id),
      email: admin.email,
      token: adminAuth.accessToken,
      phone: adminPhone,
    },
  };
}

export async function seedThreeFuelCompanies(
  app: INestApplication,
): Promise<ThreeFuelCompanyFixture> {
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);

  const superAdminPhone = uniquePhone();
  const superAdminUser = await usersService.create({
    role: UserRole.SUPER_ADMIN,
    email: 'owner-exchange@platform.test',
    password: DEFAULT_PASSWORD,
    fullName: 'Platform Owner',
    phone: superAdminPhone,
    isActive: true,
  });
  const superAdminAuth = await authService.login({
    email: superAdminUser.email,
    password: DEFAULT_PASSWORD,
  });

  const [companyA, companyB, companyC] = await Promise.all([
    createFuelCompanyOnly(app, 'ExchangeCoA', [
      { fuelType: FuelType.PETROL_95, basePricePerLiter: 2.3 },
    ]),
    createFuelCompanyOnly(app, 'ExchangeCoB', [
      { fuelType: FuelType.PETROL_95, basePricePerLiter: 2.35 },
    ]),
    createFuelCompanyOnly(app, 'ExchangeCoC', [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 },
    ]),
  ]);

  return {
    superAdmin: {
      id: String(superAdminUser._id),
      email: superAdminUser.email,
      token: superAdminAuth.accessToken,
      phone: superAdminPhone,
    },
    companyA,
    companyB,
    companyC,
  };
}

// ---------------------------------------------------------------------------
// spec 017 (operator dashboard)
// ---------------------------------------------------------------------------

export interface ActorFixture {
  id: string;
  email: string;
  token: string;
  phone: string;
}

/**
 * A `SUPER_ADMIN` with a live token, on its own, with no company around it.
 *
 * Every operator-only refusal test (SC-012) needs one actor of each role and
 * nothing else; re-seeding a whole two-company platform per suite to obtain a
 * single token is what makes those suites slow enough to be skipped. The email
 * is caller-supplied because a suite that seeds more than one platform-level
 * actor would otherwise collide on the unique email index.
 */
export async function superAdminActor(
  app: INestApplication,
  email = 'operator@platform.test',
): Promise<ActorFixture> {
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);

  const phone = uniquePhone();
  const user = await usersService.create({
    role: UserRole.SUPER_ADMIN,
    email,
    password: DEFAULT_PASSWORD,
    fullName: 'Platform Operator',
    phone,
    isActive: true,
  });
  const auth = await authService.login({ email, password: DEFAULT_PASSWORD });

  return { id: String(user._id), email, token: auth.accessToken, phone };
}

export interface CompanyWithAdminFixture {
  companyId: string;
  name: string;
  admin: ActorFixture;
}

export interface MultiCompanyPlatformFixture {
  superAdmin: ActorFixture;
  /** Fuel companies, in creation order. */
  fuelCompanies: CompanyWithAdminFixture[];
  /** Transport companies, in creation order, each parented to `fuelCompanies[0]`. */
  transportCompanies: CompanyWithAdminFixture[];
}

/**
 * A platform of N fuel and M transport companies, each with its own
 * administrator — the fixture behind the company-type filter (US2), the
 * platform overview's company counts (US1) and the announcement fan-out's
 * recipient set (US6).
 *
 * Deliberately lighter than {@link createCompanyFixture}: no client, driver,
 * truck, tank or station. Nothing that counts companies reads any of that, and
 * building eight full company fixtures would dominate the suite's runtime for
 * no coverage gained. A test that needs a whole delivery chain uses
 * {@link seedTwoCompanies} instead.
 *
 * Every transport company is created through
 * `CompaniesService.createTransportCompany` under the FIRST fuel company —
 * i.e. through the platform's PRE-EXISTING path, not this feature's new
 * operator route. That is what makes it usable as the "before" half of the
 * FR-031 / SC-005 equivalence tests: a transporter seeded here must stay
 * indistinguishable from one the operator onboards.
 */
export async function seedMultiCompanyPlatform(
  app: INestApplication,
  options: { fuelCompanies?: number; transportCompanies?: number } = {},
): Promise<MultiCompanyPlatformFixture> {
  const fuelCount = options.fuelCompanies ?? 3;
  const transportCount = options.transportCompanies ?? 5;

  const companiesService = app.get(CompaniesService);
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);

  const superAdmin = await superAdminActor(app, 'operator-platform@platform.test');

  const makeAdmin = async (
    companyId: string,
    role: UserRole,
    slug: string,
    label: string,
  ): Promise<ActorFixture> => {
    const phone = uniquePhone();
    const email = `admin-${slug}@platform.test`;
    const user = await usersService.create({
      companyId: companyId as never,
      role,
      email,
      password: DEFAULT_PASSWORD,
      fullName: label,
      phone,
      isActive: true,
    });
    const auth = await authService.login({ email, password: DEFAULT_PASSWORD });
    return { id: String(user._id), email, token: auth.accessToken, phone };
  };

  const fuelCompanies: CompanyWithAdminFixture[] = [];
  for (let i = 0; i < fuelCount; i += 1) {
    const name = `PlatformFuel${i + 1}`;
    const company = await companiesService.create({
      name,
      type: CompanyType.FUEL,
      status: CompanyStatus.ACTIVE,
      contactEmail: `contact-${name.toLowerCase()}@platform.test`,
      contactPhone: '+966500000000',
      fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
    });
    const companyId = String(company._id);
    fuelCompanies.push({
      companyId,
      name,
      admin: await makeAdmin(
        companyId,
        UserRole.FUEL_COMPANY_ADMIN,
        name.toLowerCase(),
        `${name} Admin`,
      ),
    });
  }

  const parentFuelCompanyId = fuelCompanies[0].companyId;
  const transportCompanies: CompanyWithAdminFixture[] = [];
  for (let i = 0; i < transportCount; i += 1) {
    const name = `PlatformTransport${i + 1}`;
    const company = await companiesService.createTransportCompany(parentFuelCompanyId, {
      name,
      contactEmail: `contact-${name.toLowerCase()}@platform.test`,
      contactPhone: '+966500000002',
      status: CompanyStatus.ACTIVE,
    });
    const companyId = String(company._id);
    await companiesService.assignRegions(parentFuelCompanyId, companyId, [RegionCode.RIYADH]);
    transportCompanies.push({
      companyId,
      name,
      admin: await makeAdmin(
        companyId,
        UserRole.TRANSPORT_COMPANY_ADMIN,
        name.toLowerCase(),
        `${name} Admin`,
      ),
    });
  }

  return { superAdmin, fuelCompanies, transportCompanies };
}
