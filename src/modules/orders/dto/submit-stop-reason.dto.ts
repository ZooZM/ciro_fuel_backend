import { IsEnum, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { StopReason } from '../../../common/enums/stop-reason.enum';

/**
 * spec 011 FR-005/FR-006: the driver's answer to a detected stop.
 *
 * `reasonText` is required **only** for `OTHER` — that asymmetry is the whole
 * point of the fixed list. A driver at the roadside answers TRAFFIC in one
 * tap and types nothing (SC-003); making the text mandatory across the board
 * would put a keyboard between a stopped driver and the answer this feature
 * needs from them, which is exactly what the fixed vocabulary exists to
 * avoid. Enforced here rather than in the controller so the refusal is a
 * plain 400 from the same validation pipe as every other malformed body.
 */
export class SubmitStopReasonDto {
  @IsEnum(StopReason)
  reason!: StopReason;

  @ValidateIf((o: SubmitStopReasonDto) => o.reason === StopReason.OTHER)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reasonText?: string;
}
