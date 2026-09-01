/**
 * Why a session ended other than the driver's own sign-out (spec 006
 * FR-036, FR-042). Carried on a `SessionEvent{ type: REVOKED }` row and on
 * the `session:revoked` socket push, so the app can state the specific
 * reason rather than a generic "session expired" message. The app maps
 * this to a localized string and MUST NOT match on message text
 * (Principle I/III).
 */
export enum SessionRevocationCause {
  SIGNED_IN_ELSEWHERE = 'SIGNED_IN_ELSEWHERE',
  PASSWORD_RESET = 'PASSWORD_RESET',
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
}
