import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { TankMaterial } from '../../../common/enums/tank-material.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type TankDocument = Tank & Document;

/**
 * The trailer (spec 008 US1/data-model.md). Single-tenant, `markTenantScoped`
 * (research R2). Holds everything about *carrying capability* — capacity and
 * fuel-grade guards validate THIS record, never the truck (research R3).
 *
 * Carries **no** credential of any kind (FR-048c) — a tank is assigned,
 * never verified. `material` is a recorded fact only; it does not derive or
 * constrain `fuelTypes` (FR-048g) — an iron tank and an aluminium tank are
 * equally free to carry any grade the operator says they carry.
 */
@Schema({ timestamps: true })
export class Tank {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  companyId!: Types.ObjectId;

  // Globally unique (FR-048b) — unlike a plate, a code is stated as a
  // fleet-wide identifier and appears on the driver's screen (FR-033a), so
  // global uniqueness keeps what a driver sees unambiguous.
  @Prop({ required: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, enum: TankMaterial })
  material!: TankMaterial;

  @Prop({ required: true, min: 1 })
  maxCapacityLiters!: number;

  @Prop({ type: [String], required: true, enum: FuelType })
  fuelTypes!: FuelType[];

  @Prop({ default: true })
  isActive!: boolean;

  // Present ⇒ committed (FR-048f). Withdrawal clears `isActive` but never
  // this — an in-progress delivery continues.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  activeOrderId?: Types.ObjectId;
}

export const TankSchema = SchemaFactory.createForClass(Tank);
markTenantScoped(TankSchema);

TankSchema.index({ code: 1 }, { unique: true });
TankSchema.index(
  { activeOrderId: 1 },
  { unique: true, partialFilterExpression: { activeOrderId: { $exists: true } } },
);
// Serves the offered-tank list — pre-excludes tanks the platform would
// refuse (FR-016a: the offered list and the acceptable set must agree).
TankSchema.index({
  companyId: 1,
  isActive: 1,
  activeOrderId: 1,
  maxCapacityLiters: 1,
  fuelTypes: 1,
});
