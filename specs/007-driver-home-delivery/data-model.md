# Data Model: Driver Home & Active Delivery

**Feature**: 007-driver-home-delivery | **Date**: 2026-08-24

Three changes to existing documents, one new collection. Nothing here alters an existing field's
meaning; every addition is additive and absent-safe on documents written before this feature.

---

## New: `DeliveryRating`

One customer's rating of one completed delivery (spec FR-037–FR-042). A **multi-party** document
— the rater belongs to a fuel company, the subject to a transport company — so it carries
`markMultiParty`, matching `Order`, not the single-tenant plugin (research R6).

| Field | Type | Rules |
|---|---|---|
| `orderId` | ObjectId → Order | Required, **unique**, immutable. The uniqueness is what enforces "rateable once" (FR-039) at the data layer rather than in application code. |
| `driverId` | ObjectId → User | Required, immutable. The subject of the rating. |
| `clientId` | ObjectId → User | Required, immutable. The author. |
| `fuelCompanyId` | ObjectId → Company | Required. Copied from the order; the multi-party plugin's scoping predicate. |
| `transportCompanyId` | ObjectId → Company | Required. Copied from the order. |
| `score` | number | Required, integer, `min: 1`, `max: 5` (FR-037). |
| `review` | string | Optional, trimmed, `maxlength: 500` (FR-037a/b). Stored and rendered as plain text, never as markup. |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps. |

**Indexes**
- `{ orderId: 1 }` — **unique**. FR-039's enforcement point.
- `{ driverId: 1, createdAt: -1 }` — a driver reading feedback across their deliveries.

**No TTL.** A rating outlives the delivery it describes; it is the driver's standing.

**Immutability**: a rating is written once and never edited. There is no update path, because
moderation and appeal are out of scope (a recorded, accepted risk — see spec Assumptions).

---

## Changed: `Order`

### `clientSummary` — the customer contact mirror (FR-003a, research R5)

An exact structural mirror of the existing `driverSummary`, snapshotted at driver assignment
inside `DispatchService.assignDriver`'s transaction.

| Field | Type | Rules |
|---|---|---|
| `clientSummary.fullName` | string | Set at assignment from the client's user record. |
| `clientSummary.phone` | string | Set at assignment. The number the driver's call action dials. |

Optional on the schema: orders assigned before this feature have none, and the app must treat an
absent `clientSummary` as "no contact available" (FR-027b — the call action is absent, not
present and failing) rather than as an error.

**Why snapshot, not join**: identical reasoning to `driverSummary` and `deliveryAddressText` —
the order keeps its own immutable copy, so a later profile edit cannot rewrite what the driver
was shown at the time.

**Visibility**: returned on the order. The customer sees their own details; admins see what they
already see; a driver sees it only for orders where `String(order.driverId) === user.userId`,
which `findOneForUser` already enforces.

### `deliveredAt` — when the delivery actually completed (FR-032, research R7)

| Field | Type | Rules |
|---|---|---|
| `deliveredAt` | Date | Optional. Set exactly once, when the order transitions to `DELIVERED`. |

**Index**: `{ driverId: 1, deliveredAt: -1 }`, partial on `deliveredAt` existing — serves the
daily count without scanning a driver's whole history.

**Why a new field rather than an existing one**: `updatedAt` is not the delivery moment — a
delivered order is still touched by invoice issuance and payment settlement afterwards, so a
count keyed on it drifts. `statusHistory` holds the truth but requires an `$elemMatch` over an
array for a figure rendered on every home-screen open.

Set for **every** route into `DELIVERED`, including `OrdersService.forceComplete`'s
administrator override — which is what makes research R8's decision (override completions count)
fall out with no special-casing.

---

## Changed: `User` — the driver's rating aggregate

Maintained rather than computed, updated in the same transaction as the rating insert
(research R6).

| Field | Type | Rules |
|---|---|---|
| `ratingAverage` | number | Optional, `min: 1`, `max: 5`. **Absent means never rated** — this is a distinct state, not zero (FR-031). |
| `ratingCount` | number | Optional, `min: 0`, default `0`. |

**Absence is meaningful and must survive.** FR-031 forbids showing a default score, a zero, or
an empty star row to an unrated driver. A schema default of `0` on `ratingAverage` would destroy
that distinction at the data layer, so it deliberately has **no default** — `undefined` is the
"not yet rated" state, all the way from the document to the screen.

`ratingCount` may default to `0`, since a count of zero is honest and unambiguous.

**Deactivation**: neither field is touched by deactivation (FR-042). Spec 006's
`revokeSession` / `setActive` paths write neither.

---

## Derived, not stored: duty state

`readyForWork` is computed per request, never persisted as its own flag:

```
isActive && isOnline && isAvailable && activeOrderId is absent
```

This is the same predicate `DispatchService.findCandidates` already filters candidates on. It is
computed server-side and returned (research R9) so the app never re-derives dispatch semantics
client-side, and so the indicator cannot disagree with actual dispatch eligibility.

A second flag would be a second source of truth for something already knowable, and could drift
from the query that actually decides whether a driver receives work.

---

## Aggregate update rule

On accepting a rating, inside one `ClientSession` (Principle V):

1. Insert the `DeliveryRating` — the unique index on `orderId` rejects a duplicate here, which
   is how "rate once" is enforced rather than by a prior existence check that could race.
2. Recompute the driver's aggregate incrementally:
   `ratingAverage = ((ratingAverage ?? 0) × ratingCount + score) ÷ (ratingCount + 1)`,
   `ratingCount = ratingCount + 1`.

Both writes commit together or neither does. A rating stored without its aggregate bump would
show a driver feedback that never affects their standing; a bump without its rating would be an
unattributable score.

---

## What is NOT changing

- **`OrderStatus`** gains no new value. The delivery stages this feature displays already exist;
  the mock `_OrderMockState` is deleted, not mirrored into the real enum (research R11).
- **No new order state for cancellation or reassignment** — spec 006 already established that
  releasing a driver uses the existing path.
- **No `isOnDuty` field.** Duty is read-only and derived (FR-035/FR-036).
- **No rating on `Company`**, no transporter-level or fuel-company-level aggregate. The spec
  scopes rating to the driver of a completed delivery only.
