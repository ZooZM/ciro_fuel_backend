import { IsEmail, IsString, MinLength } from 'class-validator';

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

  @IsString()
  adminPhone!: string;

  @IsString()
  @MinLength(8)
  adminPassword!: string;
}
