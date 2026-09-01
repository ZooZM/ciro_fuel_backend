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
}
