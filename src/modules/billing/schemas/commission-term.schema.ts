import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { CommissionBasis } from '../../../common/enums/commission-basis.enum';

export type CommissionTermDocument = CommissionTerm & Document;

/**
 * spec 013 (fuel company admin dashboard) T132/FR-055/FR-057/FR-058, data-model.md — the
 * commission rate the platform charges, effective-dated. Platform-level: no isolation
 * marker, following `Company`'s own precedent for a record with no tenant above it (every
 * fuel company reads the same currently-in-force term).
 *
 * **No update path at all.** A rate change writes a NEW document; the previous one is
 * never touched. This is what makes FR-058 ("a rate change must not alter commission
 * already accrued") structural rather than disciplinary — accrual stamps the rate it used
 * onto the movement (T143), so even if this collection were mutated, past movements
 * would be unaffected, but the collection is immutable regardless, by construction.
 */
@Schema({ timestamps: true })
export class CommissionTerm {
  @Prop({ type: String, required: true, enum: CommissionBasis })
  basis!: CommissionBasis;

  @Prop({ required: true, min: 0 })
  rate!: number;

  @Prop({ required: true, default: Date.now })
  effectiveFrom!: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  setBy!: Types.ObjectId;
}

export const CommissionTermSchema = SchemaFactory.createForClass(CommissionTerm);
// FR-057/T137: "the term in force at instant T" is a single query on this index.
CommissionTermSchema.index({ effectiveFrom: -1, _id: -1 });
