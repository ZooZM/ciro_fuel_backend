import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, DEFAULT_PASSWORD } from '../utils/fixtures';
import {
  SessionEvent,
  SessionEventDocument,
} from '../../src/modules/sessions/schemas/session-event.schema';
import { SessionAuditService } from '../../src/modules/sessions/session-audit.service';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { SessionRevocationCause } from '../../src/common/enums/session-revocation-cause.enum';

jest.setTimeout(120_000);

describe('Session audit trail (spec 006 FR-043–046)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let sessionEventModel: Model<SessionEventDocument>;
  let sessionAudit: SessionAuditService;
  let tenantContext: TenantContextService;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    sessionEventModel = app.get(getModelToken(SessionEvent.name));
    sessionAudit = app.get(SessionAuditService);
    tenantContext = app.get(TenantContextService);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('writes a SIGNED_IN row on a real login (T018 wiring, exercised end to end)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phone: undefined, email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);

    const rows = await sessionEventModel
      .find({ userId: new Types.ObjectId(fixtures.companyA.driver.id) })
      .exec();
    expect(rows.some((r) => r.type === 'SIGNED_IN')).toBe(true);
  });

  it("an admin of company A cannot read company B's session events (Principle II)", async () => {
    // Force a distinguishable row in each company by writing directly
    // through the service — independent of whichever HTTP flows are wired
    // in this phase.
    await sessionAudit.signedIn({
      userId: fixtures.companyA.driver.id,
      companyId: fixtures.companyA.transportCompanyId,
      role: UserRole.DRIVER,
      generation: 0,
    });
    await sessionAudit.signedIn({
      userId: fixtures.companyB.driver.id,
      companyId: fixtures.companyB.transportCompanyId,
      role: UserRole.DRIVER,
      generation: 0,
    });

    const rowsVisibleToA = await tenantContext.run(
      {
        userId: fixtures.companyA.transportAdmin.id,
        role: UserRole.TRANSPORT_COMPANY_ADMIN,
        companyId: fixtures.companyA.transportCompanyId,
      },
      () => sessionEventModel.find({}).exec(),
    );

    const companyBDriverId = fixtures.companyB.driver.id;
    expect(rowsVisibleToA.some((r) => String(r.userId) === companyBDriverId)).toBe(false);
    expect(rowsVisibleToA.some((r) => String(r.userId) === fixtures.companyA.driver.id)).toBe(true);
  });

  it('a SUPER_ADMIN sign-in writes a row without throwing on the absent companyId', async () => {
    await expect(
      sessionAudit.signedIn({
        userId: fixtures.superAdmin.id,
        companyId: undefined,
        role: UserRole.SUPER_ADMIN,
        generation: 0,
      }),
    ).resolves.not.toThrow();

    const row = await sessionEventModel
      .findOne({ userId: new Types.ObjectId(fixtures.superAdmin.id), role: UserRole.SUPER_ADMIN })
      .exec();
    expect(row).not.toBeNull();
    expect(row?.companyId).toBeUndefined();
  });

  it('the {userId, occurredAt} query answers which session was live at a given delivery timestamp (FR-044, SC-009a)', async () => {
    const driverId = fixtures.companyA.driver.id;
    const subject = {
      userId: driverId,
      companyId: fixtures.companyA.transportCompanyId,
      role: UserRole.DRIVER,
    };

    // Session 1: signed in, then signed out.
    await sessionAudit.signedIn({ ...subject, generation: 10 });
    const deliveryDuringSession1 = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await sessionAudit.signedOut({ ...subject, generation: 10 });

    await new Promise((r) => setTimeout(r, 5));

    // Session 2: a different generation, displacing the first.
    await sessionAudit.signedIn({ ...subject, generation: 11 });
    const deliveryDuringSession2 = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await sessionAudit.revoked(
      { ...subject, generation: 11 },
      SessionRevocationCause.PASSWORD_RESET,
    );

    // Reconstruction: for a delivery completed at `deliveryDuringSession1`,
    // the most recent event AT OR BEFORE that timestamp identifies the
    // live session (generation 10, SIGNED_IN).
    const asOfSession1 = await sessionEventModel
      .findOne({
        userId: new Types.ObjectId(driverId),
        occurredAt: { $lte: deliveryDuringSession1 },
      })
      .sort({ occurredAt: -1 })
      .exec();
    expect(asOfSession1?.generation).toBe(10);
    expect(asOfSession1?.type).toBe('SIGNED_IN');

    const asOfSession2 = await sessionEventModel
      .findOne({
        userId: new Types.ObjectId(driverId),
        occurredAt: { $lte: deliveryDuringSession2 },
      })
      .sort({ occurredAt: -1 })
      .exec();
    expect(asOfSession2?.generation).toBe(11);
  });

  it('writes no per-request rows — only the lifecycle events actually invoked (FR-046)', async () => {
    const driverId = fixtures.companyB.driver.id;
    const before = await sessionEventModel.countDocuments({
      userId: new Types.ObjectId(driverId),
    });

    // Several ordinary authenticated requests that touch nothing
    // session-lifecycle-related.
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${fixtures.companyB.driver.token}`)
      .expect(200);

    const after = await sessionEventModel.countDocuments({ userId: new Types.ObjectId(driverId) });
    expect(after).toBe(before);
  });
});
