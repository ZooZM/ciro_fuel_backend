// spec 011 FR-008c: how a stop came to exist. Two values, not a boolean,
// because the transport admin must be able to tell an *incident* (the
// platform noticed a truck had stalled and had to ask) from an *expected*
// stop (the driver said so before anyone asked) — they warrant different
// presentation, and collapsing them would style a prayer break as an alarm.
export enum StopOrigin {
  DETECTED = 'DETECTED',
  DECLARED = 'DECLARED',
  // feature 013 US5a: the driver reported they cannot reach the destination
  // and is asking for help. Unlike DECLARED — which is written already
  // resolved and suppresses detection for a driver-stated duration — a
  // BLOCKED stop is written UNRESOLVED, carries NO `suppressedUntil` (a
  // request for help must not silence detection, FR-039b), stamps
  // `escalatedAt` at creation, and notifies the transporter in the same
  // operation (FR-039a). It cannot be filed as a declaration: that would
  // tell nobody and switch detection off (research R5).
  BLOCKED = 'BLOCKED',
}
