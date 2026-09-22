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
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { RegionCode } from '../../src/common/enums/region.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) US4 / FR-025–FR-037 / SC-004, SC-005, SC-006.
 *
 * The operator onboards a transport company naming its parent fuel company.
 * The correctness condition that matters most here is a **negative** one: a
 * transporter onboarded through this route must be indistinguishable from one
 * its parent fuel company created itself (FR-031). Only a test that drives both
 * through the same journey can prove that, which is what T065 does below.
 */
describe('The operator onboards and oversees transport companies (US4)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  let seq = 0;
  function onboardBody(overrides: Record<string, unknown> = {}) {
    seq += 1;
    return {
      name: `OperatorOnboarded${seq}`,
      contactEmail: `contact-onboarded-${seq}@platform.test`,
      contactPhone: '+966500000002',
      parentFuelCompanyId: fixtures.companyA.companyId,
      adminEmail: `admin-onboarded-${seq}@platform.test`,
      adminFullName: `Onboarded Admin ${seq}`,
      adminPhone: uniquePhone(),
      adminPassword: DEFAULT_PASSWORD,
      ...overrides,
    };
  }

  const onboard = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/companies/transporters')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  async function counts() {
    return {
      companies: await connection.collection('companies').countDocuments({}),
      users: await connection.collection('users').countDocuments({}),
    };
  }

  describe('onboarding, end to end, with no other role involved (FR-027, SC-004, scenario 2)', () => {
    it('creates the company and its first administrator, who can then sign in', async () => {
      const body = onboardBody();
      const res = await onboard(fixtures.superAdmin.token, body).expect(201);

      expect(res.body.company.type).toBe(CompanyType.TRANSPORT);
      expect(String(res.body.company.parentFuelCompanyId)).toBe(fixtures.companyA.companyId);
      expect(res.body.admin.email).toBe(body.adminEmail);

      // The administrator signs in to their own surface.
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: body.adminEmail, password: DEFAULT_PASSWORD })
        .expect(201);
      expect(login.body.accessToken).toBeTruthy();

      // And their token resolves to THEIR company, not the operator's parent —
      // this is the assertion that would fail had the tenant plugin's
      // companyId overwrite fired (it does not: a SUPER_ADMIN actor takes the
      // role bypass, research R12).
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);
      expect(me.body.role).toBe(UserRole.TRANSPORT_COMPANY_ADMIN);
      expect(String(me.body.companyId)).toBe(String(res.body.company._id));
      expect(String(me.body.companyId)).not.toBe(fixtures.companyA.companyId);
    });
  });

  describe('company and administrator are ONE unit of work (FR-028)', () => {
    it('a duplicate administrator email leaves NEITHER behind', async () => {
      const first = onboardBody();
      await onboard(fixtures.superAdmin.token, first).expect(201);

      const before = await counts();
      // Same admin email, different company name — the company would commit
      // first and the admin insert would fail.
      await onboard(
        fixtures.superAdmin.token,
        onboardBody({ adminEmail: first.adminEmail }),
      ).expect(409);
      const after = await counts();

      expect(after.companies).toBe(before.companies);
      expect(after.users).toBe(before.users);
    });
  });

  describe('the parent fuel company is verified before any write (FR-030, scenario 3)', () => {
    it('refuses an absent parentFuelCompanyId', async () => {
      const body = onboardBody();
      delete (body as Record<string, unknown>).parentFuelCompanyId;
      const before = await counts();
      await onboard(fixtures.superAdmin.token, body).expect(400);
      expect(await counts()).toEqual(before);
    });

    it('refuses a malformed parentFuelCompanyId', async () => {
      const before = await counts();
      await onboard(
        fixtures.superAdmin.token,
        onboardBody({ parentFuelCompanyId: 'not-an-id' }),
      ).expect(400);
      expect(await counts()).toEqual(before);
    });

    it('refuses a well-formed id that names no company', async () => {
      const before = await counts();
      const res = await onboard(
        fixtures.superAdmin.token,
        onboardBody({ parentFuelCompanyId: new Types.ObjectId().toString() }),
      ).expect(400);
      expect(res.body.error ?? res.body.message?.error).toBe(ErrorCode.INVALID_PARENT_FUEL_COMPANY);
      expect(await counts()).toEqual(before);
    });

    it('refuses a parent that is not of type FUEL — the case a present id would pass', async () => {
      // A TRANSPORT company's id is well-formed and exists. Parenting a
      // transporter to it would create a company that signs in, appears in
      // every list and never receives an order.
      const before = await counts();
      const res = await onboard(
        fixtures.superAdmin.token,
        onboardBody({ parentFuelCompanyId: fixtures.companyA.transportCompanyId }),
      ).expect(400);
      expect(res.body.error ?? res.body.message?.error).toBe(ErrorCode.INVALID_PARENT_FUEL_COMPANY);
      expect(await counts()).toEqual(before);
    });
  });

  describe('the route is the operator`s alone (FR-032, SC-012)', () => {
    it('refuses a FUEL_COMPANY_ADMIN', async () => {
      await onboard(fixtures.companyA.admin.token, onboardBody()).expect(403);
    });

    it('refuses a TRANSPORT_COMPANY_ADMIN', async () => {
      await onboard(fixtures.companyA.transportAdmin.token, onboardBody()).expect(403);
    });

    it('leaves the fuel company`s OWN transporter route working unchanged (FR-075)', async () => {
      seq += 1;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({
          name: `SelfOnboarded${seq}`,
          contactEmail: `contact-self-${seq}@platform.test`,
          contactPhone: '+966500000002',
          adminEmail: `admin-self-${seq}@platform.test`,
          adminFullName: `Self Admin ${seq}`,
          adminPhone: uniquePhone(),
          adminPassword: DEFAULT_PASSWORD,
        })
        .expect(201);
      expect(res.body.company.type).toBe(CompanyType.TRANSPORT);
    });
  });

  /**
   * T064a — **the SC-005 test.** Transport companies created BEFORE this
   * feature (the fixture's own, seeded directly) must remain visible to and
   * manageable by their parent fuel company's administrator, with no change in
   * behaviour.
   */
  describe('SC-005: pre-existing transporters are unaffected', () => {
    it('the parent fuel company still lists and manages its original transporter', async () => {
      const list = await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
      const ids = list.body.map((c: { _id: string }) => String(c._id));
      expect(ids).toContain(fixtures.companyA.transportCompanyId);

      // Still manageable: regions can still be assigned to it.
      await request(app.getHttpServer())
        .put(`/api/v1/companies/${fixtures.companyA.transportCompanyId}/regions`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({ regionCodes: [RegionCode.RIYADH] })
        .expect(200);
    });
  });

  /**
   * T065 — **the SC-006 test, and the only one that can prove FR-031.**
   *
   * Onboards transporter A through the operator's route and transporter B
   * through the parent fuel company's own route, then drives BOTH through the
   * same journey. Any observable difference between them is a defect: the
   * operator's route must be another door onto the same capability, not a
   * parallel one.
   */
  describe('SC-006: a transporter onboarded either way is indistinguishable', () => {
    let operatorOnboardedId: string;
    let selfOnboardedId: string;

    beforeAll(async () => {
      const viaOperator = await onboard(fixtures.superAdmin.token, onboardBody()).expect(201);
      operatorOnboardedId = String(viaOperator.body.company._id);

      seq += 1;
      const viaParent = await request(app.getHttpServer())
        .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .send({
          name: `ParitySelf${seq}`,
          contactEmail: `contact-parity-${seq}@platform.test`,
          contactPhone: '+966500000002',
          adminEmail: `admin-parity-${seq}@platform.test`,
          adminFullName: `Parity Admin ${seq}`,
          adminPhone: uniquePhone(),
          adminPassword: DEFAULT_PASSWORD,
        })
        .expect(201);
      selfOnboardedId = String(viaParent.body.company._id);
    });

    it('the parent fuel company lists BOTH', async () => {
      const list = await request(app.getHttpServer())
        .get(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);
      const ids = list.body.map((c: { _id: string }) => String(c._id));
      expect(ids).toContain(operatorOnboardedId);
      expect(ids).toContain(selfOnboardedId);
    });

    it('regions assign to BOTH through the parent`s own route', async () => {
      for (const id of [operatorOnboardedId, selfOnboardedId]) {
        await request(app.getHttpServer())
          .put(`/api/v1/companies/${id}/regions`)
          .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
          .send({ regionCodes: [RegionCode.MAKKAH] })
          .expect(200);
      }
    });

    it('the stored documents differ in nothing but identity and the fields supplied', async () => {
      const [viaOperator, viaParent] = await Promise.all(
        [operatorOnboardedId, selfOnboardedId].map((id) =>
          connection.collection('companies').findOne({ _id: new Types.ObjectId(id) }),
        ),
      );
      const shapeOf = (doc: Record<string, unknown> | null) => Object.keys(doc ?? {}).sort();
      expect(shapeOf(viaOperator)).toEqual(shapeOf(viaParent));
      expect(viaOperator!.type).toBe(viaParent!.type);
      expect(String(viaOperator!.parentFuelCompanyId)).toBe(String(viaParent!.parentFuelCompanyId));
      expect(viaOperator!.status).toBe(viaParent!.status);
    });

    it('both administrators are stamped with their OWN company, not the parent`s', async () => {
      for (const companyId of [operatorOnboardedId, selfOnboardedId]) {
        const admin = await connection
          .collection('users')
          .findOne({ companyId: new Types.ObjectId(companyId) });
        expect(admin).not.toBeNull();
        expect(admin!.role).toBe(UserRole.TRANSPORT_COMPANY_ADMIN);
      }
    });
  });

  /** T064b — per-transporter order volume (FR-026, FR-026a, FR-026b). */
  describe('order volumes resolve for a whole page in ONE request (FR-026a, FR-026b)', () => {
    const volumes = (token: string, query: string) =>
      request(app.getHttpServer())
        .get(`/api/v1/platform/transport-company-volumes${query}`)
        .set('Authorization', `Bearer ${token}`);

    let busyTransporterId: string;
    let quietTransporterId: string;

    beforeAll(async () => {
      busyTransporterId = fixtures.companyA.transportCompanyId;
      quietTransporterId = fixtures.companyB.transportCompanyId;
      for (let i = 0; i < 3; i += 1) {
        await connection.collection('orders').insertOne({
          clientId: new Types.ObjectId(fixtures.companyA.client.id),
          fuelCompanyId: new Types.ObjectId(fixtures.companyA.companyId),
          transportCompanyId: new Types.ObjectId(busyTransporterId),
          fuelType: 'DIESEL',
          quantityLiters: 100,
          estimatedPrice: 250,
          status: OrderStatus.IN_TRANSIT,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    });

    it('returns a row for every company asked about, in one call', async () => {
      const res = await volumes(
        fixtures.superAdmin.token,
        `?companyIds=${busyTransporterId},${quietTransporterId}`,
      ).expect(200);
      expect(res.body.items).toHaveLength(2);
      const byId = new Map(
        res.body.items.map((row: { companyId: string; orderCount: number }) => [
          row.companyId,
          row.orderCount,
        ]),
      );
      expect(byId.get(busyTransporterId)).toBeGreaterThanOrEqual(3);
    });

    it('a transporter never routed to reports 0, rather than being omitted', async () => {
      const res = await volumes(
        fixtures.superAdmin.token,
        `?companyIds=${quietTransporterId}`,
      ).expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].companyId).toBe(quietTransporterId);
      expect(res.body.items[0].orderCount).toBe(0);
    });

    it('defaults its period identically to the platform overview (FR-026a)', async () => {
      const [vol, overview] = await Promise.all([
        volumes(fixtures.superAdmin.token, `?companyIds=${busyTransporterId}`).expect(200),
        request(app.getHttpServer())
          .get('/api/v1/platform/overview')
          .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
          .expect(200),
      ]);
      expect(vol.body.isDefault).toBe(true);
      expect(new Date(vol.body.from).toISOString()).toBe(
        new Date(overview.body.period.from).toISOString(),
      );
    });

    it('requires companyIds rather than silently answering for the whole platform', async () => {
      await volumes(fixtures.superAdmin.token, '').expect(400);
    });

    it('refuses every non-operator role', async () => {
      for (const token of [
        fixtures.companyA.admin.token,
        fixtures.companyA.transportAdmin.token,
        fixtures.companyA.client.token,
        fixtures.companyA.driver.token,
      ]) {
        await volumes(token, `?companyIds=${busyTransporterId}`).expect(403);
      }
    });
  });

  /** FR-033 — suspend and reinstate use the EXISTING route; no backend change. */
  describe('suspend and reinstate reuse the existing operator-only status route (FR-033)', () => {
    it('suspends and reinstates a transport company', async () => {
      const id = fixtures.companyB.transportCompanyId;
      const suspend = await request(app.getHttpServer())
        .patch(`/api/v1/companies/${id}/status`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ status: 'SUSPENDED' })
        .expect(200);
      expect(suspend.body.status).toBe('SUSPENDED');

      const reinstate = await request(app.getHttpServer())
        .patch(`/api/v1/companies/${id}/status`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(reinstate.body.status).toBe('ACTIVE');
    });
  });
});
