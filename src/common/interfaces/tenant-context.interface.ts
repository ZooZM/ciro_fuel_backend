import { UserRole } from '../enums/user-role.enum';

/**
 * The authenticated actor for the current request, socket event or job.
 *
 * `userId` and `role` are required HERE because every caller of
 * `TenantContextService.run()` is establishing a genuine actor. The stored
 * shape is wider — see `RequestScope` below, which is what the scoping
 * plugins actually read.
 */
export interface TenantContext {
  userId: string;
  role: UserRole;
  companyId?: string;
  /** Set only when `companyId` names a TRANSPORT company (spec 004) — the
   * Fuel Company that owns it. Read by the multi-party scoping plugin so a
   * TRANSPORT_COMPANY_ADMIN or DRIVER's queries still carry `fuelCompanyId`. */
  parentFuelCompanyId?: string;
}

/**
 * What is actually held in the AsyncLocalStorage store (spec 012, FR-029/FR-030).
 *
 * A `TenantContext` plus a correlation id, and — crucially — **either half may
 * be absent independently**:
 *
 *  · A public route (login, refresh, the payment webhook) has a correlation id
 *    and NO actor. Before spec 012 nothing was stored at all on those routes;
 *    now a store exists so the request's records can be correlated, which is
 *    why both scoping plugins bypass on a missing `role` rather than on a
 *    missing store. Getting that wrong throws
 *    "authenticated non-SUPER_ADMIN context is missing companyId" on every
 *    login attempt.
 *
 *  · A script or seed has neither.
 *
 * The correlation id lives in THIS store rather than a second
 * `AsyncLocalStorage` (research R6). Two request-scoped stores can disagree:
 * a job that establishes one but not the other produces a record with a tenant
 * and no correlation, which is invisible until someone tries to reconstruct an
 * order's history and finds a gap where the background work should be.
 */
export type RequestScope = Partial<TenantContext> & {
  correlationId?: string;
};
