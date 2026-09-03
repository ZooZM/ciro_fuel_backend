import { IsBoolean, IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';

// spec 013 FR-030. `grantedAmount` is meaningful only when accepting — the accepted
// amount may differ from what was requested. Ignored (never required) when rejecting.
export class ResolveCreditLimitRequestDto {
  @IsBoolean()
  accept!: boolean;

  @ValidateIf((dto: ResolveCreditLimitRequestDto) => dto.accept)
  @IsNumber()
  @Min(0.01)
  @IsOptional()
  grantedAmount?: number;
}
