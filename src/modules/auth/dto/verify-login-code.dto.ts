import { IsString, Length, Matches } from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';

export class VerifyLoginCodeDto {
  @Matches(E164_PATTERN, { message: 'phone must be in E.164 format' })
  phone!: string;

  // Exactly 6 digits (FR-012) — the platform's shared
  // `OtpPrimitivesService.generateCode` produces a 6-digit zero-padded code.
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
