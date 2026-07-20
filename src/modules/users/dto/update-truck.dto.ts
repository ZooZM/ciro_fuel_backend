import { ArrayMinSize, IsArray, IsEnum, IsNumber, IsString, Min, MinLength } from 'class-validator';
import { FuelType } from '../../../common/enums/fuel-type.enum';

export class UpdateTruckDto {
  @IsString()
  @MinLength(1)
  plateNumber!: string;

  @IsNumber()
  @Min(1)
  maxCapacityLiters!: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(FuelType, { each: true })
  fuelTypes!: FuelType[];
}
