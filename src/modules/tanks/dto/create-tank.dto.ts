import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { TankMaterial } from '../../../common/enums/tank-material.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';

export class CreateTankDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsEnum(TankMaterial)
  material!: TankMaterial;

  @IsInt()
  @Min(1)
  maxCapacityLiters!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(FuelType, { each: true })
  fuelTypes!: FuelType[];
}
