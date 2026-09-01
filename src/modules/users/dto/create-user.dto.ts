import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';
import { UserRole } from '../../../common/enums/user-role.enum';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';
import { GeoPointDto } from '../../orders/dto/create-order.dto';

/** Spec 004 US3 — captured at client registration: region/governorate for
 * routing (FR-014), the dropped pin, and the (geocode-suggested, user-edited)
 * address text. Region/governorate pairing is checked in the controller
 * against `regions.constants.ts`, the source of truth for which
 * governorate belongs to which region — not duplicated here as decorators. */
export class StationDto {
  @IsEnum(RegionCode)
  regionCode!: RegionCode;

  @IsEnum(GovernorateCode)
  governorateCode!: GovernorateCode;

  @ValidateNested()
  @Type(() => GeoPointDto)
  location!: GeoPointDto;

  // May be empty — FR-013: a failed/unavailable geocode lookup must not
  // block registration, so this is not @IsNotEmpty().
  @IsOptional()
  @IsString()
  addressText?: string;

  @IsOptional()
  @IsString()
  name?: string;
}

export class CreateUserDto {
  // A FUEL_COMPANY_ADMIN provisions CLIENT/DRIVER accounts only —
  // FUEL_COMPANY_ADMIN and TRANSPORT_COMPANY_ADMIN accounts are created
  // exclusively via company registration, never through this endpoint.
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

  @Matches(E164_PATTERN, { message: 'phone must be a valid E.164 number' })
  phone!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StationDto)
  station?: StationDto;
}
