import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/** Spec 004 User Story 2: a Fuel Company creates a Transportation Company
 * and assigns it the regions it may serve. */
describe('Transporter creation & region assignment (spec 004 US2)', () => {
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

  async function createTransporter(fuelCompanyId: string, adminToken: string, name: string) {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/companies/${fuelCompanyId}/transporters`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name,
        contactEmail: `contact@${name.toLowerCase().replace(/\s+/g, '')}.test`,
        contactPhone: '+966500000001',
        adminEmail: `admin@${name.toLowerCase().replace(/\s+/g, '')}.test`,
        adminFullName: `${name} Admin`,
        adminPhone: '+966500000002',
        adminPassword: 'Password123!',
      })
      .expect(201);
    return res.body as {
      company: { _id: string; type: string; parentFuelCompanyId: string; servedRegions: string[] };
      admin: { id: string; email: string };
    };
  }

  it('creates a transporter typed TRANSPORT, owned by the creating Fuel Company, with a TRANSPORT_COMPANY_ADMIN admin', async () => {
    const created = await createTransporter(
      fixtures.companyA.companyId,
      fixtures.companyA.admin.token,
      'Region Test Transporter A',
    );

    expect(created.company.type).toBe('TRANSPORT');
    expect(created.company.parentFuelCompanyId).toBe(fixtures.companyA.companyId);
    expect(created.company.servedRegions).toEqual([]);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: created.admin.email, password: 'Password123!' })
      .expect(201);
    expect(login.body.user.role).toBe('TRANSPORT_COMPANY_ADMIN');
  });

  it('assigns exactly the given regions, replacing rather than merging on a second call', async () => {
    const created = await createTransporter(
      fixtures.companyA.companyId,
      fixtures.companyA.admin.token,
      'Region Test Transporter B',
    );

    const first = await request(app.getHttpServer())
      .put(`/api/v1/companies/${created.company._id}/regions`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ regionCodes: ['RIYADH', 'MAKKAH'] })
      .expect(200);
    expect(first.body.servedRegions.sort()).toEqual(['MAKKAH', 'RIYADH']);

    const second = await request(app.getHttpServer())
      .put(`/api/v1/companies/${created.company._id}/regions`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ regionCodes: ['TABUK'] })
      .expect(200);
    // Replace, not merge — RIYADH/MAKKAH must be gone, not accumulated.
    expect(second.body.servedRegions).toEqual(['TABUK']);
  });

  it('reads back the assigned regions via the read-only company lookup, for both the Fuel Company and the transporter itself', async () => {
    const created = await createTransporter(
      fixtures.companyA.companyId,
      fixtures.companyA.admin.token,
      'Region Test Transporter C',
    );
    await request(app.getHttpServer())
      .put(`/api/v1/companies/${created.company._id}/regions`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ regionCodes: ['ASIR'] })
      .expect(200);

    const asFuelAdmin = await request(app.getHttpServer())
      .get(`/api/v1/companies/${created.company._id}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    expect(asFuelAdmin.body.servedRegions).toEqual(['ASIR']);

    const transportLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: created.admin.email, password: 'Password123!' })
      .expect(201);

    // T032: the transporter's own admin reads their own company (existing
    // assertCompanyAccess — role-agnostic, needs no new endpoint) and sees
    // their servedRegions, but cannot change them.
    const asTransportAdmin = await request(app.getHttpServer())
      .get(`/api/v1/companies/${created.company._id}`)
      .set('Authorization', `Bearer ${transportLogin.body.accessToken}`)
      .expect(200);
    expect(asTransportAdmin.body.servedRegions).toEqual(['ASIR']);

    await request(app.getHttpServer())
      .put(`/api/v1/companies/${created.company._id}/regions`)
      .set('Authorization', `Bearer ${transportLogin.body.accessToken}`)
      .send({ regionCodes: ['NAJRAN'] })
      .expect(403);
  });

  it('rejects an unknown region code rather than silently accepting an ambiguous value', async () => {
    const created = await createTransporter(
      fixtures.companyA.companyId,
      fixtures.companyA.admin.token,
      'Region Test Transporter D',
    );

    await request(app.getHttpServer())
      .put(`/api/v1/companies/${created.company._id}/regions`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ regionCodes: ['ATLANTIS'] })
      .expect(400);
  });

  it("rejects Fuel Company B assigning regions to Fuel Company A's transporter (404, never 403)", async () => {
    const created = await createTransporter(
      fixtures.companyA.companyId,
      fixtures.companyA.admin.token,
      'Region Test Transporter E',
    );

    await request(app.getHttpServer())
      .put(`/api/v1/companies/${created.company._id}/regions`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({ regionCodes: ['JAZAN'] })
      .expect(404);
  });

  it("rejects Fuel Company B creating a transporter under Fuel Company A (cannot self-assign into someone else's tenant)", async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({
        name: 'Imposter Transporter',
        contactEmail: 'contact@imposter.test',
        contactPhone: '+966500000003',
        adminEmail: 'admin@imposter.test',
        adminFullName: 'Imposter Admin',
        adminPhone: '+966500000004',
        adminPassword: 'Password123!',
      })
      .expect(404);
  });

  it('CLIENT and DRIVER cannot create a transporter or assign regions', async () => {
    const server = app.getHttpServer();
    const payload = {
      name: 'Should Not Exist',
      contactEmail: 'contact@shouldnotexist.test',
      contactPhone: '+966500000005',
      adminEmail: 'admin@shouldnotexist.test',
      adminFullName: 'Nope',
      adminPhone: '+966500000006',
      adminPassword: 'Password123!',
    };
    await request(server)
      .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send(payload)
      .expect(403);
    await request(server)
      .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send(payload)
      .expect(403);
  });

  /**
   * spec 013 (fuel company admin dashboard) FR-033, T086a — genuine platform addition:
   * `create` above existed with no listing counterpart. Without this, an onboarded
   * transporter could never be seen again through any endpoint.
   */
  describe('listing a fuel company\'s own transporters (FR-033)', () => {
    it('lists exactly the transporters this fuel company created, and none of another\'s', async () => {
      const created = await createTransporter(
        fixtures.companyA.companyId,
        fixtures.companyA.admin.token,
        'Region Test Transporter List A',
      );

      const asOwner = await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
      const ids = (asOwner.body as { _id: string }[]).map((c) => c._id);
      expect(ids).toContain(created.company._id);

      // Company B's own listing must never contain company A's transporter.
      const asOtherCompany = await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyB.companyId}/transporters`)
        .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
        .expect(200);
      const otherIds = (asOtherCompany.body as { _id: string }[]).map((c) => c._id);
      expect(otherIds).not.toContain(created.company._id);
    });

    it("refuses Fuel Company B listing Fuel Company A's transporters (404, never 403)", async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
        .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
        .expect(404);
    });
  });

  /**
   * spec 013 FR-035/FR-036, T086a/T086b — the FUEL-type counterpart to servedRegions
   * above: the regions a fuel company covers itself, distinct from the regions it
   * assigns to a transporter.
   */
  describe("a fuel company's own covered regions (FR-036)", () => {
    it('starts empty, is set by the owning admin, and reads back the same value', async () => {
      const initial = await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}/covered-regions`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
      expect(initial.body).toEqual([]);

      const set = await request(app.getHttpServer())
        .put(`/api/v1/companies/${fixtures.companyA.companyId}/covered-regions`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({ regionCodes: ['RIYADH', 'MAKKAH'] })
        .expect(200);
      expect(set.body.sort()).toEqual(['MAKKAH', 'RIYADH']);

      const readBack = await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}/covered-regions`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
      expect(readBack.body.sort()).toEqual(['MAKKAH', 'RIYADH']);
    });

    it("never touches the fuel company's own servedRegions field (they are distinct)", async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/companies/${fixtures.companyA.companyId}/covered-regions`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({ regionCodes: ['TABUK'] })
        .expect(200);

      const asOwner = await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
      // A fuel company's own servedRegions is meaningless/absent — this asserts the two
      // fields do not alias each other, not a specific value for servedRegions.
      expect(asOwner.body.coveredRegions.sort()).toEqual(['TABUK']);
    });

    it("refuses Fuel Company B reading or writing Fuel Company A's covered regions (404)", async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}/covered-regions`)
        .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
        .expect(404);
      await request(app.getHttpServer())
        .put(`/api/v1/companies/${fixtures.companyA.companyId}/covered-regions`)
        .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
        .send({ regionCodes: ['JAZAN'] })
        .expect(404);
    });

    it('rejects an unknown region code', async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/companies/${fixtures.companyA.companyId}/covered-regions`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({ regionCodes: ['ATLANTIS'] })
        .expect(400);
    });
  });
});
