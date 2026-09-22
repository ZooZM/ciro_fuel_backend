import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GovernorateCode } from '../../../common/enums/region.enum';
import { ExchangeOfferState } from '../../../common/enums/exchange-offer-state.enum';
import { markPartySet } from '../../../common/plugins/party-set.marker';

export type ExchangeOfferDocument = ExchangeOffer & Document;

/**
 * spec 016 (broadcast fuel exchange offers) data-model.md, research R1 — replaces the
 * directed `ExchangeRequest`. `markPartySet`, under the AMENDED
 * `party-set-scope.plugin.ts`: `openToMarket: true` means one owner (the raiser) plus an
 * unbounded audience (every eligible fuel company); `openToMarket: false` is the legacy
 * two-owner shape, reached only through migration (`migratedFromRequestId`).
 *
 * Deliberately carries NO price field — the raiser proposes no price at all (FR-005a).
 * The agreed figures (`agreedUnitPrice` etc.) exist ONLY once the offer is awarded
 * (research R7) and are frozen at that moment, never recomputed from a live proposal.
 */
@Schema({ timestamps: true })
export class ExchangeOffer {
  // THE isolation field — array membership OR openToMarket, never equality
  // (party-set-scope.plugin.ts, research R1). Exactly [raiser] when openToMarket is
  // true; exactly [raiser, recipient] when false (migrated records only).
  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'Company', required: true })
  partyCompanyIds!: Types.ObjectId[];

  @Prop({ type: Boolean, required: true, immutable: true })
  openToMarket!: boolean;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  raisedByCompanyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  raisedByUserId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: FuelType, immutable: true })
  fuelType!: FuelType;

  @Prop({ required: true, min: 0.001, immutable: true })
  quantityLitres!: number;

  // Must be future ONLY at creation (spec Assumptions) — a passed delivery date makes
  // an existing offer stale, never invalid, so no validator runs on read or update.
  @Prop({ required: true, immutable: true })
  deliveryAt!: Date;

  @Prop({ type: String, required: true, enum: GovernorateCode })
  city!: GovernorateCode;

  // The NEIGHBOURHOOD — free text, deliberately NOT `RegionCode` (research R8: the
  // platform already uses that enum for its 13 administrative regions, a different
  // concept the approved design's المنطقة label would have collided with).
  @Prop({ trim: true, maxlength: 120 })
  district?: string;

  // http(s) only, validated server-side by the DTO (FR-028) — never trusted from the
  // client alone, since this is rendered as a link.
  @Prop({ trim: true, maxlength: 2048 })
  locationUrl?: string;

  @Prop({ trim: true, maxlength: 1000 })
  notes?: string;

  @Prop({
    type: String,
    required: true,
    enum: ExchangeOfferState,
    default: ExchangeOfferState.OPEN,
  })
  state!: ExchangeOfferState;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ExchangeProposal' })
  awardedProposalId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company' })
  awardedCompanyId?: Types.ObjectId;

  // Frozen at award (research R7) — absent while OPEN means "no price agreed", never
  // zero. Never recomputed from the winning proposal after the fact.
  @Prop()
  agreedUnitPrice?: number;

  @Prop()
  agreedTotal?: number;

  @Prop()
  agreedQuantityLitres?: number;

  @Prop()
  currency?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  resolvedBy?: Types.ObjectId;

  @Prop()
  resolvedAt?: Date;

  // The migration's idempotency key (research R5) — set ONLY by
  // scripts/migrate-exchange-requests-to-offers.ts, absent on every offer this feature
  // itself creates.
  @Prop({ type: MongooseSchema.Types.ObjectId })
  migratedFromRequestId?: Types.ObjectId;
}

export const ExchangeOfferSchema = SchemaFactory.createForClass(ExchangeOffer);
markPartySet(ExchangeOfferSchema);

// THE isolation index (party-set-scope.plugin.ts's own registration-time check fails
// startup without this).
ExchangeOfferSchema.index({ partyCompanyIds: 1 });
// The market listing, with its grade relevance filter applied in the service layer
// (research R2) — never in the injected filter.
ExchangeOfferSchema.index({ openToMarket: 1, state: 1, fuelType: 1, createdAt: -1, _id: -1 });
// Outgoing — a raiser's own offers, direction derived at read time (never stored).
ExchangeOfferSchema.index({ raisedByCompanyId: 1, state: 1, createdAt: -1, _id: -1 });
// The migration's idempotency key — unique sparse, since only migrated records carry it.
ExchangeOfferSchema.index({ migratedFromRequestId: 1 }, { unique: true, sparse: true });
