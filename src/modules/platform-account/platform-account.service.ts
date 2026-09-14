import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AccountMovement, AccountMovementDocument } from './schemas/account-movement.schema';
import { AccountMovementKind } from '../../common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../common/enums/account-movement-state.enum';
import { CommissionBasis } from '../../common/enums/commission-basis.enum';
import { SettlementMethod } from '../../common/enums/settlement-method.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { CursorSortField } from '../../common/pagination/cursor.util';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { isDuplicateKeyError } from '../../common/utils/mongo-error.util';
import { AccountMovementDirection, directionForKind } from '../../common/enums/account-movement-direction.enum';

// data-model.md's `(companyId, createdAt, _id)` index — `companyId` itself is applied by
// the tenant-scope plugin's ambient filter, never listed here (same convention as
// `INVOICE_SORT_KEYS` in invoices.service.ts).
const MOVEMENT_SORT_KEYS: CursorSortField[] = [
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

export interface CreateMovementInput {
  companyId: string | Types.ObjectId;
  kind: AccountMovementKind;
  amount: number;
  currency: string;
  state: AccountMovementState;
  sourceInvoiceId?: string | Types.ObjectId;
  appliedRate?: number;
  appliedBasis?: CommissionBasis;
  method?: SettlementMethod;
  reference?: string;
  documentFileId?: string | Types.ObjectId;
  reversalOfId?: string | Types.ObjectId;
  confirmedBy?: string | Types.ObjectId;
  confirmedAt?: Date;
}

@Injectable()
export class PlatformAccountService {
  constructor(
    @InjectModel(AccountMovement.name)
    private readonly accountMovementModel: Model<AccountMovementDocument>,
  ) {}

  /**
   * spec 013 T141 — the tenant-scope plugin's `pre('save')` hook unconditionally forces
   * `companyId` to the ACTING user's own tenant on any new document (same mechanism
   * `companies.controller.ts:createTransporter` already works around). That is correct
   * for commission accrual (always triggered by the beneficiary company's own admin
   * approving their own order) but WRONG for cashback on a DEFERRED invoice, where the
   * actor settling it (the paying TRANSPORT company) is not the beneficiary (the
   * FUEL company that issued the invoice). The correcting update below is a no-op when
   * they already match and load-bearing when they don't — always run, never conditional,
   * so this method is safe regardless of which caller's context is active.
   */
  async createMovement(
    input: CreateMovementInput,
    session?: ClientSession,
  ): Promise<AccountMovementDocument> {
    const companyId = new Types.ObjectId(input.companyId);
    const [movement] = await this.accountMovementModel.create(
      [
        {
          companyId,
          kind: input.kind,
          amount: input.amount,
          currency: input.currency,
          state: input.state,
          sourceInvoiceId: input.sourceInvoiceId ? new Types.ObjectId(input.sourceInvoiceId) : undefined,
          appliedRate: input.appliedRate,
          appliedBasis: input.appliedBasis,
          method: input.method,
          reference: input.reference,
          documentFileId: input.documentFileId ? new Types.ObjectId(input.documentFileId) : undefined,
          reversalOfId: input.reversalOfId ? new Types.ObjectId(input.reversalOfId) : undefined,
          confirmedBy: input.confirmedBy ? new Types.ObjectId(input.confirmedBy) : undefined,
          confirmedAt: input.confirmedAt,
        },
      ],
      { session },
    );

    await this.accountMovementModel
      .updateOne({ _id: movement._id }, { $set: { companyId } }, { session })
      .exec();

    return movement;
  }

  /**
   * T161/T162/FR-065/FR-067/FR-072 — the acting FCA user IS the beneficiary company here
   * (they can only ever record a payment for their own tenant), so `createMovement`'s
   * companyId correction is a guaranteed no-op for this call — run anyway, for the same
   * reason it's unconditional everywhere else: this method must stay correct regardless of
   * which caller's context is active. Created `RECORDED`, never `CONFIRMED` (FR-068, FR-067a)
   * — no session, since nothing else needs to commit atomically with it (T164).
   */
  async recordPayment(
    companyId: string | Types.ObjectId,
    input: { amount: number; method: SettlementMethod; reference?: string; documentFileId?: string },
    currency: string,
  ): Promise<AccountMovementDocument> {
    if (!input.reference && !input.documentFileId) {
      throw new BadRequestException({
        error: ErrorCode.PAYMENT_EVIDENCE_REQUIRED,
        message: 'A payment must carry a reference or a supporting document',
      });
    }
    return this.createMovement({
      companyId,
      kind: AccountMovementKind.PAYMENT_RECORDED,
      amount: input.amount,
      currency,
      state: AccountMovementState.RECORDED,
      method: input.method,
      reference: input.reference,
      documentFileId: input.documentFileId,
    });
  }

  /**
   * spec 017 (operator dashboard) T139/FR-065/FR-067 — what the platform
   * currently owes this fuel company in cashback.
   *
   * **A new TWO-KIND derivation, beside `getConfirmedBalance` rather than
   * instead of it.** This is research R11's trap, and it is worth stating
   * plainly: `getConfirmedBalance` is per-kind. A payout recorded under
   * `CASHBACK_PAID_OUT` leaves `getConfirmedBalance(CASHBACK_CREDITED)`
   * completely unchanged — and still returns a correct-looking number, because
   * it is a correct answer to a different question. An implementation that
   * reused it would satisfy every over-balance, duplicate-reference and
   * authorization test in this feature while the owed balance simply never
   * fell (FR-067 violated, silently). T130 is the guard that catches it.
   *
   * `getConfirmedBalance` is deliberately left untouched: it is load-bearing
   * for the commission and payment balances, where per-kind is the right shape.
   */
  async getCashbackOwed(
    companyId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<number> {
    const [credited, paidOut] = await Promise.all([
      this.getConfirmedBalance(companyId, AccountMovementKind.CASHBACK_CREDITED, session),
      this.getConfirmedBalance(companyId, AccountMovementKind.CASHBACK_PAID_OUT, session),
    ]);
    return credited - paidOut;
  }

  /**
   * spec 017 T140/T141/FR-066–FR-070 — the operator records that the platform
   * paid a fuel company its accrued cashback.
   *
   * **One transaction that re-reads the owed balance INSIDE the session**
   * (FR-069, Constitution V). The figure the operator's screen was showing has
   * no authority: an accrual can land between the screen rendering and the form
   * submitting, and comparing against the stale number would let through a
   * payout the balance no longer covers.
   *
   * Created already **`CONFIRMED`**, unlike `recordPayment` above, and the
   * asymmetry is deliberate. A company's payment is `RECORDED` until the
   * operator confirms it, because the operator is a genuine second party
   * verifying the company's claim. Here the operator IS the party asserting the
   * money moved — there is nobody left to confirm it, and leaving it `RECORDED`
   * would mean the payout did not reduce the balance, so a second payout for
   * the same amount would be permitted immediately (FR-067 violated).
   *
   * FR-070's duplicate-reference refusal is carried by the partial unique index
   * on `(companyId, kind, reference)`, caught below — never by a prior read,
   * which two concurrent submissions can both pass.
   */
  async recordCashbackPayout(
    companyId: string | Types.ObjectId,
    input: {
      amount: number;
      method: SettlementMethod;
      reference: string;
      documentFileId?: string;
    },
    currency: string,
    confirmedBy: string,
  ): Promise<AccountMovementDocument> {
    const session = await this.accountMovementModel.db.startSession();
    let movement!: AccountMovementDocument;
    try {
      await session.withTransaction(async () => {
        // Re-read INSIDE the session — the whole point of FR-069.
        const owed = await this.getCashbackOwed(companyId, session);
        if (input.amount > owed) {
          // THROWN, never returned. An early `return` inside
          // `session.withTransaction` COMMITS rather than aborts — the exact
          // defect spec 008's assignment booking shipped and had to fix.
          throw new ConflictException({
            error: ErrorCode.CASHBACK_PAYOUT_EXCEEDS_BALANCE,
            message: `Payout of ${input.amount} exceeds the ${owed} currently owed`,
          });
        }
        movement = await this.createMovement(
          {
            companyId,
            kind: AccountMovementKind.CASHBACK_PAID_OUT,
            amount: input.amount,
            currency,
            state: AccountMovementState.CONFIRMED,
            method: input.method,
            reference: input.reference,
            documentFileId: input.documentFileId,
            confirmedBy,
            confirmedAt: new Date(),
          },
          session,
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException({
          error: ErrorCode.CASHBACK_PAYOUT_DUPLICATE_REFERENCE,
          message: 'A payout with this reference is already recorded for this company',
        });
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return movement;
  }

  /**
   * T163/T164/FR-069/FR-067a — conditional update filtered on `state: RECORDED`, same
   * idiom as `CreditLimitRequestsService.resolve`: `modifiedCount` (via `findOneAndUpdate`'s
   * null return), never a prior read, decides which of two concurrent confirmations wins.
   * No payment is ever confirmed automatically anywhere else in this codebase — this is the
   * only path that can move a `PAYMENT_RECORDED` movement into the balance.
   */
  async confirmPayment(id: string, confirmedBy: string): Promise<AccountMovementDocument> {
    const result = await this.accountMovementModel
      .findOneAndUpdate(
        { _id: id, kind: AccountMovementKind.PAYMENT_RECORDED, state: AccountMovementState.RECORDED },
        { $set: { state: AccountMovementState.CONFIRMED, confirmedBy: new Types.ObjectId(confirmedBy), confirmedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!result) {
      throw new ConflictException({
        error: ErrorCode.PAYMENT_ALREADY_CONFIRMED,
        message: 'This payment has already been confirmed',
      });
    }
    return result;
  }

  /** T160/FR-071 — tenant plugin scopes an FCA caller to their own ledger automatically;
   * `SUPER_ADMIN` bypasses it and sees every company's movements, matching the bypass
   * precedent on every other tenant-scoped collection (invoices, orders). */
  // spec 013 T238 (US13): `companyId` is safe to accept unconditionally — the
  // tenant-scope plugin's own `.where({companyId})` overwrites this key for a
  // FUEL_COMPANY_ADMIN caller regardless of what is passed, so it is only ever
  // load-bearing for SUPER_ADMIN, who bypasses the plugin and otherwise sees every
  // company's movements mixed together with no way to narrow to one.
  async listMovements(
    filter: { kind?: AccountMovementKind; state?: AccountMovementState; cursor?: string; companyId?: string } = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const query: Record<string, unknown> = {};
    if (filter.kind !== undefined) query.kind = filter.kind;
    if (filter.state !== undefined) query.state = filter.state;
    if (filter.companyId !== undefined) query.companyId = filter.companyId;
    const page = await paginate(
      this.accountMovementModel,
      query,
      MOVEMENT_SORT_KEYS,
      filter.cursor,
    );
    // spec 017 T144/FR-064 — `direction` is ADDED, nothing is reshaped. Every
    // field feature 013's dashboard already reads is present and unchanged, so
    // its ledger keeps working untouched; this is the field that stops a
    // cashback the platform paid OUT from being indistinguishable from a
    // payment the company paid IN (FR-071).
    return { items: page.items.map((m) => this.toMovementView(m)), nextCursor: page.nextCursor };
  }

  /**
   * spec 017 T144/FR-064 — one movement with its `direction` derived from its
   * `kind` at serialisation.
   *
   * **Derived, never stored** (research R11). Adding the field to the schema
   * would duplicate a fact the `kind` already determines, could disagree with it
   * after a bad write, and would need every existing row migrated to introduce
   * — and this feature adds no migration because it rewrites nothing.
   */
  toMovementView(movement: AccountMovementDocument): Record<string, unknown> {
    return {
      ...movement.toObject(),
      direction: directionForKind(movement.kind),
    };
  }

  /**
   * FR-068/SC-012: the balance is always computed live from confirmed movements, never a
   * stored running total. A reversal (`reversalOfId` set) nets OUT of the sum it points
   * at rather than being modeled as a negative `amount` (the schema keeps `amount`
   * non-negative throughout, matching every other money field on this platform).
   */
  async getConfirmedBalance(
    companyId: string | Types.ObjectId,
    kind: AccountMovementKind,
    session?: ClientSession,
  ): Promise<number> {
    const query = this.accountMovementModel
      .find({ companyId: new Types.ObjectId(companyId), kind, state: AccountMovementState.CONFIRMED })
      .select('amount reversalOfId');
    if (session) query.session(session);
    const movements = await query.exec();
    return movements.reduce((sum, m) => sum + (m.reversalOfId ? -m.amount : m.amount), 0);
  }

  /** FR-063 — every CONFIRMED, not-already-reversed movement sourced from this invoice
   * gets a compensating entry. Never a delete, never a mutation of the original. */
  async reverseMovementsForInvoice(
    invoiceId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const sourceInvoiceId = new Types.ObjectId(invoiceId);
    const originals = await this.accountMovementModel
      .find({ sourceInvoiceId, state: AccountMovementState.CONFIRMED, reversalOfId: { $exists: false } })
      .session(session)
      .exec();

    const alreadyReversed = await this.accountMovementModel
      .find({ reversalOfId: { $in: originals.map((m) => m._id) } })
      .session(session)
      .exec();
    const reversedIds = new Set(alreadyReversed.map((m) => String(m.reversalOfId)));

    for (const original of originals) {
      if (reversedIds.has(String(original._id))) continue;
      await this.createMovement(
        {
          companyId: original.companyId,
          kind: original.kind,
          amount: original.amount,
          currency: original.currency,
          state: AccountMovementState.CONFIRMED,
          sourceInvoiceId: original.sourceInvoiceId,
          appliedRate: original.appliedRate,
          appliedBasis: original.appliedBasis,
          reversalOfId: original._id as Types.ObjectId,
        },
        session,
      );
    }
  }
}
