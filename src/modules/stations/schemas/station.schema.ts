import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';
import { GeoPoint, GeoPointSchema } from '../../../common/schemas/geo-point.schema';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type StationDocument = Station & Document;

/**
 * A client's site that receives fuel deliveries (spec 005 D2/research R1) —
 * promoted out of the single embedded `User.station` so a client can hold
 * several, registered by their fuel company. `User.station` is retained
 * read-only, populated from this collection's default, purely for backward
 * compatibility with `GET /auth/me` during the transition (T017).
 *
 * Single-tenant (one owning `companyId`) — the original `companyId`-equality
 * plugin via `markTenantScoped`, not the multi-party plugin. That alone is
 * NOT sufficient isolation: two clients share a fuel company, so every
 * client-facing query additionally filters `clientId = req.user.sub`
 * (StationsService.findForClient) — see data-model.md.
 */
@Schema({ timestamps: true })
export class Station {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  clientId!: Types.ObjectId;

  // Optional display label ("محطة الرحاب"), independent of addressText.
  @Prop({ trim: true })
  name?: string;

  @Prop({ type: String, required: true, enum: RegionCode })
  regionCode!: RegionCode;

  @Prop({ type: String, required: true, enum: GovernorateCode })
  governorateCode!: GovernorateCode;

  @Prop({ type: GeoPointSchema, required: true })
  location!: GeoPoint;

  // Geocode-suggested, admin-edited, never re-derived from the pin on a
  // later read — same convention as the embedded predecessor.
  @Prop({ trim: true, default: '' })
  addressText!: string;

  // Exactly one true per clientId among active stations — enforced by the
  // partial unique index below (Principle V: DB-level, not assumed from
  // application ordering).
  @Prop({ default: false })
  isDefault!: boolean;

  // The only field a CLIENT may write (FR-036a/FR-037) — everything else
  // is fuel-company-admin-only (FR-036b).
  @Prop({ default: false })
  isFavourite!: boolean;

  // Soft delete (FR-036c): a withdrawn station stays readable through any
  // order that referenced it, but drops out of GET /stations.
  @Prop({ default: true })
  isActive!: boolean;
}

export const StationSchema = SchemaFactory.createForClass(Station);
markTenantScoped(StationSchema);

StationSchema.index({ clientId: 1, isActive: 1 });
// Enforces "exactly one default per client" at the data layer — a second
// concurrent PATCH setting isDefault:true on a different station for the
// same client fails at the DB rather than racing in application code.
StationSchema.index(
  { clientId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);
