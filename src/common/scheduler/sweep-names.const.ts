/**
 * Names of the platform's fleet-wide scheduled sweeps, used as scheduler-lease
 * keys (spec 012 FR-056b). Named constants rather than inline literals so a
 * typo cannot silently give two instances different keys — which would hand
 * both of them "the" lease and defeat the arbitration entirely (Constitution I).
 *
 * Both sweeps are FLEET-WIDE, so both take a lease keyed by sweep name. Neither
 * is per-entity work:
 *   · PRESENCE_OFFLINE  — `PresenceService.sweepOfflineDrivers`, a static @Cron
 *   · STOP_DETECTION    — `StopDetectionService.sweepStalledDeliveries`,
 *     registered at runtime via `SchedulerRegistry.addInterval` purely so
 *     STOP_DETECTION_SWEEP_SECONDS stays configurable (the e2e suite and the
 *     quickstart both lower it); that configurability must survive the lease.
 *
 * The per-order escalation timer is deliberately absent: it already runs on the
 * shared queue with a deterministic per-order job id, already distributes
 * correctly across instances, and was never a single-instance constraint.
 * Leasing it would be a regression (FR-057a).
 */
export const SWEEP_NAMES = {
  PRESENCE_OFFLINE: 'presence-offline',
  STOP_DETECTION: 'stop-detection',
} as const;

export type SweepName = (typeof SWEEP_NAMES)[keyof typeof SWEEP_NAMES];
