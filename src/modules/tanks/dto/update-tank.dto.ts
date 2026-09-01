import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { TankMaterial } from '../../../common/enums/tank-material.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';

export class UpdateTankDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  code?: string;

  @IsOptional()
  @IsEnum(TankMaterial)
  material?: TankMaterial;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxCapacityLiters?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(FuelType, { each: true })
  fuelTypes?: FuelType[];
}
