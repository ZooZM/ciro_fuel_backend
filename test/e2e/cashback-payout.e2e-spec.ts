import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Connection, Types } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { AccountMovementKind } from '../../src/common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../src/common/enums/account-movement-state.enum';
import { AccountMovementDirection } from '../../src/common/enums/account-movement-direction.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) US8 / FR-064–FR-073 / SC-011.
 *
 * The whole story rests on one figure actually falling. `getConfirmedBalance`
 * is PER-KIND, so an implementation that reused it for the owed balance would
 * pass every over-balance, duplicate-reference, authorization and ledger test
 * below while the owed figure never moved (research R11, trap 1). The guard is
 * the first test here, deliberately.
 */
describe('Settling a cashback owed to a fuel company (US8)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;

  const CURRENCY = 'SAR';
  let reference = 0;
  const nextReference = () => `PAYOUT-REF-${(reference += 1)}`;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  /**
   * Accrues a confirmed cashback credit directly. The accrual path itself is
   * exercised by `cashback-programme.e2e-spec.ts`; what this suite needs is a
   * known starting balance.
   */
  async function accrueCashback(companyId: string, amount: number) {
    await connection.collection('accountmovements').insertOne({
      companyId: new Types.ObjectId(companyId),
      kind: AccountMovementKind.CASHBACK_CREDITED,
      amount,
      currency: CURRENCY,
      state: AccountMovementState.CONFIRMED,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const owed = (companyId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/platform-account/cashback/${companyId}/owed`)
      .set('Authorization', `Bearer ${token}`);

  const payout = (
    companyId: string,
    token: string,
    body: { amount: number; method?: string; reference?: string },
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/platform-account/cashback/${companyId}/payouts`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        method: 'BANK_TRANSFER',
        reference: nextReference(),
        ...body,
      });

  const movementCount = (companyId: string) =>
    connection.collection('accountmovements').countDocuments({
      companyId: new Types.ObjectId(companyId),
    });

  /**
   * T130 — **guard test (trap 1).** After a payout, the owed balance must
   * actually FALL.
   */
  describe('GUARD: recording a payout reduces what the platform owes (research R11)', () => {
    it('the owed balance falls by exactly the amount paid', async () => {
      const companyId = fixtures.companyA.companyId;
      await accrueCashback(companyId, 1000);

      const before = await owed(companyId, fixtures.superAdmin.token).expect(200);
      await payout(companyId, fixtures.superAdmin.token, { amount: 400 }).expect(201);
      const after = await owed(companyId, fixtures.superAdmin.token).expect(200);

      // The assertion the per-kind implementation fails: it would report the
      // same `owed` before and after, with no error anywhere.
      expect(after.body.owed).toBeCloseTo(before.body.owed - 400, 2);
      expect(after.body.owed).not.toBeCloseTo(before.body.owed, 2);
    });
  });

  describe('partial and full settlement (FR-067, SC-011, scenarios 2/3)', () => {
    it('a partial payout leaves the remainder still owed, and a payout for it reaches zero', async () => {
      const companyId = fixtures.companyB.companyId;
      await accrueCashback(companyId, 500);

      const start = await owed(companyId, fixtures.superAdmin.token).expect(200);
      expect(start.body.owed).toBeCloseTo(500, 2);

      await payout(companyId, fixtures.superAdmin.token, { amount: 200 }).expect(201);
      const mid = await owed(companyId, fixtures.superAdmin.token).expect(200);
      expect(mid.body.owed).toBeCloseTo(300, 2);

      await payout(companyId, fixtures.superAdmin.token, { amount: 300 }).expect(201);
      const end = await owed(companyId, fixtures.superAdmin.token).expect(200);
      expect(end.body.owed).toBeCloseTo(0, 2);
    });

    it('the payout is created already CONFIRMED — there is no second party to confirm it', async () => {
      const companyId = fixtures.companyA.companyId;
      await accrueCashback(companyId, 100);
      const res = await payout(companyId, fixtures.superAdmin.token, { amount: 100 }).expect(201);

      expect(res.body.state).toBe(AccountMovementState.CONFIRMED);
      expect(res.body.kind).toBe(AccountMovementKind.CASHBACK_PAID_OUT);
      expect(res.body.confirmedAt).toBeTruthy();
      // Left RECORDED it would not reduce the balance, and a second payout for
      // the same amount would be permitted immediately.
      // INBOUND: `direction` is stated from the COMPANY's point of view, and
      // this is money arriving at the company (SC-011).
      expect(res.body.direction).toBe(AccountMovementDirection.INBOUND);
    });
  });

  describe('a payout larger than the balance is refused and records nothing (FR-068, scenario 4)', () => {
    it('returns 409 with the movement count unchanged', async () => {
      const companyId = fixtures.companyB.companyId;
      await accrueCashback(companyId, 50);

      const before = await movementCount(companyId);
      const res = await payout(companyId, fixtures.superAdmin.token, { amount: 5000 }).expect(409);
      expect(res.body.error ?? res.body.message?.error).toBe(
        ErrorCode.CASHBACK_PAYOUT_EXCEEDS_BALANCE,
      );
      // Nothing committed — an early `return` inside the transaction rather
      // than a throw would have committed the movement here.
      expect(await movementCount(companyId)).toBe(before);
    });

    it('a payout for exactly the balance is permitted', async () => {
      const companyId = fixtures.companyB.companyId;
      const current = await owed(companyId, fixtures.superAdmin.token).expect(200);
      await payout(companyId, fixtures.superAdmin.token, {
        amount: current.body.owed,
      }).expect(201);
      const after = await owed(companyId, fixtures.superAdmin.token).expect(200);
      expect(after.body.owed).toBeCloseTo(0, 2);
    });
  });

  describe('a duplicate reference is refused, never applied twice (FR-070, edge case)', () => {
    it('returns 409 and records only the first', async () => {
      const companyId = fixtures.companyA.companyId;
      await accrueCashback(companyId, 1000);
      const ref = nextReference();

      await payout(companyId, fixtures.superAdmin.token, { amount: 100, reference: ref }).expect(
        201,
      );
      const before = await movementCount(companyId);

      const res = await payout(companyId, fixtures.superAdmin.token, {
        amount: 100,
        reference: ref,
      }).expect(409);
      expect(res.body.error ?? res.body.message?.error).toBe(
        ErrorCode.CASHBACK_PAYOUT_DUPLICATE_REFERENCE,
      );
      expect(await movementCount(companyId)).toBe(before);
    });

    it('the same reference is free for a DIFFERENT company — the index is per company', async () => {
      const ref = nextReference();
      await accrueCashback(fixtures.companyA.companyId, 100);
      await accrueCashback(fixtures.companyB.companyId, 100);
      await payout(fixtures.companyA.companyId, fixtures.superAdmin.token, {
        amount: 50,
        reference: ref,
      }).expect(201);
      await payout(fixtures.companyB.companyId, fixtures.superAdmin.token, {
        amount: 50,
        reference: ref,
      }).expect(201);
    });

    it('leaves PAYMENT_RECORDED references unconstrained (the index`s kind clause)', async () => {
      // Without the `kind` clause the partial index would start refusing a
      // company's second payment under one bank reference — a rule never
      // stated for that kind, broken silently by an unrelated feature.
      const sharedRef = 'SHARED-BANK-REF';
      for (let i = 0; i < 2; i += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/platform-account/payments')
          .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
          .send({ amount: 10, method: 'BANK_TRANSFER', reference: sharedRef })
          .expect(201);
      }
    });
  });

  /**
   * T134 — FR-069. The balance is evaluated at the moment the payout is
   * RECORDED, not at the moment the operator's screen rendered.
   */
  describe('the balance is re-read inside the transaction (FR-069)', () => {
    it('a payout is judged against the balance at submission, not the one displayed', async () => {
      const companyId = fixtures.companyB.companyId;
      const ACCRUAL = 1000;
      await accrueCashback(companyId, ACCRUAL);

      // Whatever the operator's screen reads — asserted relatively, since
      // earlier cases in this suite legitimately leave a residual balance.
      const displayed = await owed(companyId, fixtures.superAdmin.token).expect(200);

      // The accrual is reversed before they submit. A real possibility in the
      // seconds between a screen rendering and a form being sent.
      await connection.collection('accountmovements').deleteOne({
        companyId: new Types.ObjectId(companyId),
        kind: AccountMovementKind.CASHBACK_CREDITED,
        amount: ACCRUAL,
      });
      const actual = await owed(companyId, fixtures.superAdmin.token).expect(200);
      expect(actual.body.owed).toBeCloseTo(displayed.body.owed - ACCRUAL, 2);

      // Submitting the figure the SCREEN showed is now refused — the
      // comparison happens against the balance re-read inside the session.
      const res = await payout(companyId, fixtures.superAdmin.token, {
        amount: displayed.body.owed,
      }).expect(409);
      expect(res.body.error ?? res.body.message?.error).toBe(
        ErrorCode.CASHBACK_PAYOUT_EXCEEDS_BALANCE,
      );
    });
  });

  /** T135 — FR-071, scenario 5. */
  describe('the fuel company sees the payout in its own ledger (FR-071, scenario 5)', () => {
    it('appears identified as money received FROM the platform', async () => {
      const companyId = fixtures.companyA.companyId;
      await accrueCashback(companyId, 777);
      const created = await payout(companyId, fixtures.superAdmin.token, {
        amount: 777,
      }).expect(201);

      const ledger = await request(app.getHttpServer())
        .get('/api/v1/platform-account/movements')
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);

      const row = ledger.body.items.find(
        (m: { _id: string }) => String(m._id) === String(created.body._id),
      );
      expect(row).toBeDefined();
      // FR-064: without `direction`, this row and a payment the company MADE
      // are two positive amounts with no visible difference between them.
      // SC-011: read from the RECEIVING company's own ledger, a payout the
      // platform made to it is money coming IN. A commission charged to that
      // same company is OUTBOUND, which is the distinction FR-064 is for.
      expect(row.direction).toBe(AccountMovementDirection.INBOUND);
      expect(row.kind).toBe(AccountMovementKind.CASHBACK_PAID_OUT);
    });

    it('adds `direction` to every movement without reshaping any existing field (FR-064)', async () => {
      const ledger = await request(app.getHttpServer())
        .get('/api/v1/platform-account/movements')
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);

      expect(ledger.body.items.length).toBeGreaterThan(0);
      for (const row of ledger.body.items) {
        expect(row.direction).toBeDefined();
        // Feature 013's dashboard reads these unchanged.
        expect(row).toHaveProperty('_id');
        expect(row).toHaveProperty('kind');
        expect(row).toHaveProperty('amount');
        expect(row).toHaveProperty('state');
        expect(row).toHaveProperty('currency');
      }
    });
  });

  describe('a company can never record money as having been paid TO it (FR-072, SC-012)', () => {
    it('refuses a FUEL_COMPANY_ADMIN', async () => {
      await payout(fixtures.companyA.companyId, fixtures.companyA.admin.token, {
        amount: 1,
      }).expect(403);
    });

    it('refuses a TRANSPORT_COMPANY_ADMIN, a CLIENT and a DRIVER', async () => {
      for (const token of [
        fixtures.companyA.transportAdmin.token,
        fixtures.companyA.client.token,
        fixtures.companyA.driver.token,
      ]) {
        await payout(fixtures.companyA.companyId, token, { amount: 1 }).expect(403);
      }
    });

    it('refuses every non-operator role on the owed figure too', async () => {
      for (const token of [
        fixtures.companyA.admin.token,
        fixtures.companyA.transportAdmin.token,
        fixtures.companyA.client.token,
        fixtures.companyA.driver.token,
      ]) {
        await owed(fixtures.companyA.companyId, token).expect(403);
      }
    });
  });

  describe('the DTO refuses what FR-070 depends on', () => {
    it('requires a reference', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/platform-account/cashback/${fixtures.companyA.companyId}/payouts`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ amount: 10, method: 'BANK_TRANSFER' })
        .expect(400);
    });

    it('refuses a zero or negative amount', async () => {
      for (const amount of [0, -5]) {
        await payout(fixtures.companyA.companyId, fixtures.superAdmin.token, { amount }).expect(
          400,
        );
      }
    });
  });
});
