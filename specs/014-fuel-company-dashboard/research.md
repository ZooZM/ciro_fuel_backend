# Phase 0 Research: Fuel Company Admin Dashboard — Live Platform Integration

**Feature**: `013-fuel-company-dashboard` | **Date**: 2026-09-03

Twelve decisions. R1, R2, R5 and R6 each make the feature **cheaper** than the spec's Dependencies
section assumed. R3 and R4 each find something that would have shipped broken. R3 is the keystone.

---

## R1 — Slice 0 is the session, and it lands alone

**Decision**: Replace the dashboard's role vocabulary, re-derive every route guard, delete the demo
role picker and the placeholder-credential paths, and collapse the duplicated session store and
platform-access layer — as one slice, merged before any screen is wired.

**Rationale**: Verified on the dashboard's `main`, not taken from the prior feature's notes:

| Claim in feature 009's record | Actual state on `main` |
|---|---|
| Role vocabulary replaced with the platform's five | `constants/roles.ts` has `SUPER_ADMIN`, `COMPANY_ADMIN`, `CLIENT`, `DRIVER`. Neither company role exists. |
| `RoleSelectionPage` deleted | Routed at `/select-role`. |
| `'dummy-token'` bypass deleted | Live in `auth/bootstrap-session.ts:21`, `auth/components/RoleSelectionPage.tsx:14`, `lib/api/api.client.ts:72`. |

A commit titled *"Refactor roles and permissions for transport and fuel company admins"* exists
(`17f6bd5`) and did not land this. **`FUEL_COMPANY_ADMIN` appears in five files as a string literal
inside feature code, while the role constant it should come from does not exist** — which is how the
gap survived review: the type system never saw it, because the values are inline strings.

The guard is wrong in both directions: `/petrolCompany` admits `[Role.CLIENT, Role.COMPANY_ADMIN]`,
so a station owner passes the guard for the screen that sets their own credit limit and prices.

**Alternatives considered**: Wiring screens first and fixing the session later — rejected because
every screen would be built and reviewed against a session shape the platform never issues, which is
precisely how the previous attempt produced screens that pass review and cannot run.

**Constitution**: Principle II (server-side RBAC is the source of truth; the client guard is UX over
it) and the Web constraint on role-conditional rendering.

---

## R2 — The order summary needs one line, not an endpoint

**Decision**: Add `UserRole.FUEL_COMPANY_ADMIN` to the existing `@Roles` on `GET /orders/summary`.

**Rationale**: The handler takes **no user parameter at all** —
`this.ordersService.getSummary(start, end)` (`orders.controller.ts:99-106`). Scoping is entirely the
multi-party plugin's, which already returns `{ fuelCompanyId }` for `FUEL_COMPANY_ADMIN`
(`multi-party-scope.plugin.ts`, `resolveFilter`). The role is excluded by decorator only; the
computation is already correct for it.

The spec's Dependencies section called this a "platform addition". It is a one-token change plus a
test that a second fuel company's orders are absent from the counts.

**Alternatives considered**: A separate fuel-company summary endpoint — rejected as a duplicate of a
working, already-scoped computation.

---

## R3 — KEYSTONE: neither isolation plugin can express a two-party record, and fuel exchange is one

**Decision**: Fuel exchange requires a **third isolation mechanism**, scoping by *membership in a
party set* rather than equality with one company id. It is designed and reviewed before Story 12
begins, and Story 12 does not start until it exists.

**Rationale**: Both existing plugins are single-owner by construction.

- `tenant-scope.plugin.ts` injects `{ companyId }` — one value, equality — and **forces
  `this.companyId = companyId` on create**.
- `multi-party-scope.plugin.ts` injects `{ fuelCompanyId }` plus a role narrowing, and **forces
  `fuelCompanyId` on create** to the acting company.

An exchange request has **two fuel companies, both of which must read it**: the raiser and the
recipient. Neither mechanism can express `fuelCompanyId ∈ {A, B}`.

The failure is silent and total, and it is worth being precise about why, because "just mark it
multi-party" looks correct:

1. Company A raises a request. `pre('save')` stamps `fuelCompanyId = A`.
2. Company B lists incoming requests. The plugin injects `{ fuelCompanyId: B }`.
3. **B's incoming list is empty, always.** No error, no refusal — an empty state that reads exactly
   like "nobody has sent you anything".

Every single-instance test passes. The defect appears only in a test with two fuel companies and an
assertion that B *can* see it — which is the shape of test the repo has needed before (feature 012's
`multi-instance.e2e-spec.ts` was the only thing that could see the Redis adapter never attaching).

**The `SUPER_ADMIN` bypass hides it further**: the platform operator sees every request correctly,
because both plugins bypass for that role. So Story 13's operator exchange screen would look
completely healthy while both fuel companies see nothing.

**Alternatives considered**:
- *Two documents, one per party* — rejected: two records for one agreement is two things to keep in
  step, and FR-082 ("exactly one final outcome") becomes a distributed-consistency problem instead of
  a conditional update.
- *No plugin; hand-written filters on the exchange service* — rejected outright by Principle II:
  "MUST NEVER be left to per-feature developer discipline."
- *Widen the multi-party plugin's filter to an `$or`* — rejected for this feature: that plugin is
  load-bearing for orders and invoices, the two collections a leak would be worst on, and widening
  its filter shape to serve a new domain risks all of it. A separate marker and plugin, following the
  precedent by which the multi-party plugin was itself added alongside the tenant plugin rather than
  replacing it, keeps the blast radius at the new collection.

**Constitution**: Principle II. This is the same "accepted second mechanism" reasoning recorded in
spec 004's Complexity Tracking, applied a second time for the same structural reason.

---

## R4 — Invoices are issued at approval, not at delivery

**Decision**: Commission accrues inside `InvoicesService.issueInvoice`, which already runs in the
approval transaction. Story 6 (invoices) is testable as soon as Story 2 (approval) works, not after a
delivery completes.

**Rationale**: `OrdersService.approve` calls `issueInvoice(approved, session)` inside
`session.withTransaction` (`orders.service.ts:270`). An invoice exists the moment an order is
approved.

Two consequences the spec had wrong:

1. Story 6's rationale ("Invoices follow completed deliveries, so this has no value until orders flow
   end to end") is false. Corrected in the spec — it changes slice ordering, since invoices can be
   exercised without a driver, a truck or a delivery.
2. FR-057's "commission MUST accrue as invoices are raised" resolves to **approval time**. Accruing
   at delivery instead would have produced a commission balance that disagrees with the invoice list
   on screen for every in-flight order.

The accrual point being already transactional satisfies Principle V with no new transaction: a
partial write that issued an invoice without its commission is impossible by construction.

**FR-063 (reversal on void)** attaches to whatever path voids an invoice; if no such path exists,
reversal is unreachable and must be recorded as such rather than implemented speculatively.

---

## R5 — Station listing is already scoped; there is no platform gap

**Decision**: Add a `FUEL_COMPANY_ADMIN` listing on the stations controller. No new scoping.

**Rationale**: `Station` is `markTenantScoped` (`station.schema.ts:66`) — the single
`companyId`-equality plugin. A fuel company admin's query is therefore *already* filtered to their
own company's stations. `GET /stations` is `@Roles(CLIENT)` only because the client's variant
additionally filters `clientId`; the cross-owner listing FR-025 asks for is what the plugin does by
default.

The spec's Dependencies section listed this as a platform addition requiring new work. It is a
controller route over an existing service call.

**Alternatives considered**: Aggregating client-by-client from `GET /users/:id/stations` — rejected;
N+1 by construction, and the plugin already answers the question in one query.

---

## R6 — Litre balances and account movements are single-owner; only exchange is not

**Decision**:

| New collection | Marker | Why |
|---|---|---|
| `LitreBalance` | `markTenantScoped` | One fuel company owns it; the client reads it. Exactly `Station`'s shape, which clients already read through this plugin. |
| `AccountMovement` | `markTenantScoped` | One fuel company; the operator reads it via the `SUPER_ADMIN` bypass. |
| `CreditLimitRequest` | `markTenantScoped` | One fuel company; the client is the subject and reads within it. |
| `SupplierInvoice` | *(see R7)* | — |
| `ExchangeRequest` | **new party-set mechanism (R3)** | Two fuel companies. |

**Rationale**: The temptation is to reach for the multi-party plugin for anything with more than one
*reader*. That is the wrong test. The right test is whether more than one **company** must read it.
A client reading their own litre balance is inside their fuel company's tenant — `Station` proves the
pattern works, since clients read stations through the plain tenant plugin today.

Only `ExchangeRequest` genuinely crosses a company boundary. Marking the other three multi-party
would add `fuelCompanyId` and role-narrowing they do not need, and would put four new collections
behind the mechanism that guards orders and invoices for no benefit.

---

## R7 — The supplier invoice is a document on the order, not a collection

**Decision**: Record the supplier invoice as an embedded sub-document on `Order`, holding the
extracted values, the confirmed values, and a `FileRecord` reference for the document itself.

**Rationale**: It is one-to-one with an order (spec Assumptions: one invoice, one order, one grade),
it is only ever read in the context of its order, and `Order.verifications` is the established
precedent for exactly this shape. A separate collection would need its own isolation marker and would
be queried only by `orderId`.

**Keep `_id` on the sub-document** — the same call the stop-detection feature had to make and record.
The confirm step, the replace path and the balance movement all address one specific invoice.

**The document itself goes through `FilesService`**, which since feature 012 sits behind an abstract
storage port with GCS and local drivers. `FileRecord` is `markTenantScoped`, which is what makes
FR-073f (retrievable by the uploading fuel company and the operator, nobody else) already true — the
same property that makes `files.controller.ts:download` correctly need no explicit tenant check.

**Alternatives considered**: A `SupplierInvoice` collection — rejected as a collection that would
only ever be queried by one foreign key.

---

## R8 — Extraction is a seam, and the feature is correct without it

**Decision**: Define an extraction port with one method (document in, candidate field values out) and
a null implementation that returns nothing. Ship the confirm-and-correct flow against the null
implementation first; add a real extractor behind the same seam afterwards.

**Rationale**: FR-073a-ii makes the administrator's confirmation the recorded value, and
FR-073a-iii requires manual entry when extraction yields nothing. **Those two together mean the null
extractor is a fully working feature** — every requirement in Story 11 is satisfiable with an
extractor that always returns empty. That makes extraction the one part of this feature that can be
deferred without deferring anything else, and it should be, because it is also the part most likely
to consume time unpredictably.

The standard tax-invoice QR carries seller, tax registration, timestamp and totals — **not line
quantities** — so there is no structured path to the number that matters. Any real extractor parses
document text.

Storing extracted and confirmed values separately (FR-073a-iv) turns extraction quality into
something measurable from production data before anyone tunes it.

**Constitution**: Principle IV — the seam is an abstract port with DI, and no caller learns which
implementation answered, mirroring how `FilesModule` hides its storage driver.

---

## R9 — The balance draw-down is the only client-facing change, and it is transactional

**Decision**: Draw-down happens at order creation, inside the order-creation transaction, as a
conditional update on the balance document.

**Rationale**: FR-074 requires a later order to consume the balance automatically and to show the
amount drawn before placing. This reaches into `POST /orders` and `POST /orders/quote` — the client's
path, and the only place this feature changes what a station owner *does* rather than what they see.
Both Flutter clients read that path.

Concurrency is real: two orders placed at once for one owner and grade must not both consume the same
litres. Principle V requires the guarantee at the data layer — a conditional update whose filter
carries the expected balance, so the second order's write matches nothing and retries, exactly the
idiom `ratings.service.ts` and the escalation processor already use.

**The quote must not consume anything.** A quote that draws the balance down would leak litres on
every abandoned quote. Quote *shows* the projected draw; creation performs it.

---

## R10 — Commission and cashback are configuration with history, not a running total

**Decision**: Store commission and cashback terms as effective-dated records, and accrue onto the
company by conditional increment at the moment an invoice is raised or paid. Never recompute a
balance by re-reading historical invoices.

**Rationale**: FR-058 and FR-034 are the same requirement in two places — a rate change must not
alter what already accrued. An effective-dated term record makes that structural: the accrual reads
the term in force at that instant and stamps the rate onto the movement it creates. A single mutable
"current rate" field would make every historical figure a function of today's configuration, which is
how a rate change silently rewrites last quarter's balances.

This is the same reasoning the platform already applies to order pricing, which retains the rates in
force on the order rather than referencing the company's live `pricingConfig`.

---

## R11 — Refresh, not sockets, for everything this feature adds

**Decision**: TanStack Query with per-screen refetch intervals, `refetchOnWindowFocus` off while
hidden. No new socket events, no socket subscription on any screen this feature adds.

**Rationale**: The transport dashboard established the hybrid: refresh for lists, detail and counts;
a live connection only for a truck's position. Nothing this feature adds is position data. Commission
balances, ledgers, exchange requests and litre balances are all "fresh within a minute" data.

FR-050 (no refresh while the tab is hidden) is a TanStack Query configuration, not per-screen code.

---

## R12 — The two dashboard repositories share this spec, not a spec directory

**Decision**: The dashboard repository gets a `SPEC-POINTER.md` for feature 013 pointing here; it
does not get a `specs/013-…` directory. Dashboard-side tasks are prefixed `web_dashboard/` in
`tasks.md`.

**Rationale**: The arrangement feature 009 used, recorded in the dashboard's existing
`SPEC-POINTER.md`, which states the reason directly: a parallel spec would fork the source of truth
the two repositories are required to share. The dashboard's own `specs/` directory holds only its
UI-architecture features (004–006), none of which are platform features.

---

## Open items carried into the plan

- **Audit of commission accrual and payment confirmation** — deferred at the clarification quota.
  Litre balances and extraction carry attribution (FR-073a-iv, FR-075a); money movements between a
  company and the platform do not. Raised in the plan's Complexity Tracking as a decision to take
  before Story 10, not after.
- **FR-063 (accrual reversal on a voided invoice)** — no invoice-void path was found. Confirm one
  exists before implementing reversal, or record the requirement as unreachable.
