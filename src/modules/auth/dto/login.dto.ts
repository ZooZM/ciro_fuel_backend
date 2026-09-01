import { IsEmail, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';

export class LoginDto {
  // CLIENT/DRIVER sign in by phone, admins by email. When both are sent phone
  // wins, so the identifier the service reads is always the one validated here.
  @ValidateIf((o: LoginDto) => o.phone === undefined)
  @IsEmail()
  email?: string;

  @ValidateIf((o: LoginDto) => o.phone !== undefined)
  @Matches(E164_PATTERN, { message: 'phone must be a valid E.164 number' })
  phone?: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
