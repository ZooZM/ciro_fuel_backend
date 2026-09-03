import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsMongoId, IsNumber, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { FuelType } from '../../../common/enums/fuel-type.enum';

// spec 013 T186/T187/FR-073a-ii — what the administrator confirmed, after correcting any
// extracted value or entering by hand what extraction did not yield (FR-073a-iii). This
// is what counts; `extracted` (retained separately, T185's upload response) never feeds
// the balance computation directly.
export class ConfirmedSupplierInvoiceDataDto {
  @IsNumber()
  @Min(0)
  quantityLitres!: number;

  @IsEnum(FuelType)
  fuelType!: FuelType;

  @IsString()
  @MinLength(1)
  reference!: string;

  @IsDateString()
  issueDate!: string;
}

export class ConfirmSupplierInvoiceDto {
  @IsMongoId()
  fileId!: string;

  @ValidateNested()
  @Type(() => ConfirmedSupplierInvoiceDataDto)
  confirmed!: ConfirmedSupplierInvoiceDataDto;
}
