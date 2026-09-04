import { IsEmail, IsString, Matches, MinLength } from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';

export class CreateFuelCompanyDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  contactEmail!: string;

  @IsString()
  contactPhone!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(2)
  adminFullName!: string;

  // spec 015 R5 — an administrator's phone is now a login identifier and must
  // resolve to exactly one account, so it must be a real E.164 number, not a
  // placeholder.
  @Matches(E164_PATTERN, { message: 'adminPhone must be a valid E.164 number' })
  adminPhone!: string;

  @IsString()
  @MinLength(8)
  adminPassword!: string;
}
