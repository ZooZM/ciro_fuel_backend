# Data Model: NFC Truck Verification & Warehouse Loading

**Feature**: 008-nfc-truck-loading | **Date**: 2026-08-24 | **Phase**: 1

Three new collections, one new embedded record, one deletion, and additions to `Order`. Every
addition is absent-safe; the one deletion is deliberate and covered by the pre-production cutover
(research R12).

---

## New: `Truck`

The tractor. Single-tenant, owned by a transportation company — `markTenantScoped` (R2).

| Field | Type | Rules |
|---|---|---|
| `companyId` | ObjectId → Company | Required, immutable. Injected by the tenant plugin; always a TRANSPORT company. |
| `plateNumber` | string | Required, trimmed. Unique **within a company**, not globally — two transporters may legitimately hold similar plates. |
| `model` | string | Optional. |
| `nfcCardUid` | string | Optional, **globally unique** when present. The card identifier as captured by the desk reader; an opaque string compared for equality only. |
| `qrToken` | string | Optional, **globally unique** when present. Platform-generated high-entropy secret; rotatable. Never derived from `_id`. |
| `isActive` | boolean | Default `true`. `false` = withdrawn from service (FR-007). |
| `activeOrderId` | ObjectId → Order | Optional. Present ⇒ committed to that delivery (R13). |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps. |

**Indexes**
- `{ companyId: 1, plateNumber: 1 }` — unique. Per-company plate uniqueness.
- `{ nfcCardUid: 1 }` — unique, partial on existing. **FR-005's enforcement point**: a card cannot pair to two trucks.
- `{ qrToken: 1 }` — unique, partial on existing. Also the credential-resolution lookup.
- `{ activeOrderId: 1 }` — unique, partial on existing. **FR-012's enforcement point** (R13).
- `{ companyId: 1, isActive: 1, activeOrderId: 1 }` — the operator's "available trucks" list.

**Why globally unique rather than per-company for credentials**: a driver presents a credential
without stating which company owns it. Resolution must be unambiguous platform-wide, or the same
card could resolve to two trucks in different companies. Cross-company resolution is then refused
by the ownership check, revealing nothing (R6).

---

## New: `Tank`

The trailer. Single-tenant, `markTenantScoped` (R2). Holds everything about *carrying capability*.

| Field | Type | Rules |
|---|---|---|
| `companyId` | ObjectId → Company | Required, immutable. Plugin-injected. |
| `code` | string | Required, trimmed, **globally unique** (FR-048b). |
| `material` | `TankMaterial` | Required enum — `IRON` \| `ALUMINIUM`. Recorded fact only; does **not** derive permitted grades (FR-048g). |
| `maxCapacityLiters` | number | Required, min 1. **The capacity guard validates this** (FR-010). |
| `fuelTypes` | `FuelType[]` | Required, non-empty. **The grade guard validates this** (FR-011). |
| `isActive` | boolean | Default `true`. |
| `activeOrderId` | ObjectId → Order | Optional. Present ⇒ committed (FR-048f). |
| `createdAt` / `updatedAt` | Date | Timestamps. |

**Indexes**
- `{ code: 1 }` — unique. FR-048b.
- `{ activeOrderId: 1 }` — unique, partial on existing. SC-024.
- `{ companyId: 1, isActive: 1, activeOrderId: 1, maxCapacityLiters: 1, fuelTypes: 1 }` — serves the offered-tank list, which FR-016a requires to pre-exclude tanks the platform would refuse.

**Note on `code` being globally unique**: unlike a plate, a tank code is stated by the operator as a
fleet-wide identifier and appears on the driver's screen (FR-033a). Global uniqueness means a code
shown to a driver is unambiguous. It does leak existence across tenants on collision — mitigated by
returning a generic `TANK_CODE_IN_USE` that does not say which company holds it.

---

## New: `Warehouse`

Platform infrastructure. **Neither scoping marker** — follows `Company`'s precedent (R1).

| Field | Type | Rules |
|---|---|---|
| `name` | string | Required, trimmed. |
| `location` | GeoPoint | Required. Reuses the shared `GeoPointSchema`. |
| `addressText` | string | Required, trimmed. Human-readable (FR-035b). |
| `region` | `RegionCode` | Required. Matches the platform's existing region taxonomy. |
| `governorate` | `GovernorateCode` | Required. |
| `fuelTypes` | `FuelType[]` | Required, non-empty. Grades this depot supplies (FR-035b). |
| `isActive` | boolean | Default `true`. Withdrawal affects only unstarted deliveries (FR-035e edge case). |
| `externalRef` | string | Optional, unique when present. The operator's own identifier from the national dataset, so a bulk re-load is idempotent rather than duplicating. |
| `createdAt` / `updatedAt` | Date | Timestamps. |

**Indexes**
- `{ location: '2dsphere' }` — FR-035d's nearest-supplying query. **Safe**: the "second 2dsphere index" warning in `user.schema.ts` is scoped to *that* collection; a different collection cannot make `DispatchService`'s `$geoNear` ambiguous (R9).
- `{ fuelTypes: 1, isActive: 1 }` — the grade filter applied alongside `$near`.
- `{ externalRef: 1 }` — unique, partial on existing. Idempotent bulk load.

**Access**: read by every authenticated role; created, altered and withdrawn only by `SUPER_ADMIN`
(FR-035c), enforced by `@Roles` at the controller exactly as `CompaniesController` does.

---

## New embedded: `VehicleVerification`

One verification attempt, successful or not. Embedded on `Order` as an append-only array — it is
per-order evidence, always read with the order, and bounded by the rate limit (FR-023).

| Field | Type | Rules |
|---|---|---|
| `stage` | `VerificationStage` | `DEPARTURE` \| `LOADING`. Derived server-side from the order's status, never supplied by the client (R7). |
| `method` | `VerificationMethod` | `NFC_CARD` \| `QR_CODE`. **FR-036c** — what lets an operator tell a tapped card from a scanned code. |
| `matched` | boolean | Whether the presented credential resolved to the assigned truck. |
| `presentedTruckId` | ObjectId → Truck | Optional. The truck the credential resolved to, when it resolved to one at all. **Never the raw credential** — FR-042 forbids storing or exposing a card identifier here. |
| `at` | Date | Required. |
| `driverLocation` | GeoPoint | Optional. Where the driver was (FR-024). The fix sent with the read when the device had one, falling back to the driver's last streamed position otherwise. Absent if neither existed — recorded honestly rather than defaulted. |
| `distanceMeters` | number | Optional. Metres between `driverLocation` and the order's `warehouseSummary.location` (FR-030d). Present on `LOADING` attempts only — `DEPARTURE` is not geofenced — and recorded whatever the verdict, so a pass in the yard stays distinguishable from a refusal 4 km out. |
| `actorId` | ObjectId → User | Required. The driver who attempted it. |

**Why the raw credential is not stored**: an attempt log holding card identifiers would be a
harvestable list of every credential presented, including valid ones. Storing the *resolved truck*
answers every audit question FR-039/FR-040 ask without retaining a reusable secret.

**Why `matched` is not purely about the credential at the loading stage**: `matched` is the
platform's verdict on the whole attempt, and a loading attempt has two conditions (FR-030/FR-030a)
— the right truck, presented at the right place. A read that satisfies one and not the other is
`matched: false` with `distanceMeters` recorded, which is what distinguishes it afterward from a
wrong-card attempt. A driver *cannot* reach `confirm-loading` on a half-satisfied attempt, since
that gate reads `matched` alone.

**Why a distance and not a boolean**: `withinGeofence: true/false` would answer the question the
platform asked at the time and nothing else. The radius is configurable (FR-030b), so a stored
boolean silently means different things across a change to it, and an operator reviewing an
override needs to know whether the driver was at the fence or in another city.

---

## Changed: `Order`

| Field | Type | Rules |
|---|---|---|
| `truckId` | ObjectId → Truck | Optional (absent pre-cutover). Set at assignment. **The record verification is checked against** (FR-013). |
| `tankId` | ObjectId → Tank | Optional. Set at assignment (FR-009f). |
| `tankSummary` | `{ code, material }` | Optional. Snapshotted at assignment so the driver's screen (FR-033a) and later review show what was assigned, not what the tank record says now — same discipline as `driverSummary`/`clientSummary`. |
| `warehouseId` | ObjectId → Warehouse | Optional. Resolved at assignment (R9). |
| `warehouseSummary` | `{ name, addressText, location }` | Optional. Snapshotted, frozen once loading begins (**FR-035e**). |
| `verifications` | `VehicleVerification[]` | Default `[]`. Append-only. |
| `loadingConfirmedAt` | Date | Optional. Set when the loading stage completes. |

`driverSummary.plateNumber` keeps its shape but is now sourced from the assigned `Truck` rather than
the driver's deleted embedded truck (R12) — the customer-facing contract does not change.

**Indexes** — no new index required. `truckId`/`tankId` are read via the order, and the
last-used-truck lookup (R4) needs `{ driverId: 1, truckId: 1, createdAt: -1 }`, partial on `truckId`
existing so pre-cutover orders never enter it.

---

## Deleted: `User.truck`

The embedded `Truck` class and the `truck` property are **removed outright** (FR-043, R12). No
migration promotes them. `PATCH /users/:id/truck` and `UpdateTruckDto` go with them.

This also removes the reason `DispatchService.findCandidates` filtered on
`truck.maxCapacityLiters`/`truck.fuelTypes` — those predicates are deleted, not relocated (R3).

`UserSchema.index({ location: '2dsphere' })` **stays**; drivers still report position and are still
ranked by proximity.

---

## Changed: `OrderStatus` — one new value

```
PENDING_APPROVAL → APPROVED → [PENDING_PAYMENT] → AWAITING_ROUTING | ROUTED_TO_TRANSPORT
                                                        ↓
                                              ASSIGNED_TO_DRIVER
                                                        ↓  departure verification (or override)
                                                    LOADING          ← NEW
                                                        ↓  loading confirmed (or override)
                                                   IN_TRANSIT
                                                        ↓
                                                   UNLOADING → DELIVERED
```

**Transition table changes** (`order-state.service.ts`):

| From | To | Note |
|---|---|---|
| `ASSIGNED_TO_DRIVER` | `IN_TRANSIT` | **REMOVED** — the edge `assignDriver` auto-traverses today (FR-046a) |
| `ASSIGNED_TO_DRIVER` | `LOADING` | **NEW** — departure verification, or operator override |
| `LOADING` | `IN_TRANSIT` | **NEW** — loading confirmed, or operator override |
| `LOADING` | `CANCELLED` | **NEW** — FR-046d |
| `LOADING` | `DELIVERED` | **NEW**, `requiresManualOverride` — mirrors the existing `IN_TRANSIT → DELIVERED` force-complete edge (FR-046e) |

**Meaning changes**: `ASSIGNED_TO_DRIVER` now means *assigned, awaiting verification* and no longer
auto-advances. `IN_TRANSIT` narrows to *loaded and travelling to the customer* (FR-046b).

**Exhaustive switches that must gain a case** (FR-046c) — Dart's sealed-enum exhaustiveness makes
most of these compile errors rather than silent gaps:

- Backend: `TRANSITIONS`.
- Mobile `OrderPresentation`: `statusLabel`, `statusColor`, `flowStep`, `statusProgress`, `cardKindFor`.
- Mobile `OrderFilter.inDelivery` and the driver's "In progress" tab — both must include `loading`.
- Client tracking timeline; stage-change notification copy.

---

## New enums

| Enum | Values | Where |
|---|---|---|
| `VerificationMethod` | `NFC_CARD`, `QR_CODE` | backend + mobile |
| `VerificationStage` | `DEPARTURE`, `LOADING` | backend (derived server-side) |
| `TankMaterial` | `IRON`, `ALUMINIUM` | backend + mobile |

New `ErrorCode` values: `VEHICLE_MISMATCH`, `VEHICLE_NOT_VERIFIED`, `TRUCK_UNAVAILABLE`,
`TANK_UNAVAILABLE`, `CARD_ALREADY_PAIRED`, `TANK_CODE_IN_USE`, `NO_WAREHOUSE_FOR_GRADE`. Each
mirrored into mobile's `error_codes.dart` and `_knownCodes`.

---

## Resource booking and release

All three resources — driver, truck, tank — are booked in `assignDriver`'s **existing** transaction,
each by conditional update against its unique partial index (R13):

```
findOneAndUpdate(
  { _id, isActive: true, activeOrderId: { $exists: false }, …capability },
  { $set: { activeOrderId: order._id } },
  { session }
)
```

A null result means the resource was taken concurrently ⇒ the transaction aborts and the operator is
told to retry against a fresh list. Exactly one of two simultaneous attempts wins, enforced by Mongo
(SC-007, SC-024).

**Release** extends `releaseDriverIfAssigned` to all three, called from the same points it already
is: delivery completion, cancellation, force-complete. Withdrawal of a truck or tank clears
`isActive` but **never** `activeOrderId` (FR-008, FR-048e) — an in-progress delivery continues.

---

## What is NOT in this model

- **No loaded volume field.** The driver records none (FR-028a); the authoritative figure arrives via
  a later reconciliation feature.
- **No client litre balance.** Cut at clarification into its own feature.
- **No tank credential.** Tanks carry no card and no token — assigned, never verified (FR-048c).
- **No QR image storage.** A QR is rendered from `qrToken` on demand; nothing is written to
  `sys_storge`.
