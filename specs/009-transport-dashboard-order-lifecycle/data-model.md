# Data Model: Transport Admin Dashboard — Live Order Lifecycle

**Feature**: 009 | **Date**: 2026-08-26 | **Phase**: 1

**No stored schema changes.** Every collection this feature reads already exists and is current.
What follows is therefore two things: the platform's shape as the dashboard must understand it,
and the dashboard's own corrected vocabulary — which is where the actual defects live.

---

## 1. Vocabularies the dashboard has wrong

These are not new types. They are existing dashboard constants whose values disagree with the
platform, which is why the transport surface cannot function.

### 1.1 Role — `src/constants/roles.ts`

| Platform (`user-role.enum.ts`) | Dashboard today | After |
|---|---|---|
| `SUPER_ADMIN` | `SUPER_ADMIN` | `SUPER_ADMIN` |
| `FUEL_COMPANY_ADMIN` | — | **added** |
| `TRANSPORT_COMPANY_ADMIN` | — | **added** |
| `CLIENT` | `CLIENT` | `CLIENT` |
| `DRIVER` | `DRIVER` | `DRIVER` |
| — | `COMPANY_ADMIN` | **removed** |

`DASHBOARD_LOGIN_ROLES` becomes `[SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN]`.
`CLIENT` and `DRIVER` are mobile personas and must not hold a dashboard session.

**Route guards re-derived** — each surface guarded by the role that owns it:

| Route | Today | After |
|---|---|---|
| `/admin` | `[COMPANY_ADMIN, DRIVER, SUPER_ADMIN]` | `[SUPER_ADMIN]` |
| `/petrolCompany` | `[CLIENT, COMPANY_ADMIN]` | `[FUEL_COMPANY_ADMIN, SUPER_ADMIN]` |
| `/transport` | `[COMPANY_ADMIN, DRIVER, SUPER_ADMIN]` | `[TRANSPORT_COMPANY_ADMIN, SUPER_ADMIN]` |

`SUPER_ADMIN` is admitted everywhere because the platform exempts it from tenant isolation by
design. A `DRIVER` is admitted nowhere — today it can reach both admin surfaces.

### 1.2 OrderStatus — `src/constants/order-status.ts`

Twelve platform values; the dashboard has eight. The four missing are exactly the transporter's
own working range.

| Value | Present today | Meaning at this surface |
|---|---|---|
| `PENDING_APPROVAL` | ✓ | Not yet the transporter's |
| `APPROVED` | ✓ | Not yet the transporter's |
| `AWAITING_ROUTING` | **✗** | No transporter serves the region |
| `ROUTED_TO_TRANSPORT` | **✗** | **The transporter's work queue** — assignable |
| `ASSIGNED_TO_DRIVER` | **✗** | **Assigned; awaiting the driver's departure verification** |
| `PENDING_PAYMENT` | ✓ | Held before routing |
| `LOADING` | **✗** | **Verified; at or heading to the warehouse** |
| `IN_TRANSIT` | ✓ | Loaded and travelling — **trackable** |
| `UNLOADING` | ✓ | At the customer — **trackable** |
| `DELIVERED` | ✓ | Complete |
| `REJECTED` | ✓ | Terminal |
| `CANCELLED` | ✓ | Terminal |

**Derived, single-source mappings** (FR-010, FR-011) — each exhaustive over the twelve, so a value
the dashboard does not recognise renders as an explicit unknown rather than a blank:

- `ORDER_STATUS_LABEL` → translation key, both languages
- `ORDER_STATUS_TONE` → visual treatment
- `IS_ASSIGNABLE` → `status === ROUTED_TO_TRANSPORT` (gates the assignment action)
- `IS_TRACKABLE` → `IN_TRANSIT | UNLOADING` (mirrors the platform's own `order:watch` rule)
- `IS_TERMINAL` → `DELIVERED | REJECTED | CANCELLED`

### 1.3 Paged response — every `api/*.ts`

```ts
// Today — a shape the platform never produces
interface Paginated<T> { items: T[]; total: number; page: number }

// After — what GET /orders actually returns
interface CursorPage<T> { items: T[]; nextCursor: string | null }
```

`total` moves to the summary endpoint (§3). `page` disappears; lists advance by cursor.

---

## 2. Platform entities as this surface reads them

Read-only. Field names are the platform's.

### Order (`orders`) — multi-party scoped

| Field | Notes for this surface |
|---|---|
| `_id`, `status`, `fuelType`, `quantityLiters` | Core identity and load |
| `statusHistory[]` | `{ status, at, manualOverride?, overrideReason? }` — drives FR-012, FR-013 |
| `clientSummary` | Customer name and contact, snapshotted at assignment |
| `driverSummary` | Driver name and contact, snapshotted at assignment |
| `truckId`, `truckSummary` | The tractor |
| `tankId`, `tankSummary` | The trailer — **operator-visible only**, stripped for customers |
| `verifications[]` | `{ stage, matched, at }` — **operator-visible only** |
| `vehicleVerified` | Derived by the platform: a `DEPARTURE` verification exists and matched |
| `deliveryAddressText`, `deliveryLocation`, `station` | Destination |
| `etaMinutes`, `driverLocation` | Present on detail; seeds the map before the first live update |
| `fuelCompanyId`, `transportCompanyId`, `clientId`, `driverId` | Isolation keys — **never rendered** |
| `deliveredAt`, `rating` | Completion; `rating` absent means not yet rated, never zero |

**Isolation**: the multi-party plugin injects `{ fuelCompanyId, transportCompanyId }` for this
role on every read, count and update. Another company's order is indistinguishable from absent.

**An override writes no verification record.** `vehicleVerified` therefore reads false for an
overridden departure automatically — which is precisely how FR-033's "never presented as verified"
is guaranteed, with no separate flag to keep honest.

### Truck (`trucks`) — tenant scoped by `companyId`

`plateNumber` · `model` · `nfcCardUid` (the card binding) · `qrToken` (the rotatable credential) ·
`isActive` · `activeOrderId` (present ⇒ committed, cannot be withdrawn or double-assigned).

Derived for the fleet list (FR-053): `hasPairedCard` = `nfcCardUid` present ·
`hasLiveCredential` = `qrToken` present. **Neither `nfcCardUid` nor `qrToken` is ever logged.**

### Tank (`tanks`) — tenant scoped by `companyId`

`code` · `material` · `capacityLiters` · `allowedFuelTypes[]` · `isActive` · `activeOrderId`.

**These two fields are the guards.** Assignment refuses when
`capacityLiters < order.quantityLiters` or `!allowedFuelTypes.includes(order.fuelType)` — the
platform decides, the dashboard names which rule failed (FR-005).

### Assignment candidate (`GET /dispatch/orders/:id/candidates`)

Not stored — computed per request. A ranked driver plus `suggestedTruck`, which is the driver's
most recently operated tractor **derived from order history**, suppressed to `null` when that
truck is withdrawn or already committed. There is no `lastTruckId` field, and the dashboard must
not invent one.

### Driver (`users`, role `DRIVER`) · Warehouse (`warehouses`)

Driver: identity, `isActive`, duty state, location, `ratingAverage` — **absent when never rated**,
which is a distinct state from zero all the way to the screen. Warehouse: platform-level, written
only by `SUPER_ADMIN`, seeded for the walkthrough.

---

## 3. The one new contract — order summary

Cursor pagination cannot produce a total, and the overview needs several. The multi-party plugin
scopes `countDocuments` alongside reads, so each count carries this administrator's
`fuelCompanyId` and `transportCompanyId` structurally.

```
GET /api/v1/orders/summary?from=<ISO>&to=<ISO>
Roles: TRANSPORT_COMPANY_ADMIN, FUEL_COMPANY_ADMIN, SUPER_ADMIN
```

```jsonc
{
  "awaitingAssignment": 3,   // ROUTED_TO_TRANSPORT
  "inProgress": 7,           // ASSIGNED_TO_DRIVER | LOADING | IN_TRANSIT | UNLOADING
  "completedInPeriod": 42,   // DELIVERED, deliveredAt within [from, to]
  "driversOnDuty": 5,
  "outstandingSettlements": { "amount": 128400, "currency": "SAR", "count": 6 }
}
```

**One request serves the whole overview** (FR-058) — the cheapest possible answer to the cost
constraint, against an alternative that would page entire collections to count them.
`completedInPeriod` uses `deliveredAt`, never `updatedAt`, which drifts when invoices and payments
touch a delivered order afterwards.

---

## 4. Dashboard-only state

Held in memory for the life of a screen; nothing here is persisted.

**Pending card capture** (the pairing screen, FR-045–FR-051)

| Field | Purpose |
|---|---|
| `capturedUid` | The identifier awaiting confirmation — never logged, cleared on unmount |
| `source` | `'reader'` \| `'device'` \| `'manual'` — shown so the operator knows what happened |
| `isArmed` | **Capture is armed only while this screen is mounted and awaiting a card.** This is what stops a stray read reaching another field — FR-048, by construction rather than by discipline |
| `targetTruckId` | May be chosen after capture; a read arriving first is held, not discarded (edge case) |

A second read **replaces** the pending value rather than binding twice, which makes a repeating
reader harmless. Discrimination between a reader and a person is by inter-keystroke timing plus a
terminating newline; a hand-typed entry must be submitted deliberately and is marked `'manual'`.

**Live position** (the tracking screen, FR-021–FR-024)

`lastPosition` · `lastReceivedAt` (drives the stale statement, FR-018) · `connectionState`.
**One connection per session**, opened only while a tracking screen is open on a trackable
delivery and closed when it is left. The screen never judges trackability itself — it reports the
platform's `NOT_TRACKABLE` refusal.

---

## 5. State transitions this surface can cause

The platform is the sole authority (FR-063); the dashboard offers the action and renders the
outcome.

| Action | Transition | Guards enforced by the platform |
|---|---|---|
| Assign driver + truck + tank | `ROUTED_TO_TRANSPORT` → `ASSIGNED_TO_DRIVER` | Status is assignable · tank capacity ≥ quantity · tank permits the grade · truck and tank uncommitted · transactional, so concurrent attempts yield exactly one winner |
| Override departure verification | `ASSIGNED_TO_DRIVER` → `LOADING` | Not already departed · reason required · **writes no verification record** |
| Reassign vehicle | no stage change | Before departure only · releases the previous truck and tank |

Every other transition in the walkthrough belongs to another participant: the customer places and
rates, the fuel company approves and routes (by script, this feature builds no screen for it), the
driver verifies, loads, drives, arrives and completes.

---

## 6. What this feature does not touch

`mobile_app` — unmodified; it participates in the walkthrough as it stands, with card reading,
vehicle verification, the loading stage and the notification vocabulary all present and current.
Platform schemas — no field added, changed or removed. The fuel company's dashboard — out of
scope; its two lifecycle steps are scripted.
