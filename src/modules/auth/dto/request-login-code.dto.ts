import { IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { E164_PATTERN } from '../../../common/constants/phone';

/** spec 015 §3 — a solved proof-of-work challenge. */
export class LoginChallengeDto {
  @IsString()
  seed!: string;

  // A decimal string — the client searches for one whose
  // sha256(seed || nonce) has the required leading zero bits.
  @IsString()
  nonce!: string;
}

export class RequestLoginCodeDto {
  @Matches(E164_PATTERN, { message: 'phone must be in E.164 format' })
  phone!: string;

  // Required ONLY after `loginOtp.challengeAfter` rate-limited requests for
  // this number (FR-023); absent on an ordinary first request.
  @IsOptional()
  @ValidateNested()
  @Type(() => LoginChallengeDto)
  challenge?: LoginChallengeDto;
}
