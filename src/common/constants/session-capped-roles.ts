import { UserRole } from '../enums/user-role.enum';

/**
 * spec 015 (dashboard auth) — the roles that hold multiple concurrent,
 * independently-revocable sessions bounded by `auth.maxAdminSessions`
 * (research R1). Every place the session model splits by role — the `sid`
 * membership check in `validateActiveSessionWithScoping`, the role branch in
 * `AuthService.login`/`logout`/`refresh`, whether a token carries `sid` —
 * keys on THIS constant, never an inline role array (Constitution I). A role
 * added to the platform later must fail loudly at every check site (it will
 * be absent here and fall into the DRIVER/CLIENT single-session path) rather
 * than silently acquiring or skipping the cap.
 *
 * DRIVER and CLIENT are deliberately absent: their sessions stay single and
 * `sessionGeneration`-based, bit-for-bit unchanged (FR-033, SC-013, SC-020).
 */
export const SESSION_CAPPED_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.FUEL_COMPANY_ADMIN,
  UserRole.TRANSPORT_COMPANY_ADMIN,
] as const;

export function isSessionCappedRole(role: UserRole): boolean {
  return SESSION_CAPPED_ROLES.includes(role);
}
