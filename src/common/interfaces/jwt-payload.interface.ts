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
}
