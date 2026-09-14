/**
 * spec 017 (operator dashboard) FR-040 — a driver's duty state on the
 * operator's roster.
 *
 * **Three-valued, not a boolean**, and that is the whole point. `User.isOnline`
 * defaults to `false`, so a driver who has never connected at all is
 * indistinguishable from one who has connected and gone off duty if the roster
 * reports a boolean. They are different facts: the first is "this account has
 * never been used", which is what an operator investigating a new hire needs to
 * see, and the second is "this person is not working right now".
 *
 * `UNKNOWN` is a PRESENT value on a PRESENT row. A driver who has never
 * connected must appear on the roster — the omission feature 010 found in
 * dispatch, where `$geoNear` silently dropped every driver with no recorded
 * location, is the failure this enum exists to prevent repeating.
 */
export enum DutyState {
  /** Connected and currently on duty. */
  ON_DUTY = 'ON_DUTY',
  /** Has connected before and is not on duty now. */
  OFF_DUTY = 'OFF_DUTY',
  /** Has never connected. Not an error, and never a reason to omit the row. */
  UNKNOWN = 'UNKNOWN',
}
