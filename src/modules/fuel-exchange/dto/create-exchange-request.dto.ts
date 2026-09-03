import { IsDateString, IsEnum, IsMongoId, IsNumber, IsString, Min, MinLength } from 'class-validator';
import { FuelType } from '../../../common/enums/fuel-type.enum';

// spec 013 T221/FR-078/FR-098 — the raiser's own terms. `recipientCompanyId` names the
// counterparty; `unitPrice`/`currency` and `deliveryAt`/`deliveryPlaceText` are TERMS of
// the proposed agreement, never instructions the platform itself acts on (FR-086a).
export class CreateExchangeRequestDto {
  @IsMongoId()
  recipientCompanyId!: string;

  @IsEnum(FuelType)
  fuelType!: FuelType;

  @IsNumber()
  @Min(0.001)
  quantityLitres!: number;

  @IsNumber()
  @Min(0.01)
  unitPrice!: number;

  @IsDateString()
  deliveryAt!: string;

  @IsString()
  @MinLength(1)
  deliveryPlaceText!: string;
}
