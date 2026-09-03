import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { LitreMovementKind } from '../../../common/enums/litre-movement-kind.enum';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type LitreBalanceDocument = LitreBalance & Document;

/**
 * spec 013 T182/data-model.md — one balance movement. **Keeps its `_id`**, same precedent
 * as `Order.StopEvent` and `VehicleVerification`'s siblings that DON'T (this one is never
 * addressed individually by id — it's `orderId` a movement is looked up by — but data-
 * model.md is explicit that it keeps `_id` regardless, for the same "never tidy an
 * embedded array item into `_id: false` without checking every reader" discipline).
 */
@Schema()
export class LitreMovement {
  // Declared explicitly (Mongoose adds it at runtime regardless) so callers that
  // address one movement by id — `LitreBalancesService.restateReconciliation`'s `$pull`
  // — get it on the TS type rather than reaching for a cast.
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: LitreMovementKind })
  kind!: LitreMovementKind;

  // Signed: positive credits the owner, negative debits.
  @Prop({ required: true })
  litres!: number;

  // Present for every kind except CORRECTION (FR-075a).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  // Required for CORRECTION only (FR-075) — enforced in the service, not
  // here, since the requirement is conditional on `kind`.
  @Prop()
  reason?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  actorId!: Types.ObjectId;

  @Prop({ required: true, default: Date.now })
  at!: Date;
}
export const LitreMovementSchema = SchemaFactory.createForClass(LitreMovement);

/**
 * spec 013 T181/FR-073/FR-074 — a litres-owed balance per station owner per fuel grade.
 * `markTenantScoped` on `companyId` (R6): a fuel company's own client, exactly `Station`'s
 * precedent (clients already read `markTenantScoped` records today).
 *
 * `balanceLitres` MUST equal `sum(movements.litres)` (SC-014a) — enforced structurally by
 * `LitreBalancesService` writing both together in one conditional update, never
 * separately, and never recomputed by summing `movements` on read (a stored total that
 * every write updates atomically, not a total derived on demand — data-model.md's own
 * wording for this field, deliberately unlike `AccountMovement`'s balance, which IS always
 * summed live; the difference is `AccountMovement` needs to net out reversals invisibly,
 * while a litre balance's history is never reversed, only appended to).
 */
@Schema({ timestamps: true })
export class LitreBalance {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  clientId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: FuelType })
  fuelType!: FuelType;

  @Prop({ required: true, default: 0 })
  balanceLitres!: number;

  @Prop({ type: [LitreMovementSchema], default: [] })
  movements!: LitreMovement[];

  /**
   * T183/FR-073e's idempotency guard, corrected TWICE from the task's literal
   * description. First correction: a `partialFilterExpression` on `movements.orderId`
   * scoped to `movements.kind` does not restrict a multikey index to matching array
   * elements — MongoDB evaluates a partial filter against the whole document once, then
   * indexes every element of the array field regardless, so a document already holding
   * one `SHORTFALL_CREDIT` would also index every `ORDER_DRAWDOWN`'s `orderId` — a false
   * collision. This flat array was the fix for that.
   *
   * Second correction, found while writing T205's unit tests: a unique index on this
   * field does NOT catch a duplicate value pushed into the SAME document's own array —
   * MongoDB's uniqueness constraint is between separate documents, not within one
   * document's own multikey entries, so retrying `recordReconciliation` for an order
   * already in this array silently succeeded and applied the movement twice. The actual
   * guard is now in `LitreBalancesService.recordReconciliation`'s own filter
   * (`reconciledOrderIds: { $ne: orderId }`, checked via a `null` result rather than a
   * caught duplicate-key error) — this index is kept only as a genuine, if narrower,
   * defense-in-depth backstop (still catches two DIFFERENT balance documents ever
   * colliding on one order id, which should never happen but costs nothing to also
   * refuse structurally).
   */
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] })
  reconciledOrderIds!: Types.ObjectId[];
}

export const LitreBalanceSchema = SchemaFactory.createForClass(LitreBalance);
markTenantScoped(LitreBalanceSchema);

// One balance per owner per grade (T181).
LitreBalanceSchema.index({ companyId: 1, clientId: 1, fuelType: 1 }, { unique: true });

// T183/FR-073e — defense-in-depth only; see `reconciledOrderIds`'s own comment. The real
// idempotency guard is `LitreBalancesService.recordReconciliation`'s update filter.
LitreBalanceSchema.index({ reconciledOrderIds: 1 }, { unique: true, sparse: true });
