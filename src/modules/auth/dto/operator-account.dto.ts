/**
 * spec 017 (operator dashboard) T122/§7 of contracts/rest-api-delta.md — the
 * operator's own identity, session count and last sign-in.
 *
 * Deliberately separate from `GET /auth/me`, which every role reads and which
 * must stay unchanged (FR-075). This is the profile screen's payload: the real
 * sign-in number rather than the mask the mock rendered, and two facts the
 * platform genuinely records.
 *
 * **Carries no permission list and no account statistic** (FR-063). The
 * platform has no permission model beyond `UserRole` and records no per-account
 * statistic, so both are ABSENT rather than fabricated or zeroed — and the
 * dashboard deletes the cards that rendered them rather than leaving them
 * empty, because an empty card reads as "loading" or "none yet" when the truth
 * is "this does not exist".
 */
export interface OperatorAccountDto {
  fullName: string;
  email: string;
  /** FR-057 — the real sign-in identifier, never masked by the platform. */
  phone: string;
  /** FR-059 — how many devices currently hold a session. */
  activeSessionCount: number;
  /**
   * FR-058 — the newest `SIGNED_IN` audit event. `null` means genuinely never
   * signed in, which is distinct from "not recorded".
   */
  lastSignInAt: string | null;
}
