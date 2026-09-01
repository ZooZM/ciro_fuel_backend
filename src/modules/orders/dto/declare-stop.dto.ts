import { IsInt, Max, Min } from 'class-validator';
import { SubmitStopReasonDto } from './submit-stop-reason.dto';

/**
 * spec 011 FR-008a-d: a stop the driver announces before anyone asks —
 * a prayer break, a planned refuelling stop, a queue they can already see.
 *
 * Extends [SubmitStopReasonDto] because a declaration *is* an answer, given
 * early: it carries the same reason vocabulary and the same OTHER-requires-
 * text rule, and arrives already answered, which is precisely why it never
 * prompts and never escalates.
 *
 * The duration is what keeps that from being a loophole. Without an upper
 * bound, one declaration at the start of a delivery would silence detection
 * for the entire journey — the exact blindness this feature exists to remove,
 * self-inflicted and invisible. Capped at four hours: longer than any
 * legitimate roadside stop on this leg, short enough that a driver who wanted
 * to disappear for a shift would have to keep re-declaring, each one its own
 * recorded event on the delivery.
 */
export class DeclareStopDto extends SubmitStopReasonDto {
  @IsInt()
  @Min(1)
  @Max(240)
  expectedDurationMinutes!: number;
}
