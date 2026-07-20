import { IsEnum, IsInt, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { FuelType } from '../../../common/enums/fuel-type.enum';

export class GeoPointDto {
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;
}

export class CreateOrderDto {
  @IsEnum(FuelType)
  fuelType!: FuelType;

  @IsInt()
  @Min(1)
  quantityLiters!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoPointDto)
  deliveryLocation?: GeoPointDto;
}
