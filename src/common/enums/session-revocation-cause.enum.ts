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
  // spec 013 (fuel company admin dashboard) FR-090/Edge Cases. Surfaced ONLY on an
  // already-established session's next `validateActiveSessionWithScoping` check
  // (`JwtStrategy.validate`, e.g. `GET /auth/me`) — deliberately NOT surfaced at
  // `AuthController.login`, which stays behind the platform's existing generic
  // `GENERIC_AUTH_ERROR` for every refusal (wrong password, deactivated account,
  // suspended company alike). Distinguishing "company suspended" from "wrong password"
  // at the raw login boundary would hand a password-guessing attacker an oracle for
  // exactly the case the platform's anti-enumeration login design exists to deny —
  // this cause is safe to reveal only to someone who already holds a live session,
  // the same precedent `ACCOUNT_DEACTIVATED` already established for this exact enum.
  COMPANY_SUSPENDED = 'COMPANY_SUSPENDED',
}
