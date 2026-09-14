import { OrderStatus } from '../enums/order-status.enum';

/**
 * spec 017 (operator dashboard) T053/FR-020 — the stages a delivery can be
 * force-completed from.
 *
 * Unchanged from what the platform already permitted; it was three inline
 * literal comparisons and a fourth statement of the same list in the refusal
 * message, so the message could drift from the check without anything failing
 * (Constitution I, research R7). The refusal now names this constant, which is
 * the only way the stated set and the enforced set stay the same set.
 *
 * The boundary is deliberate: force-completing means "this fuel reached the
 * customer and the platform's record is behind". That can only be true once
 * the truck is loaded and moving — before `LOADING` there is nothing to have
 * delivered.
 */
export const FORCE_COMPLETABLE_STATUSES: readonly OrderStatus[] = [
  // spec 008 FR-046e: LOADING has its own force-complete edge, mirroring
  // IN_TRANSIT's — a delivery stuck at the depot (e.g. a failed loading
  // confirmation) can still be short-circuited.
  OrderStatus.LOADING,
  OrderStatus.IN_TRANSIT,
  OrderStatus.UNLOADING,
] as const;

export function isForceCompletable(status: OrderStatus): boolean {
  return FORCE_COMPLETABLE_STATUSES.includes(status);
}
