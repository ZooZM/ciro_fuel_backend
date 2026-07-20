import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { CompanyStatus } from '../../../common/enums/company-status.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';

export type CompanyDocument = Company & Document;

@Schema({ _id: false })
export class FuelPrice {
  @Prop({ type: String, required: true, enum: FuelType })
  fuelType!: FuelType;

  @Prop({ required: true, min: 0.01 })
  basePricePerLiter!: number;
}
export const FuelPriceSchema = SchemaFactory.createForClass(FuelPrice);

// Companies are the tenant root — NOT scoped by the tenant plugin (there is
// nothing "above" a company to scope against). SUPER_ADMIN manages these
// globally; a COMPANY_ADMIN may only read/act on their own via explicit _id checks.
@Schema({ timestamps: true })
export class Company {
  @Prop({ required: true, unique: true, trim: true, minlength: 2, maxlength: 120 })
  name!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'File' })
  commercialRegisterFileId?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: CompanyStatus, default: CompanyStatus.ACTIVE })
  status!: CompanyStatus;

  @Prop({ type: [FuelPriceSchema], default: [] })
  fuelPrices!: FuelPrice[];

  @Prop({ required: true })
  contactEmail!: string;

  @Prop({ required: true })
  contactPhone!: string;
}

export const CompanySchema = SchemaFactory.createForClass(Company);
