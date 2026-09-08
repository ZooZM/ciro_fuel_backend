import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { ProposalOutcome } from '../../../common/enums/proposal-outcome.enum';
import { markProposal } from '../../../common/plugins/proposal.marker';

export type ExchangeProposalDocument = ExchangeProposal & Document;

/**
 * spec 016 (broadcast fuel exchange offers) data-model.md, research R3 — a response to
 * one `ExchangeOffer`, its OWN collection, never an array embedded on the offer. An
 * embedded array travels with every read of its parent, and this codebase has already
 * shipped that exact leak once (spec 008's `OrdersController.findMine` verification
 * trail) — blindness (FR-011b) is a storage decision here, not a rendering one.
 *
 * `markProposal`, under `proposal-scope.plugin.ts`: readable by its own author OR the
 * company that raised the offer it answers.
 */
@Schema({ timestamps: true })
export class ExchangeProposal {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ExchangeOffer', required: true, immutable: true })
  offerId!: Types.ObjectId;

  // Denormalised so the proposal-scope filter never needs a `$lookup` (research R3) — a
  // scope filter that requires a join is one that will eventually be worked around.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  offerRaisedByCompanyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  proposingCompanyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  proposingUserId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ProposalOutcome, default: ProposalOutcome.PROPOSED })
  outcome!: ProposalOutcome;

  // Required when PROPOSED (FR-011a), absent on a decline — enforced in the service,
  // not the schema, since Mongoose conditional-required on a sibling enum field is
  // easy to get subtly wrong and the service already validates the DTO's own
  // mutual-exclusion (price XOR decline).
  @Prop({ min: 0.01 })
  unitPrice?: number;

  @Prop()
  currency?: string;

  @Prop({ required: true })
  respondedAt!: Date;

  // Set when the PARENT offer resolves (award or withdrawal) — never by the proposer.
  @Prop()
  resolvedAt?: Date;
}

export const ExchangeProposalSchema = SchemaFactory.createForClass(ExchangeProposal);
markProposal(ExchangeProposalSchema);

// The one-answer-per-company guarantee (FR-011c, FR-018) — DB-enforced, not
// application code (Constitution V). This index, not a prior existence check, is what
// makes a double submission collide rather than silently duplicate.
ExchangeProposalSchema.index({ offerId: 1, proposingCompanyId: 1 }, { unique: true });
// Required by proposal-scope.plugin.ts's own registration-time check.
ExchangeProposalSchema.index({ proposingCompanyId: 1, createdAt: -1, _id: -1 });
ExchangeProposalSchema.index({ offerRaisedByCompanyId: 1, offerId: 1 });
