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

    // The ceiling is DERIVED from what the first order actually accrues,
    // rather than guessed, so this test no longer depends on hand-tuned litre
    // counts. It used to pick 400 because 132 L happened to accrue exactly 360
    // (90%) and 4 L exactly 40 — arithmetic that only held while an order's
    // amount was fuel + haul. It is now fuel + service fee + haul + VAT, and no
    // integer litre count lands on a round fraction of a round ceiling.
    //
    // Start high so the first approval is never itself refused; the real
    // ceiling is set below, once there is a real figure to set it from.
    await request(server)
      .put(`/api/v1/companies/${companyId}/commission-ceiling`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ commissionCeiling: 1_000_000 })
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

    // One order at 100% commission. Whatever it accrues becomes the ceiling,
    // which puts the balance EXACTLY on it — the boundary this test cares
    // about, reached by construction instead of by arithmetic that has to be
    // re-tuned whenever a fee moves.
    const orderId1 = await createAndApproveCreditOrder(fixtures.companyA, 132);
    await request(server)
      .patch(`/api/v1/orders/${orderId1}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const accruedFirst = (
      await request(server)
        .get('/api/v1/billing/balances/me')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200)
    ).body.commissionAccrued;
    expect(accruedFirst).toBeGreaterThan(0);

    const ceiling = accruedFirst;
    await request(server)
      .put(`/api/v1/companies/${companyId}/commission-ceiling`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ commissionCeiling: ceiling })
      .expect(200);

    // AT the ceiling: warned (>= 90%) but NOT exceeded, because the rule is a
    // strict `accrued > ceiling`. Landing exactly on it is the one case where
    // those two answers differ, which is why it is asserted rather than
    // approximated.
    const atCeiling = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(atCeiling.body.commissionAccrued).toBeCloseTo(ceiling, 2);
    expect(atCeiling.body.commissionCeiling).toBeCloseTo(ceiling, 2);
    expect(atCeiling.body.ceilingWarning).toBe(true);
    expect(atCeiling.body.ceilingExceeded).toBe(false);

    // A further approval is still PERMITTED here, even though it will push the
    // balance past the ceiling: the gate checks the balance ENTERING the
    // attempt, not what the attempt would produce (T147).
    const orderId2 = await createAndApproveCreditOrder(fixtures.companyA, 4);
    await request(server)
      .patch(`/api/v1/orders/${orderId2}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    // That permitted approval is what carries the balance past the ceiling.
    // The old sequence needed an extra order here because it landed exactly ON
    // the ceiling and `>` is strict; landing on it is now the previous step's
    // own assertion, so one order does what two used to.
    const overCeiling = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(overCeiling.body.commissionAccrued).toBeGreaterThan(ceiling);
    expect(overCeiling.body.ceilingExceeded).toBe(true);

    const orderId4 = await createAndApproveCreditOrder(fixtures.companyA, 10);
    const refused = await request(server)
      .patch(`/api/v1/orders/${orderId4}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(409);
    expect(refused.body.error).toBe('COMMISSION_CEILING_EXCEEDED');
    // The refusal names the ceiling it is enforcing (FR-062b), whatever that
    // ceiling happens to be — formatted the way the message formats it.
    expect(refused.body.message).toContain(ceiling.toFixed(2));

    // The refused order is not left half-committed. The ceiling is checked in
    // invoice issuance, which now happens at ROUTING — so the refusal undoes
    // the routing it was part of and the order rests at APPROVED: un-routed,
    // uninvoiced, no transporter told about it, and routable again through
    // `PATCH :id/route` once a payment brings the balance back under the
    // ceiling. What must never happen — a transporter committed to an order
    // the platform has refused to bill — does not.
    const orderAfterRefusal = await request(server)
      .get(`/api/v1/orders/${orderId4}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(orderAfterRefusal.body.status).toBe('APPROVED');
    expect(orderAfterRefusal.body.transportCompanyId).toBeFalsy();
    expect(orderAfterRefusal.body.invoiceId).toBeFalsy();

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
