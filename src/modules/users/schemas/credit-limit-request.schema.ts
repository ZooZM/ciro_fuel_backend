import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { CreditLimitRequestState } from '../../../common/enums/credit-limit-request-state.enum';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type CreditLimitRequestDocument = CreditLimitRequest & Document;

/**
 * spec 013 (fuel company admin dashboard) FR-029/FR-030/FR-031, data-model.md — a
 * station owner's request for a higher credit limit. Single-tenant
 * (`markTenantScoped`, R6): one fuel company owns it, and the requesting client reads
 * within that same tenant — the same shape `Station`/`SupportRequest` already use, not
 * the multi-party or party-set mechanisms (only a fuel-exchange request crosses a
 * company boundary).
 *
 * Resolution is a conditional update filtered on `state: PENDING` (FR-031, SC-008) —
 * `modifiedCount` decides which of two concurrent resolutions wins, never a
 * read-then-write. See `CreditLimitRequestsService.resolve`.
 */
@Schema({ timestamps: true })
export class CreditLimitRequest {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  clientId!: Types.ObjectId;

  @Prop({ required: true, min: 0.01 })
  requestedAmount!: number;

  @Prop({ type: String, required: true, enum: CreditLimitRequestState, default: CreditLimitRequestState.PENDING })
  state!: CreditLimitRequestState;

  // Present only once accepted — may differ from `requestedAmount` (FR-030).
  @Prop({ min: 0 })
  grantedAmount?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  resolvedBy?: Types.ObjectId;

  @Prop()
  resolvedAt?: Date;
}

export const CreditLimitRequestSchema = SchemaFactory.createForClass(CreditLimitRequest);
markTenantScoped(CreditLimitRequestSchema);

// The administrator's pending queue (FR-030) and the owner's own history (FR-029).
CreditLimitRequestSchema.index({ companyId: 1, state: 1, createdAt: -1 });
CreditLimitRequestSchema.index({ clientId: 1, createdAt: -1 });
