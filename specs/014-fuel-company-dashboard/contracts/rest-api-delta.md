# Contract: REST API Delta

**Feature**: `013-fuel-company-dashboard` | Base: `/api/v1`

Canonical platform contract: `specs/001-fuel-delivery-platform/contracts/rest-api.md`. This file
records only what changes. Roles are the platform's `UserRole` values; `FCA` =
`FUEL_COMPANY_ADMIN`, `SA` = `SUPER_ADMIN`, `CL` = `CLIENT`.

---

## Part 1 — Changes to existing endpoints (slices 0–8)

Small, and smaller than the spec assumed.

| Endpoint | Change | Slice |
|---|---|---|
| `GET /orders/summary` | **Add `FCA` to `@Roles`.** Nothing else. The handler takes no user parameter and is already scoped by the multi-party plugin (R2). | 7 |
| `GET /stations/all` | **New route** (found during implementation — `GET /stations` bare is CLIENT-only and Nest cannot bind two role-gated handlers to one path) returning every station of the acting fuel company, across all its owners. Already scoped by the tenant plugin; no filter to write (R5). The existing `CL` `GET /stations` branch is unchanged. | 6 |
| `POST /orders` | Draw down the client's litre balance for the ordered grade, inside the existing creation transaction. Response gains `litreDrawdown: { litresDrawn, balanceRemaining }` (R9, FR-074). | 11 |
| `POST /orders/quote` | Response gains the **projected** draw-down. **Consumes nothing** — a quote that moved the balance would leak litres on every abandoned quote (R9). | 11 |
| `GET /orders/:id` | Response gains `supplierInvoice` (confirmed values + shortfall) where recorded. Absent, not null-filled, when not (FR-048). | 11 |

**No change** to approve / reject / route / redispatch / force-complete. They already exist with the
correct role and are already wired on the dashboard — the two files that reach the platform today.

---

## Part 2 — New endpoints

### Fuel company region coverage (slice 4) — genuine platform addition, found during analysis

`Company.servedRegions` is TRANSPORT-only (a transporter's regions, set by its parent fuel company —
`company.schema.ts:72-75`); a FUEL-type company has no field recording the regions it covers itself.
Unlike R2/R5, this is a real gap, not a pattern-match. See `data-model.md`'s `coveredRegions` entry.

| Method | Path | Roles | Notes |
|---|---|---|---|
| `GET` | `/companies/:id/covered-regions` | `FCA`, `SA` | Same access rule as `fuel-prices`/`pricing-config` — the owning company and the operator (FR-035, FR-036). |
| `PUT` | `/companies/:id/covered-regions` | `FCA` | Own company only (`assertCompanyAccess`). Retained and reflected on reload (FR-036 scenario 3). |

### Credit limit requests (slice 3)

| Method | Path | Roles | Notes |
|---|---|---|---|
| `POST` | `/users/me/credit-limit-requests` | `CL` | FR-029. Refuse a second while one is `PENDING`. |
| `GET` | `/credit-limit-requests` | `FCA` | The administrator's queue; `?state=` filter. |
| `GET` | `/users/me/credit-limit-requests` | `CL` | The owner's own history and outcomes. |
| `PATCH` | `/credit-limit-requests/:id/resolve` | `FCA` | Body `{ accept: boolean, grantedAmount?, }`. **Conditional on `state: PENDING`** → `409` if already resolved (FR-031). Accepting writes the new limit and the resolution in one transaction. |

### Supplier invoices and litre balances (slice 11)

| Method | Path | Roles | Notes |
|---|---|---|---|
| `POST` | `/orders/:id/supplier-invoice/upload` | `FCA` | Multipart. Stores the document via `FilesService`, runs extraction, returns `{ fileId, extracted, orderedQuantityLitres }`. **Records nothing and moves no balance** (FR-073a-ii, SC-014c). |
| `POST` | `/orders/:id/supplier-invoice` | `FCA` | Body `{ fileId, confirmed: {...} }`. Records the invoice and applies the balance movement in one transaction. `409` if already recorded (FR-073e); `400` on grade mismatch (FR-073g); `409` if the order is cancelled or rejected. |
| `PUT` | `/orders/:id/supplier-invoice` | `FCA` | Replace: supersedes the prior invoice and **restates** the movement — never applies a second (FR-073e). |
| `GET` | `/litre-balances` | `FCA` | `?clientId=` — the owner's balances across grades. |
| `GET` | `/users/me/litre-balances` | `CL` | FR-076. Includes movements, each traceable (FR-075a). |
| `POST` | `/litre-balances/:id/corrections` | `FCA` | Body `{ litres, reason }`. `reason` **required** → `400` without it (FR-075). |

### Commission and cashback (slice 9)

| Method | Path | Roles | Notes |
|---|---|---|---|
| `GET` | `/billing/commission-terms/current` | `FCA`, `SA` | Read-only for `FCA` (FR-056). |
| `PUT` | `/billing/commission-terms` | `SA` | Writes a **new effective-dated record**; never mutates (R10, FR-058). |
| `GET` | `/billing/cashback-programme/current` | `FCA`, `SA` | |
| `PUT` | `/billing/cashback-programme` | `SA` | New effective-dated record. |
| `GET` | `/billing/balances/me` | `FCA` | Accrued commission, accrued cashback, ceiling, and the 90% warning state (FR-061, FR-062c). |
| `PUT` | `/companies/:id/commission-ceiling` | `SA` | FR-062a. Absent ⇒ platform default governs (FR-062b). |

**Enforcement (FR-062d)**: deferred dealing is refused once accrued commission exceeds the ceiling,
with a typed error code naming the ceiling. Resumes automatically when a **confirmed** payment brings
it back below — no operator action (Story 9, scenario 9).

### Platform account (slice 10)

| Method | Path | Roles | Notes |
|---|---|---|---|
| `GET` | `/platform-account/movements` | `FCA`, `SA` | Cursor-paginated (FR-071). |
| `POST` | `/platform-account/payments` | `FCA` | Body `{ amount, method, reference?, documentFileId? }`. Full or partial (FR-065). `400` without evidence (FR-067). Created as `RECORDED` — **the balance does not move** (FR-068). |
| `PATCH` | `/platform-account/payments/:id/confirm` | `SA` | FR-069, FR-067a. Conditional on `state: RECORDED`. |

**No payment provider is integrated** (FR-066a). The platform displays details to pay elsewhere and
records what the payer reports. It never initiates, takes or receives a payment.

### Fuel exchange (slice 12 — behind the party-set plugin)

| Method | Path | Roles | Notes |
|---|---|---|---|
| `GET` | `/fuel-exchange/requests` | `FCA`, `SA` | `?direction=incoming\|outgoing\|all` — derived from `raisedByCompanyId` against the viewer, never stored per-viewer (FR-084). |
| `POST` | `/fuel-exchange/requests` | `FCA` | `400` if the recipient does not sell the grade (FR-085) or on invalid quantity/price (FR-086). |
| `GET` | `/fuel-exchange/requests/:id` | `FCA`, `SA` | Includes the counterparty's contact details — **only to the two parties** (FR-086b). |
| `PATCH` | `/fuel-exchange/requests/:id/respond` | `FCA` | Recipient only. Body `{ accept: boolean }`. Conditional on `AWAITING_RESPONSE` → `409` (FR-082). |
| `PATCH` | `/fuel-exchange/requests/:id/withdraw` | `FCA` | Raiser only. Same conditional. |

**Creates no order, delivery or invoice on acceptance** (FR-086a).

### Operator oversight (slice 13)

| Method | Path | Roles | Notes |
|---|---|---|---|
| `GET` | `/companies?type=FUEL` | `SA` | Already exists; the operator's listing is a query, not a new route. |
| `POST` | `/companies` | `SA` | Exists (FR-088). |
| `PATCH` | `/companies/:id/status` | `SA` | Exists (FR-090). |

Slice 13 is almost entirely dashboard work over endpoints that already exist plus the `SA` roles
added above — which is why it must follow, not lead.

---

## Cross-cutting

- **Pagination** is cursor-based (`{ items, nextCursor }`) everywhere, never skip/limit — inserts at
  the head would duplicate rows (FR-009, FR-071).
- **Conflicts** return `409` with a typed error code, never a generic `500` (FR-019, SC-008).
- **Isolation refusals** do not reveal whether the record exists (Constitution II).
- **Every amount carries its currency; every quantity its unit** (FR-098).
