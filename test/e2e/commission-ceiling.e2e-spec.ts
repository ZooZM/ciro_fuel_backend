import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { PlatformAccountService } from '../../src/modules/platform-account/platform-account.service';
import { AccountMovementKind } from '../../src/common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../src/common/enums/account-movement-state.enum';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T152/FR-062a-d/SC-013 — the 90% warning, the
 * ceiling refusal naming it, automatic resumption once a confirmed payment brings the
 * balance back down, and the platform-wide default governing an unset per-company
 * ceiling. Phase 13 (the ledger/payment screen) does not exist yet, so "a confirmed
 * payment" is recorded directly via `PlatformAccountService` — the same
 * `AccountMovement` mechanism that screen will call, reached through the Nest
 * application instance the way this suite's siblings already reach into services no
 * public route covers yet (e.g. `order-lifecycle.e2e-spec.ts` toggling driver
 * presence via the `User` model directly).
 */
describe('Commission ceiling: warning, refusal, automatic resumption, platform default (FR-062a-d, SC-013)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let platformAccountService: PlatformAccountService;
  let connection: Connection;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    platformAccountService = app.get(PlatformAccountService);
    connection = app.get(getConnectionToken());
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  async function createAndApproveCreditOrder(
    fixture: TwoCompanyFixture['companyA'],
    quantityLiters: number,
  ) {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters, paymentMethod: 'CREDIT' })
      .expect(201);
    return created.body._id as string;
  }

  it('warns at 90%, refuses past the ceiling naming it, resumes automatically after a confirmed payment', async () => {
    const server = app.getHttpServer();
    const { admin, client, companyId } = fixtures.companyA;

    await request(server)
      .put(`/api/v1/users/${client.id}/credit-limit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ creditLimit: 1_000_000 })
      .expect(200);

    // A fresh, isolated ceiling: 100 SAR, PERCENTAGE commission at 100% for round figures.
    await request(server)
      .put(`/api/v1/companies/${companyId}/commission-ceiling`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ commissionCeiling: 100 })
      .expect(200);
    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 100 })
      .expect(200);

    // A FUEL_COMPANY_ADMIN cannot set its own ceiling (FR-062a).
    await request(server)
      .put(`/api/v1/companies/${companyId}/commission-ceiling`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ commissionCeiling: 999 })
      .expect(403);

    // 2.5/L * 36L = 90.00 -> 100% commission = 90.00, exactly 90% of the 100 ceiling.
    const orderId1 = await createAndApproveCreditOrder(fixtures.companyA, 36);
    await request(server)
      .patch(`/api/v1/orders/${orderId1}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const atWarning = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(atWarning.body.commissionAccrued).toBeCloseTo(90, 2);
    expect(atWarning.body.commissionCeiling).toBe(100);
    expect(atWarning.body.ceilingWarning).toBe(true);
    expect(atWarning.body.ceilingExceeded).toBe(false);

    // One more small order pushes it to 100.00 — AT the ceiling, not yet over, so this
    // approval itself is still permitted (T147: the gate checks the balance ENTERING
    // the attempt, not what the attempt would produce).
    const orderId2 = await createAndApproveCreditOrder(fixtures.companyA, 4);
    await request(server)
      .patch(`/api/v1/orders/${orderId2}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const atCeiling = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(atCeiling.body.commissionAccrued).toBeCloseTo(100, 2);
    expect(atCeiling.body.ceilingExceeded).toBe(false);

    // NOW a further DEFERRED/CREDIT approval is refused — the balance (100) already
    // equals-or-exceeds nothing yet, so push one more unit over first.
    const orderId3 = await createAndApproveCreditOrder(fixtures.companyA, 4);
    await request(server)
      .patch(`/api/v1/orders/${orderId3}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const overCeiling = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(overCeiling.body.commissionAccrued).toBeGreaterThan(100);
    expect(overCeiling.body.ceilingExceeded).toBe(true);

    const orderId4 = await createAndApproveCreditOrder(fixtures.companyA, 10);
    const refused = await request(server)
      .patch(`/api/v1/orders/${orderId4}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(409);
    expect(refused.body.error).toBe('COMMISSION_CEILING_EXCEEDED');
    expect(refused.body.message).toContain('100.00');

    // The refused order is not left half-approved — still exactly PENDING_APPROVAL.
    const orderAfterRefusal = await request(server)
      .get(`/api/v1/orders/${orderId4}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(orderAfterRefusal.body.status).toBe('PENDING_APPROVAL');

    // A confirmed payment brings the balance back under the ceiling — dealing resumes
    // with NO operator action beyond recording+confirming the payment itself (T148).
    const paymentSession = await connection.startSession();
    try {
      await paymentSession.withTransaction(async () => {
        await platformAccountService.createMovement(
          {
            companyId,
            kind: AccountMovementKind.PAYMENT_RECORDED,
            amount: overCeiling.body.commissionAccrued,
            currency: 'SAR',
            state: AccountMovementState.CONFIRMED,
            reference: 'test-settlement',
            confirmedBy: new Types.ObjectId(fixtures.superAdmin.id),
            confirmedAt: new Date(),
          },
          paymentSession,
        );
      });
    } finally {
      await paymentSession.endSession();
    }

    const afterPayment = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(afterPayment.body.ceilingExceeded).toBe(false);

    // Dealing resumes automatically — the same approval that was refused a moment ago
    // now succeeds for a fresh order, with no operator unlock action taken.
    const orderId5 = await createAndApproveCreditOrder(fixtures.companyA, 4);
    await request(server)
      .patch(`/api/v1/orders/${orderId5}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
  });

  it("a newly onboarded company with no explicit ceiling is governed by the platform-wide default", async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyB;

    const balances = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    // Never explicitly set for company B in this suite — the platform default governs.
    expect(balances.body.commissionCeiling).toBe(Number(process.env.PLATFORM_DEFAULT_COMMISSION_CEILING));
    void companyId;
  });
});
