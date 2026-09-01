import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { markMultiParty } from '../../../common/plugins/multi-party.marker';

/**
 * spec 007 US6 (FR-037–FR-042, data-model.md): one customer's rating of one
 * completed delivery. Multi-party — the rater belongs to a Fuel Company,
 * the subject to a Transportation Company — so it carries `markMultiParty`,
 * matching `Order`, not the single-tenant plugin (research R6).
 *
 * Immutable: written once, never edited. There is no update path —
 * moderation and appeal are out of scope (spec Assumptions).
 */
@Schema({ timestamps: true })
export class DeliveryRating {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true, immutable: true })
  orderId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  driverId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  clientId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  fuelCompanyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  transportCompanyId!: Types.ObjectId;

  @Prop({ required: true, min: 1, max: 5 })
  score!: number;

  // FR-037b: rendered as plain text only, never interpreted as markup —
  // enforced on the read side (mobile), trimmed/length-capped here.
  @Prop({ trim: true, maxlength: 500 })
  review?: string;
}

export type DeliveryRatingDocument = DeliveryRating & Document;
export const DeliveryRatingSchema = SchemaFactory.createForClass(DeliveryRating);
markMultiParty(DeliveryRatingSchema);

// FR-039's actual enforcement point: a duplicate insert is rejected by
// Mongo itself, which a prior-existence check cannot guarantee under two
// concurrent submissions for the same order.
DeliveryRatingSchema.index({ orderId: 1 }, { unique: true });
DeliveryRatingSchema.index({ driverId: 1, createdAt: -1 });
