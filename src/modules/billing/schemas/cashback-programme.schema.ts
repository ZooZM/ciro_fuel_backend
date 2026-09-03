import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { CommissionBasis } from '../../../common/enums/commission-basis.enum';

export type CashbackProgrammeDocument = CashbackProgramme & Document;

/**
 * spec 013 T133/FR-059/FR-060 — mirrors `CommissionTerm`'s effective-dated, no-update-path
 * shape. `isActive`/`targetsAllCompanies`/`targetCompanyIds` are read together at PAYMENT
 * time (T144), never cached — a programme switched off between an invoice's issuance and
 * its payment accrues nothing, matching FR-060's own wording ("only while the programme
 * is active").
 */
@Schema({ timestamps: true })
export class CashbackProgramme {
  @Prop({ type: String, required: true, enum: CommissionBasis })
  basis!: CommissionBasis;

  @Prop({ required: true, min: 0 })
  rate!: number;

  @Prop({ required: true, default: false })
  isActive!: boolean;

  @Prop({ required: true, default: true })
  targetsAllCompanies!: boolean;

  // Meaningful only when targetsAllCompanies is false (data-model.md).
  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'Company', default: [] })
  targetCompanyIds!: Types.ObjectId[];

  @Prop({ required: true, default: Date.now })
  effectiveFrom!: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  setBy!: Types.ObjectId;
}

export const CashbackProgrammeSchema = SchemaFactory.createForClass(CashbackProgramme);
CashbackProgrammeSchema.index({ effectiveFrom: -1, _id: -1 });
