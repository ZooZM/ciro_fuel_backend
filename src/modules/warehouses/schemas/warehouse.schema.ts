import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GeoPoint, GeoPointSchema } from '../../../common/schemas/geo-point.schema';

export type WarehouseDocument = Warehouse & Document;

/**
 * A gasoline depot a driver loads from before travelling to the customer
 * (spec 008 US4/data-model.md). Platform infrastructure, not owned by any
 * tenant — carries **neither** `markTenantScoped` nor `markMultiParty`,
 * following `Company`'s own precedent for global reference data with no
 * tenant above it (research R1). Written only by SUPER_ADMIN (FR-035c);
 * read by every authenticated role, same as `Company`.
 */
@Schema({ timestamps: true })
export class Warehouse {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ type: GeoPointSchema, required: true })
  location!: GeoPoint;

  @Prop({ required: true, trim: true })
  addressText!: string;

  @Prop({ type: String, required: true, enum: RegionCode })
  region!: RegionCode;

  @Prop({ type: String, required: true, enum: GovernorateCode })
  governorate!: GovernorateCode;

  @Prop({ type: [String], required: true, enum: FuelType })
  fuelTypes!: FuelType[];

  // Withdrawal affects only unstarted deliveries (FR-035e edge case) — an
  // order that already snapshotted this warehouse's summary at assignment
  // keeps showing it regardless of this flag.
  @Prop({ default: true })
  isActive!: boolean;

  // The operator's own identifier from the national dataset (FR-035a), so a
  // bulk re-load upserts on this field rather than duplicating rows.
  @Prop({ trim: true })
  externalRef?: string;
}

export const WarehouseSchema = SchemaFactory.createForClass(Warehouse);

// spec 008 R9: a second 2dsphere index is only ambiguous for $geoNear WITHIN
// the same collection (see the warning on UserSchema) — a different
// collection entirely cannot make DispatchService's own $geoNear ambiguous.
WarehouseSchema.index({ location: '2dsphere' });
WarehouseSchema.index({ fuelTypes: 1, isActive: 1 });
WarehouseSchema.index(
  { externalRef: 1 },
  { unique: true, partialFilterExpression: { externalRef: { $exists: true } } },
);
