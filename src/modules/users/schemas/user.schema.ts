import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { UserRole } from '../../../common/enums/user-role.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GeoPoint, GeoPointSchema } from '../../../common/schemas/geo-point.schema';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type UserDocument = User & Document;

@Schema({ _id: false })
export class Truck {
  @Prop({ required: true, trim: true })
  plateNumber!: string;

  @Prop({ required: true, min: 1 })
  maxCapacityLiters!: number;

  // Non-empty; dispatch matches an order's fuelType against this list (FR-011).
  @Prop({ required: true, type: [String], enum: FuelType })
  fuelTypes!: FuelType[];

  @Prop()
  model?: string;
}
export const TruckSchema = SchemaFactory.createForClass(Truck);

@Schema({ timestamps: true })
export class User {
  // Required for every role except SUPER_ADMIN (enforced in DTOs/service layer).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company' })
  companyId?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: UserRole, immutable: true })
  role!: UserRole;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  @Prop({ required: true, select: false })
  passwordHash!: string;

  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({ required: true })
  phone!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'File' })
  profilePictureFileId?: Types.ObjectId;

  @Prop({ default: true })
  isActive!: boolean;

  // --- CLIENT-only fields ---
  @Prop({ type: GeoPointSchema })
  stationLocation?: GeoPoint;

  // --- DRIVER-only fields ---
  @Prop({ default: true })
  isAvailable?: boolean;

  @Prop({ default: false })
  isOnline?: boolean;

  @Prop()
  lastSeenAt?: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  activeOrderId?: Types.ObjectId;

  @Prop({ type: GeoPointSchema })
  location?: GeoPoint;

  @Prop()
  locationUpdatedAt?: Date;

  @Prop({ type: TruckSchema })
  truck?: Truck;
}

export const UserSchema = SchemaFactory.createForClass(User);
markTenantScoped(UserSchema);

UserSchema.index({ companyId: 1, role: 1 });
UserSchema.index({ location: '2dsphere' });
UserSchema.index(
  { activeOrderId: 1 },
  { unique: true, partialFilterExpression: { activeOrderId: { $exists: true } } },
);
UserSchema.index({ companyId: 1, role: 1, isActive: 1, isOnline: 1, isAvailable: 1 });
UserSchema.index({ role: 1, isOnline: 1, lastSeenAt: 1 });
