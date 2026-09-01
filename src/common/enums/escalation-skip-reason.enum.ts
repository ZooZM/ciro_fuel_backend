// spec 010 FR-015/edge case ("the SMS provider itself fails to deliver..."):
// why an assignment's escalation window elapsed with no SMS successfully
// sent — an enum, not a bare string, so a third reason can be added later
// without changing the shape of `Order.assignmentEscalationSkippedReason`.
export enum EscalationSkipReason {
  // The driver has no valid phone number on file — never attempted.
  NO_PHONE = 'NO_PHONE',
  // A phone was on file and the send was attempted, but the SMS provider
  // itself failed the request — distinct from NO_PHONE, since the platform
  // did try. `SmsSender` implementations MUST throw on failure (never
  // swallow it), which is what this reason is caught from.
  SEND_FAILED = 'SEND_FAILED',
}
