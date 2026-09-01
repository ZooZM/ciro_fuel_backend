# Research: NFC Truck Verification & Warehouse Loading

**Feature**: 008-nfc-truck-loading | **Date**: 2026-08-24 | **Phase**: 0

Thirteen decisions. Each records what was chosen, why, and what was rejected. Where an existing
mechanism already solves the problem it is reused rather than re-invented — noted explicitly, since
several of these look like new infrastructure and are not.

---

## R1 — Warehouse tenancy: an unmarked schema, guarded by role

**Decision**: `Warehouse` carries **neither** `markTenantScoped` nor `markMultiParty`. Write access
is restricted to `SUPER_ADMIN` at the controller with `@Roles`; read access is open to every
authenticated role.

**Rationale**: This is not a new shape — `Company` already has it. Its schema comment states the
precedent exactly: *"Companies are the tenant root — NOT scoped by the tenant plugin (there is
nothing 'above' a company to scope against). CIRO (SUPER_ADMIN) manages these globally."* A
warehouse is the same kind of thing: national infrastructure belonging to no tenant, which every
company must be able to read because they all load from the same physical depots (spec FR-035,
FR-035c).

Both plugins would actively break it. `markTenantScoped` injects `companyId` equality, and a
warehouse has no `companyId` — every query would match nothing. `markMultiParty` resolves a
`fuelCompanyId` and throws for a role with no scoping rule, which is worse than silently empty.

**Alternatives rejected**:
- *A third plugin for "global reference data"* — the constitution's Complexity Tracking would
  demand justification, and `Company` proves no plugin is needed. Two plugins plus a documented
  unmarked category is already the established pattern.
- *Duplicating warehouses per fuel company* — every company would hold its own copy of the same
  physical depot, and FR-035 explicitly says they belong to no company.

**Constitution note**: Principle II says isolation must be structural, not per-feature discipline.
That holds here — a warehouse carries no tenant data at all, so there is nothing to isolate. The
`@Roles(SUPER_ADMIN)` guard on writes is the enforcement point, identical to `CompaniesController`.

---

## R2 — Truck and Tank tenancy: `markTenantScoped`, no exceptions

**Decision**: Both `Truck` and `Tank` carry `markTenantScoped` with `companyId` referencing the
owning **transportation** company.

**Rationale**: They are ordinary single-tenant records with exactly one legitimate owner, which is
precisely what the original plugin is for. This delivers FR-003 and FR-048d automatically — a
cross-company read returns nothing, which the global exception filter renders as a 404 rather than
a 403 (Principle II's "without revealing whether the target record exists").

**Alternatives rejected**:
- *`markMultiParty`* — a truck has one owner. Multi-party exists for records with up to four
  legitimate viewers in three companies (orders, invoices); a truck is not that.
- *Hand-written `companyId` filters* — forbidden by Principle II.

---

## R3 — The candidate query: capability filtering leaves it entirely

**Decision**: `DispatchService.findCandidates` keeps its single `$geoNear` pass but **drops** the
`truck.maxCapacityLiters` and `truck.fuelTypes` pre-filters. It ranks drivers by proximity and
availability only. Capacity and grade are enforced later, when the operator picks a tank.

**Rationale**: This was flagged as the feature's architectural landmine — vehicles were denormalised
onto the driver record because `$near` cannot follow a `$lookup`, so separating them appeared to
break the query. Two clarification answers dissolved the problem rather than requiring a solution:

1. Capacity and permitted grades moved to **Tank** (spec FR-048a), not Truck.
2. Selection became **sequential** — driver → truck → tank (FR-009a).

Because the operator picks a driver *before* any vehicle, the driver list has no vehicle to filter
on and does not need one. What remains — role, active status, presence, availability, no active
order, plus distance — is exactly what a single `$geoNear` handles natively. The constraint that
forced denormalisation no longer applies.

**Consequence**: `User.truck` is deleted (R12), and with it the only reason drivers carried vehicle
data at all.

**Alternatives rejected**:
- *`$lookup` from driver to truck to tank* — cannot follow `$geoNear`; this is the original problem.
- *Denormalising tank capability onto the driver* — reproduces the exact coupling being removed, and
  is wrong the moment a driver takes a different tank.
- *Two-phase query (geo, then filter in application code)* — unnecessary work for a filter no longer
  required at this step.

---

## R4 — "Last operated truck": derived from order history, not stored

**Decision**: FR-009b's pre-filled suggestion is computed by querying the most recent order carrying
both this `driverId` and a `truckId`, sorted by assignment time. No `lastTruckId` field is added to
`User`.

**Rationale**: A stored field is a second source of truth that must be written on every assignment
and can drift from the orders that are the actual record. The order history already holds the answer
and is authoritative. This is one indexed lookup on a screen the operator is already waiting on, not
a hot path.

The supporting index is `{ driverId: 1, truckId: 1, createdAt: -1 }`, partial on `truckId` existing
so orders predating the feature never enter it.

FR-009d requires the suggestion to be suppressed when that truck is withdrawn or busy, so the result
is validated for availability before being offered — a stored field would need the same check anyway.

**Alternatives rejected**:
- *`lastTruckId` on `User`* — denormalisation with no read-performance justification, and exactly
  the kind of drift-prone duplication R3 is removing.
- *Suggesting the most-used truck rather than the most recent* — FR-009b says "last operated",
  and "most frequent" would surprise an operator who just moved a driver to a different vehicle.

---

## R5 — NFC on Flutter: `nfc_manager`, and why iOS makes the QR fallback load-bearing

**Decision**: Add `nfc_manager` for Android and iOS tag reading. Read only the tag's **identifier**;
never parse NDEF payloads or write to a tag.

**Rationale**: `nfc_manager` is the actively maintained mainstream package covering both platforms
and exposing raw tag identifiers, which is all FR-042 permits the app to handle.

**The platform constraint that matters**: iOS is materially weaker than Android here. Reading tag
identifiers requires the *Near Field Communication Tag Reading* capability, a paid Apple developer
account, and an entitlement plus `com.apple.developer.nfc.readersession.formats` in `Info.plist`.
iOS cannot present a background/ambient read the way Android can — every scan opens a system sheet.
And support for specific 13.56 MHz card types is narrower than Android's: MIFARE Classic in
particular is not reliably readable on iOS at all.

This is why the operator-generated QR (FR-036) is not a nicety. It is the mechanism that keeps the
feature viable on iOS and on any Android device without NFC hardware, and it was already chosen by
clarification independent of this finding. **Android is the primary NFC path; iOS may in practice
run entirely on the QR path.**

Android additionally needs `<uses-permission android:name="android.permission.NFC"/>` and a
`uses-feature` declared `required="false"`, so devices without the hardware can still install and
use the QR path.

**Alternatives rejected**:
- *`flutter_nfc_kit`* — comparable capability, smaller ecosystem; no advantage for identifier-only
  reads.
- *Writing NDEF records to cards* — the cards are pre-existing stock stuck to vehicles; the platform
  reads what is already there and stores an opaque identifier (spec assumption).
- *Requiring NFC hardware and dropping the QR path* — rejected at clarification, and R5's iOS
  findings independently confirm it would be unworkable.

---

## R6 — Two credentials, both opaque secrets resolved server-side

**Decision**: `Truck` carries two independent, nullable, uniquely-indexed credentials:

- `nfcCardUid` — the card's identifier, as captured by the desk reader.
- `qrToken` — a high-entropy random secret generated by the platform, rotatable.

The QR encodes **`qrToken` only** — never the truck's id, plate, or company. Verification submits
the presented credential plus which method produced it; the server resolves it to a truck and
compares that truck against the order's assigned truck.

**Rationale**: Encoding the truck's identifier in the QR would make the code forgeable by anyone who
learns an id — ids appear in URLs and API responses and are not secrets. A random token is
unguessable and, crucially, **rotatable**, which is exactly what FR-036f/g require: revoking a leaked
code is a token rotation, and the old code stops resolving immediately.

Keeping them independent satisfies FR-036d (generating a code must not disturb the card) and makes
FR-036e a one-line rule: replacing the card clears `qrToken`.

Resolving server-side keeps Principle II's guarantee intact — a credential that resolves to another
company's truck is refused identically to one that resolves to nothing, so probing reveals nothing.

**Alternatives rejected**:
- *QR contains the truck id* — forgeable, and unrevocable without changing the id.
- *QR contains a signed JWT* — self-contained tokens cannot be revoked before expiry, which
  directly contradicts FR-036h (no expiry) combined with FR-036f (revocable on demand).
- *One shared credential field for both methods* — FR-036c requires knowing which method was used,
  and FR-036d requires them to coexist.

---

## R7 — One verification endpoint, stage inferred from the order

**Decision**: A single `POST /orders/:id/verify-vehicle` accepting `{ credential, method }`. Which
stage it advances is derived from the order's current status, not from the request.

**Rationale**: This mirrors a decision already made and proven in this codebase — spec 007's
`DeliveryCubit.confirmHandover` chooses verify-arrival versus verify-delivery from the order's own
status rather than from which screen the driver is on, precisely so the client cannot assert a
transition. Principle I's "backend is the sole source of truth for every transition" is the same
rule.

A client-supplied stage would be a parameter the server must then distrust and re-derive anyway.

Out-of-sequence attempts (FR-025) fall out naturally: if the order's status has no verification
pending, the request is refused as a conflict.

**Alternatives rejected**:
- *Separate `/verify-departure` and `/verify-loading`* — two endpoints that must each re-derive the
  same state, and a driver's device choosing between them is the client asserting a transition.
- *A `stage` field in the body* — same objection, made explicit.

---

## R8 — `LOADING` state and its transition edges

**Decision**: Add one value to `OrderStatus`. The transition table gains:

```
ASSIGNED_TO_DRIVER → LOADING            (departure verification, or operator override)
LOADING            → IN_TRANSIT         (loading confirmed, or operator override)
LOADING            → CANCELLED          (FR-046d)
LOADING            → DELIVERED          (requiresManualOverride — force-complete, FR-046e)
```

`ASSIGNED_TO_DRIVER → IN_TRANSIT` is **removed** — it is the edge `assignDriver` currently
auto-traverses, and FR-046a forbids it.

**Rationale**: The existing table is exhaustive and every edge explicit, so adding a state is a
contained change to a structure designed for it. Placing `LOADING` between assignment and transit
gives FR-046b its meaning: `IN_TRANSIT` narrows to "loaded and travelling to the customer".

`LOADING → DELIVERED` under manual override mirrors the existing `IN_TRANSIT → DELIVERED`
force-complete edge, so an administrator retains the same emergency capability at the new stage
(FR-046e) without inventing a second override mechanism.

**Blast radius** — this is the widest change in the feature (spec FR-046c). Every exhaustive switch
over `OrderStatus` must gain a case, in three codebases:

| Surface | What must change |
|---|---|
| `order-state.service.ts` | transitions table |
| `OrderPresentation` (mobile) | `statusLabel`, `statusColor`, `flowStep`, `statusProgress`, `cardKindFor` — all exhaustive `switch`es, so a missed case is a **compile error**, not a runtime blank |
| `OrderFilter` / driver tabs | "In progress" must include `LOADING` |
| Client tracking view | new stage on the timeline |
| Notifications | stage-change copy |

Dart's exhaustive switch on a sealed enum turns most of this into compile-time failure, which is the
cheapest possible way to find them.

**Alternatives rejected**:
- *Two states (heading-to-warehouse, loading)* — rejected at clarification; doubles the edges for
  granularity nobody asked for.
- *A boolean flag alongside `IN_TRANSIT`* — rejected at clarification; makes "in transit" untrue for
  the warehouse leg, which the customer's tracking view already interprets as "on the way to you".

---

## R9 — Warehouse selection: `$near` from the station, at assignment time

**Decision**: The warehouse is resolved during `assignDriver`, inside the existing transaction, by a
`$near` query on `Warehouse` from the order's `deliveryLocation`, filtered to warehouses supplying
the order's `fuelType` and in service. The resolved `warehouseId` **and** a snapshot of its
position and address are written onto the order.

**Rationale**: FR-035d says nearest-supplying-the-grade to the customer's station; FR-035e says the
choice is frozen once recorded. Resolving at assignment — rather than lazily when the driver
departs — means FR-035f can refuse the assignment outright when no warehouse supplies the grade,
which is what the requirement asks for ("the operator MUST be told why rather than the driver being
sent nowhere").

Snapshotting position and address follows the discipline already established for `driverSummary`,
`clientSummary` and `deliveryAddressText`: the order keeps its own copy so a later edit to the
warehouse list cannot rewrite where a completed delivery loaded.

**Index**: `{ location: '2dsphere' }` on `Warehouse`, plus `{ fuelTypes: 1 }`.

**A trap avoided**: `user.schema.ts` carries an explicit warning that a second 2dsphere index on
*that* collection would make `$geoNear` ambiguous for `DispatchService`. That warning is
collection-scoped — `Warehouse` is a different collection, so its own geo index cannot interfere.
Worth stating because the warning reads as a general prohibition on adding geo indexes.

**Alternatives rejected**:
- *Nearest to the driver* — the driver's position at assignment is not where they will be when they
  depart, and FR-035d specifies the station.
- *Operator picks the warehouse* — rejected at clarification (auto-selection keeps the operator's
  job unchanged).
- *Resolving lazily at departure* — would surface FR-035f's "no warehouse" failure to the driver at
  the roadside instead of to the operator at assignment.

---

## R10 — Operator override reuses `manualOverride` / `overrideReason`

**Decision**: FR-047's override is expressed through `OrderStateService.transition`'s existing
`manualOverride: true` + `overrideReason` options, which already write a `statusHistory` entry
carrying both plus the acting actor and timestamp.

**Rationale**: This machinery exists and is already used by force-complete. It satisfies FR-047b
(reason, author, time) with no new structure, and `statusHistory` is already the audit surface an
operator reviews.

The override is recorded as a **status transition with an override flag**, and deliberately does
**not** write a `VehicleVerification` record — that is what makes FR-047c's "must not be recorded
as, or presented as, a verification" structurally true rather than a naming convention. An overridden
stage simply has no verification against it, which is exactly the distinction FR-047f and FR-047d
need to surface.

**Alternatives rejected**:
- *Writing a verification record flagged `overridden: true`* — puts an attestation in the same
  collection as proof and invites code that treats them alike.
- *A separate override audit collection* — `statusHistory` already is one.

---

## R11 — Live-camera-only: enforced by omission

**Decision**: The QR path uses the existing `mobile_scanner` `MobileScanner` widget with its live
`onDetect` callback — the same component `driver_scan_screen.dart` already uses for the customer
handover code. FR-036i/j are satisfied by **not building** any image-derived path: no
`image_picker` call, no gallery access, no file picker, no share-intent handler anywhere in the
verification flow.

**Rationale**: The requirement is an absence, and absence is enforced by not writing the code plus a
test that asserts it. `image_picker` **is** already a dependency (used for profile pictures), so this
is a real discipline rather than an impossibility — which is precisely why it needs a guarding test
rather than a comment.

`MobileScanner`'s `onDetect` only ever fires from the live camera feed; it has no image-analysis
entry point, so the widget itself cannot be fed a stored image.

**Test strategy**: a static assertion that no file under the verification flow imports
`image_picker`, mirroring how spec 007 audited the driver build for forbidden OTP endpoint calls.

**Alternatives rejected**:
- *Detecting screenshots at runtime* — unreliable, platform-specific, and trivially defeated by
  photographing another screen. R11 bounds the easy attack; it does not claim to close it, and the
  spec's assumption says so.

---

## R12 — Cutover: delete, don't migrate

**Decision**: Remove the embedded `Truck` class and the `truck` property from `User`, delete
`PATCH /users/:id/truck` and `UpdateTruckDto`, and write **no** migration. Seed fixtures and e2e
tests are updated to create `Truck`/`Tank` records instead.

**Rationale**: Clarified explicitly — the platform is pre-production with only test data, so
operational continuity is not a concern and a flag day is acceptable (FR-043, FR-043a). This removes
substantial complexity: no dual-source period, no promotion script, no compatibility branch in the
dispatch query.

`driverSummary.plateNumber`, currently read from `bookedDriver.truck!.plateNumber`, is re-sourced
from the assigned `Truck` record. The customer-facing shape does not change.

**What must be updated in lockstep**: `test/utils/fixtures.ts` (`seedTwoCompanies` creates drivers
with embedded trucks), every e2e spec that assigns a driver, and `scripts/seed-load-test.ts`.

**Alternatives rejected**:
- *Auto-promotion* — rejected at clarification; would mean writing and testing a migration for data
  that is about to be discarded.
- *Dual-source period* — two definitions of a vehicle, which FR-043 forbids outright.

---

## R13 — One truck, one tank, one order: unique partial indexes

**Decision**: `Truck` and `Tank` each carry `activeOrderId?: ObjectId` with a unique partial index,
mirroring `User.activeOrderId` exactly:

```
{ activeOrderId: 1 }, { unique: true, partialFilterExpression: { activeOrderId: { $exists: true } } }
```

Booking happens inside `assignDriver`'s existing transaction via conditional
`findOneAndUpdate({ _id, activeOrderId: { $exists: false }, ... })`, identical in shape to how the
driver is booked today.

**Rationale**: Principle V requires concurrency safety at the data layer — "conditional updates +
unique indexes, not assumed from application ordering". This is the same pattern already proven for
drivers, so FR-012, FR-048f, SC-007 and SC-024 are enforced by Mongo rather than by application
sequencing. Two simultaneous assignments race at the index and exactly one wins.

Releasing a truck and tank reuses `releaseDriverIfAssigned`'s shape, extended to all three
resources and called from the same points (delivery completion, cancellation, force-complete).

**Alternatives rejected**:
- *A boolean `isAvailable` flag* — not atomic against a concurrent read-then-write, and the
  existing driver booking already rejected this shape.
- *Application-level locking* — forbidden by Principle V.

---

## R14 — The loading read is geofenced; the departure read is not

**Decision**: A `LOADING` verification is accepted only when the assigned truck's credential is
presented from within a configurable radius (default **500 m**) of the order's own
`warehouseSummary.location`, measured against a position fix **sent with the request**. A
`DEPARTURE` verification is not geofenced at all. A loading attempt with no fix is refused without
recording anything; one outside the radius is refused *and recorded*, with the distance.

**Rationale**: The two reads present the same card on the same tractor. Departure asks "is this the
assigned truck", and once that is answered, the second read re-answers a question already settled —
FR-030 as originally written could be satisfied without the driver ever leaving the yard they
started in. What the loading stage actually needs to establish is that the driver **reached the
depot**, and the card read is the moment the platform gets to ask. Adding position to that read
turns a redundant check into the only evidence in the flow that the warehouse leg happened at all.

Departure stays ungeofenced deliberately: the truck is wherever the shift starts, and the platform
holds no expectation about that location to compare against.

The fix travels with the request rather than being read from `User.location` because the streamed
position is throttled to 50 m / 3 minutes (R4) and is staler than that whenever the driver has been
parked — precisely the situation at a depot gate. A geofence satisfied by an hour-old point proves
the phone was near the warehouse once, which is not the claim being made.

The radius is generous by design. Civilian GPS between metal tanks is poor and the recorded
warehouse point may sit at a gate rather than a pump; the geofence exists to catch a verification
from a different city, not to adjudicate metres.

**On trust**: a reported fix is a measurement, not a verdict — the platform decides against it but
cannot prove the phone was honest, the same footing `location:update` already stands on. This
raises the cost of verifying from the wrong place; it is not the last line of defence, and is not
presented as one.

**Refusal shape**: `NOT_AT_WAREHOUSE` is deliberately *not* folded into `VEHICLE_MISMATCH`, whose
one-code discipline (R6/FR-018) exists to stop a device probing which credentials exist. A location
refusal reveals no credential — only that the driver holding their own truck's card has not yet
reached a depot whose address they were handed at departure. The credential is still answered
first, so a wrong card at the right place never hints that the location half would have passed.

**Alternatives rejected**:
- *Give each warehouse its own NFC card/QR and verify that instead* — strictly stronger proof, and
  the shape the platform already has for trucks. Rejected on rollout, not on design: it needs a
  physical credential paired at every depot in the national dataset before a single delivery can
  load, and depots are not ours to fit hardware to. Worth revisiting as its own feature; the
  recorded distance on every attempt is what would make its absence measurable in the meantime.
- *Drop the second read and geofence arrival alone* — loses the vehicle re-check, and makes
  "loaded" a claim with no credential behind it whatsoever.
- *Evaluate against the driver's last streamed position* — see above; the staleness is worst exactly
  where the check matters.
- *Fall back to the streamed position when no fresh fix exists* — a silent downgrade from "is there
  now" to "was there recently", invisible in the record afterward. Refusing, with the operator
  override (R10) as the escape hatch, keeps the two apart.
- *Record `withinGeofence: true/false`* — answers the question the platform asked at the time and
  nothing else. The radius is configurable, so a stored boolean means different things across a
  change to it, and an operator reviewing an override needs to know whether the driver was at the
  fence or in another city.

---

## Cross-cutting: what is NOT being built

Recorded so planning does not drift into it:

- **Aramco invoice upload and reconciliation**, and the **client litre balance** it feeds — cut at
  clarification into their own feature. Nothing here records an actual loaded volume.
- **Tank verification** — the card is on the tractor. A swapped trailer is undetectable by the
  platform; showing the driver the tank's code and material (FR-033a) makes it visible to a person.
- **QR code generation UI** — operator-facing, belongs to the unbuilt web dashboard. The backend
  endpoint that mints and rotates a token is in scope; the screen that displays it is not.
