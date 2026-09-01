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

/** SUPER_ADMIN-only (FR-035c) — every field optional, unlike `CreateWarehouseDto`. */
export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoPointDto)
  location?: GeoPointDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  addressText?: string;

  @IsOptional()
  @IsEnum(RegionCode)
  region?: RegionCode;

  @IsOptional()
  @IsEnum(GovernorateCode)
  governorate?: GovernorateCode;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(FuelType, { each: true })
  fuelTypes?: FuelType[];

  @IsOptional()
  @IsString()
  externalRef?: string;
}
