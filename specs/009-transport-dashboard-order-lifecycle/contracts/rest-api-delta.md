# REST API Delta — Feature 009

**Base**: `/api/v1` · **Auth**: `Authorization: Bearer <access token>` on every call.

Almost nothing here is new. The platform already serves the transporter's whole job; the dashboard
simply does not call it, and in three cases calls things this role is forbidden to touch. This
document is therefore mostly a **correction to the client's address list**, plus one genuine
addition.

---

## Part 1 — The one new endpoint

### `GET /orders/summary`

**Roles**: `TRANSPORT_COMPANY_ADMIN`, `FUEL_COMPANY_ADMIN`, `SUPER_ADMIN`

Cursor pagination cannot yield a total, and the overview needs several (FR-059–FR-061). This
returns every figure the dashboard home shows in **one** request (FR-067).

**Query**: `from`, `to` — ISO-8601, bounding `completedInPeriod`. Both optional; default is the
current month.

**200**

```jsonc
{
  "awaitingAssignment": 3,
  "inProgress": 7,
  "completedInPeriod": 42,
  "driversOnDuty": 5,
  "outstandingSettlements": { "amount": 128400, "currency": "SAR", "count": 6 }
}
```

| Field | Derivation |
|---|---|
| `awaitingAssignment` | count where `status = ROUTED_TO_TRANSPORT` |
| `inProgress` | count where `status ∈ {ASSIGNED_TO_DRIVER, LOADING, IN_TRANSIT, UNLOADING}` |
| `completedInPeriod` | count where `status = DELIVERED` and **`deliveredAt`** ∈ `[from, to]` |
| `driversOnDuty` | count of this company's drivers currently on duty |
| `outstandingSettlements` | unsettled invoice total and count for this company |

**Implementation constraints**

- Counts go through `countDocuments`, which the multi-party plugin scopes — so
  `{ fuelCompanyId, transportCompanyId }` is injected structurally, never hand-written
  (Constitution II). A `FUEL_COMPANY_ADMIN` calling the same endpoint gets their own scope by the
  same mechanism, with no branching in the handler.
- **`deliveredAt`, never `updatedAt`** — invoices and payments touch a delivered order afterwards
  and would corrupt the count.
- Read-only. No transaction (Constitution V does not apply).

---

## Part 2 — Endpoints the dashboard must stop calling

These are in `api-routes.ts` today. The transport administrator's role is **forbidden** all four;
each would return `403`. **A finding from implementation**: the original planning pass (spec,
this document) named three — `cancel` is a fourth, confirmed against
`OrdersController.cancel`'s own guard (`user.role === UserRole.FUEL_COMPANY_ADMIN`, admitting no
transporter), and against three orphaned dialog components in the dashboard
(`ApproveOrderDialog.tsx`, `RejectOrderDialog.tsx`, `ForceCompleteDialog.tsx`) that called all
four and were never actually rendered by any screen.

| Remove from the transport surface | Owner |
|---|---|
| `PATCH /orders/:id/approve` | `FUEL_COMPANY_ADMIN` |
| `PATCH /orders/:id/reject` | `FUEL_COMPANY_ADMIN` |
| `PATCH /orders/:id/force-complete` | `FUEL_COMPANY_ADMIN` |
| `PATCH /orders/:id/cancel` | `FUEL_COMPANY_ADMIN` or `CLIENT` |

**Also remove**: `dispatch.trigger` → `POST /dispatch/orders/:id`. This path no longer exists on
the platform; it was the pre-split auto-select retry, replaced by the two endpoints in Part 3.

**Also remove**: `users.truck` → `PATCH /users/:id/truck`. A truck is no longer a field embedded
on the driver — it is its own record (Part 4).

FR-070 forbids offering an action the role cannot perform, so these leave the surface entirely
rather than being rendered disabled.

---

## Part 3 — The transporter's own actions (exist; never called)

### `GET /dispatch/orders/:id/candidates` — `TRANSPORT_COMPANY_ADMIN`

The ranked driver list for a routed order.

**200** — array of candidates, each: driver identity, contact, duty state, distance from the
destination, and `suggestedTruck`.

`suggestedTruck` is the driver's most recently operated tractor, **derived from order history**,
and is **`null`** when that truck is withdrawn or already committed (FR-003). There is no
`lastTruckId` field; the dashboard must not invent one or cache it.

**409** — the order is not `ROUTED_TO_TRANSPORT`. Surface as "no longer awaiting assignment" and
refresh the order (FR-006).

### `POST /dispatch/orders/:id/assign` — `TRANSPORT_COMPANY_ADMIN`

```jsonc
{ "driverId": "<id>", "truckId": "<id>", "tankId": "<id>" }
```

All three required (`AssignDriverDto`, all `@IsMongoId`). Transactional.

**200** — the assigned order; status becomes `ASSIGNED_TO_DRIVER`.

**Refusals the dashboard must name specifically** (FR-005, FR-006, FR-008):

| Cause | Surface as |
|---|---|
| Tank capacity < ordered volume | The capacity rule, with both numbers |
| Tank does not permit the grade | The grade rule, naming the grade |
| Truck or tank already committed | Which vehicle, and that it is in use |
| Order no longer assignable | Already assigned or cancelled — **refresh to the true state** |

Concurrency resolves at the data layer: exactly one of two simultaneous attempts wins (SC-008).
The loser gets a refusal, not a corrupted order.

### `POST /orders/:id/override-verification` — `TRANSPORT_COMPANY_ADMIN`

Carries a reason. Advances `ASSIGNED_TO_DRIVER → LOADING` without the driver's verification.

**Writes no verification record** — deliberately. `vehicleVerified` therefore stays false, so an
override can never be read as a verification anywhere downstream (FR-055). The dashboard must
render provenance from `statusHistory`'s `manualOverride`/`overrideReason`, never by inferring.

**409** — already departed the warehouse (FR-056).

### `PATCH /orders/:id/reassign-vehicle` — `TRANSPORT_COMPANY_ADMIN`

Swaps truck and/or tank before departure, releasing the previous vehicle (FR-035, FR-036).

---

## Part 4 — Fleet (exists; no dashboard client at all)

All `TRANSPORT_COMPANY_ADMIN`, all tenant-scoped by `companyId`.

### Trucks

| Method | Path | Notes |
|---|---|---|
| `POST` | `/trucks` | `{ plateNumber, model? }` |
| `GET` | `/trucks` | Fleet list |
| `GET` | `/trucks/:id` | |
| `PATCH` | `/trucks/:id` | |
| `PATCH` | `/trucks/:id/withdraw` | **409** when committed to a delivery (FR-042) |
| `PATCH` | `/trucks/:id/restore` | |
| `POST` | `/trucks/:id/pair-card` | `{ nfcCardUid }` — **409** when already bound elsewhere; the response must let the dashboard name the holding tractor (FR-050) |
| `POST` | `/trucks/:id/qr-token` | Issue |
| `POST` | `/trucks/:id/qr-token/rotate` | Effective immediately (FR-052, SC-022) |
| `PATCH` | `/trucks/:id/qr-token/revoke` | Effective immediately |

**`nfcCardUid` and `qrToken` must never be written to logs or diagnostics** (FR-051). The list
response supports the derived `hasPairedCard` / `hasLiveCredential` indicators (FR-053).

### Tanks

`POST` `/tanks` · `GET` `/tanks` · `GET` `/tanks/:id` · `PATCH` `/tanks/:id` ·
`PATCH` `/tanks/:id/withdraw` · `PATCH` `/tanks/:id/restore`

Carries `code`, `material`, `capacityLiters`, `allowedFuelTypes[]`. **The last two are what make
the assignment guards real** — they are required fields on the trailer form, not optional detail.

---

## Part 5 — Corrections to existing calls

### `GET /orders` — pagination shape

```jsonc
// The dashboard's type today — the platform has never produced this
{ "items": [...], "total": 128, "page": 1 }

// What it actually returns
{ "items": [...], "nextCursor": "<opaque>" }
```

Query is `?status=&cursor=`; there is no `page`. Cursor paging is deliberate — skip/limit
duplicates rows when inserts land at the head (FR-019). Totals come from `/orders/summary`.

For `TRANSPORT_COMPANY_ADMIN` the service adds no explicit predicate; the multi-party plugin
supplies `{ fuelCompanyId, transportCompanyId }`. The work queue (FR-009) is
`GET /orders?status=ROUTED_TO_TRANSPORT`.

### `GET /orders/:id`

Returns `tankSummary` and `verifications` **only** to operator and driver roles — stripped for
customers by the platform. Also returns `vehicleVerified`, `etaMinutes`, `driverLocation`,
`station`, and `rating` **only when one exists** (absence is "not yet rated", never zero).

### Auth

`POST /auth/refresh` takes the refresh token **in the request body** (`RefreshTokenDto`). The
dashboard currently sends an empty body with `withCredentials`, expecting an httpOnly cookie the
platform does not issue — so silent refresh cannot work today. The client is corrected to match
the platform. See the plan's Complexity Tracking: the cookie design is better and deferred, not
abandoned, because changing it here would alter both Flutter clients' refresh path.

---

## Part 6 — Never on this surface

- **The customer's delivery handover code.** `GET /orders/:id/otp/current` is `CLIENT`-only and
  `order:otp` is emitted only to the customer's own room. The dashboard must not request, receive,
  render, cache or log it (FR-071).
- **Isolation keys as content.** `fuelCompanyId`, `transportCompanyId`, `clientId`, `driverId`
  are routing and scoping values, never displayed.
- **Another company's anything.** A cross-company record returns `404`, indistinguishable from one
  that does not exist. The dashboard must not special-case it into a "no permission" message —
  that would leak existence (Constitution II, FR-069).
