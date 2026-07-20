import { Type } from 'class-transformer';
import { ArrayMinSize, IsEnum, IsNumber, Min, ValidateNested } from 'class-validator';
import { FuelType } from '../../../common/enums/fuel-type.enum';

class FuelPriceEntryDto {
  @IsEnum(FuelType)
  fuelType!: FuelType;

  @IsNumber()
  @Min(0.01)
  basePricePerLiter!: number;
}

export class SetFuelPricesDto {
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FuelPriceEntryDto)
  prices!: FuelPriceEntryDto[];
}
