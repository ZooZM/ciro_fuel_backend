import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  // Same E.164 rule as creation: for CLIENT/DRIVER this is the login
  // identifier, so an unvalidated edit could leave an account unable to sign in.
  @IsOptional()
  @Matches(E164_PATTERN, { message: 'phone must be a valid E.164 number' })
  phone?: string;
}
