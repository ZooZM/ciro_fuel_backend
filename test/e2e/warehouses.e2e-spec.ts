import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { WarehousesService } from '../../src/modules/warehouses/warehouses.service';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { GovernorateCode, RegionCode } from '../../src/common/enums/region.enum';

jest.setTimeout(120_000);

/**
 * spec 008 US4 (T035-T036): warehouses as platform infrastructure —
 * research R1's "neither scoping marker" decision made observable.
 *
 * The access shape here is unusual for this codebase and worth pinning
 * down: `Warehouse` is the one collection every authenticated role may read
 * in full and only SUPER_ADMIN may write. Every other resource is scoped to
 * a tenant, so a reviewer meeting this for the first time could plausibly
 * "fix" it by adding a scoping plugin — which would hide depots from the
 * drivers who must drive to them.
 */
describe('Warehouses — platform infrastructure (spec 008 US4)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let server: ReturnType<INestApplication['getHttpServer']>;

  // Far from the fixture warehouse in Riyadh, so this file's own geography
  // is not perturbed by it.
  const DAMMAM: [number, number] = [50.0, 26.0];

  const warehouseAt = (
    name: string,
    coordinates: [number, number],
    fuelTypes: FuelType[],
    externalRef?: string,
  ) => ({
    name,
    location: { longitude: coordinates[0], latitude: coordinates[1] },
    addressText: `${name} — test`,
    region: RegionCode.EASTERN_PROVINCE,
    governorate: GovernorateCode.DAMMAM,
    fuelTypes,
    ...(externalRef ? { externalRef } : {}),
  });

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  // --- T035 -----------------------------------------------------------

  it('SUPER_ADMIN creates a warehouse; all four other roles can read it and none can write (FR-035c)', async () => {
    const created = await request(server)
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send(warehouseAt('T035 Depot', DAMMAM, [FuelType.DIESEL]))
      .expect(201);
    const warehouseId = created.body._id;

    // A driver must be able to read the depot they are being sent to; a
    // client's order names one; both admin roles plan against them.
    const readers = {
      FUEL_COMPANY_ADMIN: fixtures.companyA.admin.token,
      TRANSPORT_COMPANY_ADMIN: fixtures.companyA.transportAdmin.token,
      CLIENT: fixtures.companyA.client.token,
      DRIVER: fixtures.companyA.driver.token,
    };

    for (const token of Object.values(readers)) {
      const list = await request(server)
        .get('/api/v1/warehouses')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // Every role in this loop must see the depot — a driver most of all,
      // since they are the one being sent to it.
      expect(list.body.items.map((w: { _id: string }) => w._id)).toContain(warehouseId);

      await request(server)
        .get(`/api/v1/warehouses/${warehouseId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }

    // …and none of the four may create, alter or withdraw one. A depot is
    // not a tenant's to edit, however much it is theirs to drive to.
    for (const [role, token] of Object.entries(readers)) {
      await request(server)
        .post('/api/v1/warehouses')
        .set('Authorization', `Bearer ${token}`)
        .send(warehouseAt(`${role} should not create`, DAMMAM, [FuelType.DIESEL]))
        .expect(403);
      await request(server)
        .patch(`/api/v1/warehouses/${warehouseId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `renamed by ${role}` })
        .expect(403);
      await request(server)
        .patch(`/api/v1/warehouses/${warehouseId}/withdraw`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(server)
        .post('/api/v1/warehouses/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ warehouses: [warehouseAt('bulk', DAMMAM, [FuelType.DIESEL])] })
        .expect(403);
    }

    // The refusals were refusals, not silent no-ops.
    const after = await request(server)
      .get(`/api/v1/warehouses/${warehouseId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(after.body.name).toBe('T035 Depot');
    expect(after.body.isActive).toBe(true);
  });

  it('a repeated bulk load on the same externalRef updates rather than duplicates (FR-035a)', async () => {
    const entry = warehouseAt('Bulk Depot', DAMMAM, [FuelType.DIESEL], 'WH-EXT-T035');

    const first = await request(server)
      .post('/api/v1/warehouses/bulk')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ warehouses: [entry] })
      .expect(201);
    expect(first.body).toEqual({ created: 1, updated: 0 });

    // Re-loading the national dataset is a routine operation, not an
    // exceptional one — it must be safe to run twice.
    const second = await request(server)
      .post('/api/v1/warehouses/bulk')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ warehouses: [{ ...entry, name: 'Bulk Depot (renamed upstream)' }] })
      .expect(201);
    expect(second.body).toEqual({ created: 0, updated: 1 });

    const list = await request(server)
      .get('/api/v1/warehouses')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    const matching = list.body.items.filter(
      (w: { externalRef?: string }) => w.externalRef === 'WH-EXT-T035',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].name).toBe('Bulk Depot (renamed upstream)');
  });

  // --- T036 -----------------------------------------------------------

  describe('findNearestSupplying (SC-017)', () => {
    // Its own patch of empty map, deliberately far from the depots the
    // tests above create at DAMMAM: a nearest-match assertion is only
    // meaningful if this file's other fixtures cannot win it by accident.
    const PROBE: [number, number] = [45.0, 20.0];
    let service: WarehousesService;
    /** 100 m away, supplies the wrong grade. */
    let nearWrongGrade: string;
    /** ~5 km away, supplies the right one. */
    let farRightGrade: string;

    beforeAll(async () => {
      service = app.get(WarehousesService);
      const near = await request(server)
        .post('/api/v1/warehouses')
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send(warehouseAt('Near, wrong grade', [PROBE[0] + 0.001, PROBE[1]], [FuelType.PETROL_95]))
        .expect(201);
      nearWrongGrade = near.body._id;

      const far = await request(server)
        .post('/api/v1/warehouses')
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send(
          warehouseAt(
            'Far, right grade',
            [PROBE[0] + 0.05, PROBE[1]],
            [FuelType.DIESEL, FuelType.PETROL_95],
          ),
        )
        .expect(201);
      farRightGrade = far.body._id;
    });

    it('skips nearer warehouses that do not supply the grade', async () => {
      // The whole point of FR-035d: proximity is a tiebreak among depots
      // that can actually fill the order, never a reason to send a driver
      // somewhere that cannot. Sorting by distance first and filtering
      // afterwards would pick `nearWrongGrade` here.
      const nearest = await service.findNearestSupplying(PROBE, FuelType.DIESEL);
      expect(String(nearest?._id)).toBe(farRightGrade);
    });

    it('returns the nearest one among those that do supply it', async () => {
      const nearest = await service.findNearestSupplying(PROBE, FuelType.PETROL_95);
      expect(String(nearest?._id)).toBe(nearWrongGrade);
    });

    it('returns nothing when no warehouse supplies the grade at all', async () => {
      // Feeds FR-035f: the operator is refused at assignment rather than a
      // driver being routed to a depot that cannot fill them.
      const nearest = await service.findNearestSupplying(PROBE, FuelType.KEROSENE);
      expect(nearest).toBeNull();
    });

    it('skips a withdrawn warehouse (FR-035d)', async () => {
      await request(server)
        .patch(`/api/v1/warehouses/${farRightGrade}/withdraw`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .expect(200);

      // Only the Riyadh fixture depot supplies DIESEL now — several hundred
      // km away, and still the right answer: withdrawal removes a depot
      // from selection entirely rather than deprioritising it.
      const nearest = await service.findNearestSupplying(PROBE, FuelType.DIESEL);
      expect(String(nearest?._id)).not.toBe(farRightGrade);
      expect(nearest?.name).toBe('Test Central Warehouse');

      await request(server)
        .patch(`/api/v1/warehouses/${farRightGrade}`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ name: 'Far, right grade' })
        .expect(200);
    });
  });
});
