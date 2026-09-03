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
  listMovements(
    filter: { kind?: AccountMovementKind; state?: AccountMovementState; cursor?: string; companyId?: string } = {},
  ): Promise<PaginatedResponse<AccountMovementDocument>> {
    const query: Record<string, unknown> = {};
    if (filter.kind !== undefined) query.kind = filter.kind;
    if (filter.state !== undefined) query.state = filter.state;
    if (filter.companyId !== undefined) query.companyId = filter.companyId;
    return paginate(this.accountMovementModel, query, MOVEMENT_SORT_KEYS, filter.cursor);
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
