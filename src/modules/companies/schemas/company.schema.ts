import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { CompanyStatus } from '../../../common/enums/company-status.enum';
import { CompanyType } from '../../../common/enums/company-type.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { RegionCode } from '../../../common/enums/region.enum';

export type CompanyDocument = Company & Document;

@Schema({ _id: false })
export class FuelPrice {
  @Prop({ type: String, required: true, enum: FuelType })
  fuelType!: FuelType;

  @Prop({ required: true, min: 0.01 })
  basePricePerLiter!: number;
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

  @Prop({ required: true })
  contactEmail!: string;

  @Prop({ required: true })
  contactPhone!: string;
}

export const CompanySchema = SchemaFactory.createForClass(Company);
