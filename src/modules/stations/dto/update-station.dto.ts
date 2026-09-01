import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';
import { GeoPointDto } from '../../orders/dto/create-order.dto';

/**
 * FUEL_COMPANY_ADMIN-only (spec 005 T108) — every field optional, unlike
 * `StationDto` (create-user.dto.ts), since a PATCH may touch just one of
 * them. The controller separately requires regionCode/governorateCode to
 * arrive together — validating the pairing (`governorateBelongsToRegion`)
 * needs both, and a partial pairing update against the stored value isn't
 * worth the read-before-write it would take to check safely.
 */
export class UpdateStationDto {
  @IsOptional()
  @IsEnum(RegionCode)
  regionCode?: RegionCode;

  @IsOptional()
  @IsEnum(GovernorateCode)
  governorateCode?: GovernorateCode;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoPointDto)
  location?: GeoPointDto;

  @IsOptional()
  @IsString()
  addressText?: string;

  @IsOptional()
  @IsString()
  name?: string;
}
