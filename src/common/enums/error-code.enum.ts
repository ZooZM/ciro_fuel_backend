/**
 * Application-specific error codes for feature 005, carried in the uniform
 * error envelope's `error` field (see `HttpExceptionFilter`) so the mobile
 * app can distinguish cases that share an HTTP status — e.g. `QUOTE_STALE`
 * vs `CREDIT_LIMIT_EXCEEDED`, both 409 — without matching on message text.
 *
 * Thrown as `throw new ConflictException({ error: ErrorCode.QUOTE_STALE, message, ...extra })`;
 * the filter reads `body.error` when present instead of defaulting to the
 * exception's class name.
 */
export enum ErrorCode {
  PRICING_NOT_CONFIGURED = 'PRICING_NOT_CONFIGURED',
  QUOTE_STALE = 'QUOTE_STALE',
  QUOTE_EXPIRED = 'QUOTE_EXPIRED',
  PHONE_IN_USE = 'PHONE_IN_USE',
  SMS_SEND_FAILED = 'SMS_SEND_FAILED',
  LAST_STATION = 'LAST_STATION',
  // spec 006 (driver auth & session)
  // One code for wrong/expired/superseded/attempt-locked-out alike —
  // distinguishing them would tell an attacker which wall they hit and
  // confirm the account exists (FR-024).
  RESET_CODE_INVALID = 'RESET_CODE_INVALID',
  // Carries `retryAfterSeconds` so the app can state the wait (FR-025).
  RESET_RATE_LIMITED = 'RESET_RATE_LIMITED',
  // Carries `cause` (a SessionRevocationCause) so the app can state which
  // of the three applies rather than a generic expiry message (FR-036).
  SESSION_REVOKED = 'SESSION_REVOKED',
  // spec 007 (driver home & active delivery)
  // A rating was submitted for an order that has not reached DELIVERED yet.
  ORDER_NOT_DELIVERED = 'ORDER_NOT_DELIVERED',
  // A rating already exists for this order — enforced by a unique index on
  // orderId (FR-039), so this is thrown by catching the duplicate-key error,
  // never by a prior existence check that could race.
  ALREADY_RATED = 'ALREADY_RATED',

  // spec 008 (NFC truck verification & warehouse loading)
  // A verification's credential resolved to a different truck than the one
  // assigned, or to no truck at all. Deliberately one code for both cases —
  // distinguishing "wrong truck" from "unknown credential" would let a
  // driver's device probe which cards exist (FR-018, Principle II).
  VEHICLE_MISMATCH = 'VEHICLE_MISMATCH',
  // Loading (or a later step) was attempted before the required
  // verification succeeded (FR-031).
  VEHICLE_NOT_VERIFIED = 'VEHICLE_NOT_VERIFIED',
  // The loading-stage verification presented the RIGHT truck, from outside
  // the assigned warehouse's geofence (FR-030a). Deliberately distinct from
  // VEHICLE_MISMATCH: it reveals nothing about which credentials exist —
  // only that this driver, holding their own assigned truck's card, is not
  // yet at a depot whose address they were already shown — and collapsing
  // the two would tell a driver standing at the wrong gate to go looking
  // for a different card.
  NOT_AT_WAREHOUSE = 'NOT_AT_WAREHOUSE',
  // A loading-stage verification arrived with no position fix (FR-030c).
  // Nothing is evaluated and nothing is recorded — the request cannot be
  // judged at all, the same footing as an out-of-sequence attempt.
  LOCATION_REQUIRED = 'LOCATION_REQUIRED',
  // The requested truck is withdrawn or already committed to another
  // in-progress delivery (FR-012, FR-007).
  TRUCK_UNAVAILABLE = 'TRUCK_UNAVAILABLE',
  // As TRUCK_UNAVAILABLE, for a tank (FR-048f, FR-048e).
  TANK_UNAVAILABLE = 'TANK_UNAVAILABLE',
  // The order's quantity exceeds the tank's maxCapacityLiters (FR-010).
  TANK_CAPACITY_EXCEEDED = 'TANK_CAPACITY_EXCEEDED',
  // The tank's fuelTypes does not include the order's grade (FR-011).
  TANK_GRADE_UNSUPPORTED = 'TANK_GRADE_UNSUPPORTED',
  // An NFC card identifier is already paired to a different truck (FR-005)
  // — thrown by catching the duplicate-key violation, never by a prior
  // existence check two concurrent pairings could both pass.
  CARD_ALREADY_PAIRED = 'CARD_ALREADY_PAIRED',
  // A tank code is already in use platform-wide (FR-048b) — same
  // duplicate-key discipline as CARD_ALREADY_PAIRED.
  TANK_CODE_IN_USE = 'TANK_CODE_IN_USE',
  // A truck's plate number is already in use within the same company.
  DUPLICATE_PLATE = 'DUPLICATE_PLATE',
  // No in-service warehouse supplies the order's fuel grade (FR-035f).
  NO_WAREHOUSE_FOR_GRADE = 'NO_WAREHOUSE_FOR_GRADE',
  // A vehicle reassignment (FR-015) was attempted after the order already
  // departed — reassignment is only permitted before departure.
  ALREADY_DEPARTED = 'ALREADY_DEPARTED',

  // spec 009 (transport dashboard order lifecycle)
  // Two concurrent `assign` calls on the SAME order, each naming a
  // different (individually available) driver/truck/tank — the order's own
  // status guard admits both until the unique `activeOrderId` index on the
  // losing driver's write collides at commit (FR-008, SC-008). Caught as a
  // duplicate-key error, same discipline as CARD_ALREADY_PAIRED/ALREADY_RATED,
  // never guarded by a prior read that two concurrent transactions could
  // both pass identically.
  ORDER_ALREADY_ASSIGNED = 'ORDER_ALREADY_ASSIGNED',

  // spec 010 (driver availability & assignment escalation)
  // Assigning a driver who is currently OFFLINE (`DriverEligibility`) without
  // the required `reason` (FR-008). A validation-shaped 400 — the request
  // itself is malformed, not a state conflict — never a 409. A BUSY driver
  // is refused outright regardless of reason (FR-007 correction) — this
  // code names only the offline case, the one reason actually unblocks.
  ASSIGNMENT_REASON_REQUIRED = 'ASSIGNMENT_REASON_REQUIRED',

  // spec 011 (in-transit stop detection)
  // A delivery may carry at most one unresolved stop at a time (FR-016), so
  // declaring a stop while one is already open is refused — the driver should
  // answer the open one rather than declaring over it. Like every other
  // one-at-a-time guarantee on this platform, enforced by a conditional write
  // rather than a prior read.
  STOP_ALREADY_OPEN = 'STOP_ALREADY_OPEN',

  // A second reason submitted for a stop that already carries one. Narrow by
  // design: this names a genuine duplicate submission ONLY. An answer arriving
  // after the response window has already escalated is NOT this — FR-010 makes
  // a late answer an ordinary resolution, and coding it as a conflict is the
  // single most likely reflex mistake in this feature.
  STOP_ALREADY_ANSWERED = 'STOP_ALREADY_ANSWERED',

  // Declaring a stop outside IN_TRANSIT (FR-002). A truck parked at the
  // warehouse or at the customer's gate is where it is supposed to be —
  // there is no journey to interrupt, so there is nothing to declare.
  STOP_NOT_IN_TRANSIT = 'STOP_NOT_IN_TRANSIT',

  // An administrator marking a stop handled that is already resolved —
  // typically a second click, or two administrators on the same alert.
  STOP_ALREADY_RESOLVED = 'STOP_ALREADY_RESOLVED',
}
