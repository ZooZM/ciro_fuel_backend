// spec 011 FR-008c: how a stop came to exist. Two values, not a boolean,
// because the transport admin must be able to tell an *incident* (the
// platform noticed a truck had stalled and had to ask) from an *expected*
// stop (the driver said so before anyone asked) — they warrant different
// presentation, and collapsing them would style a prayer break as an alarm.
export enum StopOrigin {
  DETECTED = 'DETECTED',
  DECLARED = 'DECLARED',
}
