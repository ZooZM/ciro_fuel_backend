import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { CompanyStatus } from '../../../common/enums/company-status.enum';
import { CompanyType } from '../../../common/enums/company-type.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';

export type CompanyDocument = Company & Document;

@Schema({ _id: false })
export class FuelPrice {
  @Prop({ type: String, required: true, enum: FuelType })
  fuelType!: FuelType;

  @Prop({ required: true, min: 0.01 })
  basePricePerLiter!: number;

  /**
   * The value this grade held before the most recent CHANGE to it, and when that
   * change happened. Together they are the only source for "آخر تحديث: منذ 5 أيام",
   * the change percentage, and the مقارنة الأسعار table's "السعر السابق" column —
   * every one of which feature 013 deleted from the dashboard as fabricated, because
   * this schema recorded a price and nothing else.
   *
   * Both are OPTIONAL and both stay absent until a grade is changed for the first
   * time: a grade priced once and never revised has no previous value, and inventing
   * one (0, or the current price, giving a permanent "0.00% لم يتغيّر") would be the
   * same fabrication in a new place. "Never changed" and "changed by nothing" are
   * different facts and the API must be able to say which.
   */
  @Prop({ min: 0.01 })
  previousPricePerLiter?: number;

  /** When `basePricePerLiter` last CHANGED — not when the document was last written. */
  @Prop()
  priceChangedAt?: Date;
}
export const FuelPriceSchema = SchemaFactory.createForClass(FuelPrice);

/**
 * A FUEL company's own delivery fee, service fee and tax rate (spec 005
 * D3/research R2), alongside the tanker capacities it sells in (FR-017).
 * Sits beside `fuelPrices` above — same access rule (`assertCompanyAccess`),
 * same FUEL-only scope. Optional at the schema level so adding it doesn't
 * invalidate every existing company document, but required in practice:
 * FR-011j refuses to price an order for a company with none set, rather
 * than silently deriving a total from defaults or zeros.
 */
@Schema({ _id: false })
export class PricingConfig {
  @Prop({ required: true, min: 0 })
  deliveryFee!: number;

  @Prop({ required: true, min: 0, max: 100 })
  serviceFeePercent!: number;

  @Prop({ required: true, min: 0, max: 100 })
  taxRatePercent!: number;

  // Non-empty, ascending (FR-017) — the client's quantity selector steps
  // through exactly this ladder. Never derived from Truck.maxCapacityLiters
  // (FR-017a): those belong to transport companies, a different tenant.
  @Prop({ type: [Number], required: true })
  tankerCapacitiesLiters!: number[];

  @Prop({ required: true, default: Date.now })
  updatedAt!: Date;
}
export const PricingConfigSchema = SchemaFactory.createForClass(PricingConfig);

/**
 * One area a TRANSPORT company hauls into, and what it charges to do so.
 *
 * Embedded on `Company` exactly as `fuelPrices` is, and for the same reasons: a
 * bounded list (13 regions, optionally narrowed to a governorate) that is only ever
 * read and written as one set, through one company.
 *
 * This is the transport price the CLIENT is quoted, not an internal cost — the
 * transporter sets it, and `PricingService` resolves it through the same
 * region-serving rule `RoutingService.findServingTransporters` uses to route the
 * order later, so the price quoted and the transporter eventually routed come from
 * one rule rather than two that can disagree.
 *
 * `minPrice` is a floor, not an alternative: a short haul still costs the
 * transporter a truck and a driver, and per-km alone prices a 2 km delivery at
 * almost nothing.
 */
@Schema({ _id: false })
export class DeliveryRate {
  @Prop({ type: String, required: true, enum: RegionCode })
  regionCode!: RegionCode;

  /**
   * Absent means the rate covers the WHOLE region. A governorate-specific rate wins
   * over its region's (resolution is most-specific-first) — without that, a
   * transporter could not charge more for one hard-to-reach governorate without
   * re-pricing everywhere else it serves.
   */
  @Prop({ type: String, enum: GovernorateCode })
  governorateCode?: GovernorateCode;

  @Prop({ required: true, min: 0 })
  pricePerKm!: number;

  @Prop({ required: true, min: 0 })
  minPrice!: number;

  @Prop({ required: true, default: Date.now })
  updatedAt!: Date;
}
export const DeliveryRateSchema = SchemaFactory.createForClass(DeliveryRate);

// Companies are the tenant root — NOT scoped by the tenant plugin (there is
// nothing "above" a company to scope against). CIRO (SUPER_ADMIN) manages
// these globally; a FUEL_COMPANY_ADMIN or TRANSPORT_COMPANY_ADMIN may only
// read/act on their own via explicit _id checks.
//
// One collection covers both FUEL and TRANSPORT companies (spec 004 plan.md
// §2) rather than two, so the existing company lifecycle, status suspension
// and file attachment are shared unchanged; `type` distinguishes them.
@Schema({ timestamps: true })
export class Company {
  @Prop({ required: true, unique: true, trim: true, minlength: 2, maxlength: 120 })
  name!: string;

  @Prop({ type: String, required: true, enum: CompanyType })
  type!: CompanyType;

  // Set only when type === TRANSPORT: the Fuel Company that created and owns
  // this transporter. A FUEL company never has this set.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company' })
  parentFuelCompanyId?: Types.ObjectId;

  // TRANSPORT-only: the regions this transporter is assigned to serve
  // (spec 004 FR-014), assigned by its parent Fuel Company.
  @Prop({ type: [String], enum: RegionCode, default: [] })
  servedRegions!: RegionCode[];

  // spec 013 (fuel company admin dashboard) FR-036, T086a — genuine platform addition,
  // found during analysis, not a pattern-match: `servedRegions` above is TRANSPORT-only
  // (assigned BY a fuel company TO its transporter). A FUEL-type company had no field of
  // its own recording the regions it covers. Deliberately a separate field, never reusing
  // `servedRegions` — the two mean different things for different company types and
  // conflating them would let a fuel company's own coverage silently overwrite, or be
  // overwritten by, one of its transporters' served regions.
  @Prop({ type: [String], enum: RegionCode, default: [] })
  coveredRegions!: RegionCode[];

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'File' })
  commercialRegisterFileId?: Types.ObjectId;

  // spec 013 T135/FR-062a/FR-062b — the maximum accrued commission this company may owe
  // before further deferred dealing is refused. Optional BY DESIGN: absent means the
  // platform-wide default (config, not a document — `billing.defaultCommissionCeiling`)
  // governs, so changing that default can never silently overwrite a ceiling the operator
  // set explicitly for one company. Set only via `PUT /companies/:id/commission-ceiling`
  // (SUPER_ADMIN only) — a company can never set or change its own.
  @Prop({ min: 0 })
  commissionCeiling?: number;

  @Prop({ type: String, required: true, enum: CompanyStatus, default: CompanyStatus.ACTIVE })
  status!: CompanyStatus;

  // FUEL-only: fuel is priced and sold by the Fuel Company, never the transporter.
  @Prop({ type: [FuelPriceSchema], default: [] })
  fuelPrices!: FuelPrice[];

  // FUEL-only, optional (see PricingConfig doc comment — FR-011j gates on
  // its absence at the pricing boundary, not here).
  @Prop({ type: PricingConfigSchema })
  pricingConfig?: PricingConfig;

  /**
   * TRANSPORT companies only — a FUEL company hauls nothing itself. Empty by
   * default: a transporter that has priced no area yet is a real, reportable state
   * (the order simply cannot be quoted through it), never an implied free delivery.
   */
  @Prop({ type: [DeliveryRateSchema], default: [] })
  deliveryRates!: DeliveryRate[];

  @Prop({ required: true })
  contactEmail!: string;

  @Prop({ required: true })
  contactPhone!: string;
}

export const CompanySchema = SchemaFactory.createForClass(Company);
