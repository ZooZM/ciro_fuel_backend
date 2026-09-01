import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type NotificationDocument = Notification & Document;

@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  recipientUserId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: NotificationType })
  type!: NotificationType;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  @Prop()
  readAt?: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
markTenantScoped(NotificationSchema);
NotificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });
// spec 005 FR-031/research R3: supports GET /notifications' cursor pagination.
NotificationSchema.index({ recipientUserId: 1, createdAt: -1, _id: -1 });
