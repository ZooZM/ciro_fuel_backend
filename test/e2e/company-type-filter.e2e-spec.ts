import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedMultiCompanyPlatform, MultiCompanyPlatformFixture } from '../utils/fixtures';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { CompanyType } from '../../src/common/enums/company-type.enum';

jest.setTimeout(120_000);

/**
 * spec 017 (operator dashboard) US2 / FR-010–FR-014 / SC-002.
 *
 * `GET /companies` bound NO query parameters at all before this feature. The
 * dashboard has been sending `?type=FUEL` since feature 013 and the platform
 * has never read it, so the operator's fuel-company list and its count card
 * have silently been counting transporters too (research R2).
 *
 * The FR-012 half matters more than the happy path: the filter must INTERSECT
 * a Fuel Company admin's own-tenant narrowing, never replace it. An
 * implementation that built one merged filter object in the wrong order would
 * pass every operator case here and hand a fuel company every transporter on
 * the platform.
 */
describe('GET /companies honours type and status (US2)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: MultiCompanyPlatformFixture;
  const FUEL_COUNT = 3;
  const TRANSPORT_COUNT = 5;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedMultiCompanyPlatform(app, {
      fuelCompanies: FUEL_COUNT,
      transportCompanies: TRANSPORT_COUNT,
    });
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const list = (token: string, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/companies${query}`)
      .set('Authorization', `Bearer ${token}`);

  describe('as the platform operator (FR-010, FR-011, SC-002)', () => {
    it('type=FUEL returns exactly the fuel companies', async () => {
      const res = await list(fixtures.superAdmin.token, '?type=FUEL').expect(200);
      expect(res.body).toHaveLength(FUEL_COUNT);
      expect(res.body.every((c: { type: string }) => c.type === CompanyType.FUEL)).toBe(true);
    });

    it('type=TRANSPORT returns exactly the transport companies', async () => {
      const res = await list(fixtures.superAdmin.token, '?type=TRANSPORT').expect(200);
      expect(res.body).toHaveLength(TRANSPORT_COUNT);
      expect(res.body.every((c: { type: string }) => c.type === CompanyType.TRANSPORT)).toBe(
        true,
      );
    });

    it('no type returns every company — never a silent default (FR-011)', async () => {
      const res = await list(fixtures.superAdmin.token).expect(200);
      expect(res.body).toHaveLength(FUEL_COUNT + TRANSPORT_COUNT);
    });

    it('an empty type returns every company, not none', async () => {
      // A dashboard select whose "all" option carries value="" sends this on
      // every unfiltered request. Treated as a literal it returns nothing,
      // which is indistinguishable from a platform with no companies on it.
      const res = await list(fixtures.superAdmin.token, '?type=').expect(200);
      expect(res.body).toHaveLength(FUEL_COUNT + TRANSPORT_COUNT);
    });

    it('an unrecognised type is refused with 400, never ignored', async () => {
      await list(fixtures.superAdmin.token, '?type=BANANA').expect(400);
    });
  });

  describe('the filter never widens a fuel company own view (FR-012)', () => {
    const ownCompanyOnly = (body: unknown[], companyId: string) => {
      expect(body).toHaveLength(1);
      expect(String((body[0] as { _id: string })._id)).toBe(companyId);
    };

    it('type=FUEL still returns only their own company', async () => {
      const fuelAdmin = fixtures.fuelCompanies[0];
      const res = await list(fuelAdmin.admin.token, '?type=FUEL').expect(200);
      ownCompanyOnly(res.body, fuelAdmin.companyId);
    });

    it('type=TRANSPORT returns NOTHING — never every transporter on the platform', async () => {
      // The intersection case. A filter that replaced the `_id` narrowing
      // rather than joining it would return all five transport companies here
      // and every operator test above would still pass.
      const fuelAdmin = fixtures.fuelCompanies[0];
      const res = await list(fuelAdmin.admin.token, '?type=TRANSPORT').expect(200);
      expect(res.body).toHaveLength(0);
    });

    it('no filter still returns only their own company', async () => {
      const fuelAdmin = fixtures.fuelCompanies[1];
      const res = await list(fuelAdmin.admin.token).expect(200);
      ownCompanyOnly(res.body, fuelAdmin.companyId);
    });
  });

  describe('status follows the same three rules (FR-013)', () => {
    let suspendedCompanyId: string;

    beforeAll(async () => {
      // Suspend one fuel company so ACTIVE and SUSPENDED are distinguishable.
      suspendedCompanyId = fixtures.fuelCompanies[FUEL_COUNT - 1].companyId;
      await request(app.getHttpServer())
        .patch(`/api/v1/companies/${suspendedCompanyId}/status`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ status: CompanyStatus.SUSPENDED })
        .expect(200);
    });

    it('status=SUSPENDED returns only the suspended company', async () => {
      const res = await list(fixtures.superAdmin.token, '?status=SUSPENDED').expect(200);
      expect(res.body).toHaveLength(1);
      expect(String(res.body[0]._id)).toBe(suspendedCompanyId);
    });

    it('status=ACTIVE excludes it', async () => {
      const res = await list(fixtures.superAdmin.token, '?status=ACTIVE').expect(200);
      expect(res.body).toHaveLength(FUEL_COUNT + TRANSPORT_COUNT - 1);
      expect(
        res.body.some((c: { _id: string }) => String(c._id) === suspendedCompanyId),
      ).toBe(false);
    });

    it('combines with type — both narrowings intersect', async () => {
      const res = await list(fixtures.superAdmin.token, '?type=FUEL&status=ACTIVE').expect(200);
      expect(res.body).toHaveLength(FUEL_COUNT - 1);
      expect(res.body.every((c: { type: string }) => c.type === CompanyType.FUEL)).toBe(true);
    });

    it('an empty status returns every company', async () => {
      const res = await list(fixtures.superAdmin.token, '?status=').expect(200);
      expect(res.body).toHaveLength(FUEL_COUNT + TRANSPORT_COUNT);
    });

    it('an unrecognised status is refused with 400', async () => {
      await list(fixtures.superAdmin.token, '?status=PAUSED').expect(400);
    });

    it('never widens a fuel company own view', async () => {
      const fuelAdmin = fixtures.fuelCompanies[0];
      // This admin's own company is ACTIVE, so SUSPENDED must return nothing —
      // not the other company that happens to be suspended.
      const res = await list(fuelAdmin.admin.token, '?status=SUSPENDED').expect(200);
      expect(res.body).toHaveLength(0);
    });
  });

  // T150 / FR-075: the negative guarantee. An absent filter must return
  // exactly what it returned before this feature for every existing caller.
  describe('no filter is the pre-feature behaviour (FR-075)', () => {
    it('the operator still receives every company with every field', async () => {
      const res = await list(fixtures.superAdmin.token).expect(200);
      expect(res.body).toHaveLength(FUEL_COUNT + TRANSPORT_COUNT);
      for (const company of res.body) {
        expect(company).toHaveProperty('_id');
        expect(company).toHaveProperty('name');
        expect(company).toHaveProperty('type');
        expect(company).toHaveProperty('status');
      }
    });
  });
});
