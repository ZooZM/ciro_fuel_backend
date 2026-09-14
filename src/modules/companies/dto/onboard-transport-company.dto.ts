import { IsEmail, IsMongoId, IsString, Matches, MinLength } from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';

/**
 * spec 017 (operator dashboard) T066/FR-027/FR-029/FR-030 — the platform
 * operator onboarding a transport company.
 *
 * Distinct from {@link CreateTransportCompanyDto} by exactly one field, and
 * that field is the whole reason this DTO exists. A `FUEL_COMPANY_ADMIN` using
 * `POST /companies/:id/transporters` names the parent implicitly — it is their
 * own tenant, and the route refuses any other id. A `SUPER_ADMIN` has no
 * tenant, so the parent has to be stated.
 *
 * `parentFuelCompanyId` is **required** (FR-030). A transport company with no
 * parent is unroutable: routing resolves a transporter through its parent fuel
 * company, so an optional field defaulting to absent would create a company
 * that can sign in, appear in every list, and never receive an order — a
 * failure with no error message anywhere. It is also immutable after creation;
 * nothing on this platform reparents a transporter, and the onboarding form
 * says so.
 */
export class OnboardTransportCompanyDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  contactEmail!: string;

  @IsString()
  contactPhone!: string;

  /**
   * Validated as an ObjectId here and verified to EXIST and to be of type
   * `FUEL` in the handler, before any write. A merely well-formed id satisfies
   * this requirement's letter and none of its purpose.
   */
  @IsMongoId()
  parentFuelCompanyId!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(2)
  adminFullName!: string;

  // spec 015 R5 — an administrator's phone is a login identifier; it must be a
  // real E.164 number.
  @Matches(E164_PATTERN, { message: 'adminPhone must be a valid E.164 number' })
  adminPhone!: string;

  @IsString()
  @MinLength(8)
  adminPassword!: string;
}
