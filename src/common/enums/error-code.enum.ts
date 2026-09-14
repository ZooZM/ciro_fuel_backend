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

  // spec 014 (fuel company admin dashboard — live platform integration)
  // A credit-limit-request resolution attempted after it already carries an
  // outcome (FR-031). Conditional-update discipline, same as ORDER_ALREADY_ASSIGNED
  // — the filter names the expected PENDING state, and `modifiedCount` (not a
  // prior read) decides which of two concurrent resolutions wins (SC-008).
  LIMIT_REQUEST_ALREADY_RESOLVED = 'LIMIT_REQUEST_ALREADY_RESOLVED',
  // A company's accrued commission exceeds its ceiling (FR-062d). Carries
  // `ceiling` and `accrued` as extra fields so the refusal names the number,
  // never just the fact. Resumes automatically once a CONFIRMED payment
  // brings the accrued amount back below — this code is never latched.
  COMMISSION_CEILING_EXCEEDED = 'COMMISSION_CEILING_EXCEEDED',
  // A recorded payment (`AccountMovement`, kind PAYMENT_RECORDED) carries
  // neither a `documentFileId` nor a `reference` (FR-067). Validation-shaped
  // — the request itself is incomplete, not a state conflict.
  PAYMENT_EVIDENCE_REQUIRED = 'PAYMENT_EVIDENCE_REQUIRED',
  // The operator confirms a payment that is not RECORDED — either already
  // CONFIRMED or does not exist in that state (FR-069). Conditional update
  // on `state: RECORDED`; `modifiedCount` decides, never a prior read.
  PAYMENT_ALREADY_CONFIRMED = 'PAYMENT_ALREADY_CONFIRMED',
  // An order already carries a supplier invoice (FR-073e) — `POST` refuses;
  // `PUT` is the replace path and does not throw this. Read together with
  // the partial unique index on `LitreBalance.movements.orderId`, this is
  // what makes a retried upload move a balance once, never twice.
  SUPPLIER_INVOICE_ALREADY_RECORDED = 'SUPPLIER_INVOICE_ALREADY_RECORDED',
  // A confirmed supplier-invoice fuel grade differs from the order's own
  // (FR-073g). Deliberately distinct from SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE
  // — this names a data-entry mismatch on an otherwise-eligible order.
  SUPPLIER_INVOICE_GRADE_MISMATCH = 'SUPPLIER_INVOICE_GRADE_MISMATCH',
  // A supplier invoice was uploaded or recorded against an order that is
  // CANCELLED or REJECTED (spec Edge Cases) — there is nothing left to
  // reconcile a delivered quantity against.
  SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE = 'SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE',
  // A litre-balance correction submitted with no `reason` (FR-075).
  // Validation-shaped — every correction MUST carry a reason and be
  // attributed to the administrator who made it (FR-074a).
  BALANCE_CORRECTION_REASON_REQUIRED = 'BALANCE_CORRECTION_REASON_REQUIRED',
  // A supplier-invoice excess would take a litre balance below zero
  // (FR-073d). The platform still records the movement — this code states
  // the outcome explicitly at the point of recording rather than leaving a
  // negative balance unexplained; it is advisory, not a refusal.
  LITRE_BALANCE_WOULD_GO_NEGATIVE = 'LITRE_BALANCE_WOULD_GO_NEGATIVE',
  // An exchange request's respond/withdraw was attempted after it already
  // reached a final outcome (FR-082). Conditional update on
  // `state: AWAITING_RESPONSE`; `modifiedCount` decides which of a
  // concurrent accept/withdraw wins — the same idiom as every other
  // exactly-once resolution on this platform (SC-008).
  EXCHANGE_ALREADY_RESOLVED = 'EXCHANGE_ALREADY_RESOLVED',
  // An exchange request named a fuel grade the receiving company does not
  // sell (FR-085) — refused at submission, before any party-set write.
  EXCHANGE_GRADE_NOT_SOLD = 'EXCHANGE_GRADE_NOT_SOLD',
  // The party-set plugin's create-time guard (contracts/isolation-contract.md):
  // the acting company is absent from `partyCompanyIds`, or the array does
  // not hold exactly the parties the domain defines. Distinct from every
  // other isolation refusal on this platform in one way — the existing
  // plugins FORCE a value on create and cannot fail this way; this one
  // VALIDATES membership, so a genuine refusal path exists here that has no
  // equivalent in tenant-scope or multi-party-scope.
  EXCHANGE_PARTY_INVALID = 'EXCHANGE_PARTY_INVALID',

  // spec 015 (dashboard auth & Taqnyat SMS)
  // The single refusal for the passwordless sign-in code — wrong, expired,
  // superseded and attempt-locked-out alike (FR-017). Mirrors
  // RESET_CODE_INVALID's discipline exactly: distinguishing the four states
  // would tell an attacker which wall they hit. No attempt count in the body.
  LOGIN_CODE_INVALID = 'LOGIN_CODE_INVALID',
  // 429, carries `retryAfterSeconds` (FR-022). Used for BOTH the per-phone
  // request-rate refusal AND the cross-code temporary block (FR-025) —
  // deliberately indistinguishable, so a caller cannot tell which wall they
  // hit, the same reasoning LOGIN_CODE_INVALID applies to its four states.
  LOGIN_RATE_LIMITED = 'LOGIN_RATE_LIMITED',
  // 400, carries `{ seed, difficultyBits }` (FR-023). Demanded only after
  // `loginOtp.challengeAfter` rate-limited requests for a number; a missing,
  // invalid, expired or replayed response is refused with this same code and
  // a FRESH seed.
  CHALLENGE_REQUIRED = 'CHALLENGE_REQUIRED',
  // 404, and ONLY when `loginOtp.revealUnknownPhone` is explicitly enabled.
  // It states outright that a number belongs to no administrator, which is
  // precisely what FR-015's constant 202 exists to withhold: with this on, the
  // endpoint is an oracle for "is this mobile number a platform administrator",
  // the targeting step before SIM-swap or phishing. Off by default, and off is
  // the only setting under which FR-015 holds.
  PHONE_NOT_REGISTERED = 'PHONE_NOT_REGISTERED',

  // ── delivery pricing moved to the party that performs the haul ────────────
  // 409. A transporter serves the client's region but has priced no area
  // covering it, so there is no transport price to quote. Deliberately NOT
  // satisfied by falling back to the fuel company's own `pricingConfig.deliveryFee`:
  // that figure is what the fuel company used to charge, and quoting it while a
  // transporter is the one who will haul (and bill) would put a number in front of
  // the client that nobody stands behind.
  TRANSPORT_PRICE_NOT_SET = 'TRANSPORT_PRICE_NOT_SET',
  // 409. MORE THAN ONE transporter serves the region and their rates for this area
  // disagree. Which one hauls is the fuel company's choice at routing (FR-014) —
  // made AFTER the invoice is issued — so at quote time the price is genuinely
  // undetermined. Picking the cheapest would quote a client a price the actual
  // hauler never agreed to; picking the dearest would overcharge. The platform
  // refuses, exactly as PRICING_NOT_CONFIGURED refuses rather than assuming zeros.
  // Note this fires only when the resulting FEES differ: several transporters that
  // agree on the price present no ambiguity and are quoted normally.
  TRANSPORT_PRICE_AMBIGUOUS = 'TRANSPORT_PRICE_AMBIGUOUS',

  // spec 016 (broadcast fuel exchange offers)
  // No fuel company on the platform (other than the raiser) sells the named
  // grade (FR-005). Refused at raise time, before any offer is created —
  // there would be no one for it to ever reach.
  EXCHANGE_NO_ELIGIBLE_COMPANY = 'EXCHANGE_NO_ELIGIBLE_COMPANY',
  // This company already proposed or declined this offer (FR-011c) — the
  // response to both a genuine second answer and a duplicate submission,
  // translated from the unique `(offerId, proposingCompanyId)` index
  // violation, never from a prior existence check two concurrent
  // submissions could both pass identically.
  EXCHANGE_ALREADY_ANSWERED = 'EXCHANGE_ALREADY_ANSWERED',
  // Proposing on an offer that is not OPEN — already awarded, withdrawn, or
  // its raising company is suspended (FR-010, research R13). Award and
  // withdraw reuse the platform's existing EXCHANGE_ALREADY_RESOLVED for the
  // same shape of refusal (contracts/rest-api-delta.md).
  EXCHANGE_OFFER_NOT_OPEN = 'EXCHANGE_OFFER_NOT_OPEN',
  // 400. `deliveryAt` was already in the past at raise time (spec Assumptions:
  // the rule binds CREATION only — a date passing later makes an existing offer
  // stale, never invalid, which is why this is not a DTO constraint). Carries a
  // code rather than the bare string it threw before so a client can state the
  // refusal in the operator's own language: every other refusal on this endpoint
  // is code-addressable, and a lone untranslatable message is the one a dashboard
  // has no choice but to show in English or bury under a generic error.
  EXCHANGE_DELIVERY_IN_PAST = 'EXCHANGE_DELIVERY_IN_PAST',

  // spec 017 (operator dashboard)
  // 409. The payout amount exceeds what the platform currently owes this fuel
  // company (FR-068). The comparison is made against the owed balance re-read
  // INSIDE the recording transaction (FR-069), never against the figure the
  // operator's screen was showing — an accrual can land between the two.
  CASHBACK_PAYOUT_EXCEEDS_BALANCE = 'CASHBACK_PAYOUT_EXCEEDS_BALANCE',
  // 409. A payout with this reference is already recorded for this company
  // (FR-070). Translated from the partial unique `(companyId, kind,
  // reference)` index violation, never from a prior existence check two
  // concurrent submissions could both pass identically.
  CASHBACK_PAYOUT_DUPLICATE_REFERENCE = 'CASHBACK_PAYOUT_DUPLICATE_REFERENCE',
  // 400. `status` and `bucket` were both supplied and the status is not a
  // member of that bucket. A contradictory pair must refuse: returning a
  // silently empty page would read as "there are no such orders" when the
  // truth is "that combination cannot exist".
  ORDER_BUCKET_STATUS_CONFLICT = 'ORDER_BUCKET_STATUS_CONFLICT',
  // 400. `parentFuelCompanyId` is absent, malformed, names no company, or
  // names a company that is not of type FUEL (FR-030). A merely-present id
  // satisfies the requirement's letter and none of its purpose — a transport
  // company parented to another transport company is unroutable.
  INVALID_PARENT_FUEL_COMPANY = 'INVALID_PARENT_FUEL_COMPANY',

  // 409. The station owner tried to accept a total on an order that is not
  // waiting for it — either it is not at PENDING_PAYMENT at all, or it is a
  // DIRECT order, which is confirmed by paying rather than by accepting.
  ORDER_NOT_AWAITING_CONFIRMATION = 'ORDER_NOT_AWAITING_CONFIRMATION',
}
