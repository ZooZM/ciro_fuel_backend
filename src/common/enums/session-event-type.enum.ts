/**
 * The kind of session-lifecycle event recorded by `SessionAuditService`
 * (spec 006 FR-043–046). Deliberately narrow: this is an audit trail of
 * *sessions*, not a request log — see FR-046, which forbids per-request
 * entries.
 */
export enum SessionEventType {
  SIGNED_IN = 'SIGNED_IN',
  SIGNED_OUT = 'SIGNED_OUT',
  // Any session end that was not the driver's own sign-out — displacement
  // by a sign-in elsewhere, a password reset, or a deactivation. The
  // specific cause is carried separately, in `SessionRevocationCause`.
  REVOKED = 'REVOKED',
  // Written only when the phone number resolves to an account (FR-021 —
  // an unregistered number gets the identical response with no audit row,
  // since there is no account for the row to belong to).
  RECOVERY_REQUESTED = 'RECOVERY_REQUESTED',
  RECOVERY_VERIFY_FAILED = 'RECOVERY_VERIFY_FAILED',
  // spec 015 (dashboard auth) FR-031 — mirrors the RECOVERY_* pair for the
  // passwordless code sign-in flow. Written only when the number resolves to
  // exactly one active administrator (an unregistered/driver/client number
  // gets the identical neutral response and no row). The code itself is
  // NEVER recorded on these rows.
  LOGIN_CODE_REQUESTED = 'LOGIN_CODE_REQUESTED',
  LOGIN_CODE_VERIFY_FAILED = 'LOGIN_CODE_VERIFY_FAILED',
}
