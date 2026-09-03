import { IsNumber, Min } from 'class-validator';

// spec 013 FR-029.
export class CreateCreditLimitRequestDto {
  @IsNumber()
  @Min(0.01)
  requestedAmount!: number;
}
