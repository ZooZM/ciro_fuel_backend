# Phase 1 Data Model: Fuel Company Admin Dashboard

**Feature**: `013-fuel-company-dashboard` | **Date**: 2026-09-03

Four new collections, one new embedded sub-document, and additive fields on two existing schemas.
Isolation markers follow R6; the test is **whether more than one company must read it**, not whether
more than one role must.

---

## Isolation assignment (R6, R3)

| Collection | Marker | Owning field | Rationale |
|---|---|---|---|
| `CommissionTerm` | *(none — platform-level)* | — | Set by the operator, read by every company. Follows `Company`'s precedent for platform-level records with no tenant above them. |
| `CashbackProgramme` | *(none — platform-level)* | — | Same. Targeting is a field on the record, not an isolation boundary. |
| `AccountMovement` | `markTenantScoped` | `companyId` | One fuel company; the operator reads it through the `SUPER_ADMIN` bypass. |
| `CreditLimitRequest` | `markTenantScoped` | `companyId` | One fuel company; the client is its subject and reads within that tenant. |
| `LitreBalance` | `markTenantScoped` | `companyId` | One fuel company; the client reads their own. Exactly `Station`'s shape — clients already read `markTenantScoped` records today. |
| `ExchangeRequest` | **`markPartySet`** (new, R3) | `partyCompanyIds[]` | **Two** fuel companies must read it. Neither existing plugin can express this; see plan Complexity Tracking. |
| `Order.supplierInvoice` | *(inherits `Order`)* | — | Embedded sub-document (R7). |

**The `markPartySet` mechanism**: injects `{ partyCompanyIds: <actingCompanyId> }` on read (an array
membership match, not equality) and, on create, requires the acting company to be among the parties
rather than forcing a single owner. `SUPER_ADMIN` bypasses, as with both existing plugins.

---

## New collections

### `CommissionTerm`

Effective-dated (R10). Never mutated — a rate change writes a new record.

| Field | Type | Notes |
|---|---|---|
| `basis` | enum `PERCENTAGE \| PER_UNIT` | FR-055. Named constant, never a literal (Principle I). |
| `rate` | number | Percentage points, or currency per unit of invoice value |
| `effectiveFrom` | Date | The accrual reads the record in force at its instant |
| `setBy` | ObjectId → User | Operator only (FR-056) |

**Rule**: no update path. FR-058 holds structurally rather than by discipline.

### `CashbackProgramme`

| Field | Type | Notes |
|---|---|---|
| `basis` | enum `PERCENTAGE \| PER_UNIT` | FR-059 |
| `rate` | number | |
| `isActive` | boolean | FR-059's on/off |
| `targetsAllCompanies` | boolean | FR-059 |
| `targetCompanyIds` | ObjectId[] | Meaningful only when `targetsAllCompanies` is false |
| `effectiveFrom` | Date | |
| `setBy` | ObjectId → User | |

**Rule**: accrual requires `isActive` **and** (`targetsAllCompanies` or membership) — FR-060. Both
conditions evaluated at payment time against the record in force then.

### `AccountMovement`

One entry in a company's ledger with the platform (FR-064).

| Field | Type | Notes |
|---|---|---|
| `companyId` | ObjectId → Company | Forced by the tenant plugin |
| `kind` | enum `COMMISSION_CHARGED \| CASHBACK_CREDITED \| PAYMENT_RECORDED` | Named constant |
| `amount` | number | Currency stated separately (FR-098) |
| `currency` | string | |
| `sourceInvoiceId` | ObjectId → Invoice | Present for charge/credit; absent for a payment |
| `appliedRate` | number | **Stamped at accrual** (R10) — never re-derived from current terms |
| `appliedBasis` | enum | Stamped with the rate |
| `method` | enum `BANK_TRANSFER \| NATIONAL_PAYMENT_SERVICE` | Payments only (FR-066) |
| `reference` | string | The payment reference where one applies |
| `documentFileId` | ObjectId → FileRecord | Evidence (FR-067) |
| `state` | enum `RECORDED \| CONFIRMED` | FR-068 — only `CONFIRMED` affects the balance |
| `confirmedBy` / `confirmedAt` | ObjectId → User / Date | FR-069 |
| `reversalOfId` | ObjectId → AccountMovement | FR-063 |

**Rules**:
- A `PAYMENT_RECORDED` movement MUST carry `documentFileId` or `reference` (FR-067).
- Balance = sum of **confirmed** movements only (FR-068, SC-012). Never a stored running total that
  can drift from its own ledger.
- Reversal is a compensating movement, never a delete (FR-063).

### `CreditLimitRequest`

| Field | Type | Notes |
|---|---|---|
| `companyId` | ObjectId → Company | Tenant plugin |
| `clientId` | ObjectId → User | The station owner requesting |
| `requestedAmount` | number | FR-029 |
| `state` | enum `PENDING \| ACCEPTED \| REJECTED` | |
| `grantedAmount` | number | Present when accepted; may differ from requested (FR-030) |
| `resolvedBy` / `resolvedAt` | ObjectId → User / Date | |

**Rule**: resolution is a **conditional update filtered on `state: PENDING`** — `modifiedCount`
decides which of two concurrent resolutions wins (FR-031, SC-008). This is the idiom the escalation
processor already uses; a read-then-write would let both administrators resolve it.

### `LitreBalance`

| Field | Type | Notes |
|---|---|---|
| `companyId` | ObjectId → Company | Tenant plugin |
| `clientId` | ObjectId → User | |
| `fuelType` | enum `FuelType` | The platform's own grades only (FR-077) |
| `balanceLitres` | number | |
| `movements` | `LitreMovement[]` | Embedded; see below |

**Unique index** on `(companyId, clientId, fuelType)` — one balance per owner per grade.

#### `LitreMovement` (embedded, **keeps its `_id`**)

| Field | Type | Notes |
|---|---|---|
| `kind` | enum `SHORTFALL_CREDIT \| EXCESS_DEBIT \| ORDER_DRAWDOWN \| DRAWDOWN_RETURNED \| CORRECTION` | |
| `litres` | number | Signed |
| `orderId` | ObjectId → Order | Present for every kind except `CORRECTION` (FR-075a) |
| `reason` | string | **Required** for `CORRECTION` (FR-075) |
| `actorId` | ObjectId → User | FR-074a |
| `at` | Date | |

**Rules**:
- `balanceLitres` MUST equal the sum of `movements.litres` (SC-014a). Enforced by only ever writing
  the two together in one conditional update.
- At most one `SHORTFALL_CREDIT`/`EXCESS_DEBIT` per `orderId` (FR-073e) — a **partial unique index**
  on `movements.orderId` for those kinds is what makes a retried upload idempotent, rather than an
  application-level "have we done this already" check.
- `ORDER_DRAWDOWN` is written inside the order-creation transaction as a conditional update carrying
  the expected balance (R9, Principle V).

### `ExchangeRequest` — the two-party record (R3)

| Field | Type | Notes |
|---|---|---|
| `partyCompanyIds` | ObjectId[2] → Company | **The isolation field.** Raiser and recipient. |
| `raisedByCompanyId` | ObjectId → Company | Which party is which — gives direction (FR-079) |
| `recipientCompanyId` | ObjectId → Company | |
| `raisedByUserId` | ObjectId → User | |
| `fuelType` | enum `FuelType` | Must be sold by the recipient (FR-085) |
| `quantityLitres` | number | |
| `unitPrice` / `currency` | number / string | FR-098 |
| `deliveryAt` | Date | A **term of the agreement**, not an instruction to the platform (FR-086a) |
| `deliveryPlaceText` | string | Same |
| `state` | enum `AWAITING_RESPONSE \| ACCEPTED \| DECLINED \| WITHDRAWN` | |
| `resolvedBy` / `resolvedAt` | ObjectId → User / Date | |

**Rules**:
- `partyCompanyIds` MUST contain exactly the two ids, and the acting company MUST be one of them on
  create — the party-set plugin enforces membership rather than forcing a single owner.
- Resolution is a **conditional update filtered on `state: AWAITING_RESPONSE`** (FR-082) — this is
  what makes accept-versus-withdraw at the same instant produce one outcome both parties see
  (SC-008, and the spec's own edge case).
- **No order, delivery or invoice is created on acceptance** (FR-086a).
- Direction is derived from `raisedByCompanyId` against the viewer, never stored per-viewer.

---

## Additions to existing schemas

### `Order` — supplier invoice (embedded, R7)

`Order.supplierInvoice`, one per order, **keeping its `_id`** (the confirm, replace and
balance-movement paths each address one specific invoice).

| Field | Type | Notes |
|---|---|---|
| `fileId` | ObjectId → FileRecord | The document. `FileRecord` is `markTenantScoped`, which is what makes FR-073f already true. |
| `extracted` | `{ quantityLitres?, fuelType?, reference?, issueDate? }` | What the platform read (FR-073a-i) |
| `confirmed` | `{ quantityLitres, fuelType, reference, issueDate }` | What the administrator confirmed — **this is what counts** (FR-073a-ii) |
| `confirmedBy` / `confirmedAt` | ObjectId → User / Date | |
| `supersededAt` | Date | Set when replaced (FR-073e) |

**Rules**:
- `confirmed` absent ⇒ nothing recorded, no balance movement (SC-014c). An abandoned upload leaves no
  sub-document at all.
- `confirmed.fuelType` MUST equal `Order.fuelType` (FR-073g).
- Shortfall = `Order.quantityLitres − confirmed.quantityLitres`; positive credits the owner, negative
  debits (FR-073c/d).
- Retaining `extracted` alongside `confirmed` is what makes extraction accuracy measurable after the
  fact (FR-073a-iv, SC-014d).

### `Company` — commission ceiling (FR-062a/b)

| Field | Type | Notes |
|---|---|---|
| `commissionCeiling` | number, optional | **Optional by design.** Absent means the platform-wide default governs, so changing that default cannot silently overwrite a ceiling the operator set explicitly (FR-062b). |

The platform-wide default is configuration, not a document — read through the existing config/Joi
path, so an absent value fails at boot rather than at first accrual.

### `Company` — fuel company region coverage (FR-036) — genuine platform addition

**Found during analysis, not by R2/R5's pattern-match**: `Company.servedRegions` is documented
in-schema as *"TRANSPORT-only: the regions this transporter is assigned to serve ... assigned by its
parent Fuel Company"* (`company.schema.ts:72-75`) — it is the field FR-035 reads (a transporter's
served regions, set **by** the fuel company), not a field a FUEL-type company holds for itself.
Unlike R2 (`GET /orders/summary`) and R5 (station listing), where the spec's "platform addition"
turned out to be a decorator or a route, this one is real: no field records the regions a fuel
company itself covers.

| Field | Type | Notes |
|---|---|---|
| `coveredRegions` | `RegionCode[]`, default `[]` | **FUEL-only.** The regions this fuel company covers (FR-036) — distinct from `servedRegions`, which stays TRANSPORT-only and unchanged. Not scoped by any isolation marker; a company reads/writes only its own via the existing `assertCompanyAccess` pattern `companies.controller.ts` already uses for `fuelPrices`/`pricingConfig`. |

**Endpoint** (added to `contracts/rest-api-delta.md` Part 2): `PUT /companies/:id/covered-regions`
(`FUEL_COMPANY_ADMIN`, own company only) and `GET /companies/:id/covered-regions` (same access rule
as `fuel-prices`/`pricing-config` — the owning company and `SUPER_ADMIN`).

### `User` — nothing

Credit limits already exist on `User`. The request-and-resolve exchange is a new collection, not a
field.

---

## State transitions

```
CreditLimitRequest:   PENDING ──accept──> ACCEPTED        (conditional on PENDING)
                              └─reject──> REJECTED

ExchangeRequest:      AWAITING_RESPONSE ──accept───> ACCEPTED    (conditional on AWAITING_RESPONSE)
                                        ├─decline──> DECLINED
                                        └─withdraw─> WITHDRAWN   (raiser only)

AccountMovement:      RECORDED ──operator confirms──> CONFIRMED  (balance moves only here)
```

Every transition above is a single conditional update whose filter names the expected prior state.
None is a read-then-write. That is what SC-008 tests.

---

## Indexes

| Collection | Index | Why |
|---|---|---|
| `LitreBalance` | `(companyId, clientId, fuelType)` unique | One balance per owner per grade |
| `LitreBalance` | `movements.orderId` partial, credit/debit kinds | Makes a retried upload idempotent (FR-073e) |
| `AccountMovement` | `(companyId, createdAt, _id)` | Cursor pagination (FR-071) |
| `AccountMovement` | `(companyId, state)` | Balance = confirmed only |
| `CreditLimitRequest` | `(companyId, state, createdAt)` | The administrator's pending queue |
| `ExchangeRequest` | `partyCompanyIds` (multikey) | **The isolation filter** — must be indexed |
| `ExchangeRequest` | `(partyCompanyIds, state, createdAt, _id)` | Direction/state filtering + paging |
| `CommissionTerm` / `CashbackProgramme` | `effectiveFrom` desc | "In force at instant T" |
