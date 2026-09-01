import { IsString, MinLength } from 'class-validator';

/** FR-047b: an operator override is an explicit, reasoned attestation — never optional. */
export class OverrideVerificationDto {
  @IsString()
  @MinLength(10)
  reason!: string;
}
