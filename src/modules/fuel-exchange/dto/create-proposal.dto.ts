import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * spec 016 (broadcast fuel exchange offers) T046/FR-011/FR-011a — a price OR a decline,
 * mutually exclusive. The XOR itself is enforced in `FuelExchangeService.propose`
 * (`EXCHANGE_PARTY_INVALID`-style 400s live in the service throughout this module),
 * not here — class-validator's declarative decorators cannot express "exactly one of
 * these two" cleanly, and the service already owns every other propose-time refusal
 * (grade, offer state, self-answer).
 */
export class CreateProposalDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  unitPrice?: number;

  @IsOptional()
  @IsBoolean()
  decline?: boolean;
}
