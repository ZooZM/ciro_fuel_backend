import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { UserRole } from '../../../common/enums/user-role.enum';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GeoPointDto } from '../../orders/dto/create-order.dto';

class TruckDto {
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

export class CreateUserDto {
  // Company Admins provision CLIENT/DRIVER accounts only — COMPANY_ADMIN
  // accounts are created exclusively via company registration (T058).
  @IsIn([UserRole.CLIENT, UserRole.DRIVER])
  role!: UserRole.CLIENT | UserRole.DRIVER;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(2)
  fullName!: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoPointDto)
  stationLocation?: GeoPointDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TruckDto)
  truck?: TruckDto;
}
