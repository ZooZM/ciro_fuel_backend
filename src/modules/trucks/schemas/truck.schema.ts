import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type TruckDocument = Truck & Document;

/**
 * The tractor (spec 008 US1/data-model.md) — a real, company-owned record
 * with its own identity, replacing the embedded per-driver `Truck` that used
 * to live on `User` (deleted outright, research R12). Single-tenant, owned
 * by a transportation company — `markTenantScoped` (research R2).
 *
 * Carries the NFC card and the rotatable QR token; carries **no** capacity
 * or fuel-grade fields — that capability lives on `Tank` (research R3),
 * which is what dissolved the old `$geoNear`/`$lookup` constraint that
 * forced vehicles onto the driver record in the first place.
 */
@Schema({ timestamps: true })
export class Truck {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  companyId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  plateNumber!: string;

  @Prop({ trim: true })
  model?: string;

  // The card identifier as captured by the desk reader (FR-004) — an opaque
  // string compared for equality only, globally unique when present
  // (FR-005's enforcement point, via the index below).
  @Prop({ trim: true })
  nfcCardUid?: string;

  // Platform-generated, high-entropy, rotatable — never derived from `_id`
  // (research R6, FR-036h: no TTL/expiry field anywhere here).
  @Prop({ trim: true })
  qrToken?: string;

  // Withdrawn from service (FR-007). Withdrawal clears this but NEVER
  // `activeOrderId` — an in-progress delivery continues (FR-008).
  @Prop({ default: true })
  isActive!: boolean;

  // Present ⇒ committed to that delivery (research R13 — the same booking
  // pattern already used for `User.activeOrderId`).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  activeOrderId?: Types.ObjectId;
}

export const TruckSchema = SchemaFactory.createForClass(Truck);
markTenantScoped(TruckSchema);

// Per-company plate uniqueness — two transporters may legitimately hold
// similar plates (data-model.md).
TruckSchema.index({ companyId: 1, plateNumber: 1 }, { unique: true });
// FR-005's enforcement point: a card cannot pair to two trucks. Globally
// unique (not per-company) — a driver presents a credential without stating
// which company owns it, so resolution must be unambiguous platform-wide
// (data-model.md's "why globally unique" note).
TruckSchema.index(
  { nfcCardUid: 1 },
  { unique: true, partialFilterExpression: { nfcCardUid: { $exists: true } } },
);
// Also the credential-resolution lookup.
TruckSchema.index(
  { qrToken: 1 },
  { unique: true, partialFilterExpression: { qrToken: { $exists: true } } },
);
// FR-012's enforcement point (research R13).
TruckSchema.index(
  { activeOrderId: 1 },
  { unique: true, partialFilterExpression: { activeOrderId: { $exists: true } } },
);
// The operator's "available trucks" list.
TruckSchema.index({ companyId: 1, isActive: 1, activeOrderId: 1 });
