import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { AccountMovementKind } from '../../../common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../../common/enums/account-movement-state.enum';
import { CommissionBasis } from '../../../common/enums/commission-basis.enum';
import { SettlementMethod } from '../../../common/enums/settlement-method.enum';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type AccountMovementDocument = AccountMovement & Document;

/**
 * spec 013 T141/FR-064, data-model.md — one entry in a company's ledger with the
 * platform. `markTenantScoped` on `companyId` (R6): one company's own ledger; the
 * operator reads across all of them via the `SUPER_ADMIN` bypass, same as every other
 * tenant-scoped collection.
 *
 * Balance is ALWAYS `sum(amount) where state = CONFIRMED` — computed live, never a stored
 * running total a write could let drift from its own ledger (FR-068, SC-012). A
 * `COMMISSION_CHARGED`/`CASHBACK_CREDITED` movement is created already CONFIRMED (system-
 * computed at accrual, nothing to confirm by hand); only `PAYMENT_RECORDED` starts
 * RECORDED and needs the operator's explicit confirm (FR-067a, Phase 13).
 */
@Schema({ timestamps: true })
export class AccountMovement {
  // Deliberately NOT `immutable: true` (unlike every other field here, and unlike this
  // same field on most other tenant-scoped schemas): `PlatformAccountService.createMovement`
  // must correct it once, right after creation, for a movement whose beneficiary company
  // differs from the acting request's own tenant (cashback on a DEFERRED invoice, settled
  // by the paying TRANSPORT company — see that method's own comment). Mongoose silently
  // strips an `immutable` field from a query-level `$set` update, which would make that
  // correction a no-op that still reports `modifiedCount: 1` (only `updatedAt` actually
  // changes) — found by a real accrual query returning zero results despite the
  // "successful" correction.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: AccountMovementKind, immutable: true })
  kind!: AccountMovementKind;

  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({ required: true })
  currency!: string;

  // Present for COMMISSION_CHARGED/CASHBACK_CREDITED; absent for PAYMENT_RECORDED.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Invoice' })
  sourceInvoiceId?: Types.ObjectId;

  // Stamped at accrual (T143/R10) — never re-derived from the term in force today.
  @Prop({ min: 0 })
  appliedRate?: number;

  @Prop({ type: String, enum: CommissionBasis })
  appliedBasis?: CommissionBasis;

  // Payments only (FR-066).
  @Prop({ type: String, enum: SettlementMethod })
  method?: SettlementMethod;

  @Prop({ trim: true })
  reference?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'File' })
  documentFileId?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: AccountMovementState })
  state!: AccountMovementState;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  confirmedBy?: Types.ObjectId;

  @Prop()
  confirmedAt?: Date;

  // FR-063: a reversal is a compensating movement, never a delete.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountMovement' })
  reversalOfId?: Types.ObjectId;
}

export const AccountMovementSchema = SchemaFactory.createForClass(AccountMovement);
markTenantScoped(AccountMovementSchema);

AccountMovementSchema.index({ companyId: 1, createdAt: -1, _id: -1 });
AccountMovementSchema.index({ companyId: 1, state: 1 });

/**
 * spec 017 (operator dashboard) T138/FR-070 — a cashback payout reference is
 * unique per company.
 *
 * **This index, not an application pre-read, IS the guarantee.** A
 * read-then-write duplicate check is a race: two submissions of the same
 * reference can both find nothing and both write. The refusal the operator sees
 * is translated from this index's violation
 * (`CASHBACK_PAYOUT_DUPLICATE_REFERENCE`), the same idiom `ratings.service.ts`
 * and `dispatch.service.ts` already use.
 *
 * Partial on **BOTH** `kind` and `reference` existing, and both clauses matter:
 *
 *  - without the `kind` clause it would constrain existing `PAYMENT_RECORDED`
 *    rows, which have never been unique on reference and for which no such rule
 *    was ever stated — a company recording two payments under one bank
 *    reference would start being refused, silently, by an index added for an
 *    unrelated feature;
 *  - without the `reference` clause every row lacking one would collide on
 *    `null`.
 */
AccountMovementSchema.index(
  { companyId: 1, kind: 1, reference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      kind: AccountMovementKind.CASHBACK_PAID_OUT,
      reference: { $exists: true },
    },
  },
);
