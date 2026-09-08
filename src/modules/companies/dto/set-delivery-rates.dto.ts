import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, Min, ValidateNested } from 'class-validator';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';

class DeliveryRateEntryDto {
  @IsEnum(RegionCode)
  regionCode!: RegionCode;

  /** Omitted = the whole region. Checked against the region in the controller,
   *  against `regions.constants.ts`, exactly as `CreateUserDto.station` is —
   *  the pairing is data, not a decorator. */
  @IsOptional()
  @IsEnum(GovernorateCode)
  governorateCode?: GovernorateCode;

  // `@Min(0)`, not `@Min(0.01)` as fuel prices use: zero is a legitimate rate
  // here. A transporter may cover a nearby area on the minimum charge alone,
  // and a zero floor is how a transporter says "per-km only, no minimum".
  @IsNumber()
  @Min(0)
  pricePerKm!: number;

  @IsNumber()
  @Min(0)
  minPrice!: number;
}

/**
 * The WHOLE set, every time — the same shape `SetFuelPricesDto` uses, and for the
 * same reason: an area disappearing from the list is how a transporter stops
 * serving it, which a per-entry PATCH could not express without a second delete
 * endpoint and a way to name an entry that has no id.
 */
export class SetDeliveryRatesDto {
  // No `@ArrayMinSize(1)`: an empty list is meaningful — it is a transporter
  // withdrawing from every area at once, which must be sayable.
  @ValidateNested({ each: true })
  @Type(() => DeliveryRateEntryDto)
  rates!: DeliveryRateEntryDto[];
}
