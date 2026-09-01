import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'ascending', async: false })
class IsAscendingConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    for (let i = 1; i < value.length; i++) {
      if (value[i] <= value[i - 1]) return false;
    }
    return true;
  }

  defaultMessage(): string {
    return 'tankerCapacitiesLiters must be strictly ascending';
  }
}

export class SetPricingConfigDto {
  @IsNumber()
  @Min(0)
  deliveryFee!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  serviceFeePercent!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  taxRatePercent!: number;

  // Non-empty and strictly ascending (FR-017) — the client's quantity
  // selector steps through exactly this ladder in this order.
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Validate(IsAscendingConstraint)
  tankerCapacitiesLiters!: number[];
}
