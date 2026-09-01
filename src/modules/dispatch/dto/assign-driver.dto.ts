import { IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * spec 008 FR-009: assignment is now driver -> truck -> tank, sequential
 * (research R3/R4) — `truckId` and `tankId` are required alongside
 * `driverId`, replacing the driver-only pick spec 004 introduced.
 */
export class AssignDriverDto {
  @IsMongoId()
  driverId!: string;

  @IsMongoId()
  truckId!: string;

  @IsMongoId()
  tankId!: string;

  // spec 010 FR-008: required only when `driverId` resolves to a BUSY or
  // OFFLINE driver at assignment time — enforced in the service, not here,
  // since eligibility is server-side data this DTO cannot see.
  @IsOptional()
  @IsString()
  @MinLength(1)
  reason?: string;
}
