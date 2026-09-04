import { UserRole } from '../enums/user-role.enum';

export interface JwtPayload {
  sub: string;
  role: UserRole;
  companyId?: string;
  /** The `sessionGeneration` in force when this pair was issued (spec 006
   * FR-027/029/035b/042). Optional so tokens minted before this feature
   * stay valid — both sides normalize an absent value to 0 (research R1).
   * Carried on both the access and the refresh token; a revoked session
   * must not be renewable by its own refresh token. */
  sgen?: number;
  /** spec 015 (dashboard auth) — the `ActiveSession` this token pair was
   * minted for. Present for admin roles (SUPER_ADMIN, FUEL_COMPANY_ADMIN,
   * TRANSPORT_COMPANY_ADMIN); ABSENT for DRIVER and CLIENT, whose sessions
   * stay single and counter-based (research R1). Optional in the type but
   * required IN EFFECT for administrators: an admin payload with no `sid` is
   * refused, since accepting it would be a permanent bypass of the session
   * cap. Carried on BOTH tokens for the same reason `sgen` is — a closed
   * session must not be renewable by its own refresh token (FR-039). Never
   * generated inside `issueTokenPair`; always passed in, so refresh reissues
   * for the SAME session rather than opening a new one. */
  sid?: string;
}

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  companyId?: string;
  /** Set only when `companyId` names a TRANSPORT company (spec 004) — the
   * Fuel Company that owns it, resolved per-request, never persisted in the
   * JWT itself (see `UsersService.validateActiveSessionWithScoping`). */
  parentFuelCompanyId?: string;
  /** feature 013 US2 (research R2): the `sessionGeneration` this connection
   * claimed **at handshake**, stamped from the verified token and never
   * re-read from the account. Absent normalises to `0` so a token minted
   * before spec 006 stays valid — dropping that would make every legacy
   * token a permanent mismatch, and the failure would look exactly like the
   * enforcement working. Only the socket path stamps this today
   * (`authenticateSocket`); the REST path re-checks `sgen` on every request
   * inside `validateActiveSessionWithScoping` already. */
  sgen?: number;
  /** spec 015 (dashboard auth) — the admin session id this connection
   * presented, stamped from the VERIFIED token by `JwtStrategy.validate` and
   * `authenticateSocket`, never re-read from the account (same discipline as
   * `sgen`: sourcing both sides of a comparison from the account compares a
   * value to itself). Present only for admin roles. `AuthController.logout`
   * is the ONE handler permitted to read it — it needs to name the single
   * session it is closing (FR-035). That is a review rule, not a type rule. */
  sid?: string;
}
