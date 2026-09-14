import { DutyState } from '../../../common/enums/duty-state.enum';

/**
 * spec 017 (operator dashboard) T082/§5 of contracts/rest-api-delta.md — one
 * row of the platform's driver roster.
 *
 * **This interface IS the privacy boundary** (FR-043, FR-044, SC-014). The
 * roster answers "who is this driver and who employs them" and nothing else.
 * It carries no `location`, `driverLocation`, `lastSeenAt`, `lastMovedAt`,
 * `lastMovedLocation`, `activeOrderId`, `stopEvents`, `deliveredAt`, `orderId`
 * or trip count of any kind, and SC-014 is asserted against the SERIALIZED
 * response body rather than against what a screen renders — a field this
 * platform sends is disclosed whether or not today's dashboard draws it.
 *
 * Feature 011 drew the same line and drew it in the data model rather than in
 * discipline: stop events are embedded on `Order` precisely so a per-driver
 * stop history cannot be queried. The equivalent here is the shape of this
 * type and the single-field projection that fills `lastOperatedTruck`.
 */
export interface DriverRosterRowDto {
  driverId: string;
  fullName: string;
  phone: string;
  isActive: boolean;
  /** Three-valued — see {@link DutyState}. Never omitted, never inferred from a boolean. */
  dutyState: DutyState;
  /**
   * The employing transport company. Resolved with ONE batched lookup for the
   * whole page, never a query per row.
   */
  transportCompany: { id: string; name: string } | null;
  /**
   * The truck this driver most recently operated, derived from order history.
   *
   * `null` means **never driven** (FR-039b) — a real, distinct fact the screen
   * renders as "never driven" rather than as blank. It does NOT mean "could not
   * resolve": an unresolvable truck identity is a `500`, not a `null`.
   *
   * Carries the truck's identity and plate and NOTHING about the orders it was
   * derived from — not their number, dates, customers or routes (FR-044a). The
   * aggregate behind it projects `truckId` alone, which is what makes that
   * enforceable by shape rather than by discipline.
   */
  lastOperatedTruck: { id: string; plateNumber: string } | null;
}
