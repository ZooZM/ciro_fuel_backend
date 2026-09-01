# Phase 1 Data Model: Client Mobile App — Backend Integration

**Feature**: `005-client-backend-integration` | **Date**: 2026-08-15

Changes are grouped as **new collections**, **modified collections**, and **derived responses**
(computed, not stored). Every new or modified collection states its isolation mechanism
explicitly — Principle II requires isolation to be structural, so "which plugin" is a modelling
decision, not an implementation detail.

Field types are Mongoose/TypeScript. Enum values are named constants per Principle I; no literal
appears in code.

---

## New collections

### `Station` — `src/modules/stations/schemas/station.schema.ts`

Promoted from the embedded sub-document on `User` (research R1). A client's site that receives
fuel deliveries.

| Field | Type | Rules |
|---|---|---|
| `_id` | ObjectId | |
| `companyId` | ObjectId → Company | Required, immutable. The client's fuel company. |
| `clientId` | ObjectId → User | Required, immutable. Indexed. |
| `name` | string | Optional display label ("محطة الرحاب"). |
| `regionCode` | RegionCode | Required. Carried from the existing embedded schema — drives routing (spec 004 FR-014). |
| `governorateCode` | GovernorateCode | Required. |
| `location` | GeoPoint | Required. The dropped pin. |
| `addressText` | string | Default `''`. Geocode-suggested, admin-edited, never re-derived on read. |
| `isDefault` | boolean | Default `false`. Exactly one per client (see invariant below). |
| `isFavourite` | boolean | Default `false`. **Client-written**; the only field a CLIENT may modify. |
| `isActive` | boolean | Default `true`. Withdrawal is a soft delete — FR-036c requires historical orders to stay readable. |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps. |

**Isolation**: single-tenant → the original `companyId`-equality plugin via `markTenantScoped`.
Not the multi-party plugin — a station has exactly one owning company.

**Additional ownership check**: the tenant plugin scopes to the company, which is not enough. A
CLIENT must reach only their *own* stations, and two clients share a fuel company. Every
client-facing station query therefore adds `clientId = currentUser.userId` on top of the plugin.
This is the same belt-and-braces the users controller already applies for self-access.

**Invariants**:

- Exactly one `isDefault: true` per `clientId` among active stations. Enforced by a partial unique
  index on `{ clientId: 1, isDefault: 1 }` where `isDefault: true` — a DB-level guarantee, per
  Principle V, not an application assumption.
- `isActive: false` never blocks reading a station referenced by an existing order.
- A client may write `isFavourite` and nothing else. Enforced by a DTO that whitelists that single
  field (the `dto-whitelist.spec.ts` unit test is the existing pattern for asserting this).

**Indexes**:

- `{ clientId: 1, isActive: 1 }` — the list query.
- `{ clientId: 1, isDefault: 1 }` partial unique on `isDefault: true` — the invariant above.

---

### `PhoneVerification` — `src/modules/users/schemas/phone-verification.schema.ts`

Short-lived pending phone changes (research R4). Deliberately **not** on the user document, since
FR-035c requires the user's phone to stay untouched until the code is accepted.

| Field | Type | Rules |
|---|---|---|
| `_id` | ObjectId | |
| `userId` | ObjectId → User | Required, immutable. |
| `newPhone` | string | Required. E.164. |
| `hash` | string | Required. Salted SHA-256 of the code — never the code itself. |
| `salt` | string | Required. |
| `expiresAt` | Date | Required. TTL index. |
| `attempts` | number | Default 0. Max 5 (`AppLimits.otpMaxAttempts`). |
| `consumedAt` | Date | Optional. Set on success; a consumed record can never verify again. |
| `createdAt` | Date | Required. Drives the 3-requests-per-15-minutes throttle. |

**Isolation**: not tenant-scoped — it is keyed by `userId` and only ever queried by the owning
user's own id. Marking it tenant-scoped would be misleading, since a user's identity, not their
company, is the boundary.

**Invariants**:

- At most one unconsumed, unexpired record per `userId`. A new request supersedes any prior
  unconsumed one (matching how `OtpService.issue` drops stale records).
- `newPhone` must not already belong to another user — checked **before** a code is sent
  (FR-035e), so an SMS is never spent on a doomed change.
- The plaintext code is never stored, never returned in any response, never logged (FR-035g).
  It exists only in the SMS body and, briefly, in the Redis cache the existing OTP mechanism uses.

**Indexes**:

- `{ userId: 1, consumedAt: 1 }`.
- `{ expiresAt: 1 }` TTL — expired records self-delete rather than accumulating.

---

### `SupportRequest` — `src/modules/support/schemas/support-request.schema.ts`

| Field | Type | Rules |
|---|---|---|
| `_id` | ObjectId | |
| `companyId` | ObjectId → Company | Required, immutable. The client's fuel company — the routing target. |
| `clientId` | ObjectId → User | Required, immutable. |
| `orderId` | ObjectId → Order | Optional. Present when raised from an order (FR-038). |
| `topic` | SupportTopic | Required. Enum, mirroring the app's existing `support_topics.dart`. |
| `message` | string | Required, trimmed, 1–2000 chars. |
| `state` | SupportRequestState | `SUBMITTED` \| `ACKNOWLEDGED`. Default `SUBMITTED`. **Two states only** (FR-039a). |
| `acknowledgedAt` | Date | Optional. |
| `acknowledgedBy` | ObjectId → User | Optional. A fuel company admin. |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps. |

**Isolation**: single-tenant → the original `companyId` plugin. Client-facing reads add
`clientId = currentUser.userId`, as with stations.

**Invariants**:

- `state` transitions `SUBMITTED → ACKNOWLEDGED` only. No reverse, no third state.
- `acknowledgedAt` and `acknowledgedBy` are set together or not at all.
- When `orderId` is present it must belong to `clientId` — a client cannot attach someone else's
  order to a support request.

---

## Modified collections

### `Company` — add `pricingConfig`

New embedded sub-document beside the existing `fuelPrices` (research R2).

| Field | Type | Rules |
|---|---|---|
| `deliveryFee` | number | Required, `min: 0`. Flat, per order, in SAR. |
| `serviceFeePercent` | number | Required, `min: 0`, `max: 100`. Applied to the fuel line total. |
| `taxRatePercent` | number | Required, `min: 0`, `max: 100`. Applied to fuel + delivery + service. |
| `tankerCapacitiesLiters` | number[] | Required, non-empty, ascending, each `min: 1`. The quantities this company sells in — the ladder the client's quantity selector steps through (FR-017). |
| `updatedAt` | Date | When the configuration last changed. |

**On `tankerCapacitiesLiters`**: this is the fuel company's own commercial configuration, *not* a
derivation from anyone's fleet. The only capacity currently in the schema is
`Truck.maxCapacityLiters`, embedded on driver users owned by **transport** companies — reading
those to build a client-facing list would cross a tenant boundary (FR-017a). The two are unrelated:
what a fuel company sells in and what a given tanker holds are different facts.

`pricingConfig` is **optional on the schema** but required in practice: FR-011j says a company
without one cannot have orders priced against it. Making it optional in the schema and required
at the pricing boundary is deliberate — it lets the field be added without invalidating every
existing company document, while still failing loudly at the point that matters.

FUEL companies only, matching `fuelPrices`. A TRANSPORT company never has one.

---

### `Order` — add `priceBreakdown` and `stationId`

| Field | Type | Rules |
|---|---|---|
| `stationId` | ObjectId → Station | Optional. The station this order was delivered to. Optional because orders predating R1's migration have none; every new order sets it. |
| `priceBreakdown` | PriceBreakdown | Optional sub-document. Absent on orders predating this feature — see the back-fill decision in research R2. |

**`PriceBreakdown` sub-document** — the four components and the three rates that produced them:

| Field | Type | Rules |
|---|---|---|
| `fuelLineTotal` | number | `min: 0`. unit price × litres. |
| `deliveryFee` | number | `min: 0`. |
| `serviceFee` | number | `min: 0`. |
| `tax` | number | `min: 0`. |
| `total` | number | `min: 0`. **The sum of the four rounded components** (research R2). |
| `unitPrice` | number | The fuel price per litre in force at pricing time. |
| `serviceFeePercent` | number | The rate in force at pricing time. |
| `taxRatePercent` | number | The rate in force at pricing time. |
| `currency` | string | Default `'SAR'`. |
| `pricedAt` | Date | When the breakdown was computed. |

**Invariants**:

- `fuelLineTotal + deliveryFee + serviceFee + tax === total`, each rounded half-up to 2dp before
  summing. This is FR-011b and it must be asserted in a unit test, not assumed — floating-point
  currency arithmetic fails this exactly often enough to reach production.
- Every component is present, zero rather than omitted when inapplicable (FR-011d).
- Immutable once written. FR-011i: a later change to the company's `pricingConfig` must not touch
  a placed order. Enforced by never including `priceBreakdown` in any update path.
- `total` must equal the order's `estimatedPrice` at creation, and `finalPrice` once confirmed —
  the existing fields remain authoritative for the payment and invoice paths; the breakdown
  explains them rather than replacing them.

**New index** (research R3): `{ clientId: 1, statusChangedAt: -1, _id: -1 }` and
`{ clientId: 1, status: 1, statusChangedAt: -1, _id: -1 }`.

---

### `PaymentEvent` — add `clientId`

| Field | Type | Rules |
|---|---|---|
| `clientId` | ObjectId → User | Denormalised from the order at write time (research R5). Required on new events; back-filled for existing ones. |

Without it, a client's payment history requires resolving every event through its order, and the
index that makes SC-004a hold cannot be built.

**New index**: `{ clientId: 1, createdAt: -1, _id: -1 }`.

**Response shaping**: `rawPayload` MUST NOT appear in any client-facing response. It holds the
gateway's untouched payload and can carry gateway-side card metadata — a Principle II violation
if projected.

---

### `User` — `station` deprecated

`user.station` stays in place through the transition and is populated from the client's default
`Station` for backward compatibility with `GET /auth/me`. It is marked deprecated in the schema
and removed in a follow-up once no reader remains. It must not be written by any new code path.

---

### `Notification` — no schema change

`NotificationType` gains a `SUPPORT_REQUEST_RAISED` member (Principle I: enum, not a literal).
The unread count (FR-030) is a `countDocuments` on the existing `readAt: null` filter, returned
alongside the list — no stored counter, which would only drift.

**New index**: `{ recipientUserId: 1, createdAt: -1, _id: -1 }`.

---

### `Invoice` — add `priceBreakdown`

| Field | Type | Rules |
|---|---|---|
| `priceBreakdown` | PriceBreakdown | Optional. **Copied from the order at issuance**, never recomputed. |

FR-011e requires the quote, the order receipt and the invoice to show the same breakdown for a
given order, and SC-008a makes that testable. An invoice carrying only `amount` cannot satisfy it.

**Copied, not referenced or recomputed** — three reasons, and they all point the same way:

- An invoice is a financial document. It must remain readable and self-consistent even if the
  order it was issued against is later amended or force-completed.
- Recomputing at read time would reintroduce exactly the drift FR-011i exists to prevent.
- A join to the order on every invoice read is the wrong cost on a paginated list.

**Invariants**:

- `priceBreakdown.total` MUST equal `invoice.amount`. If they can disagree, the client is shown two
  different figures for one debt — assert this at issuance, in a transaction, not afterwards.
- Immutable once written, like the order's copy.
- Absent on invoices issued before this feature, mirroring `Order.priceBreakdown` — the app renders
  a total-only invoice in that case.

**New index**: `{ clientId: 1, state: 1, createdAt: -1, _id: -1 }` — note this carries `state` in
the prefix, unlike the other paginated collections, because of the sort below. The cursor must
encode `state` alongside `createdAt` and `_id` for the ordering to remain stable.

Additionally, `GET /invoices` sorts **outstanding before settled**, then newest-first within each
group (FR-048f). Without this an old unpaid invoice can fall past the last loaded page while still
counting against the client's credit — the one case where pagination and the credit story
interact badly.

---

## Derived responses (computed, never stored)

### Credit Standing

Computed per request from `user.creditLimit` and `InvoicesService.getAvailableCredit` (research
R6):

| Field | Derivation |
|---|---|
| `creditLimit` | `user.creditLimit`, or `null` when no facility is assigned (FR-027). |
| `available` | `getAvailableCredit(clientId)` — the existing function, unchanged. |
| `consumed` | `creditLimit − available`. |
| `currency` | `'SAR'`. |

Stored nowhere. A stored balance would drift from the calculation that actually blocks over-limit
orders, and FR-026 requires the dashboard and credit screen to agree — which only holds if both
read one derivation.

### Quote

Computed by the pricing service, never persisted until the order is created (research R10):
the full `PriceBreakdown` shape plus `quoteToken` (a hash of the pricing inputs) and `expiresAt`.

---

## Entity relationships

```
Company (FUEL)
├── fuelPrices[]          (existing)
├── pricingConfig          (new)          ── derives ──> Order.priceBreakdown
└── clients: User[] (role CLIENT)
     ├── Station[]         (new)          ── referenced by ──> Order.stationId
     ├── PhoneVerification[] (new, transient)
     ├── SupportRequest[]  (new)          ── optionally references ──> Order
     ├── Order[]           (modified)     ── has one ──> Invoice
     │                                     ── has many ──> PaymentEvent
     └── Notification[]    (existing)
```

---

## Migration

One script, run once, covering all three back-fills together so the collections never disagree:

1. For each CLIENT with an embedded `user.station`, create a `Station` document with
   `isDefault: true`, carrying every field across unchanged.
2. For each existing `Order`, set `stationId` to its client's newly created default station.
   `priceBreakdown` is deliberately left absent (research R2 — no fabricated financial records).
3. For each existing `PaymentEvent`, set `clientId` from its order.

Idempotent, and extends the existing `test/e2e/migration.e2e-spec.ts` pattern rather than
introducing a new one. It must be verified against a copy of production-shaped data before it is
run for real: step 1 is the one that changes what `GET /auth/me` returns to every role, including
drivers.
