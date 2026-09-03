import { SubmitStopReasonDto } from './submit-stop-reason.dto';

/**
 * feature 013 US5a (contracts/rest-api-delta.md §1): the driver reports they
 * cannot reach the destination.
 *
 * Shape is identical to answering a detected stop — a `reason` from the
 * shared vocabulary, required at creation (unlike a detected stop, a blocked
 * report exists *because* the driver has something to say), and `reasonText`
 * required only when `reason` is `OTHER`. Extending [SubmitStopReasonDto]
 * rather than restating the rule so the two cannot drift.
 *
 * No `expectedDurationMinutes`: this is not a planned pause.
 */
export class ReportBlockedDto extends SubmitStopReasonDto {}
