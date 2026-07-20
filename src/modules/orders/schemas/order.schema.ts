import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { UserRole } from '../../../common/enums/user-role.enum';
import { GeoPoint, GeoPointSchema } from '../../../common/schemas/geo-point.schema';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type OrderDocument = Order & Document;

@Schema({ _id: false })
export class StatusHistoryEntry {
  @Prop({ type: String, required: true, enum: OrderStatus })
  from!: OrderStatus;

  @Prop({ type: String, required: true, enum: OrderStatus })
  to!: OrderStatus;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  actorId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: UserRole })
  actorRole!: UserRole;

  @Prop({ required: true, default: Date.now })
  at!: Date;

  @Prop({ default: false })
  manualOverride?: boolean;

  @Prop()
  overrideReason?: string;
}
export const StatusHistoryEntrySchema = SchemaFactory.createForClass(StatusHistoryEntry);

export enum OtpPurpose {
  ARRIVAL = 'ARRIVAL',
  DELIVERY = 'DELIVERY',
}

@Schema({ _id: false })
export class OtpRecord {
  @Prop({ type: String, required: true, enum: OtpPurpose })
  purpose!: OtpPurpose;

  @Prop({ required: true })
  hash!: string;

  @Prop({ required: true })
  salt!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop()
  usedAt?: Date;

  @Prop({ default: 0 })
  attempts!: number;

  @Prop({ required: true, default: Date.now })
  createdAt!: Date;
}
export const OtpRecordSchema = SchemaFactory.createForClass(OtpRecord);

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  clientId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: FuelType })
  fuelType!: FuelType;

  @Prop({ required: true, min: 1 })
  quantityLiters!: number;

  @Prop({ type: GeoPointSchema, required: true })
  deliveryLocation!: GeoPoint;

  @Prop({ type: String, required: true, enum: OrderStatus, default: OrderStatus.PENDING_APPROVAL })
  status!: OrderStatus;

  @Prop({ required: true, min: 0 })
  estimatedPrice!: number;

  @Prop({ min: 0 })
  finalPrice?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  approvedBy?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  driverId?: Types.ObjectId;

  @Prop()
  paymentDeadline?: Date;

  @Prop({ default: 0 })
  paymentTimeoutCount!: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'PaymentEvent' })
  paymentConfirmationId?: Types.ObjectId;

  @Prop({ type: [StatusHistoryEntrySchema], default: [] })
  statusHistory!: StatusHistoryEntry[];

  @Prop({ type: [OtpRecordSchema], default: [] })
  otps!: OtpRecord[];

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  cancelledBy?: Types.ObjectId;

  @Prop()
  cancellationReason?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  rejectedBy?: Types.ObjectId;

  @Prop()
  rejectionReason?: string;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
markTenantScoped(OrderSchema);

OrderSchema.index({ companyId: 1, status: 1 });
OrderSchema.index({ clientId: 1, createdAt: -1 });
OrderSchema.index({ driverId: 1, status: 1 });
OrderSchema.index({ status: 1, paymentDeadline: 1 });
OrderSchema.index({ deliveryLocation: '2dsphere' });
