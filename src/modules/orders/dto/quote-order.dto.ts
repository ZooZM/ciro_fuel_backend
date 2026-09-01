import { IsEnum, IsInt, IsMongoId, Min } from 'class-validator';
import { FuelType } from '../../../common/enums/fuel-type.enum';

export class QuoteOrderDto {
  @IsEnum(FuelType)
  fuelType!: FuelType;

  @IsInt()
  @Min(1)
  quantityLiters!: number;

  @IsMongoId()
  stationId!: string;
}
