# Implementation Plan: Multi-Tier Accounts, Regional Routing & Billing

**Spec**: `specs/004-multi-tier-platform/spec.md`
**Status**: Draft — awaiting approval

This plan covers the parts of the change that carry real risk: the isolation model, the
schema, the routing rule, the billing state machine, and the migration. It ends with a phase
breakdown where the test suite is green at every boundary.

---

## Constitution Check

*GATE: passes before Phase 1 (Foundational) work begins. Re-checked after §1 (Isolation model)
was revised to close the gap an earlier analysis pass found — see Complexity Tracking.*

| Principle | Check | Status |
|---|---|---|
| I. Strict Typing & No Magic Values | Roles, regions, order states, payment methods and invoice states are all enums (§2); nothing is compared against a string literal | ✅ Pass |
| II. Tenant Isolation & Security-First | §1's multi-party plugin injects `fuelCompanyId` for **every** non-CIRO role, with no exception — the same non-negotiable guarantee the existing single-tenant plugin gives, generalized rather than weakened. Cross-tenant access is denied indistinguishably from absent (spec FR-002, SC-001) | ✅ Pass |
| III. Centralized Error Handling | No new error-handling path; invoice/routing failures flow through the existing global exception filter | ✅ Pass |
| IV. Clean Architecture & UI/Logic Decoupling | Backend keeps module/service/controller/DTO/guard separation (§2, §3, §4); mobile changes stay within the existing Presentation/Domain/Data layering (tasks.md Phase 8) | ✅ Pass |
| V. Transactional Integrity | Driver assignment reuses the existing `ClientSession`-based commit (§3); invoice issuance + credit adjustment + settlement are each specified as single transactions (§4, FR-027) | ✅ Pass |

No unresolved violations. §1 originally proposed CLIENT/DRIVER filters scoped by user id alone,
without `fuelCompanyId` — a real gap against Principle II, caught in cross-artifact analysis
before implementation and closed below. See Complexity Tracking for why the plugin split
itself (rather than reusing the single plugin unchanged) is still necessary.

## 1. Isolation model (the load-bearing decision)

### What exists today

Every tenant-scoped schema is marked with `markTenantScoped()`, and a global Mongoose plugin
injects `companyId` into every query from `AsyncLocalStorage`. The injected value **always
overrides** whatever the caller supplied, so a forged `companyId` in a DTO cannot escape the
tenant. `SUPER_ADMIN` carries no `companyId` and is the only exemption; a non-SUPER_ADMIN
context without one throws rather than querying unscoped.

That design has one assumption baked in: **one document belongs to exactly one company.**

### Why it breaks

An order is legitimately readable by four parties in three different companies (Fuel Company,
Transportation Company, and — via their own scope — the client and driver). There is no single
`companyId` value that satisfies all four queries.

### The replacement

Split scoping into two categories, keeping the strong default:

**Category A — single-tenant collections** (users, trucks, files, regions, credit limits).
Keep the existing plugin unchanged. `companyId` here means *the owning Fuel Company*. This is
the majority of collections and keeps its current guarantees.

**Category B — multi-party collections** (orders, invoices). These carry explicit participants:

```
fuelCompanyId        // owning tenant — always set
clientId             // always set
transportCompanyId   // set at routing
driverId             // set at assignment
```

They are marked `markMultiParty()` instead, and a companion plugin injects a *role-derived
filter* rather than a fixed equality. Every non-CIRO role's filter carries `fuelCompanyId` —
this is Principle II's non-negotiable requirement, and it is retained even for CLIENT/DRIVER
so a leaked or reused user id can never cross a tenant boundary, only narrow within one:

| Acting role | Injected filter |
|---|---|
| CIRO | none |
| Fuel Company admin | `{ fuelCompanyId: ctx.companyId }` |
| Transportation Company admin | `{ fuelCompanyId: ctx.parentFuelCompanyId, transportCompanyId: ctx.companyId }` |
| Client | `{ fuelCompanyId: ctx.companyId, clientId: ctx.userId }` |
| Driver | `{ fuelCompanyId: ctx.companyId, driverId: ctx.userId }` |

Properties preserved from the current design, deliberately:

- The filter is **injected, never caller-supplied**, and overrides anything in the query.
- A non-CIRO context missing its scoping identity **throws**, rather than querying unscoped.
- `fuelCompanyId` is still forced on write, so a record cannot be created into another tenant.
- **`fuelCompanyId` is injected for every role, with no exception** — Client and Driver add a
  second predicate on top of it, they never substitute for it. This is what keeps the plugin a
  strict generalization of the existing single-tenant one rather than a departure from it.

**FR-008 (no lateral read) is enforced separately**: a client seeing a driver's name comes from
a projected summary embedded on the order at assignment time, *not* from granting the client
read access to the users collection. Assignment denormalises `{ fullName, phone, truck.plateNumber }`
onto the order. This also keeps the delivery screens on a single read.

### Risk

This is the security backbone. Mitigation: the isolation phase ships with an expanded version
of the existing `tenant-isolation` e2e suite covering every role pair in both directions, and
lands **before** any feature work builds on it.

---

## 2. Schema changes

### New: `Company.type`

`FUEL` | `TRANSPORT`, with `parentFuelCompanyId` set for transporters. Keeping one collection
(rather than two) preserves the existing company lifecycle, status suspension and file
attachment, and keeps `companyId` meaning "the company this record belongs to".

### New: `Region` reference data

Fixed list of the 13 Saudi regions and their governorates, seeded, with Arabic and English
names. Referenced by code (e.g. `RIYADH`), never free text.

### `Company` (transport) gains

`servedRegions: RegionCode[]` — assigned by the parent Fuel Company.

### `User` (client) gains

```
station: {
  regionCode, governorateCode,
  location: GeoPoint,      // existing stationLocation, moved in
  addressText: string,     // editable, geocode-prefilled
  name?: string            // station display name
}
creditLimit: Money
```

### `Order` gains

`fuelCompanyId`, `transportCompanyId`, `driverId` (participants), `invoiceId`,
`deliveryAddressText`, and a `driverSummary` snapshot at assignment. `companyId` is replaced by
`fuelCompanyId` to remove the ambiguity of the old name.

### New: `Invoice`

```
orderId, fuelCompanyId, clientId, transportCompanyId?
amount, method: DIRECT | DEFERRED | CREDIT
state: ISSUED → SETTLED | VOID
payerRole, settledAt, paymentReference
```

### New order states

`AWAITING_ROUTING` (approved, no transporter resolved — FR-016) and
`ROUTED_TO_TRANSPORT` (with transporter, awaiting driver assignment) slot between `APPROVED`
and `ASSIGNED_TO_DRIVER`. Existing states keep their meaning.

---

## 3. Routing rule

At approval, resolve candidate transporters as:

> transporters of *this* Fuel Company whose `servedRegions` include the client's `regionCode`

- Exactly one → route automatically, show it to the Fuel Company (FR-015).
- More than one → the Fuel Company picks from the candidates at approval (FR-014).
- None → `AWAITING_ROUTING` + notify (FR-016).

**Driver ranking** reuses `DispatchService`'s existing eligibility query unchanged (capacity,
fuel type, proximity, availability, not already on a trip). Its transactional assignment path
becomes the *commit* step for the transporter's manual choice, so FR-018's race protection is
the code already covered by `dispatch-race.e2e-spec.ts`. Auto-selection becomes ordering; the
selection and locking logic is retained, not rewritten.

---

## 4. Billing state machine

Invoice issuance happens at approval, when the final price is known.

| Method | On issue (at approval) | On settle |
|---|---|---|
| DIRECT | order → `PENDING_PAYMENT`; payment window + timeout accounting start | order proceeds to routing |
| DEFERRED | order proceeds to routing immediately; invoice payable by transporter only | invoice settled; order unaffected |
| CREDIT | approval refused if amount exceeds available credit; otherwise order proceeds to routing | credit restored by amount |

Approval is the single issuance point for all three methods — no invoice exists, and no money
or credit moves, before the Fuel Company sets the final price.

- Settlement stays webhook-driven and **idempotent** on `paymentReference`, reusing the
  existing verified-signature webhook and its idempotency guarantee (`payment-idempotency.e2e-spec.ts`).
- Credit adjustment and invoice state change happen **in one transaction** (FR-027), the same
  pattern dispatch and the payment webhook already use.
- Available credit is derived as `creditLimit − Σ(ISSUED credit invoices)`, so it can never
  drift from the invoices; it is not a separately mutated counter. Placement reserves nothing,
  so the credit check belongs in the approval transaction (FR-024a/FR-025).
- The existing payment window, retry and `paymentTimeoutCount` stay bound to DIRECT only
  (FR-020b); the BullMQ delayed job is scheduled solely for direct invoices.
- `Invoice` has exactly one payer. Deferred reimbursement between transporter and client is
  out of scope — no second invoice, no reimbursement tracking (FR-022).

---

## 5. ETA

`etaMinutes = haversine(driver.location, order.destination) / averageSpeedKmh`, with the speed
configurable and the field **omitted** when `driver.location` is unset (FR-029). Computed on
read; no stored value to go stale.

---

## 6. Migration

Re-runnable script (FR-031):

1. Every existing `Company` → `type: FUEL`.
2. For each, create one `TRANSPORT` company seeded from its existing drivers, and assign it the
   region derived from its clients' coordinates (or a default region flagged for review).
3. Orders: `companyId` → `fuelCompanyId`; `transportCompanyId` from the migrated transporter;
   `driverId` from `assignedDriverId`.
4. Clients: `stationLocation` → `station.location`; `regionCode`/`governorateCode` resolved from
   coordinates where possible, otherwise flagged for admin completion; `addressText` empty.
5. Issue a settled `Invoice` for every historical paid order so credit maths starts consistent.

Existing seeded/dev data is disposable, but the script must be correct for any real data.

---

## 7. Phases

Each phase ends with the full suite green.

| Phase | Delivers | Risk |
|---|---|---|
| **0** | Region reference data + seed | Low |
| **1** | `Company.type`, hierarchy, CIRO-creates-Fuel-Company, **new isolation model + expanded isolation tests** | **Highest — do first, alone** |
| **2** | Transportation companies, region assignment, **Fuel-Company-only client creation** with station fields, migration script | Medium |
| **3** | Order routing (`AWAITING_ROUTING`, `ROUTED_TO_TRANSPORT`), transporter driver list + assignment on the existing dispatch core | Medium |
| **4** | Invoice entity, three payment methods, credit accounting | Medium |
| **5** | Driver summary on order, ETA, address text on read paths | Low |
| **6** | Mobile wiring: driver/vehicle, address, ETA, finance cards — removes every placeholder | Low |
| **7** | Web dashboard (does not exist yet): CIRO, Fuel Company and Transportation Company views | **Large — a feature in its own right** |

Phase 7 is the whole of feature 003 plus the new roles. It should be planned separately once
1–5 have settled the API surface.

---

## 8. What this invalidates

- The current `orders` lifecycle tests assume approval → auto-dispatch. They are rewritten in
  Phase 3, not patched.
- `tenant-isolation.e2e-spec.ts` is expanded, not replaced, in Phase 1.
- `specs/001` contracts, `specs/002` (mobile) and `specs/003` (dashboard) all need updating to
  the new roles and routing; 003's role/route table is materially affected.

---

## 9. Outstanding prerequisites

All five design questions are resolved (see spec §Clarifications, session 2026-08-09):
invoices issue at approval; direct payment blocks routing until settled; deferred has a single
transporter payer with no platform-tracked reimbursement; credit is consumed at approval and
derived from outstanding invoices; the payment timeout applies to direct only; and only the
Fuel Company creates clients.

One prerequisite remains: a **Google Maps API key with Geocoding enabled**, needed before
Phase 5 (client station registration, US3) — not before Phase 2. Phases 1–4 are otherwise
unblocked and do not touch geocoding.

## Complexity Tracking

> Filled because the Constitution Check above required justifying one design choice.

| Decision | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| A second Mongoose plugin (`markMultiParty`) alongside the existing tenant plugin, rather than one unified mechanism | An order has up to four legitimate viewers in three different companies (spec, "Why this is a re-architecture"). A single fixed-equality `companyId` filter cannot express "visible to fuelCompanyId X **or** transportCompanyId Y **or** clientId Z" | Extending the existing plugin's `companyId` filter to accept a list would still only encode *tenant* membership, not the four-role, four-field participant shape orders need — genuinely a different filter *shape*, not a variant of the same rule. Keeping single-tenant collections (the majority) on the original, unmodified plugin bounds the blast radius of the new mechanism to exactly the two collections that need it (orders, invoices) |

This is the only place the plan departs from the constitution's literal wording ("a global
mechanism… not hand-written filters") — and only in degree, not in kind: it is a second
*global* mechanism for a second *category* of collection, still fed from the same
request-scoped context, still injected rather than caller-supplied, still forcing
`fuelCompanyId` for every role. Per the Development Workflow gate, this justification stands
in place of design revision.
