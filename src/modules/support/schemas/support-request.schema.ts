import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { SupportTopic } from '../../../common/enums/support-topic.enum';
import { SupportRequestState } from '../../../common/enums/support-request-state.enum';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type SupportRequestDocument = SupportRequest & Document;

/**
 * A client's raised problem, routed to their fuel company (spec 005
 * US9/FR-038). Single-tenant (`companyId` = the client's own fuel
 * company, the routing target) via the original tenant-equality plugin —
 * not the multi-party plugin, since a support request has exactly one
 * viewing company, unlike an order. Client-facing reads additionally
 * filter `clientId = req.user.sub` (the same belt-and-braces
 * `StationsService`/`UsersController` already apply for self-access).
 */
@Schema({ timestamps: true })
export class SupportRequest {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  clientId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: SupportTopic })
  topic!: SupportTopic;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  message!: string;

  @Prop({
    type: String,
    required: true,
    enum: SupportRequestState,
    default: SupportRequestState.SUBMITTED,
  })
  state!: SupportRequestState;

  @Prop()
  acknowledgedAt?: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  acknowledgedBy?: Types.ObjectId;
}

export const SupportRequestSchema = SchemaFactory.createForClass(SupportRequest);
markTenantScoped(SupportRequestSchema);

SupportRequestSchema.index({ clientId: 1, createdAt: -1 });
SupportRequestSchema.index({ companyId: 1, createdAt: -1 });
