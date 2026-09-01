import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { VerificationMethod } from '../../../common/enums/verification-method.enum';
import { GeoPointDto } from './create-order.dto';

/**
 * spec 008 (research R7): deliberately no `stage` field — which step is
 * being attempted is derived server-side from the order's own status, never
 * accepted as an assertion from the client.
 *
 * `driverLocation` is where the driver's device says it was standing when
 * the card was read (FR-030c). Optional here rather than required because
 * only ONE of the two stages needs it — the loading-stage geofence
 * (FR-030a) — and the stage is not the client's to declare; the service
 * refuses a loading attempt that arrives without it. A departure
 * verification carries it too when the device has a fix, which is simply a
 * fresher answer to what FR-024 already records.
 *
 * It is a measurement, never a verdict: the platform computes the distance
 * and decides, exactly as `location:update` already treats a driver's
 * reported position.
 */
export class VerifyVehicleDto {
  @IsString()
  @MinLength(1)
  credential!: string;

  @IsEnum(VerificationMethod)
  method!: VerificationMethod;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoPointDto)
  driverLocation?: GeoPointDto;
}
