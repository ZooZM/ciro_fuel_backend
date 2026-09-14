/**
 * spec 017 (operator dashboard) T100/FR-055 — where one announcement's fan-out
 * has got to.
 *
 * Two states, not three, and there is deliberately no `FAILED`. A fan-out that
 * skipped every recipient still COMPLETED: what happened to each individual
 * recipient is recorded per delivery, with a named reason (see
 * `AnnouncementDeliveryFailureReason`). Rolling that up into one status on the
 * parent would lose exactly the detail FR-054 requires and would make "reached
 * nobody" and "never ran" the same value.
 */
export enum AnnouncementState {
  /** Enqueued, not yet fanned out. The state a 202 response reports (FR-055). */
  QUEUED = 'QUEUED',
  /** The fan-out has run over every intended recipient. */
  COMPLETED = 'COMPLETED',
}
