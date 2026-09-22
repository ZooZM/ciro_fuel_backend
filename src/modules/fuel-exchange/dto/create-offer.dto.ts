import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GovernorateCode } from '../../../common/enums/region.enum';

/**
 * spec 016 (broadcast fuel exchange offers) T027/T084 — the raiser's own terms. NO
 * `recipientCompanyId` (an offer reaches every eligible fuel company, never one named
 * party — FR-002) and NO `unitPrice` (FR-005a: price is proposed by each responder, not
 * set by the raiser). `deliveryAt`'s "must be future at creation only" (spec
 * Assumptions) is checked in the service, not here — a passed date makes an EXISTING
 * offer stale, never invalid, so nothing about that rule belongs to input shape
 * validation.
 */
export class CreateOfferDto {
  @IsEnum(FuelType)
  fuelType!: FuelType;

  @IsNumber()
  @Min(0.001)
  quantityLitres!: number;

  @IsDateString()
  deliveryAt!: string;

  @IsEnum(GovernorateCode)
  city!: GovernorateCode;

  // The NEIGHBOURHOOD (research R8) — free text, deliberately not bound to `RegionCode`.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  // http(s) only (FR-028) — a `javascript:` scheme must be refused at the API, not at
  // the renderer.
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  locationUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
