# REST API Delta: NFC Truck Verification & Warehouse Loading

**Feature**: 008-nfc-truck-loading | **Phase**: 1

Additions and changes to `specs/001-fuel-delivery-platform/contracts/rest-api.md`. Base path
`/api/v1`. Every endpoint requires a bearer token; roles are enforced by `@Roles` server-side.

Error bodies use the platform's uniform shape — `{ error, message, ...extra }` — where `error` is an
`ErrorCode` value the app branches on by name (Principle III).

---

## Trucks — `TRANSPORT_COMPANY_ADMIN`

Tenant-scoped automatically. A truck belonging to another company is **404**, never 403.

### `POST /trucks`
```jsonc
// request
{ "plateNumber": "RYD-4471", "model": "Volvo FH" }        // model optional
// 201
{ "_id": "…", "plateNumber": "RYD-4471", "model": "Volvo FH",
  "isActive": true, "hasCard": false, "hasCode": false }
```
`409 DUPLICATE_PLATE` when the plate already exists **within this company**.

> `hasCard` / `hasCode` are booleans, never the values themselves — FR-042 forbids returning a card
> identifier or token to anyone.

### `GET /trucks?available=true&forOrderId=…`
Lists the company's trucks. `available=true` returns only in-service trucks with no active order
(FR-016). `forOrderId` is accepted for symmetry with tanks but applies no capability filter — a
truck has no capacity or grade of its own (R3).

### `PATCH /trucks/:id` — plate/model. `PATCH /trucks/:id/withdraw` / `/restore` — `isActive` (FR-007).

Withdrawal never clears `activeOrderId`, so a delivery in flight continues (FR-008).

### `PUT /trucks/:id/card`
```jsonc
{ "cardUid": "04A2B3C4D5E680" }   // opaque; captured by the desk USB reader (FR-006)
// 200 → { "_id": "…", "hasCard": true }
```
- `409 CARD_ALREADY_PAIRED` — paired to another truck (FR-005). The message names the conflict **within the caller's own company only**; a collision with another tenant's truck returns the same code without identifying it.
- Replacing a card **clears `qrToken`** (FR-036e) — the response reports `hasCode: false`.

### `DELETE /trucks/:id/card` — unpair.

### `POST /trucks/:id/code`
Mints or rotates `qrToken`. **The only endpoint that ever returns the token**, because the operator
must render it into a QR.
```jsonc
// 201
{ "token": "kQ7…", "rotated": true }   // `rotated: true` ⇒ a previous code just stopped working
```
Rotation is how revocation-and-reissue happens (FR-036f/g). No expiry is set (FR-036h).

### `DELETE /trucks/:id/code`
Revokes without reissuing. The old code stops resolving immediately (FR-036g).

---

## Tanks — `TRANSPORT_COMPANY_ADMIN`

### `POST /tanks`
```jsonc
{ "code": "TNK-0091", "material": "ALUMINIUM",
  "maxCapacityLiters": 30000, "fuelTypes": ["PETROL_91", "PETROL_95"] }
```
- `409 TANK_CODE_IN_USE` — codes are globally unique (FR-048b). The message never says which company holds it.
- `material` ∈ `IRON` | `ALUMINIUM`; it does **not** constrain `fuelTypes` (FR-048g).

### `GET /tanks?available=true&forOrderId=…`
With `forOrderId`, the list is **pre-filtered** to tanks whose capacity ≥ the order's quantity and
whose `fuelTypes` include its grade — FR-016a requires the offered list and the acceptable set to
agree, so an operator is never shown a tank the platform would then refuse.

### `PATCH /tanks/:id`, `PATCH /tanks/:id/withdraw` / `/restore` — as trucks.

---

## Warehouses

Platform reference data. Readable by **every authenticated role**; written only by `SUPER_ADMIN`
(FR-035c). Not tenant-scoped (research R1).

### `GET /warehouses?fuelType=DIESEL&near=lng,lat&limit=20`
Open to all roles. `near` sorts by distance.

### `POST /warehouses` — `SUPER_ADMIN`
```jsonc
{ "name": "Jeddah South Depot", "addressText": "…",
  "location": { "longitude": 39.19, "latitude": 21.48 },
  "region": "MAKKAH", "governorate": "JEDDAH",
  "fuelTypes": ["DIESEL", "PETROL_91"], "externalRef": "ARAMCO-JED-07" }
```

### `POST /warehouses/bulk` — `SUPER_ADMIN`
```jsonc
{ "warehouses": [ /* …same shape… */ ] }
// 201 → { "created": 412, "updated": 18, "skipped": 0 }
```
Idempotent on `externalRef` (FR-035a) — re-loading the national dataset updates rather than
duplicates.

### `PATCH /warehouses/:id`, `PATCH /warehouses/:id/withdraw` — `SUPER_ADMIN`.

Withdrawal affects only deliveries not yet started; an order that already snapshotted this warehouse
continues to it (FR-035e).

---

## Assignment — changed

### `POST /dispatch/orders/:id/assign` — `TRANSPORT_COMPANY_ADMIN`

**Breaking change**: the body now requires three ids.
```jsonc
// before: { "driverId": "…" }
{ "driverId": "…", "truckId": "…", "tankId": "…" }
```

Inside one transaction (Principle V): books all three against their unique partial indexes, resolves
the nearest warehouse supplying the order's grade, snapshots `driverSummary` / `clientSummary` /
`tankSummary` / `warehouseSummary`, and transitions `ROUTED_TO_TRANSPORT → ASSIGNED_TO_DRIVER`.

**It no longer advances to `IN_TRANSIT`** (FR-046a) — that now requires the driver's verification.

| Status | Code | When |
|---|---|---|
| 409 | `TRUCK_UNAVAILABLE` | withdrawn, or taken concurrently |
| 409 | `TANK_UNAVAILABLE` | withdrawn, or taken concurrently |
| 409 | `TANK_CAPACITY_EXCEEDED` | quantity > tank capacity (FR-010) |
| 409 | `TANK_GRADE_UNSUPPORTED` | tank may not carry this grade (FR-011) |
| 409 | `NO_WAREHOUSE_FOR_GRADE` | no in-service warehouse supplies it (FR-035f) |
| 404 | — | truck or tank belongs to another company |

### `GET /dispatch/orders/:id/candidates` — changed

Drivers ranked by proximity and availability. **Capability predicates removed** — a driver no longer
carries a vehicle (R3). Each candidate additionally carries:
```jsonc
{ "_id": "…", "fullName": "…", "distanceMeters": 4210,
  "suggestedTruck": { "_id": "…", "plateNumber": "RYD-4471" } | null }
```
`suggestedTruck` is the truck this driver last operated (FR-009b), **null** when they have none or
when it is withdrawn or busy (FR-009c/d) — the suggestion is suppressed rather than offered
unusable.

### `PATCH /orders/:id/reassign-vehicle` — `TRANSPORT_COMPANY_ADMIN`
```jsonc
{ "truckId": "…", "tankId": "…" }   // either or both
```
Permitted only before departure (FR-015). Releases the previous resources and books the new ones in
one transaction. `409 ALREADY_DEPARTED` once the order has left `ASSIGNED_TO_DRIVER`.

---

## Verification — `DRIVER`

### `POST /orders/:id/verify-vehicle`

**One endpoint for both stages.** Which stage it advances is derived from the order's status, never
from the request (research R7) — the client cannot assert a transition.

```jsonc
// DEPARTURE — the order is at ASSIGNED_TO_DRIVER. No position needed.
{ "credential": "04A2B3C4D5E680", "method": "NFC_CARD" }   // or "QR_CODE"
// 201
{ "status": "DEPARTURE", "order": { /* the order, now at LOADING */ },
  "warehouseSummary": { "name": "…", "addressText": "…",
                        "location": { "type": "Point", "coordinates": [39.19, 21.48] } } }

// LOADING — the order is at LOADING. `driverLocation` is REQUIRED here (FR-030c).
{ "credential": "04A2B3C4D5E680", "method": "NFC_CARD",
  "driverLocation": { "longitude": 39.19, "latitude": 21.48 } }
// 201
{ "status": "LOADING", "order": { /* still at LOADING — confirm-loading owns that edge */ },
  "distanceMeters": 62 }
```

`warehouseSummary` is present only on a successful `DEPARTURE` verification — it is where the driver
goes next (FR-026/FR-027). `distanceMeters` replaces it on a `LOADING` verification: the distance
the geofence was decided on (FR-030d).

`driverLocation` is accepted on both stages and is a **fix taken at the moment of the read**, not
the driver's last streamed position (FR-030c). It is optional on the wire because only one stage
needs it and the stage is not the client's to declare — the app sends it whenever the device has
one, and the platform refuses the loading stage without it.

| Status | Code | When |
|---|---|---|
| 403 | `VEHICLE_MISMATCH` | credential resolved to a different truck, or to none (FR-018). **Recorded** as a failed attempt (FR-040) |
| 403 | `NOT_AT_WAREHOUSE` | LOADING only: the assigned truck, presented from outside the warehouse radius (FR-030a). **Recorded** as a failed attempt, with the distance. Body carries `distanceMeters` and `radiusMeters` |
| 400 | `LOCATION_REQUIRED` | LOADING only: no `driverLocation` on the request (FR-030c). **Not recorded** — nothing about the vehicle was evaluated |
| 409 | — | no verification pending at this status (FR-025, out-of-sequence) |
| 429 | — | rate limited (FR-023) — `@Throttle`, same shape as the OTP verify endpoints |
| 404 | — | not this driver's order |

**`VEHICLE_MISMATCH` is deliberately one code** for "wrong truck" and "unknown credential". Telling
them apart would let a driver probe which cards exist (Principle II).

**`NOT_AT_WAREHOUSE` is deliberately NOT collapsed into it.** It reveals nothing about which
credentials exist — only that this driver, holding their own assigned truck's card, is not yet at a
depot whose name and address they were handed at departure. Collapsing the two would send a driver
standing at the wrong gate off to look for a different card. The credential is answered first: a
wrong card at the right place is `VEHICLE_MISMATCH`, never a hint that the location half passed.

Every attempt that gets as far as being evaluated, successful or not, appends a
`VehicleVerification` — method, matched, resolved truck, time, location, and (loading only) distance
(FR-024, FR-030d, FR-036c).

### `POST /orders/:id/confirm-loading` — `DRIVER`

```jsonc
{}    // deliberately empty — FR-028 forbids any quantity or volume input
// 201 → { "status": "IN_TRANSIT" }
```

Requires the `LOADING` verification to have already succeeded. `409 VEHICLE_NOT_VERIFIED` otherwise
(FR-031).

> The loading-stage verification is `verify-vehicle` again (the order is at `LOADING`); this endpoint
> is the separate confirmation that advances to `IN_TRANSIT`. Two calls, because FR-030 requires the
> truck to be re-verified *and* loading to be declared complete. The re-read is not a repeat of the
> departure read: the card is the same, but it is the driver's **position** at that moment that the
> loading stage is really asking about (FR-030a).

---

## Operator override — `TRANSPORT_COMPANY_ADMIN`

### `POST /orders/:id/override-verification`
```jsonc
{ "reason": "Driver at Jeddah South depot, no signal; confirmed by phone" }
// 201 → { "status": "LOADING", "overridden": true }
```

Advances exactly the one outstanding verification step (FR-047g) — it cannot skip a stage. Recorded
via the existing `manualOverride` / `overrideReason` transition options, which write the reason,
actor and timestamp into `statusHistory` (research R10).

**No `VehicleVerification` record is written** — that is what makes FR-047c structurally true: an
overridden stage has no verification against it, so nothing can present it as proof.

- `403` — administrator of a different transportation company (FR-047e)
- `409` — nothing outstanding to override

---

## Order reads — changed

`GET /orders/:id` and `GET /orders` gain, subject to role:

```jsonc
{
  "truckId": "…",
  "tankSummary": { "code": "TNK-0091", "material": "ALUMINIUM" },   // driver + operator
  "warehouseSummary": { "name": "…", "addressText": "…", "location": {…} },
  "loadingConfirmedAt": "2026-08-24T…" | null,
  "vehicleVerified": true,          // customer-safe boolean
  "verifications": [ … ]            // operator only
}
```

**Visibility rules**
- `verifications[]` — operator and the assigned driver only (FR-039, FR-041). Never the customer.
- `tankSummary` — driver and operator (FR-033a/b). Not the customer, who has no use for a trailer code.
- `vehicleVerified` — the customer's honest signal. **`false` when the stage was overridden rather
  than verified** (FR-047d), so `driverSummary.plateNumber` is never presented to a customer as
  *verified* when it was only *attested*.
- No endpoint returns `nfcCardUid` or `qrToken` to any role except `POST /trucks/:id/code`'s own
  response (FR-042).
