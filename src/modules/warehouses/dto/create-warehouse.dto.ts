import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GeoPointDto } from '../../orders/dto/create-order.dto';

export class CreateWarehouseDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @ValidateNested()
  @Type(() => GeoPointDto)
  location!: GeoPointDto;

  @IsString()
  @MinLength(1)
  addressText!: string;

  @IsEnum(RegionCode)
  region!: RegionCode;

  @IsEnum(GovernorateCode)
  governorate!: GovernorateCode;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(FuelType, { each: true })
  fuelTypes!: FuelType[];

  @IsOptional()
  @IsString()
  externalRef?: string;
}
