import { IsEmail, IsString, MinLength } from 'class-validator';

/**
 * Fuel-Company-admin-only (spec 004 US2) — creates a Transportation Company
 * under the acting admin's own Fuel Company, with its own admin account.
 * Mirrors `CreateFuelCompanyDto`'s shape; no `commercialRegister` file here —
 * that requirement is specific to a Fuel Company's own onboarding (FR-018).
 */
export class CreateTransportCompanyDto {
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
