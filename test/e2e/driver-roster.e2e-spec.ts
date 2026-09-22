import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Connection, Types } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  DEFAULT_PASSWORD,
  uniquePhone,
} from '../utils/fixtures';
import { UsersService } from '../../src/modules/users/users.service';
import { TrucksService } from '../../src/modules/trucks/trucks.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { DutyState } from '../../src/common/enums/duty-state.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) US5 / FR-038–FR-045 / SC-014.
 *
 * The roster answers "who is this driver and who employs them". Two of its
 * requirements are the kind that produce a passing happy-path test when
 * implemented wrongly, and each has a guard here:
 *
 *  - **Trap 2 (T079)**: `DispatchService.getSuggestedTruck` runs exactly the
 *    right query and then suppresses the answer when the truck is unavailable,
 *    because it is a pick-list suggestion. Calling it would make a driver whose
 *    truck is on a job right now read as "never driven" (research R8).
 *  - **SC-014 (T080)**: the privacy boundary is asserted against the SERIALIZED
 *    response body, not against what a screen renders. A field the platform
 *    sends is disclosed whether or not today's dashboard draws it.
 */
describe('GET /drivers/roster — the platform`s driver roster (US5)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;

  let neverConnectedDriverId: string;
  let neverDrivenDriverId: string;
  let twoTruckDriverId: string;
  let secondTruckId: string;
  let secondTruckPlate: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());

    const usersService = app.get(UsersService);
    const trucksService = app.get(TrucksService);

    // A driver who has NEVER connected: no `lastSeenAt` at all. Must be
    // PRESENT with dutyState UNKNOWN, not omitted (FR-040).
    const neverConnected = await usersService.create({
      companyId: fixtures.companyA.transportCompanyId as never,
      role: UserRole.DRIVER,
      email: 'never-connected@roster.test',
      password: DEFAULT_PASSWORD,
      fullName: 'Never Connected Driver',
      phone: uniquePhone(),
      isActive: true,
    });
    neverConnectedDriverId = String(neverConnected._id);

    // A driver who HAS connected but has never been assigned a truck.
    const neverDriven = await usersService.create({
      companyId: fixtures.companyA.transportCompanyId as never,
      role: UserRole.DRIVER,
      email: 'never-driven@roster.test',
      password: DEFAULT_PASSWORD,
      fullName: 'Never Driven Driver',
      phone: uniquePhone(),
      isActive: true,
      isOnline: false,
      lastSeenAt: new Date(),
    });
    neverDrivenDriverId = String(neverDriven._id);

    // A driver with deliveries on TWO different trucks — the most recent must
    // win (FR-039a).
    twoTruckDriverId = fixtures.companyA.driver.id;
    const secondTruck = await trucksService.create(fixtures.companyA.transportCompanyId, {
      plateNumber: 'ROSTER-002',
    });
    secondTruckId = String(secondTruck._id);
    secondTruckPlate = secondTruck.plateNumber;

    await insertOrderFor(twoTruckDriverId, fixtures.companyA.truck.id, '2026-01-01T00:00:00.000Z');
    await insertOrderFor(twoTruckDriverId, secondTruckId, '2026-06-01T00:00:00.000Z');
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  /** A minimal order row carrying only what the last-truck aggregate reads. */
  async function insertOrderFor(driverId: string, truckId: string, createdAt: string) {
    await connection.collection('orders').insertOne({
      clientId: new Types.ObjectId(fixtures.companyA.client.id),
      fuelCompanyId: new Types.ObjectId(fixtures.companyA.companyId),
      transportCompanyId: new Types.ObjectId(fixtures.companyA.transportCompanyId),
      driverId: new Types.ObjectId(driverId),
      truckId: new Types.ObjectId(truckId),
      fuelType: 'DIESEL',
      quantityLiters: 100,
      estimatedPrice: 250,
      status: OrderStatus.DELIVERED,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
  }

  const roster = (token: string, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/drivers/roster${query}`)
      .set('Authorization', `Bearer ${token}`);

  /** Walks every page so an assertion about "every driver" is a real one. */
  async function allRows(token: string, query = ''): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const suffix: string = cursor
        ? `${query ? `${query}&` : '?'}cursor=${encodeURIComponent(cursor)}`
        : query;
      const res = await roster(token, suffix).expect(200);
      rows.push(...res.body.items);
      cursor = res.body.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);
    return rows;
  }

  describe('every driver across every transport company, each naming its employer (FR-038, FR-039)', () => {
    it('lists drivers from more than one transport company', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      const companies = new Set(
        rows.map((row) => (row.transportCompany as { id: string } | null)?.id),
      );
      expect(companies.size).toBeGreaterThan(1);
    });

    it('names the employing company on every row', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      for (const row of rows) {
        const company = row.transportCompany as { id: string; name: string } | null;
        expect(company).not.toBeNull();
        expect(typeof company!.name).toBe('string');
        expect(company!.name.length).toBeGreaterThan(0);
      }
    });

    it('accounts for every DRIVER on the platform', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      const drivers = await connection
        .collection('users')
        .countDocuments({ role: UserRole.DRIVER });
      expect(rows).toHaveLength(drivers);
    });
  });

  describe('a driver who has never connected is PRESENT with UNKNOWN (FR-040)', () => {
    it('appears on the roster rather than being silently dropped', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      const row = rows.find((r) => r.driverId === neverConnectedDriverId);
      // The omission feature 010 found in dispatch: `$geoNear` silently
      // dropped every driver with no recorded location.
      expect(row).toBeDefined();
      expect(row!.dutyState).toBe(DutyState.UNKNOWN);
    });

    it('distinguishes UNKNOWN from OFF_DUTY', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      const offDuty = rows.find((r) => r.driverId === neverDrivenDriverId);
      expect(offDuty!.dutyState).toBe(DutyState.OFF_DUTY);
      // Two drivers, both `isOnline: false`, two different facts. A boolean
      // could not carry this.
      expect(offDuty!.dutyState).not.toBe(DutyState.UNKNOWN);
    });
  });

  describe('never driven is null and is a distinct fact (FR-039b, scenario 6)', () => {
    it('reports lastOperatedTruck: null for a driver never assigned a truck', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      const row = rows.find((r) => r.driverId === neverDrivenDriverId);
      expect(row!.lastOperatedTruck).toBeNull();
    });
  });

  describe('two trucks — the most recent wins (FR-039a, scenario 5)', () => {
    it('names the truck from the later order', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      const row = rows.find((r) => r.driverId === twoTruckDriverId);
      const truck = row!.lastOperatedTruck as { id: string; plateNumber: string };
      expect(truck).not.toBeNull();
      expect(truck.id).toBe(secondTruckId);
      expect(truck.plateNumber).toBe(secondTruckPlate);
    });
  });

  /**
   * T079 — **guard test (trap 2).**
   *
   * Puts the driver's most recent truck on another active order, then asserts
   * the roster STILL names it. `getSuggestedTruck` would suppress it here
   * (`activeOrderId` set means unavailable), and this experienced driver would
   * read as "never driven" — the same value FR-039b reserves for a driver who
   * genuinely has never driven. The roster states a historical fact; a truck
   * being busy is not a fact about the past.
   */
  describe('GUARD: a busy truck is still the truck this driver last operated (research R8)', () => {
    it('names the truck even while it is on another job right now', async () => {
      const busyOrderId = new Types.ObjectId();
      await connection
        .collection('trucks')
        .updateOne(
          { _id: new Types.ObjectId(secondTruckId) },
          { $set: { activeOrderId: busyOrderId, isAvailable: false } },
        );

      const rows = await allRows(fixtures.superAdmin.token);
      const row = rows.find((r) => r.driverId === twoTruckDriverId);
      const truck = row!.lastOperatedTruck as { id: string; plateNumber: string } | null;

      // The assertion the availability-filtering implementation fails.
      expect(truck).not.toBeNull();
      expect(truck!.id).toBe(secondTruckId);

      await connection
        .collection('trucks')
        .updateOne(
          { _id: new Types.ObjectId(secondTruckId) },
          { $unset: { activeOrderId: '' }, $set: { isAvailable: true } },
        );
    });
  });

  /**
   * T080 — **the SC-014 test.** Asserted on what the platform SENDS, not on
   * what a screen renders.
   */
  describe('SC-014: the response discloses nothing about where a driver has been', () => {
    const FORBIDDEN = [
      'location',
      'driverLocation',
      'lastSeenAt',
      'lastMovedAt',
      'lastMovedLocation',
      'locationUpdatedAt',
      'activeOrderId',
      'stopEvents',
      'deliveredAt',
      'orderId',
      'orderCount',
      'trips',
      'tripsMonth',
      'lastShipment',
      'deliveriesToday',
    ];

    it('carries none of the excluded fields at any nesting level', async () => {
      const res = await roster(fixtures.superAdmin.token).expect(200);
      const keys: string[] = [];
      const walk = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            keys.push(key);
            walk(value);
          }
        }
      };
      walk(res.body);

      for (const field of FORBIDDEN) {
        expect(keys).not.toContain(field);
      }
    });

    it('sends exactly the seven contracted row fields and no eighth', async () => {
      const res = await roster(fixtures.superAdmin.token).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const row of res.body.items) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'driverId',
            'dutyState',
            'fullName',
            'isActive',
            'lastOperatedTruck',
            'phone',
            'transportCompany',
          ].sort(),
        );
      }
    });

    it('the truck sub-object carries identity and plate only (FR-044a)', async () => {
      const rows = await allRows(fixtures.superAdmin.token);
      for (const row of rows) {
        const truck = row.lastOperatedTruck as Record<string, unknown> | null;
        if (truck) {
          expect(Object.keys(truck).sort()).toEqual(['id', 'plateNumber']);
        }
      }
    });
  });

  describe('filters and authorization (FR-041, FR-074, SC-012)', () => {
    beforeAll(async () => {
      await connection
        .collection('users')
        .updateOne({ _id: new Types.ObjectId(neverDrivenDriverId) }, { $set: { isActive: false } });
    });

    it('isActive=false narrows to deactivated drivers', async () => {
      const rows = await allRows(fixtures.superAdmin.token, '?isActive=false');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.isActive).toBe(false);
      }
      expect(rows.map((r) => r.driverId)).toContain(neverDrivenDriverId);
    });

    it('isActive=true excludes them', async () => {
      const rows = await allRows(fixtures.superAdmin.token, '?isActive=true');
      expect(rows.map((r) => r.driverId)).not.toContain(neverDrivenDriverId);
    });

    it('dutyState=UNKNOWN narrows to never-connected drivers', async () => {
      const rows = await allRows(fixtures.superAdmin.token, '?dutyState=UNKNOWN');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.dutyState).toBe(DutyState.UNKNOWN);
      }
    });

    it('refuses an unrecognised dutyState with 400', async () => {
      await roster(fixtures.superAdmin.token, '?dutyState=NAPPING').expect(400);
    });

    it('refuses a non-boolean isActive with 400, never coercing it', async () => {
      // `Boolean('no')` is true — a coercing implementation would silently
      // return the ACTIVE drivers for a filter asking the opposite.
      await roster(fixtures.superAdmin.token, '?isActive=no').expect(400);
    });

    it.each([
      ['FUEL_COMPANY_ADMIN', () => fixtures.companyA.admin.token],
      ['TRANSPORT_COMPANY_ADMIN', () => fixtures.companyA.transportAdmin.token],
      ['CLIENT', () => fixtures.companyA.client.token],
      ['DRIVER', () => fixtures.companyA.driver.token],
    ])('refuses a %s with 403', async (_role, token) => {
      await roster(token()).expect(403);
    });
  });
});
