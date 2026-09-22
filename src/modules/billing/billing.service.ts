import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { ClientSession, Model, Types } from 'mongoose';
import { CommissionTerm, CommissionTermDocument } from './schemas/commission-term.schema';
import { CashbackProgramme, CashbackProgrammeDocument } from './schemas/cashback-programme.schema';
import { Company, CompanyDocument } from '../companies/schemas/company.schema';
import { InvoiceDocument } from '../invoices/schemas/invoice.schema';
import { OrderDocument } from '../orders/schemas/order.schema';
import { PlatformAccountService } from '../platform-account/platform-account.service';
import { CommissionBasis } from '../../common/enums/commission-basis.enum';
import { AccountMovementKind } from '../../common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../common/enums/account-movement-state.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { DEFAULT_CURRENCY, roundCurrency } from '../../common/constants/money.constants';

export interface BillingBalances {
  commissionAccrued: number;
  cashbackAccrued: number;
  commissionCeiling: number;
  ceilingWarning: boolean;
  ceilingExceeded: boolean;
  currency: string;
}

// FR-062c — the warning threshold, stated as a fraction so the 90% figure appears
// exactly once rather than as a magic number wherever it's used (Principle I).
const CEILING_WARNING_THRESHOLD = 0.9;

@Injectable()
export class BillingService {
  constructor(
    @InjectModel(CommissionTerm.name)
    private readonly commissionTermModel: Model<CommissionTermDocument>,
    @InjectModel(CashbackProgramme.name)
    private readonly cashbackProgrammeModel: Model<CashbackProgrammeDocument>,
    @InjectModel(Company.name) private readonly companyModel: Model<CompanyDocument>,
    private readonly platformAccountService: PlatformAccountService,
    private readonly config: ConfigService,
  ) {}

  // T137 — "the term in force at instant T" is this one query, used by every accrual and
  // never re-derived from history. `null` means the operator has not configured a
  // commission rate yet — accrual then charges nothing (T142), rather than a fabricated
  // default rate. Sorted `effectiveFrom desc, _id desc`: `effectiveFrom` alone ties
  // whenever two records are written within the same millisecond (`Date.now()`'s
  // resolution, easily hit by two administrative writes moments apart, e.g. a test or a
  // fast double-click) — `_id` breaks the tie correctly since ObjectIds are monotonically
  // increasing within one process even inside a single millisecond, so "most recently
  // written" is unambiguous either way.
  getCurrentCommissionTerm(session?: ClientSession): Promise<CommissionTermDocument | null> {
    const query = this.commissionTermModel.findOne().sort({ effectiveFrom: -1, _id: -1 });
    if (session) query.session(session);
    return query.exec();
  }

  getCurrentCashbackProgramme(session?: ClientSession): Promise<CashbackProgrammeDocument | null> {
    const query = this.cashbackProgrammeModel.findOne().sort({ effectiveFrom: -1, _id: -1 });
    if (session) query.session(session);
    return query.exec();
  }

  // T132/FR-058 — no update path: every call inserts a new, distinct record.
  setCommissionTerm(
    basis: CommissionBasis,
    rate: number,
    setById: string,
  ): Promise<CommissionTermDocument> {
    return this.commissionTermModel.create({ basis, rate, setBy: new Types.ObjectId(setById) });
  }

  setCashbackProgramme(
    input: {
      basis: CommissionBasis;
      rate: number;
      isActive: boolean;
      targetsAllCompanies: boolean;
      targetCompanyIds: string[];
    },
    setById: string,
  ): Promise<CashbackProgrammeDocument> {
    return this.cashbackProgrammeModel.create({
      basis: input.basis,
      rate: input.rate,
      isActive: input.isActive,
      targetsAllCompanies: input.targetsAllCompanies,
      targetCompanyIds: input.targetsAllCompanies
        ? []
        : input.targetCompanyIds.map((id) => new Types.ObjectId(id)),
      setBy: new Types.ObjectId(setById),
    });
  }

  private computeAmount(basis: CommissionBasis, rate: number, invoiceAmount: number): number {
    return roundCurrency(
      basis === CommissionBasis.PERCENTAGE ? (invoiceAmount * rate) / 100 : invoiceAmount * rate,
    );
  }

  // T135/FR-062b — a company's own ceiling if the operator set one, otherwise the
  // platform-wide config default (never absent: Joi fails at boot without it, T009).
  async resolveCeiling(
    companyId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<number> {
    const query = this.companyModel.findById(companyId).select('commissionCeiling');
    if (session) query.session(session);
    const company = await query.exec();
    return (
      company?.commissionCeiling ?? this.config.get<number>('billing.defaultCommissionCeiling')!
    );
  }

  /**
   * T148/FR-062d/FR-072 — "accrued commission" for ceiling purposes is NET of confirmed
   * payments: `COMMISSION_CHARGED − PAYMENT_RECORDED` (both CONFIRMED only, per
   * `getConfirmedBalance`). This is what makes dealing resume automatically once a
   * confirmed payment lands (T148) — the check always reads the current balance fresh,
   * never a stored "barred" flag, so there is nothing to un-set. `PAYMENT_RECORDED`
   * movements themselves are Phase 13's own concern (the ledger/payment screen); this
   * balance formula is written to be correct once they exist, not revisited later.
   * Cashback is deliberately NOT netted in — FR-061 tracks it as its own, separate
   * balance, never automatically offsetting commission owed.
   */
  private async getNetCommissionOwed(
    companyId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<number> {
    const [charged, paid] = await Promise.all([
      this.platformAccountService.getConfirmedBalance(
        companyId,
        AccountMovementKind.COMMISSION_CHARGED,
        session,
      ),
      this.platformAccountService.getConfirmedBalance(
        companyId,
        AccountMovementKind.PAYMENT_RECORDED,
        session,
      ),
    ]);
    return charged - paid;
  }

  /**
   * T147/FR-062d — the ceiling gate for DEFERRED/CREDIT order approval. Reads the
   * balance BEFORE this invoice's own commission (T142 accrues separately, right after
   * this check passes) — a company already over its ceiling is refused outright; a
   * company that would only CROSS the ceiling from this one invoice is NOT refused (the
   * requirement is "once accrued commission EXCEEDS the ceiling", read as the state
   * entering this attempt, not the state this attempt would produce). Called from inside
   * `InvoicesService.issueInvoice`'s transaction — refusing here means the transaction
   * never commits, so the order is never left half-approved (spec Edge Cases).
   */
  async assertUnderCeiling(
    companyId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const [balance, ceiling] = await Promise.all([
      this.getNetCommissionOwed(companyId, session),
      this.resolveCeiling(companyId, session),
    ]);
    if (balance > ceiling) {
      throw new ConflictException({
        error: ErrorCode.COMMISSION_CEILING_EXCEEDED,
        message: `Accrued commission (${balance.toFixed(2)} ${DEFAULT_CURRENCY}) exceeds the ceiling (${ceiling.toFixed(2)} ${DEFAULT_CURRENCY})`,
      });
    }
  }

  // T142/T143/FR-057 — called from `InvoicesService.issueInvoice`, inside `approve`'s
  // transaction. A missing term means the operator has not configured commission yet:
  // charges nothing, rather than inventing a rate.
  async accrueCommission(
    order: OrderDocument,
    invoice: InvoiceDocument,
    session: ClientSession,
  ): Promise<void> {
    const term = await this.getCurrentCommissionTerm(session);
    if (!term) return;
    const amount = this.computeAmount(term.basis, term.rate, invoice.amount);
    if (amount <= 0) return;
    await this.platformAccountService.createMovement(
      {
        companyId: order.fuelCompanyId,
        kind: AccountMovementKind.COMMISSION_CHARGED,
        amount,
        currency: DEFAULT_CURRENCY,
        state: AccountMovementState.CONFIRMED,
        sourceInvoiceId: invoice._id as Types.ObjectId,
        appliedRate: term.rate,
        appliedBasis: term.basis,
      },
      session,
    );
  }

  // T144/FR-060 — called from `InvoicesService`'s settlement path, once an invoice
  // actually transitions to SETTLED (never on a repeat/no-op settle call). Cashback
  // belongs to the invoice's OWN company (`invoice.fuelCompanyId`) — for a DEFERRED
  // invoice the actor confirming payment is the PAYING transporter, a different company;
  // `PlatformAccountService.createMovement` corrects the tenant-scope plugin's
  // forced-companyId write for exactly this case.
  async accrueCashback(invoice: InvoiceDocument, session: ClientSession): Promise<void> {
    const programme = await this.getCurrentCashbackProgramme(session);
    if (!programme || !programme.isActive) return;
    const targeted =
      programme.targetsAllCompanies ||
      programme.targetCompanyIds.some((id) => String(id) === String(invoice.fuelCompanyId));
    if (!targeted) return;

    const amount = this.computeAmount(programme.basis, programme.rate, invoice.amount);
    if (amount <= 0) return;
    await this.platformAccountService.createMovement(
      {
        companyId: invoice.fuelCompanyId,
        kind: AccountMovementKind.CASHBACK_CREDITED,
        amount,
        currency: DEFAULT_CURRENCY,
        state: AccountMovementState.CONFIRMED,
        sourceInvoiceId: invoice._id as Types.ObjectId,
        appliedRate: programme.rate,
        appliedBasis: programme.basis,
      },
      session,
    );
  }

  // T149/FR-063 — a thin pass-through naming this feature's own vocabulary; the actual
  // compensating-movement logic lives in `PlatformAccountService` since Phase 13's ledger
  // reversal (were one ever needed there) would use the identical mechanism.
  reverseAccrualsForInvoice(
    invoiceId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    return this.platformAccountService.reverseMovementsForInvoice(invoiceId, session);
  }

  // T145/FR-061/FR-062c — the FCA-facing read. `commissionAccrued` is the SAME net-owed
  // figure `assertUnderCeiling` gates on (charged minus confirmed payments) — a single
  // source of truth, so `ceilingWarning`/`ceilingExceeded` can never disagree with what
  // actually blocks approval. `cashbackAccrued` stays a raw total (FR-061 tracks it as
  // its own balance, never netted against commission owed).
  async getBalancesForCompany(companyId: string | Types.ObjectId): Promise<BillingBalances> {
    const [commissionAccrued, cashbackAccrued, ceiling] = await Promise.all([
      this.getNetCommissionOwed(companyId),
      this.platformAccountService.getConfirmedBalance(
        companyId,
        AccountMovementKind.CASHBACK_CREDITED,
      ),
      this.resolveCeiling(companyId),
    ]);
    return {
      commissionAccrued: roundCurrency(commissionAccrued),
      cashbackAccrued: roundCurrency(cashbackAccrued),
      commissionCeiling: ceiling,
      ceilingWarning: ceiling > 0 && commissionAccrued >= ceiling * CEILING_WARNING_THRESHOLD,
      ceilingExceeded: commissionAccrued > ceiling,
      currency: DEFAULT_CURRENCY,
    };
  }
}
