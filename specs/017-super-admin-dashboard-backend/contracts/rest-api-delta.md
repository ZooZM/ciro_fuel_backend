# REST API Delta: Platform Operator Dashboard — Backend Integration

**Feature**: `017-super-admin-dashboard-backend` | **Phase**: 1

Base path `/api/v1`. Every route below is either **NEW**, **CHANGED**, or listed under
§0 as **UNCHANGED AND SUFFICIENT** — that last group is the largest, and reading it first prevents
rebuilding what already works.

Canonical contract: `specs/001-fuel-delivery-platform/contracts/rest-api.md`. Update it once this
feature lands.

---

## 0. UNCHANGED AND SUFFICIENT — do not rebuild

Verified working for `SUPER_ADMIN` today (research R4, R10, and the cross-cutting table). No change
of any kind is required to these:

| Route | Serves | Why it already works |
|---|---|---|
| `GET /orders` | FR-015 | `findForUser` adds no narrowing for this role; multi-party plugin bypasses |
| `GET /orders/:id` | FR-018 | `toRoleScopedShape`'s `isOperatorOrDriver` already includes `SUPER_ADMIN` |
| `GET /orders/:id` → `supplierInvoice` | FR-019 | `buildSupplierInvoiceView` admits the operator and **omits the key** when none is confirmed |
| `GET /notifications` | FR-046 | role-agnostic, cursor-paged, `?unread=true` supported |
| `PATCH /notifications/:id/read` | FR-047 | role-agnostic |
| `PATCH /notifications/read-all` | FR-047 | role-agnostic, returns `{ updated }` |
| `PATCH /companies/:id/status` | FR-033 | already `@Roles(SUPER_ADMIN)`, type-agnostic — suspends a transport company today |
| `GET /users?role=…&companyId=…` | FR-034, FR-035 | `companyId` is already load-bearing for `SUPER_ADMIN` only |
| `GET /companies/:id/covered-regions` | FR-036 | already `@Roles(FUEL_COMPANY_ADMIN, SUPER_ADMIN)` |
| `GET /platform-account/movements` | FR-071 | `companyId` filter already SA-load-bearing |
| `POST /users/me/phone/verification` | FR-060 | no `@Roles` — every authenticated role, per-user throttled |
| `POST /users/me/phone/verification/confirm` | FR-060, FR-062 | does **not** touch `sessionGeneration` or `activeSessions` |

---

## 1. Platform overview — NEW

### `GET /platform/overview` — Story 1

**Roles**: `SUPER_ADMIN` only (FR-007).

**Query**: `from` (ISO date, optional) · `to` (ISO date, optional).

Both default to the current calendar month, reusing `OrdersController.summary`'s existing
resolution (FR-005). Both are read as whole-day boundaries.

**200**

```jsonc
{
  "period": {
    "from": "2026-09-01T00:00:00.000Z",
    "to": "2026-09-30T23:59:59.999Z",
    "isDefault": true,          // FR-005 — says so rather than leaving the caller to assume
    "orderCount": 612,          // orders RAISED in the period, every state
    "orderValue": 1834220.50,   // DELIVERED orders only
    "litresMoved": 158300000,   // DELIVERED orders only
    "basis": {                  // FR-001a — the two bases, stated not inferred
      "orderCount": "RAISED_IN_PERIOD",
      "orderValue": "DELIVERED_IN_PERIOD",
      "litresMoved": "DELIVERED_IN_PERIOD"
    }
  },
  "pointInTime": {              // FR-002 — NOT bounded by the period above
    "fuelCompanies": 9,
    "transportCompanies": 6,
    "stations": 97
  },
  "breakdown": {
    "byCompanyType": [
      { "type": "FUEL", "count": 9 },
      { "type": "TRANSPORT", "count": 6 }
    ],
    "byOrderBucket": [
      { "bucket": "NEW", "count": 34 },
      { "bucket": "IN_PROGRESS", "count": 128 },
      { "bucket": "COMPLETED", "count": 450 },
      { "bucket": "REJECTED", "count": 0 },
      { "bucket": "CANCELLED", "count": 0 },
      { "bucket": "NEEDS_ATTENTION", "count": 0 }
    ]
  }
}
```

**Contract guarantees**

- Every numeric field is **always present**, `0` on an empty period (FR-008). A client must never
  receive `null` or a missing key and have to guess whether it means zero or "not computed".
- `byOrderBucket` carries **all six** buckets, including zeros, and sums to `period.orderCount`
  exactly (FR-006, FR-023d). Both are computed from the same `createdAt`-bounded match over every
  state, which is what makes the sum hold.
- **`orderCount` is NOT delivered-only.** It counts orders raised in the period, in whatever state
  they have since reached. Restricting it to delivered orders would make it equal the `COMPLETED`
  bucket and force the other five to zero — the six-segment chart would be meaningless and FR-006
  unsatisfiable. `orderValue` and `litresMoved` *are* delivered-only, bounded by `deliveredAt`, per
  the spec's own Assumptions. The `basis` object states which is which (FR-001a).
- **No trend field exists, at any nesting level** (FR-009). The platform computes no
  period-over-period comparison; the dashboard must render none.
- `403` for every other role, including `FUEL_COMPANY_ADMIN` (FR-007, FR-074).

---

## 2. Company listing — CHANGED

### `GET /companies` — Story 2

**Roles**: unchanged (`SUPER_ADMIN`, `FUEL_COMPANY_ADMIN`).

**Query** (both NEW): `type` (`FUEL | TRANSPORT`) · `status` (`ACTIVE | SUSPENDED`).

Currently the handler binds **no query parameters at all** — the dashboard has been sending
`?type=FUEL` since feature 013 and the platform has never read it (research R2).

**Semantics**

| Case | Behaviour | Requirement |
|---|---|---|
| absent or empty `type` | every type — never a silent default | FR-011 |
| `type=FUEL` as `SUPER_ADMIN` | fuel companies only | FR-010 |
| `type=TRANSPORT` as `SUPER_ADMIN` | transport companies only | FR-010 |
| any `type` as `FUEL_COMPANY_ADMIN` | still only their own company — intersected, never widened | FR-012 |
| invalid `type` value | `400` | Constitution I |

`status` follows the same three rules (FR-013).

**Implementation note (binding)**: the service takes `{ id?, type?, status? }` as distinct fields
and builds one filter. `type` must **intersect** the `_id` narrowing for a `FUEL_COMPANY_ADMIN`,
never replace it — a merged `Record` a caller could overwrite is how FR-012 would silently invert.

---

## 3. Platform-wide orders — CHANGED

### `GET /orders` — Story 3

**Query** (NEW): `bucket` (`OrderStatusBucket`) and `orderId`, alongside the existing `status` and
`cursor`.

- `status` — one real state, as today (FR-016).
- `bucket` — one of the six named buckets, expanding to `status: { $in: [...] }` (FR-016).
- Supplying both `status` and `bucket`: `status` wins if it is a member of `bucket`; otherwise
  `400`. A silent empty result for a contradictory pair is the failure mode this refusal exists to
  prevent.
- `orderId` — an exact order identifier. Returns that order alone, or an empty page if the caller
  may not see it. Overrides `bucket` and `status` (FR-016a).

**Search scope is identifier-only, and that is a recorded decision** (research R13). `Order` has no
`orderNumber` or human reference field, its human-facing values live in embedded snapshots
(`clientSummary`, `warehouseSummary`, `deliveryAddressText`), and the platform carries no text index
anywhere. Free-text search would mean either a new text index over those sub-documents or an
unindexed regex scan of every order on the platform — the first is a schema change with a migration,
the second is a full collection scan on the operator's most-used screen. `orderId` needs no new
index and answers exactly the question SC-003 asks. **Free-text search is out of scope and FR-016a
records it**, so a later reader does not mistake the omission for an oversight.

**Binding implementation constraint**: the bucket expands to a **`$in` on `status`**, never a `$or`.
Both scoping plugins inject via `Query.where()`, which **replaces** a top-level key of the same name
rather than merging — the defect feature 016 hit on every `$or` over `ExchangeOffer`. `status`
collides with nothing either plugin injects, so `$in` is safe for every role. A `$or` would be
silently discarded for a `FUEL_COMPANY_ADMIN` and work perfectly for the operator (research R4).

Response shape, paging and per-row hydration are unchanged. FR-017's row fields are already present
via `toRoleScopedShape` plus the existing station hydration.

### `GET /orders/summary` — CHANGED

**Roles**: unchanged. `SUPER_ADMIN` now receives a **third shape**.

Today the handler branches two ways over three roles, so the operator silently receives the
**transport company's** summary (`awaitingAssignment`, `driversOnDuty`, `outstandingSettlements`) —
platform-wide figures answering a transporter's questions (research R5).

**200 for `SUPER_ADMIN`** (`PlatformSummaryDto`)

```jsonc
{
  "from": "2026-09-01T00:00:00.000Z",
  "to":   "2026-09-30T23:59:59.999Z",
  "buckets": {
    "NEW": 34, "IN_PROGRESS": 128, "COMPLETED": 450,
    "REJECTED": 2, "CANCELLED": 5, "NEEDS_ATTENTION": 3
  },
  "total": 622
}
```

`total` equals the sum of the six (FR-023d). `REJECTED` and `CANCELLED` are separate keys and must
never be summed into one figure by the platform (FR-023b). `NEEDS_ATTENTION` is its own key and is
never folded into `NEW` or `IN_PROGRESS` (FR-023c).

`FUEL_COMPANY_ADMIN` and `TRANSPORT_COMPANY_ADMIN` responses are **byte-for-byte unchanged**
(FR-075).

### `PATCH /orders/:id/force-complete` — CHANGED

**Roles**: `FUEL_COMPANY_ADMIN` → `FUEL_COMPANY_ADMIN, SUPER_ADMIN` (FR-020).

Permitted stages are unchanged — `LOADING`, `IN_TRANSIT`, `UNLOADING` — but move from three inline
literal comparisons into `FORCE_COMPLETABLE_STATUSES` (Constitution I; research R7).

**Body**: `{ "reason": string }` (required, unchanged).

**409** at any other stage, naming the permitted set, leaving the order untouched (FR-021).

### FR-022 — the platform commission on an order is ALWAYS absent

Verified: `Order` carries **no commission field of any kind**. The platform records commission as
`COMMISSION_CHARGED` movements on a company ledger, sourced from an *invoice*, never from an order.
So FR-022's "where the platform records one" is never satisfied for an order, and the element is
always absent under FR-024. This is a determinate outcome, not a runtime condition — the dashboard
removes the element rather than conditionally hiding it, and records the removal (FR-078).

---

## 4. Transport companies — NEW

### `POST /companies/transporters` — Story 4

**Roles**: `SUPER_ADMIN` only.

Distinct from the existing `POST /companies/:id/transporters`
(`@Roles(FUEL_COMPANY_ADMIN)`), where `:id` means *the acting admin's own company*. The operator has
no company, and the parent is a choice rather than the actor's identity (research R12).

**Body**

```jsonc
{
  "parentFuelCompanyId": "…",   // REQUIRED (FR-029, FR-030)
  "name": "…",
  "contactEmail": "…",
  "contactPhone": "…",
  "adminEmail": "…",
  "adminFullName": "…",
  "adminPhone": "…",
  "adminPassword": "…"
}
```

**Validation**

| Condition | Response | Requirement |
|---|---|---|
| `parentFuelCompanyId` absent / empty / malformed | `400`, nothing created | FR-030 |
| names a company that does not exist | `400`, nothing created | FR-030 |
| names a company whose `type` is not `FUEL` | `400`, nothing created | FR-030 (purpose, not just letter) |
| duplicate company name / admin email / admin phone | `409`, **nothing created** | FR-028 |

**Atomicity (FR-028)**: company and first administrator are created in **one**
`session.withTransaction`, reusing the existing route's transaction verbatim. A failure on either
leaves neither — never a company nobody can sign in to.

**The one step deliberately NOT copied**: the existing route ends with a post-insert `companyId`
correction, because the tenant plugin's `pre('save')` overwrites a new user's `companyId` with the
**acting** admin's tenant. For a `SUPER_ADMIN` actor that hook returns early and writes nothing, so
the correction is a no-op. It is omitted, with a comment saying why — so a future reader does not
"fix" this path by removing the bypass it depends on (research R12).

**201**: `{ "company": { … }, "admin": { "id": "…", "email": "…" } }` — same shape as the existing
route.

**FR-031 holds by construction**: nothing records who performed the onboarding, so there is no field
by which an operator-onboarded transporter could differ from a parent-onboarded one.

### `GET /companies?type=TRANSPORT` — see §2

Serves FR-025. Each row carries `servedRegions` already; its **length** is FR-026's covered-area
count, computed by the dashboard from data it already receives. No new field.

### `GET /platform/transport-company-volumes` — NEW, FR-026

**Roles**: `SUPER_ADMIN` only.

**Query**: `companyIds` (comma-separated, required — the ids on the page being rendered) · `from` ·
`to` (both optional, resolved **identically to `GET /platform/overview`**).

**200**

```jsonc
{
  "from": "2026-09-01T00:00:00.000Z",
  "to":   "2026-09-30T23:59:59.999Z",
  "isDefault": true,
  "items": [
    { "companyId": "…", "orderCount": 42 },
    { "companyId": "…", "orderCount": 0 }    // never routed to — 0, never absent
  ]
}
```

**Contract guarantees**

- **One aggregate for the whole page**, never one request or one query per company (FR-026b). `Order`
  already carries `transportCompanyId` with an index, so a single `$match` + `$group` resolves every
  row.
- A company with no orders appears with `orderCount: 0`, **not omitted** — the spec's edge case
  requires a transporter no fuel company has ever routed to to appear in the list with zero, not as
  absent.
- The period is **the same range the overview uses**, defaulting the same way (FR-026a), so the two
  operator screens cannot disagree about what "this period" means.
- Counts orders **raised** in the period, on the same basis as the overview's `orderCount`
  (FR-001a) — a transporter's workload is what it was given, not only what it finished.

This replaces an earlier deferral that left FR-026 with no design (research R14).

---

## 5. Driver roster — NEW

### `GET /drivers/roster` — Story 5

**Roles**: `SUPER_ADMIN` only.

A new route rather than a filter on `GET /users?role=DRIVER`, which returns an **unbounded array**
with no cursor, no employer and no truck (research, cross-cutting).

**Query**: `isActive` (`true|false`) · `dutyState` (`ON_DUTY|OFF_DUTY|UNKNOWN`) · `cursor`.

**200**

```jsonc
{
  "items": [
    {
      "driverId": "…",
      "fullName": "…",
      "phone": "…",
      "isActive": true,
      "dutyState": "ON_DUTY",
      "transportCompany": { "id": "…", "name": "…" },
      "lastOperatedTruck": { "id": "…", "plateNumber": "…" }
    },
    {
      "driverId": "…",
      "fullName": "…",
      "phone": "…",
      "isActive": true,
      "dutyState": "UNKNOWN",        // never connected — FR-040
      "transportCompany": { "id": "…", "name": "…" },
      "lastOperatedTruck": null      // never driven — FR-039b
    }
  ],
  "nextCursor": null
}
```

**Contract guarantees — these are the testable privacy boundary (SC-014)**

- The response carries **no** `location`, `lastSeenAt`, `lastMovedAt`, `lastMovedLocation`,
  `activeOrderId`, trip count, delivery date, order reference or stop history (FR-043, FR-044).
- `lastOperatedTruck` is derived from order history and carries **only** the truck's identity and
  plate. Nothing about the orders it was derived from — not their number, dates, customers or routes
  — appears anywhere in this payload (FR-044a).
- `lastOperatedTruck: null` means **never driven**. It is distinct from a truck whose identity could
  not be resolved, which is a `500`, not a `null` (FR-039b).
- `dutyState` is three-valued. A driver who has never connected is **present with `UNKNOWN`**, never
  omitted (FR-040). The listing sorts on `createdAt`/`_id` — fields every driver document has —
  precisely so such a driver cannot be silently dropped, which is how feature 010's dispatch listing
  lost them.

### `GET /users/:id` — UNCHANGED

Serves FR-042. Already role-guarded and already returns the driver's own record. The employing
company is read via `GET /companies/:id`. **The driver detail screen drops the excluded cards**
rather than rendering them empty (FR-045) — a removal, not a route.

---

## 6. Announcements — NEW

### `POST /announcements` — Story 6

**Roles**: `SUPER_ADMIN` only (FR-056).

**Body**

```jsonc
{
  "title": "…",
  "body": "…",
  "targetCompanyIds": []     // empty ⇒ every active company (FR-049/FR-050)
}
```

**202 Accepted** — deliberately not `201`. The fan-out is enqueued, not performed (FR-055).

```jsonc
{ "announcementId": "…", "intendedRecipientCount": 14, "state": "QUEUED" }
```

**Recipient resolution (FR-049, FR-051)**: every `isActive` user holding `FUEL_COMPANY_ADMIN` or
`TRANSPORT_COMPANY_ADMIN` in an `ACTIVE` company. **`CLIENT` and `DRIVER` are never recipients** —
this is asserted by role, not by count (SC-008).

**Delivery (FR-053, FR-054)**: one `AnnouncementDelivery` per intended recipient, with a unique
index on `(announcementId, recipientUserId)`. A redelivered job's duplicate insert is caught and
skipped, so a retry produces zero duplicate notifications. Unreachable recipients get a row carrying
a named `failureReason` and **no** `notificationId` — recorded as missed, never counted as
delivered.

### `GET /announcements` — NEW

**Roles**: `SUPER_ADMIN` only. Cursor-paged, newest first. Serves FR-052 — what was sent and to
whom, distinct from the individual deliveries.

### `GET /announcements/:id` — NEW

**Roles**: `SUPER_ADMIN` only. The announcement plus its delivery tallies and the failure rows
(FR-054).

---

## 7. Operator profile — NEW + CHANGED

### `GET /auth/me/account` — NEW

**Roles**: `SUPER_ADMIN` (extensible to the other administrator roles later; this feature exposes it
to the operator alone, FR-074).

**200**

```jsonc
{
  "fullName": "…",
  "email": "…",
  "phone": "+9665…",          // FR-057 — the real sign-in identifier, not a mask
  "activeSessionCount": 2,    // FR-059 — User.activeSessions.length
  "lastSignInAt": "2026-09-12T08:14:22.000Z"   // FR-058 — newest SIGNED_IN SessionEvent
}
```

Carries **no permission list and no account statistic** — the platform records neither, so both are
absent rather than fabricated (FR-063).

### `POST /users/me/phone/verification` — CHANGED (one lookup only)

The route, its throttle, its `202` shape and its confirm step are **unchanged**. One thing changes
inside `PhoneVerificationService.requestVerification`: the duplicate-holder check.

It currently calls `findByPhoneForAuth`, which is **deliberately scoped to `CLIENT` and `DRIVER`**.
The unique phone index covers **all five roles**. So a number held by another **administrator**
passes the pre-check, an SMS is spent, and the change fails as a `409` only at confirm time —
violating both FR-061's timing and the service's own documented promise that "a message is never
spent on a doomed change" (research R10).

**Change**: a new, narrow existence check — **any role, any active state** — used only here.

| Condition | Response | Requirement |
|---|---|---|
| number held by any other account, any role, active or not | `409 PHONE_IN_USE`, **no SMS sent**, existing number unchanged | FR-061 |
| number is the caller's own current number | unchanged behaviour | — |

`findByPhoneForAuth` and `findSingleActiveAdminByPhone` are **not** modified — both are load-bearing
for sign-in and their scoping is deliberate and commented (FR-075).

**FR-062 is a guarantee about what does not happen**: confirming a number change must not bump
`sessionGeneration` or clear `activeSessions`. Already true; asserted by a regression test, because
a future "re-authenticate after a credential change" instinct would break feature 015's concurrent
administrator sessions.

---

## 8. Cashback settlement — NEW

### `GET /platform-account/cashback/:companyId/owed` — NEW

**Roles**: `SUPER_ADMIN` only (FR-072).

**200**: `{ "companyId": "…", "owed": 14250.5, "currency": "SAR" }`

Computed live as `confirmed(CASHBACK_CREDITED) − confirmed(CASHBACK_PAID_OUT)`, never stored
(FR-065). The existing `getConfirmedBalance` is **per-kind** and cannot answer this on its own — a
payout under a new kind leaves the `CASHBACK_CREDITED` total untouched, which is the trap research
R11 exists to flag.

### `POST /platform-account/cashback/:companyId/payouts` — NEW

**Roles**: `SUPER_ADMIN` only (FR-072). A company can never record money as having been paid to it.

**Body**: multipart — `amount` (number > 0), `method` (`SettlementMethod`), `reference` (string,
required), `evidence` (file, optional).

**Transactional (FR-069, Constitution V)**: the owed balance is re-read **inside** the session and
compared there. The figure the operator's screen displayed has no authority.

| Condition | Response | Requirement |
|---|---|---|
| `amount` ≤ owed | `201`, movement created **already `CONFIRMED`** | FR-066, FR-067 |
| `amount` > owed (evaluated in-session) | `409`, **nothing recorded** | FR-068, FR-069 |
| `reference` already used for this company | `409`, refused not applied | FR-070 |
| caller is not `SUPER_ADMIN` | `403` | FR-072 |

FR-070 is enforced by a **partial unique index** on `(companyId, kind, reference)`, not by a prior
read — a read-then-write is a race under concurrent submission.

**201**

```jsonc
{
  "_id": "…",
  "companyId": "…",
  "kind": "CASHBACK_PAID_OUT",
  "direction": "OUTBOUND",       // FR-064 — derived from kind, never a schema field
  "amount": 14250.5,
  "currency": "SAR",
  "method": "BANK_TRANSFER",
  "reference": "…",
  "documentFileId": "…",
  "state": "CONFIRMED",
  "confirmedBy": "…",
  "confirmedAt": "…"
}
```

### `GET /platform-account/movements` — CHANGED (response only)

Every movement in the response gains a derived `direction` (`INBOUND` | `OUTBOUND`). No schema
field, no migration, no change to any existing field — so feature 013's dashboard reads it
unchanged (research R11). This is what makes Story 8's scenario 6 satisfiable: a payout is never
indistinguishable from a payment the company made (FR-064, FR-071).

**No payment provider is integrated** (FR-073). These routes record that money moved elsewhere.

---

## 9. Authorization matrix

Every route in §1–§8 marked `SUPER_ADMIN` returns **403** for `FUEL_COMPANY_ADMIN`,
`TRANSPORT_COMPANY_ADMIN`, `CLIENT` and `DRIVER` (FR-074). SC-012 requires this verified **per
capability**, not once for the feature — so each new route carries its own refusal test.

| Route | SA | FCA | TCA | CLIENT | DRIVER |
|---|---|---|---|---|---|
| `GET /platform/overview` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST /companies/transporters` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET /platform/transport-company-volumes` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET /drivers/roster` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST /announcements` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET /announcements`, `GET /announcements/:id` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET /auth/me/account` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET …/cashback/:companyId/owed` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST …/cashback/:companyId/payouts` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `PATCH /orders/:id/force-complete` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `GET /companies` (`?type`, `?status`) | ✅ | ✅ own only | ❌ | ❌ | ❌ |
| `GET /orders` (`?bucket`, `?orderId`) | ✅ all | ✅ own | ✅ own | ✅ own | ✅ own |

The last two rows are the FR-012 / FR-075 guarantee in table form: a new filter **narrows** an
existing caller's result and never widens it.
