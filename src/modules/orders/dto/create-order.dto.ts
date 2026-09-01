import {
  IsEnum,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { PaymentMethod } from '../../../common/enums/payment-method.enum';

export class GeoPointDto {
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;
}

export class CreateOrderDto {
  @IsEnum(FuelType)
  fuelType!: FuelType;

  @IsInt()
  @Min(1)
  quantityLiters!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoPointDto)
  deliveryLocation?: GeoPointDto;

  // Defaults to DIRECT (spec 004 FR-021) — the existing pay-then-drive flow
  // every order used before billing existed.
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  // spec 005 US2/T055: both optional at the DTO level — genuinely required
  // by the real client app (which always calls POST /orders/quote first,
  // T063), but making them mandatory here would break every pre-existing
  // e2e suite that creates an order directly (dispatch, billing, tracking,
  // presence — none of which are about pricing). When `quoteToken` is
  // given, it MUST be honoured: the itemised breakdown it names is what
  // gets persisted, never silently recomputed as a bare estimate.
  @IsOptional()
  @IsMongoId()
  stationId?: string;

  @IsOptional()
  @IsString()
  quoteToken?: string;
}
