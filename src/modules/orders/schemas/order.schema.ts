import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { UserRole } from '../../../common/enums/user-role.enum';
import { PaymentMethod } from '../../../common/enums/payment-method.enum';
import { TankMaterial } from '../../../common/enums/tank-material.enum';
import { VerificationMethod } from '../../../common/enums/verification-method.enum';
import { VerificationStage } from '../../../common/enums/verification-stage.enum';
import { EscalationSkipReason } from '../../../common/enums/escalation-skip-reason.enum';
import { StopOrigin } from '../../../common/enums/stop-origin.enum';
import { StopReason } from '../../../common/enums/stop-reason.enum';
import { GeoPoint, GeoPointSchema } from '../../../common/schemas/geo-point.schema';
import { markMultiParty } from '../../../common/plugins/multi-party.marker';
import { DEFAULT_CURRENCY } from '../../../common/constants/money.constants';

export type OrderDocument = Order & Document;

/**
 * The four itemised components (spec 005 D3/FR-011a) plus the three input
 * rates that produced them, so an order stays auditable even after its
 * fuel company's `PricingConfig` later changes (FR-011i — this is the
 * order's own immutable copy, never re-derived on read). Optional: orders
 * placed before this feature have none, and none is ever back-filled
 * (research R2 — inventing historical rates would fabricate a financial
 * record).
 */
@Schema({ _id: false })
export class PriceBreakdown {
  @Prop({ required: true, min: 0 })
  fuelLineTotal!: number;

  @Prop({ required: true, min: 0 })
  deliveryFee!: number;

  @Prop({ required: true, min: 0 })
  serviceFee!: number;

  @Prop({ required: true, min: 0 })
  tax!: number;

  // The sum of the four rounded components above — never the rounded sum
  // of unrounded components (research R2), or FR-011b's "components sum to
  // the total" fails intermittently by a fraction of a currency unit.
  @Prop({ required: true, min: 0 })
  total!: number;

  // Rates in force when this was priced — the audit trail FR-011i implies.
  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  @Prop({ required: true, min: 0, max: 100 })
  serviceFeePercent!: number;

  @Prop({ required: true, min: 0, max: 100 })
  taxRatePercent!: number;

  @Prop({ required: true, default: DEFAULT_CURRENCY })
  currency!: string;

  @Prop({ required: true, default: Date.now })
  pricedAt!: Date;
}
export const PriceBreakdownSchema = SchemaFactory.createForClass(PriceBreakdown);

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

/**
 * spec 004 FR-008/FR-028: snapshotted onto the order the moment a driver is
 * assigned (`dispatch.service.ts`) — never re-derived on a later read, same
 * discipline as `deliveryAddressText`. This is deliberately the client's
 * ONLY window into who is delivering their order: they can never read the
 * driver's own user record directly (FR-002/US6 independent test).
 */
@Schema({ _id: false })
export class DriverSummary {
  @Prop({ required: true })
  fullName!: string;

  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true })
  plateNumber!: string;
}
export const DriverSummarySchema = SchemaFactory.createForClass(DriverSummary);

/**
 * spec 007 FR-003a: the mirror image of {@link DriverSummary} — snapshotted
 * onto the order in the same `assignDriver` transaction, so the driver can
 * identify and reach the customer they are delivering to. Absent on any
 * order assigned before this feature existed; callers must treat that as
 * "no contact available", never as an error (FR-027b).
 */
@Schema({ _id: false })
export class ClientSummary {
  @Prop({ required: true })
  fullName!: string;

  @Prop({ required: true })
  phone!: string;
}
export const ClientSummarySchema = SchemaFactory.createForClass(ClientSummary);

/**
 * spec 008 (data-model.md): snapshotted at assignment alongside
 * `driverSummary`/`clientSummary`, same discipline — the driver's screen
 * (FR-033a) and any later review show what was assigned, not what the tank
 * record says now.
 */
@Schema({ _id: false })
export class TankSummary {
  @Prop({ required: true })
  code!: string;

  @Prop({ type: String, required: true, enum: TankMaterial })
  material!: TankMaterial;
}
export const TankSummarySchema = SchemaFactory.createForClass(TankSummary);

/** spec 008 (data-model.md): snapshotted at assignment, frozen once loading begins (FR-035e). */
@Schema({ _id: false })
export class WarehouseSummary {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  addressText!: string;

  @Prop({ type: GeoPointSchema, required: true })
  location!: GeoPoint;
}
export const WarehouseSummarySchema = SchemaFactory.createForClass(WarehouseSummary);

/**
 * spec 008 (data-model.md): one verification attempt, successful or not.
 * Append-only — per-order evidence, always read with the order. Stores the
 * RESOLVED truck, never the raw credential (FR-042) — an attempt log
 * holding card identifiers would be a harvestable list of valid credentials.
 */
@Schema({ _id: false })
export class VehicleVerification {
  // Derived server-side from the order's status at the moment of the
  // attempt — never accepted as a field on the incoming request (research R7).
  @Prop({ type: String, required: true, enum: VerificationStage })
  stage!: VerificationStage;

  @Prop({ type: String, required: true, enum: VerificationMethod })
  method!: VerificationMethod;

  @Prop({ required: true })
  matched!: boolean;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Truck' })
  presentedTruckId?: Types.ObjectId;

  @Prop({ required: true, default: Date.now })
  at!: Date;

  // Absent if position was unavailable — recorded honestly rather than
  // defaulted (FR-024).
  @Prop({ type: GeoPointSchema })
  driverLocation?: GeoPoint;

  // How far `driverLocation` was from the assigned warehouse when the
  // loading-stage geofence was evaluated (FR-030d). Present on LOADING
  // attempts only — a departure attempt is not geofenced at all — and
  // recorded whatever the verdict, including on a wrong card presented at
  // the right place: "verified from 4 km away" and "verified in the yard"
  // must stay distinguishable after the fact, which a bare `matched` flag
  // cannot carry.
  @Prop()
  distanceMeters?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  actorId!: Types.ObjectId;
}
export const VehicleVerificationSchema = SchemaFactory.createForClass(VehicleVerification);

/**
 * spec 011: one stop on one delivery — either DETECTED (the sweep noticed a
 * truck had not moved for the configured window) or DECLARED (the driver
 * said so before anyone asked).
 *
 * **`_id` is retained, unlike every other embedded sub-schema in this
 * file.** `PriceBreakdown`, `StatusHistoryEntry`, `OtpRecord`,
 * `DriverSummary`, `ClientSummary`, `TankSummary`, `WarehouseSummary` and
 * `VehicleVerification` all set `_id: false`, because none of them is ever
 * addressed on its own. A stop event is: `POST /orders/:id/stops/:stopId/
 * reason` and `PATCH /orders/:id/stops/:stopId/resolve` both take one, the
 * escalation job uses it as its `jobId`, and the driver's notification
 * carries it so the app can open the right prompt. Copying the surrounding
 * precedent here would leave nothing able to identify a single stop — do
 * not "tidy" this into `_id: false`.
 */
@Schema()
export class StopEvent {
  @Prop({ type: String, required: true, enum: StopOrigin })
  origin!: StopOrigin;

  @Prop({ required: true, default: Date.now })
  detectedAt!: Date;

  // The driver's last known position when the stop was raised. Absent if
  // none has ever been recorded — recorded honestly rather than defaulted,
  // the same discipline VehicleVerification.driverLocation follows.
  @Prop({ type: GeoPointSchema })
  location?: GeoPoint;

  // Set the moment the driver answers — and set at creation for a DECLARED
  // stop, which is precisely why a declared stop never prompts and never
  // escalates (FR-008b): it arrives already answered.
  @Prop({ type: String, enum: StopReason })
  reason?: StopReason;

  // Required only when `reason` is OTHER; optional otherwise.
  @Prop()
  reasonText?: string;

  // Absence of this is what "unanswered" means — the escalation checks it,
  // not `reason`, so the two can never disagree.
  @Prop()
  reasonGivenAt?: Date;

  // DECLARED stops only: the driver's own estimate of how long they expect
  // to be stopped, and the moment suppression lapses (FR-008d). Without the
  // bound, one declaration early in a delivery would silence detection for
  // the rest of the journey — the very failure this feature exists to
  // prevent, self-inflicted.
  @Prop()
  expectedDurationMinutes?: number;

  @Prop()
  suppressedUntil?: Date;

  // Set when the response window elapsed with no reason given. Left in
  // place even if the driver answers late (FR-010) — the transporter *was*
  // alerted, and erasing that would make the record lie about what happened.
  @Prop()
  escalatedAt?: Date;

  // The single field that makes a stop "unresolved" (FR-016's invariant).
  // Set either by the driver answering a detected stop, or by an
  // administrator marking it handled — `resolvedBy` distinguishes which.
  @Prop()
  resolvedAt?: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  resolvedBy?: Types.ObjectId;
}
export const StopEventSchema = SchemaFactory.createForClass(StopEvent);

/** spec 013 T180/data-model.md — what the platform read from the document, before any
 * administrator confirmation (FR-073a-i). Every field optional: extraction can yield
 * nothing for any or all of them (R8 — `NullSupplierInvoiceExtractor` yields none). */
@Schema({ _id: false })
export class ExtractedSupplierInvoiceData {
  @Prop()
  quantityLitres?: number;

  @Prop({ type: String, enum: FuelType })
  fuelType?: FuelType;

  @Prop()
  reference?: string;

  @Prop()
  issueDate?: Date;
}
export const ExtractedSupplierInvoiceDataSchema = SchemaFactory.createForClass(ExtractedSupplierInvoiceData);

/** spec 013 T180/FR-073a-ii — what the administrator confirmed. This is what counts: the
 * shortfall/excess computation and every balance movement read `confirmed`, never
 * `extracted` (data-model.md's own words). */
@Schema({ _id: false })
export class ConfirmedSupplierInvoiceData {
  @Prop({ required: true, min: 0 })
  quantityLitres!: number;

  @Prop({ type: String, required: true, enum: FuelType })
  fuelType!: FuelType;

  @Prop({ required: true })
  reference!: string;

  @Prop({ required: true })
  issueDate!: Date;
}
export const ConfirmedSupplierInvoiceDataSchema = SchemaFactory.createForClass(ConfirmedSupplierInvoiceData);

/**
 * spec 013 T180/FR-073/R7 — one supplier invoice reconciled against this order. **Keeps
 * its `_id`**, with a comment saying so (the same call spec 011's `StopEvent` made): the
 * confirm, replace and balance-movement paths each address one specific invoice.
 * `confirmed` absent means nothing was ever recorded and no balance ever moved (SC-014c)
 * — an abandoned upload (T185's upload-only step) leaves no sub-document at all, only a
 * `FileRecord` nobody points at yet.
 */
@Schema()
export class SupplierInvoice {
  // Declared explicitly (Mongoose adds it at runtime regardless) so
  // `SupplierInvoicesService.replace`'s `$set` on `supplierInvoices.$.supersededAt`
  // (matched via this id) gets it on the TS type rather than reaching for a cast.
  _id!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'File', required: true })
  fileId!: Types.ObjectId;

  @Prop({ type: ExtractedSupplierInvoiceDataSchema })
  extracted?: ExtractedSupplierInvoiceData;

  @Prop({ type: ConfirmedSupplierInvoiceDataSchema })
  confirmed?: ConfirmedSupplierInvoiceData;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  confirmedBy?: Types.ObjectId;

  @Prop()
  confirmedAt?: Date;

  // T192/FR-073e: set when a `PUT` replaces this invoice — the record is kept, never
  // deleted, following `Invoice.state: VOID`'s precedent of leaving a full trail.
  @Prop()
  supersededAt?: Date;
}
export const SupplierInvoiceSchema = SchemaFactory.createForClass(SupplierInvoice);

@Schema({ timestamps: true })
export class Order {
  // The owning Fuel Company — always set, immutable (spec 004 plan.md §1's
  // multi-party filter requires it for every non-CIRO role, with no
  // exception). Renamed from `companyId`: this is a multi-party collection
  // now (markMultiParty below, not markTenantScoped) precisely because a
  // single `companyId` can no longer describe every legitimate viewer.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  fuelCompanyId!: Types.ObjectId;

  // Set once routing resolves a Transportation Company (FR-014/FR-015);
  // absent while PENDING_APPROVAL/APPROVED/AWAITING_ROUTING.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company' })
  transportCompanyId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  clientId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: FuelType })
  fuelType!: FuelType;

  @Prop({ required: true, min: 1 })
  quantityLiters!: number;

  @Prop({ type: GeoPointSchema, required: true })
  deliveryLocation!: GeoPoint;

  // Snapshotted from the client's station.addressText at creation
  // (FR-009/FR-030) — never re-derived or re-geocoded on a later read
  // (FR-012), even if the client's own station address changes afterward.
  @Prop({ default: '' })
  deliveryAddressText!: string;

  // spec 005 FR-036c: which of the client's (possibly several) stations
  // this order was placed against — kept readable even after that station
  // is withdrawn (isActive: false), since deliveryLocation/deliveryAddressText
  // above are already the immutable snapshot; this is purely the reference.
  // Optional: orders predating the station migration have none (T016).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Station' })
  stationId?: Types.ObjectId;

  // spec 005 D3/FR-011a — see PriceBreakdown above for why this is
  // optional and never back-filled.
  @Prop({ type: PriceBreakdownSchema })
  priceBreakdown?: PriceBreakdown;

  @Prop({ type: String, required: true, enum: OrderStatus, default: OrderStatus.PENDING_APPROVAL })
  status!: OrderStatus;

  @Prop({ required: true, min: 0 })
  estimatedPrice!: number;

  @Prop({ min: 0 })
  finalPrice?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  approvedBy?: Types.ObjectId;

  // Chosen at creation (spec 004 FR-021), immutable — approval issues the
  // invoice using whichever method the order already carries, it never
  // re-derives or overrides it.
  @Prop({ type: String, required: true, enum: PaymentMethod, default: PaymentMethod.DIRECT })
  paymentMethod!: PaymentMethod;

  // Set once the invoice is issued at approval (FR-020) — absent before then.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Invoice' })
  invoiceId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  driverId?: Types.ObjectId;

  // Snapshotted at assignment (FR-008/FR-028) — see DriverSummary above.
  @Prop({ type: DriverSummarySchema })
  driverSummary?: DriverSummary;

  // spec 007 FR-003a — snapshotted at assignment alongside driverSummary
  // above, in the same transaction. See ClientSummary's own doc comment.
  @Prop({ type: ClientSummarySchema })
  clientSummary?: ClientSummary;

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

  // spec 007 FR-032/FR-033/research R7: set once, the moment the order
  // reaches DELIVERED (normal completion or the admin `forceComplete`
  // override) — `updatedAt` is not that moment, since invoice issuance and
  // payment settlement both touch a delivered order afterwards and would
  // drift the driver's daily count.
  @Prop()
  deliveredAt?: Date;

  // spec 008 — set at assignment (FR-009f). Optional: absent pre-cutover
  // and for any order that predates this feature (research R12).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Truck' })
  truckId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tank' })
  tankId?: Types.ObjectId;

  // Snapshotted once, at assignment — never re-derived on a later read,
  // same discipline as driverSummary/clientSummary.
  @Prop({ type: TankSummarySchema })
  tankSummary?: TankSummary;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Warehouse' })
  warehouseId?: Types.ObjectId;

  // Frozen once loading begins (FR-035e) — a later withdrawal or edit of the
  // warehouse record must not rewrite what this order was told to load from.
  @Prop({ type: WarehouseSummarySchema })
  warehouseSummary?: WarehouseSummary;

  @Prop({ type: [VehicleVerificationSchema], default: [] })
  verifications!: VehicleVerification[];

  // Set when the loading stage completes (normal confirmation or override).
  @Prop()
  loadingConfirmedAt?: Date;

  // spec 010 FR-010/FR-014a: an explicit driver action (a new endpoint fired
  // from the driver app's own active-delivery load path), never inferred
  // from `Notification.readAt` or from the driver's device merely being
  // online (FR-017). Reset to `undefined` only when the driver assignment
  // itself changes to someone else — a vehicle-only `reassignVehicle` never
  // touches this, since it never touches `driverId` either (research R2).
  @Prop()
  assignmentAcknowledgedAt?: Date;

  // spec 010 FR-011/FR-013: set once the escalation SMS is actually sent.
  // Reset alongside `assignmentAcknowledgedAt` on a driver reassignment.
  @Prop()
  assignmentEscalationSmsAt?: Date;

  // spec 010 FR-015: set instead of the above when the escalation window
  // elapsed but no SMS could be attempted (no valid phone on file today —
  // see EscalationSkipReason for why this is an enum, not a boolean).
  @Prop({ type: String, enum: EscalationSkipReason })
  assignmentEscalationSkippedReason?: EscalationSkipReason;

  // spec 010 FR-008: recorded once, in the same transaction as
  // `driverSummary`, when the administrator knowingly assigned a driver who
  // was not ELIGIBLE at selection time — the same audit discipline as
  // `manualOverride`/`overrideReason` on `StatusHistoryEntry` above, applied
  // to a fact about the assignment itself rather than a status transition.
  @Prop({ default: false })
  assignedWhileIneligible?: boolean;

  @Prop()
  assignedWhileIneligibleReason?: string;

  // spec 011: the delivery's stop trail — embedded rather than its own
  // collection (research R5), which is not only the `verifications`
  // precedent but a deliberate boundary: there is no per-driver stop
  // collection to query, so "every stop this driver has ever had" cannot be
  // assembled by accident. The spec scopes this feature as safety and
  // delivery visibility, not driver surveillance, and the data model is
  // where that holds.
  @Prop({ type: [StopEventSchema], default: [] })
  stopEvents!: StopEvent[];

  // spec 013 T180/FR-073e: an ARRAY, not the single embedded sub-document data-model.md's
  // field name suggests — "replace... supersede... restate" (T192) and "retain both
  // extracted and confirmed" (FR-073a-iv) both require the superseded invoice to survive,
  // never be overwritten in place. The CURRENT one is whichever entry has no
  // `supersededAt`; at most one such entry exists at a time, enforced by the service, not
  // the schema (mirrors `Invoice.state: VOID` keeping every prior state's row rather than
  // mutating it away). Same `_id`-keeping discipline as `stopEvents` above, for the same
  // reason: the confirm, replace and balance-movement paths each address one specific one.
  @Prop({ type: [SupplierInvoiceSchema], default: [] })
  supplierInvoices!: SupplierInvoice[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);
markMultiParty(OrderSchema);

OrderSchema.index({ fuelCompanyId: 1, status: 1 });
OrderSchema.index({ transportCompanyId: 1, status: 1 });
OrderSchema.index({ clientId: 1, createdAt: -1 });
OrderSchema.index({ driverId: 1, status: 1 });
OrderSchema.index({ status: 1, paymentDeadline: 1 });
OrderSchema.index({ deliveryLocation: '2dsphere' });

// spec 005 FR-048/SC-004a (research R3): supports GET /orders' cursor
// pagination, sorted `updatedAt` desc with `_id` desc as tiebreaker — the
// platform has no dedicated `statusChangedAt` field (the mobile app's
// mapper already falls back to `updatedAt`, which every status transition
// touches via Mongoose's own timestamps), so this indexes the field that
// is actually used. Without this pair, a paginated list degrades to a
// collection scan once a client has enough orders to matter.
OrderSchema.index({ clientId: 1, updatedAt: -1, _id: -1 });
OrderSchema.index({ clientId: 1, status: 1, updatedAt: -1, _id: -1 });

// spec 007 T065: backs the driver's daily completed-deliveries count
// (`DriversService.deliveriesToday`) — partial so a driver's undelivered
// orders (which never set `deliveredAt`) are never indexed.
OrderSchema.index(
  { driverId: 1, deliveredAt: -1 },
  { partialFilterExpression: { deliveredAt: { $exists: true } } },
);

// spec 008 (research R4): backs the last-operated-truck lookup —
// `DispatchService.getCandidates` reads the most recent order carrying this
// driverId with a truckId, so it stays derived from order history rather
// than a stored `lastTruckId` field on `User`. Partial on `truckId` existing
// so pre-cutover orders never enter it.
OrderSchema.index(
  { driverId: 1, truckId: 1, createdAt: -1 },
  { partialFilterExpression: { truckId: { $exists: true } } },
);
