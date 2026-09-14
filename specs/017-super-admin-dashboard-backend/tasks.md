---
description: "Task list for Platform Operator (Super Admin) Dashboard — Backend Integration"
---

# Tasks: Platform Operator (Super Admin) Dashboard — Backend Integration

**Input**: Design documents from `/specs/017-super-admin-dashboard-backend/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **REQUIRED**, not optional. The Constitution's Development Workflow states that
"guarantees the spec marks as testable MUST have automated tests before the corresponding capability
is considered done", and this spec marks many: SC-012 requires per-capability authorization
verification, SC-014 requires verification against **what the platform sends** rather than what a
screen renders, and FR-023d/FR-053/FR-067/FR-070 are each a testable invariant.

**Organization**: Grouped by user story. Each story is independently implementable and testable.

**Repositories**: `E:\zeyad\ciro_fuel_backend` (paths below default here) and
`E:\zeyad\web_dashboard_ciro_fuel` (prefixed `<dashboard>/`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no incomplete dependencies)
- **[Story]**: US1–US8, mapping to spec.md's user stories

---

## ⚠️ Read before starting

Four findings from `research.md` describe failure modes where a **wrong implementation produces a
passing happy-path test**. Each has a guard task below, and in every case the guard is written
**before** the happy path.

| # | Trap | Guard |
|---|---|---|
| 1 | A cashback payout under a new kind leaves `getConfirmedBalance(CASHBACK_CREDITED)` untouched — FR-067 silently violated (R11) | **T130** before T140 |
| 2 | `getSuggestedTruck` suppresses a busy truck, so an active driver reads as "never driven" (R8) | **T079** before T084 |
| 3 | The fan-out worker has no request context, so an unstamped `Notification` is invisible to its recipient while the operator sees it (R9) | **T094** before T106 |
| 4 | A `$or`-shaped bucket filter is silently discarded for scoped roles and works perfectly for the operator (R4) | **T047** before T049 |

**Do not edit** `src/common/plugins/tenant-scope.plugin.ts` or
`src/common/plugins/multi-party-scope.plugin.ts`. No task requires it; the operator's platform-wide
reach is the existing bypass (isolation contract §1).

---

## Phase 1: Setup

**Purpose**: branches, seed data and recorded baselines. The baselines matter because FR-075 is a
**negative** guarantee — it can only be verified against a "before".

- [X] T001 Create and push feature branch `017-super-admin-dashboard-backend` in the dashboard repository (`<dashboard>/`) at `E:\zeyad\web_dashboard_ciro_fuel` (currently on `main`; the backend branch already exists)
- [X] T002 Extend `scripts/seed-dashboard-actors.ts` to seed **the part of the quickstart Part 0 mix that the public REST API can produce**: 3 fuel companies, 5 transport companies (the extra transporters onboarded through `POST /companies/transporters`, so the operator's own route is exercised), stations per fuel company, and the client/driver/truck/tank/warehouse chain the order flow needs. **The script also sets the transporter's `deliveryRates`** — without it `TransportPricingService` refuses every quote with `409 TRANSPORT_PRICE_NOT_SET` and the seed cannot place a single order (the rate moved onto the hauling party after this script was last updated, so every run between then and the 017 analysis pass died at the first `/orders/quote`). **Deliberately NOT seeded over HTTP, because no route produces it**: orders parked in `AWAITING_ROUTING`/`REJECTED`/`CANCELLED`, orders raised in the period but never delivered, a never-connected driver, a driver with deliveries on two different trucks, and an accrued `CASHBACK_CREDITED` balance. Each of those is seeded directly by the e2e suite that asserts it (`platform-overview`, `order-buckets`, `driver-roster`, `cashback-payout`), which is the authoritative check; the script prints this list on completion, and quickstart Part 0 reproduces it by hand
- [X] T003 [P] Record the backend baseline by running `npm run test` and `npm run test:e2e` and writing the suite/test counts plus the known-flaky e2e suite names into the Baselines table at the foot of `specs/017-super-admin-dashboard-backend/tasks.md`
- [X] T004 [P] Record the dashboard baseline by running `npx tsc -b --force` and `npx vitest run` in `E:\zeyad\web_dashboard_ciro_fuel` and writing the pre-existing `TS6133`/`TS6192` error count and the 2 load-failing suite names into the Baselines table at the foot of `specs/017-super-admin-dashboard-backend/tasks.md`

**Checkpoint**: branches exist, seed produces a platform whose counts are known, baselines recorded.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the named values shared by more than one story. `OrderStatusBucket` is consumed by both
US1's breakdown and US3's filter and summary, which is exactly what stops the two screens from
disagreeing about what "in progress" means.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

- [X] T005 Create `src/common/constants/order-status-buckets.ts` exporting the `OrderStatusBucket` enum (`NEW`, `IN_PROGRESS`, `COMPLETED`, `REJECTED`, `CANCELLED`, `NEEDS_ATTENTION`) and the `ORDER_STATUS_BUCKETS` mapping from research.md R3's table, plus a `bucketForStatus()` helper
- [X] T006 Write the exhaustiveness unit test in `test/unit/order-status-buckets.spec.ts` asserting that the union of the six bucket arrays equals `Object.values(OrderStatus)` exactly — same length, no duplicate, no omission — so a thirteenth state added later fails loudly rather than becoming unreachable (FR-023d)
- [X] T007 [P] Add the new refusal codes to `src/common/enums/error-code.enum.ts`: `CASHBACK_PAYOUT_EXCEEDS_BALANCE`, `CASHBACK_PAYOUT_DUPLICATE_REFERENCE`, `ORDER_BUCKET_STATUS_CONFLICT`, `INVALID_PARENT_FUEL_COMPANY`
- [X] T008a [P] Add the new endpoints to `<dashboard>/src/constants/api-routes.ts` (`platform.overview`, `platform.transportCompanyVolumes`, `drivers.roster`, `announcements.list/create/detail`, `auth.meAccount`, `platformAccount.cashbackOwed`, `platformAccount.cashbackPayouts`, `companies.transporters`), the `OrderStatusBucket` enum and its bilingual label maps to `<dashboard>/src/constants/order-status.ts`, and one key per new hook to `<dashboard>/src/constants/query-keys.ts` — Constitution I forbids route, status and key literals in the web repository exactly as in the backend, and every dashboard `api/` task below depends on these
- [X] T008 [P] Extend `test/utils/fixtures.ts` with a `superAdminActor()` helper and a multi-company fixture that creates fuel and transport companies with their administrators, so every operator-only refusal test (SC-012) can be written without re-seeding per suite

**Checkpoint**: shared vocabulary exists and is proven exhaustive. Stories can begin.

---

## Phase 3: User Story 2 — The fuel-company list stops counting transporters (Priority: P1) 🎯 MVP

**Goal**: `GET /companies` honours a type filter, so the operator's fuel-company list and its count
card contain exactly the platform's fuel companies.

**Independent Test**: seed 3 fuel and 5 transport companies; the fuel-companies screen shows 3 rows
and the count card reads 3; the transport screen shows 5 and no fuel company appears.

> **Sequenced first despite US1 also being P1.** This is a live defect on the operator's most-used
> screen, it is one query parameter, and US1's company-type chart cannot be correct until the
> platform can filter companies by type (spec's own "Why this priority").

### Tests for User Story 2

- [X] T009 [P] [US2] Write `test/e2e/company-type-filter.e2e-spec.ts` covering, as `SUPER_ADMIN`: `?type=FUEL` returns exactly 3, `?type=TRANSPORT` exactly 5, no `type` returns all 8, `?type=` (empty) returns all 8, and `?type=BANANA` returns 400 (FR-010, FR-011, SC-002)
- [X] T010 [P] [US2] Add to `test/e2e/company-type-filter.e2e-spec.ts` the FR-012 narrowing cases: a `FUEL_COMPANY_ADMIN` calling `?type=FUEL`, `?type=TRANSPORT` and no filter receives only their own company or nothing in every case — the filter never widens
- [X] T011 [P] [US2] Add the `?status` cases to `test/e2e/company-type-filter.e2e-spec.ts`, mirroring T009/T010 exactly (FR-013)

### Implementation for User Story 2

- [X] T012 [US2] Change `CompaniesService.findAll` in `src/modules/companies/companies.service.ts` to take a `{ id?, type?, status? }` filter object and build one query — `type` must **intersect** the `id` narrowing, never replace it
- [X] T013 [US2] Add `@Query('type')` and `@Query('status')` bindings to `CompaniesController.findAll` in `src/modules/companies/companies.controller.ts`, validated against `CompanyType`/`CompanyStatus`, treating an empty string as absent, and pass them through for both the `SUPER_ADMIN` and `FUEL_COMPANY_ADMIN` branches
- [X] T014 [US2] Correct the false comment in `<dashboard>/src/admin/petrol_companies/api/fuel-companies.api.ts` that asserts `GET /companies?type=FUEL` "already exists" — it has been false since feature 013 and is the reason the defect survived review
- [X] T015 [US2] Add `listTransportCompanies()` to `<dashboard>/src/admin/petrol_companies/api/fuel-companies.api.ts` calling `?type=TRANSPORT`, and a `useTransportCompanies` hook in `<dashboard>/src/admin/transport_companies/hooks/useTransportCompanies.ts` for US4 to consume
- [X] T016 [US2] Verify in `<dashboard>/src/admin/petrol_companies/components/AdminPetrolCompaniesStats.tsx` that the count card is computed from the now-genuinely-filtered result and not from a second unfiltered call (FR-014)

**Checkpoint**: the operator's fuel-company count is true for the first time since feature 013.

---

## Phase 4: User Story 1 — The operator sees the platform's real numbers (Priority: P1)

**Goal**: every figure on the operator's home dashboard is the platform's own count for the selected
period, with the two distribution charts summing to the totals above them.

**Independent Test**: reconcile each card against independently derived counts; changing the date
range changes the period figures and leaves the point-in-time figures alone.

**Depends on**: US2 (the company-type chart needs the type filter).

### Tests for User Story 1

- [X] T017 [P] [US1] Write `test/e2e/platform-overview.e2e-spec.ts` asserting each of the six figures against independently derived counts on the seeded platform (SC-001, FR-001, FR-002)
- [X] T018 [P] [US1] Add the period-boundary case to `test/e2e/platform-overview.e2e-spec.ts`: changing `from`/`to` changes `orderCount`, `orderValue` and `litresMoved`, and leaves `fuelCompanies`, `transportCompanies` and `stations` **unchanged** (FR-002, acceptance scenario 2)
- [X] T019 [P] [US1] Add the empty-period case: every period field is present and `0`, never absent and never `null` in `test/e2e/platform-overview.e2e-spec.ts` (FR-008, acceptance scenario 4)
- [X] T020 [P] [US1] Add the default-period case: with no `from`/`to`, the response resolves to the current calendar month and reports `isDefault: true` in `test/e2e/platform-overview.e2e-spec.ts` (FR-005)
- [X] T021 [P] [US1] Add the breakdown-sum cases to `test/e2e/platform-overview.e2e-spec.ts`: `byOrderBucket` carries all six buckets including zeros and sums to `period.orderCount` **exactly**, and `byCompanyType` sums to the two company counts (FR-006)
- [X] T021a [P] [US1] Add the two-basis case to `test/e2e/platform-overview.e2e-spec.ts`: seed a period containing orders raised but not delivered, then assert `orderCount` counts them while `orderValue` and `litresMoved` do not, and that `period.basis` reports `RAISED_IN_PERIOD` and `DELIVERED_IN_PERIOD` accordingly. **This is the test that would have caught the delivered-only order count**, which made five of the six buckets structurally zero (FR-001a)
- [X] T022 [P] [US1] Add the authorization case: `FUEL_COMPANY_ADMIN`, `TRANSPORT_COMPANY_ADMIN`, `CLIENT` and `DRIVER` each receive 403 in `test/e2e/platform-overview.e2e-spec.ts` (FR-007, SC-012)
- [X] T023 [P] [US1] Add an assertion that the response body contains **no** trend, delta or percentage field at any nesting level in `test/e2e/platform-overview.e2e-spec.ts` (FR-009)

### Implementation for User Story 1

- [X] T024 [P] [US1] Create `src/modules/platform/dto/platform-overview.dto.ts` with the `period` / `pointInTime` / `breakdown` shape from `contracts/rest-api-delta.md` §1, every numeric field non-optional
- [X] T024a [P] [US1] Create `src/common/enums/period-figure-basis.enum.ts` with `RAISED_IN_PERIOD` and `DELIVERED_IN_PERIOD` (data-model.md §2.7)
- [X] T025 [US1] Create `src/modules/platform/platform-overview.service.ts` computing the period figures on **two different bases** and reporting both in `period.basis`: `orderCount` counts **every state** bounded by `createdAt` (orders raised in the period), while `orderValue` and `litresMoved` count **`DELIVERED` orders only** bounded by `deliveredAt`. A single basis is not available — value and volume are meaningless for an undelivered order, and a delivered-only count would force five of the six buckets in T028 to zero (FR-001a, research R6)
- [X] T026 [US1] Add the point-in-time counts to `src/modules/platform/platform-overview.service.ts`: `Company.countDocuments({ type })` per type, and the station count reusing `StationsService`, relying on the `SUPER_ADMIN` plugin bypass rather than any new unscoped mechanism, so the overview is computed across every company with no scoping applied (FR-003, research R1)
- [X] T027 [US1] Add a `countForPlatform()` sibling to `src/modules/stations/stations.service.ts` delegating to the same `countDocuments({})`, so the operator's call site does not read as `countForCompany()` — which says the opposite of what it does for this caller (research R6)
- [X] T028 [US1] Add the `byOrderBucket` breakdown to `src/modules/platform/platform-overview.service.ts` by **delegating to `OrdersService.getPlatformSummary`** (T051) rather than counting a second time — one computation, so the home chart and the orders screen cannot drift apart. It must be bounded by `createdAt` over every state, the same basis as `orderCount`, so the six buckets sum to it exactly (FR-006, FR-023d)
- [X] T029 [US1] Create `src/modules/platform/platform.controller.ts` with `GET /platform/overview`, `@Roles(UserRole.SUPER_ADMIN)`, reusing `OrdersController.summary`'s existing current-calendar-month resolution for absent `from`/`to` and echoing the resolved period back (FR-004, FR-005)
- [X] T030 [US1] Create `src/modules/platform/platform.module.ts` and register it in `src/app.module.ts`
- [X] T031 [P] [US1] Create `<dashboard>/src/admin/dashboard/api/platform-overview.api.ts` and `<dashboard>/src/admin/dashboard/hooks/usePlatformOverview.ts`
- [X] T032 [US1] Replace the hardcoded `STAT_CARDS` in `<dashboard>/src/admin/dashboard/components/AdminDashboard.tsx` with live values, wiring the existing `DateRangePopup` to `from`/`to` so it actually re-fetches
- [X] T033 [US1] Remove the `trend`, `trendUp` and `date` props from all six stat cards in `AdminDashboard.tsx` and the markup that renders them — the platform computes no period-over-period comparison, so every one is fabricated (FR-009, FR-078). Do not replace them with a computed trend
- [X] T034 [US1] Replace `DOUGHNUT_CHARTS`, `DOUGHNUT_LEGEND_COMPANIES` and `DOUGHNUT_LEGEND_ORDERS` in `AdminDashboard.tsx` with the live breakdowns, rendering **six** order segments rather than the mock's two, so the segments can sum to the card above (FR-006)
- [X] T035 [US1] Wire the four `ACTION_CARDS` handlers in `AdminDashboard.tsx` to the invoices route, US4's onboarding form, the existing station-owner flow, and US6's announcement composer
- [X] T036 [US1] Audit the `MapTrackingCard`, `InvoicesSection` and `DoughnutSection` imports in `AdminDashboard.tsx` and remove any still rendering invented figures, recording each removal in the Removals table at the foot of this file — the precedent feature 009 set when it deleted these same components from the transport composition (FR-078)
- [X] T037 [US1] Add loading, empty and failed states with a retry to `AdminDashboard.tsx`, rendering zero and "not computed" differently (FR-076)

**Checkpoint**: the home screen reconciles against the platform. US1 and US2 are independently demonstrable.

---

## Phase 5: User Story 3 — The platform-wide order list and one order in full (Priority: P1)

**Goal**: the operator works every order on the platform, filters by bucket or real state, opens one
in full, and can force it closed.

**Independent Test**: place orders across several companies and states; confirm all appear, the state
counters match, and opening one shows every field against the real record.

> **Much of this story is already built** (research R4): `GET /orders` already returns every order to
> this role, `toRoleScopedShape` already grants the full record, and `buildSupplierInvoiceView`
> already omits the supplier-invoice key when none is confirmed. Do not rebuild these.

### Tests for User Story 3

- [X] T038 [P] [US3] Write `test/e2e/order-buckets.e2e-spec.ts` asserting the operator lists every order across several companies (FR-015, acceptance scenario 1)
- [X] T039 [P] [US3] Add bucket-filter cases: each of the six buckets returns exactly its states, and a single real `status` beneath a bucket also filters in `test/e2e/order-buckets.e2e-spec.ts` (FR-016)
- [X] T040 [P] [US3] Add the bucket-sum case: the summary bucket counts sum to the platform total with nothing double-counted and nothing unbucketed (acceptance scenario 2a, FR-023d) in `test/e2e/order-buckets.e2e-spec.ts`
- [X] T041 [P] [US3] Add the separation cases: an `AWAITING_ROUTING` order counts under `NEEDS_ATTENTION` and not `IN_PROGRESS`, and a rejected and a cancelled order count separately in `test/e2e/order-buckets.e2e-spec.ts` (scenarios 2b/2c, FR-023b, FR-023c)
- [X] T042 [P] [US3] Add the cursor-stability case: paging to the end with records being created mid-page shows no order twice and skips none in `test/e2e/order-buckets.e2e-spec.ts` (spec edge case, FR-016)
- [X] T043 [P] [US3] Add the supplier-invoice pair: an order with a confirmed supplier invoice returns the section, and one without **omits the key entirely** rather than returning zeros in `test/e2e/order-buckets.e2e-spec.ts` (scenario 4, FR-019)
- [X] T044 [P] [US3] Add force-complete cases: an `IN_TRANSIT` order completes with the reason recorded, and a `PENDING_APPROVAL` order returns 409 with the order unmoved in `test/e2e/order-buckets.e2e-spec.ts` (scenarios 5/6, FR-020, FR-021)
- [X] T045 [P] [US3] Add the summary-shape non-regression case: `FUEL_COMPANY_ADMIN` and `TRANSPORT_COMPANY_ADMIN` responses from `GET /orders/summary` are unchanged field-for-field in `test/e2e/order-buckets.e2e-spec.ts` (FR-075)
- [X] T045a [P] [US3] Write the FR-018 regression case in `test/e2e/order-buckets.e2e-spec.ts`: the operator opening an order receives the restricted fields (`verifications`, `tankSummary`, `stopEvents`, the dispatch fields) and a `CLIENT` opening the same order does not. This currently works by way of `toRoleScopedShape`'s role list and is asserted by nothing — every other "already works" claim in this feature has a test
- [X] T045b [P] [US3] Write the search cases in `test/e2e/order-buckets.e2e-spec.ts`: `?orderId=` returns that order alone, an unknown id returns an empty page, and a `CLIENT` passing another tenant's order id receives an empty page rather than that order (FR-016a, SC-003)
- [X] T046 [P] [US3] Write `test/unit/platform-summary.spec.ts` asserting `getPlatformSummary` returns all six buckets and a `total` equal to their sum
- [X] T047 [US3] **Guard test (trap 4)** — add to `test/e2e/order-buckets.e2e-spec.ts` a case exercising `?bucket=IN_PROGRESS` as a **`FUEL_COMPANY_ADMIN`**, asserting it returns that company's in-progress orders and no other company's. A unit test cannot see this: it correctly does not register the scoping plugins at all, which is how feature 016's identical leak survived until an e2e suite caught it

### Implementation for User Story 3

- [X] T048 [P] [US3] Create `src/modules/orders/dto/platform-summary.dto.ts` with the `from`/`to`/`buckets`/`total` shape from `contracts/rest-api-delta.md` §3
- [X] T049 [US3] Add the `bucket` filter to `OrdersService.findForUser` in `src/modules/orders/orders.service.ts`, expanding it to **`status: { $in: [...] }`** and never a `$or` — both plugins inject via `Query.where()`, which replaces a same-named top-level key rather than merging it (research R4)
- [X] T049a [US3] Add the `orderId` filter to `OrdersService.findForUser` in `src/modules/orders/orders.service.ts` as an exact `_id` match that overrides `bucket` and `status`. **Identifier only** — no free-text search over station, company or customer names: `Order` has no human reference field, its human-facing values are embedded snapshots, and the platform carries no text index, so free text would mean a new index plus a migration or an unindexed scan of every order (FR-016a, research R13)
- [X] T050 [US3] Add `@Query('bucket')` and `@Query('orderId')` to `OrdersController.findMine` in `src/modules/orders/orders.controller.ts`, returning 400 with `ORDER_BUCKET_STATUS_CONFLICT` when a supplied `status` is not a member of a supplied `bucket` — a contradictory pair must refuse, never return a silently empty page
- [X] T051 [US3] Add `getPlatformSummary(from, to)` to `src/modules/orders/orders.service.ts` counting all six buckets from `ORDER_STATUS_BUCKETS` — the platform-wide counts behind the operator's summary cards (FR-023)
- [X] T052 [US3] Add the `SUPER_ADMIN` branch to `OrdersController.summary` in `src/modules/orders/orders.controller.ts` returning `PlatformSummaryDto`, leaving the `FUEL_COMPANY_ADMIN` and default branches untouched — the operator currently falls through to the **transport company's** shape (research R5)
- [X] T053 [P] [US3] Create `src/common/constants/force-completable-statuses.ts` exporting `FORCE_COMPLETABLE_STATUSES = [LOADING, IN_TRANSIT, UNLOADING]`
- [X] T054 [US3] Add `UserRole.SUPER_ADMIN` to `forceComplete`'s `@Roles` in `src/modules/orders/orders.controller.ts` and replace the inline three-way stage comparison and its prose error message with `FORCE_COMPLETABLE_STATUSES` (FR-020, Constitution I)
- [X] T055 [P] [US3] Create `<dashboard>/src/admin/orders/api/admin-orders.api.ts` and `<dashboard>/src/admin/orders/hooks/useAdminOrders.ts` for the list, summary and force-complete calls
- [X] T056 [US3] Wire `<dashboard>/src/admin/orders/components/AdminOrdersPage.tsx` to the live list with bucket and state filters, replacing the mock's four summary cards with **five** — adding the `NEEDS_ATTENTION` card and keeping rejected and cancelled as separate figures never summed in the UI (FR-023a, FR-023b)
- [X] T056a [US3] Wire the search box in `<dashboard>/src/admin/orders/components/AdminOrdersPage.tsx` to `?orderId=`, with a label and placeholder stating that it takes an order identifier — so a search for a company name returning nothing reads as "this box takes an order number" rather than "that order does not exist" (FR-016a)
- [X] T057 [P] [US3] Wire `AdminDesktopOrdersTable.tsx` and `AdminMobileOrdersList.tsx` in `<dashboard>/src/admin/orders/components/` to the live row fields (FR-017)
- [X] T058 [US3] Wire the detail cards in `<dashboard>/src/admin/orders/components/order-details/` — `AdminOrderHeader`, `AdminOrderDataCard`, `AdminTransportCompanyCard`, `SupplierDataCard`, `AdminLinkedInvoicesCard` — to `GET /orders/:id`
- [X] T059 [US3] Wire `<dashboard>/src/admin/orders/components/order-details/AramcoInvoiceCard.tsx` to key off **absence of the `supplierInvoice` key**, not `=== 0` — a supplied quantity of zero is a different fact from no supplier invoice (FR-019)
- [X] T060 [US3] Remove any order-detail element with no data source from `<dashboard>/src/admin/orders/components/order-details/` — a street-level distance, and the platform commission, which `Order` carries **no field for at all**, so FR-022's element is always absent rather than conditionally hidden — and record each removal in the Removals table at the foot of this file (FR-022, FR-024, FR-078)
- [X] T061 [US3] Add the force-complete action with a required reason to `<dashboard>/src/admin/orders/components/AdminOrderDetailPage.tsx`, rendering a 409 as the platform's stated refusal with the row unmoved (FR-021)

**Checkpoint**: all three P1 stories complete. This is a coherent, demonstrable release.

---

## Phase 6: User Story 4 — Transport company oversight and onboarding (Priority: P2)

**Goal**: the operator sees every transporter, opens one, suspends or reinstates it, and onboards a
new one naming its parent fuel company.

**Independent Test**: onboard a transport company through the operator's form; its administrator
signs in to their own surface with every screen loading; suspend it and the administrator is refused.

**Depends on**: US2 (the parent select reads `?type=FUEL`; the list reads `?type=TRANSPORT`).

### Tests for User Story 4

- [X] T062 [P] [US4] Write `test/e2e/transport-onboarding.e2e-spec.ts` asserting the operator onboards a transport company and its first administrator together, and that administrator can sign in, end to end with no other role involved (FR-027, SC-004, scenario 2)
- [X] T063 [P] [US4] Add the atomicity cases to `test/e2e/transport-onboarding.e2e-spec.ts`: a duplicate administrator email returns 409 and leaves **neither** company nor admin, verified by `countDocuments` before and after (FR-028)
- [X] T064 [P] [US4] Add the parent-validation cases: absent, malformed, non-existent and non-`FUEL` `parentFuelCompanyId` each return 400 and create nothing in `test/e2e/transport-onboarding.e2e-spec.ts` (FR-030, scenario 3)
- [X] T064a [P] [US4] **The SC-005 test** — add a case to `test/e2e/transport-onboarding.e2e-spec.ts` asserting that transport companies created **before** this feature (seeded directly, not through the operator's route) remain visible to and manageable by their parent fuel company's administrator, with no change in behaviour
- [X] T064b [P] [US4] Add the order-volume cases to `test/e2e/transport-onboarding.e2e-spec.ts`: volumes for a page of companies resolve in **one** request, a transporter no order has ever been routed to returns `orderCount: 0` rather than being omitted, and the period defaults identically to `GET /platform/overview` (FR-026, FR-026a, FR-026b)
- [X] T065 [US4] **The SC-006 test** — add a case to `test/e2e/transport-onboarding.e2e-spec.ts` that onboards transporter A through the operator's route and transporter B through the parent fuel company's own `POST /companies/:id/transporters`, then drives **both** through the same journey: the parent lists both, an order routes to each, regions assign to each. Assert no observable difference. This is the test that proves FR-031, and it is the only one that can (isolation contract §2)

### Implementation for User Story 4

- [X] T066 [P] [US4] Create `src/modules/companies/dto/onboard-transport-company.dto.ts` with a **required**, `ObjectId`-validated `parentFuelCompanyId` alongside the company and first-administrator fields (FR-029, FR-030)
- [X] T067 [US4] Add `POST /companies/transporters` to `src/modules/companies/companies.controller.ts` with `@Roles(UserRole.SUPER_ADMIN)`, verifying the named parent exists **and is of type `FUEL`** before any write — a merely-present id satisfies FR-030's letter and none of its purpose
- [X] T068 [US4] Implement the `POST /companies/transporters` handler in `src/modules/companies/companies.controller.ts` reusing `createTransporter`'s two-write `session.withTransaction` verbatim, and **omit** its post-insert `companyId` correction with a comment explaining why: that correction exists because a `FUEL_COMPANY_ADMIN` actor's tenant clobbers the new admin's, and for a `SUPER_ADMIN` actor the `pre('save')` hook returns early and writes nothing (research R12)
- [X] T068a [US4] Add `GET /platform/transport-company-volumes` to `src/modules/platform/platform.controller.ts` with `@Roles(UserRole.SUPER_ADMIN)`, taking `companyIds`, `from` and `to` and resolving the period exactly as `GET /platform/overview` does (FR-026a)
- [X] T068b [US4] Implement the volume resolver in `src/modules/platform/platform-overview.service.ts` as **one** `$match` + `$group` over `Order` keyed on `transportCompanyId` — never one query per company (FR-026b). Count orders **raised** in the period, the same basis as the overview's `orderCount`, and emit `orderCount: 0` for a company with none rather than omitting the row
- [X] T069 [P] [US4] Create `<dashboard>/src/admin/transport_companies/api/transport-companies.api.ts` for the list, detail, onboarding and status calls
- [X] T070 [US4] Wire `<dashboard>/src/admin/transport_companies/components/AdminTransportCompaniesPage.tsx`, `AdminTransportCompaniesStats.tsx` and `AdminTransportCompanyListItem.tsx` to `?type=TRANSPORT`, deriving the covered-area count from `servedRegions.length` in the same payload (FR-025, FR-026)
- [X] T070a [US4] Wire the order-volume column in `<dashboard>/src/admin/transport_companies/components/AdminTransportCompaniesPage.tsx` to `GET /platform/transport-company-volumes`, issuing **one** call for the whole page with the rendered companies' ids (FR-026, FR-026b)
- [X] T071 [US4] Wire `<dashboard>/src/admin/transport_companies/components/AdminTransportCompanyDetailsPage.tsx`, `AdminTransportCompanyInfoCard.tsx` and `AdminCompanyDriversCard.tsx` to the company record, its administrator via `GET /users?role=TRANSPORT_COMPANY_ADMIN&companyId=`, and its drivers via `GET /users?role=DRIVER&companyId=` (FR-034, FR-035, FR-036)
- [X] T072 [US4] Build the onboarding form in `<dashboard>/src/admin/transport_companies/components/AddTransportCompanyPage.tsx` with `parentFuelCompanyId` as a **required** select populated from `?type=FUEL`, showing company names rather than ids and stating that the parent cannot be changed afterwards (FR-030)
- [X] T073 [US4] Wire suspend and reinstate in `<dashboard>/src/admin/transport_companies/components/AdminTransportCompanyDetailsPage.tsx` to the existing `PATCH /companies/:id/status`, which is already operator-only and type-agnostic — no backend change (FR-033)
- [X] T074 [US4] Remove the performance-rating and average-delivery-time elements from the transport-company detail components in `<dashboard>/src/admin/transport_companies/components/` and record the removals in the Removals table at the foot of this file — neither has a data source (FR-037, FR-078)

**Checkpoint**: the operator can oversee and onboard transporters; nothing about existing transporters changed.

---

## Phase 7: User Story 5 — The platform's driver roster (Priority: P2)

**Goal**: the operator sees every driver, their employer, their most recently operated truck, and
their active and duty state — and nothing about where that person has been.

**Independent Test**: seed drivers across several transport companies; every driver appears with
employer and truck; the filters narrow correctly.

### Tests for User Story 5

- [X] T075 [P] [US5] Write `test/e2e/driver-roster.e2e-spec.ts` asserting every driver across every transport company appears, each naming its employer (FR-038, FR-039, scenario 1)
- [X] T076 [P] [US5] Add the never-connected case: the driver is **present** with `dutyState: UNKNOWN`, not omitted — the omission feature 010 found in dispatch in `test/e2e/driver-roster.e2e-spec.ts` (FR-040)
- [X] T077 [P] [US5] Add the never-driven case: `lastOperatedTruck` is `null`, rendered distinctly from unknown in `test/e2e/driver-roster.e2e-spec.ts` (FR-039b, scenario 6)
- [X] T078 [P] [US5] Add the two-truck case: the driver with deliveries on two trucks shows the **most recent** in `test/e2e/driver-roster.e2e-spec.ts` (FR-039a, scenario 5)
- [X] T079 [US5] **Guard test (trap 2)** — add a case to `test/e2e/driver-roster.e2e-spec.ts` that puts the driver's most recent truck on another active order, then asserts the roster **still names it**. The roster states a historical fact; a truck being busy must not make an experienced driver read as "never driven" (research R8)
- [X] T080 [P] [US5] **The SC-014 test** — in `test/e2e/driver-roster.e2e-spec.ts`, assert on the serialized response body that it contains none of `location`, `driverLocation`, `lastSeenAt`, `lastMovedAt`, `lastMovedLocation`, `activeOrderId`, `stopEvents`, `deliveredAt`, `orderId`, or any trip count. Assert on what the platform **sends**, not on what a screen renders (FR-043, FR-044, FR-044a)
- [X] T081 [P] [US5] Add the filter and authorization cases: `isActive` and `dutyState` narrow the roster, and every non-operator role receives 403 in `test/e2e/driver-roster.e2e-spec.ts` (FR-041, FR-074, SC-012)

### Implementation for User Story 5

- [X] T082 [P] [US5] Create `src/modules/drivers/dto/driver-roster.dto.ts` with the shape from `contracts/rest-api-delta.md` §5 and a three-valued `DutyState` enum in `src/common/enums/duty-state.enum.ts`
- [X] T083 [US5] Create `src/modules/drivers/driver-roster.service.ts` paging drivers with `paginate()` sorted on **`createdAt`/`_id`** — fields every driver document has — never `lastSeenAt` or `isOnline`, or a never-connected driver silently vanishes (FR-040)
- [X] T084 [US5] Add the last-truck derivation to `driver-roster.service.ts` as **one aggregate for the whole page**, grouping `Order` by `driverId` sorted by `createdAt` desc and projecting **`truckId` alone** — reusing the existing `{ driverId, truckId, createdAt }` partial index but **not** `DispatchService.getSuggestedTruck`, whose availability filter would suppress a busy truck (research R8)
- [X] T085 [US5] Resolve employing company names in `driver-roster.service.ts` with one batched lookup per page, never one query per row
- [X] T086 [US5] Add `GET /drivers/roster` to `src/modules/drivers/drivers.controller.ts` with `@Roles(UserRole.SUPER_ADMIN)` and `isActive`, `dutyState` and `cursor` query parameters
- [X] T087 [P] [US5] Create `<dashboard>/src/admin/drivers/api/driver-roster.api.ts` and `<dashboard>/src/admin/drivers/hooks/useDriverRoster.ts`
- [X] T088 [US5] Replace `MOCK_DRIVERS` in `<dashboard>/src/admin/drivers/components/AdminDriversPage.tsx` with the live roster, mapping the existing `FILTERS` array to `isActive` and `dutyState` (FR-041)
- [X] T089 [US5] Remove the `capacity`, `tripsMonth` and `lastShipment` columns from the operator's driver table in `<dashboard>/src/admin/drivers/components/AdminDriversPage.tsx` — `capacity` is a tank attribute with no driver source, and the other two are per-driver trip aggregates FR-044 forbids. Render `rating` only if read from `User.ratingAverage`, absent when unrated and never `0`. Record each removed column in the Removals table at the foot of this file
- [X] T090 [US5] Make the shared `DriversStats`, `DesktopDriversTable` and `MobileDriversList` components in `<dashboard>/src/transport_company/drivers/components/` accept a column configuration and have the operator's screen omit the excluded columns — **do not** change the transport company's own screen, which FR-075 puts out of scope. Reusing these verbatim would reintroduce the forbidden fields through a component the operator's file never mentions
- [X] T091 [US5] Render `lastOperatedTruck: null` as an explicit "never driven" in `<dashboard>/src/admin/drivers/components/AdminDriversPage.tsx`, distinct from blank or placeholder text (FR-039b)
- [X] T091a [US5] Wire `<dashboard>/src/admin/drivers/components/AdminDriverDetailsPage.tsx` to the driver's own record via `GET /users/:id` and their employer via `GET /companies/:id`, feeding `AdminDriverTransportCompanyCard.tsx`. Both routes are unchanged and already admit the operator. **Wire before removing** (T092) — removing first leaves a screen with nothing on it and no signal that the wiring is still outstanding (FR-042)
- [X] T092 [US5] Drop the cards rendering excluded data from `<dashboard>/src/admin/drivers/components/AdminDriverDetailsPage.tsx` rather than rendering them empty, keeping the driver's own record and `AdminDriverTransportCompanyCard.tsx` (FR-045)

**Checkpoint**: the roster answers "who is this driver and who employs them" and nothing more.

---

## Phase 8: User Story 6 — Notifications and platform announcements (Priority: P3)

**Goal**: the operator reads their real notifications and sends an announcement reaching every
company administrator.

**Independent Test**: trigger a notification and confirm it appears; send an announcement and confirm
every company administrator receives it and no one else does.

> The notification half needs **no backend work** — `GET /notifications`,
> `PATCH /notifications/:id/read` and `PATCH /notifications/read-all` are already role-agnostic and
> cursor-paged (research, cross-cutting table). Tasks T102–T103 are wiring only.

### Tests for User Story 6

- [X] T093 [P] [US6] Write `test/e2e/announcements.e2e-spec.ts` asserting `POST /announcements` returns **202** promptly and does not block on delivery (FR-055)
- [X] T094 [US6] **Guard test (trap 3)** — in `test/e2e/announcements.e2e-spec.ts`, assert delivery by authenticating **as the recipient administrator** and reading their own notification list. Reading it back as the operator proves nothing: the operator bypasses tenant scoping and would see a wrongly-stamped notification the recipient cannot (research R9)
- [X] T095 [P] [US6] Add the recipient-role cases: every active administrator of every active company receives it, and **no `CLIENT` or `DRIVER` does**, asserted by role rather than by count in `test/e2e/announcements.e2e-spec.ts` (FR-049, FR-051, SC-008)
- [X] T096 [P] [US6] Add the subset case: an announcement naming specific companies reaches only those companies' administrators in `test/e2e/announcements.e2e-spec.ts` (FR-050)
- [X] T097 [P] [US6] Add the idempotency case: re-running the fan-out job produces **zero** duplicate deliveries, and each administrator still holds exactly one in `test/e2e/announcements.e2e-spec.ts` (FR-053, SC-009)
- [X] T098 [P] [US6] Add the unreachable cases: a suspended company and a deactivated administrator are each skipped with their own named reason and **not** counted as delivered in `test/e2e/announcements.e2e-spec.ts` (FR-054, spec edge cases)
- [X] T099 [P] [US6] Add the authorization case: a `FUEL_COMPANY_ADMIN` attempting to send receives 403 in `test/e2e/announcements.e2e-spec.ts` (FR-056, SC-012)

### Implementation for User Story 6

- [X] T100 [P] [US6] Create `src/common/enums/announcement-state.enum.ts` and `src/common/enums/announcement-delivery-failure-reason.enum.ts` with `COMPANY_SUSPENDED`, `ADMIN_DEACTIVATED` and `NO_ACTIVE_ADMIN` — a named reason, never a boolean (FR-054)
- [X] T101 [P] [US6] Add `PLATFORM_ANNOUNCEMENT` to `src/common/enums/notification-type.enum.ts` with a comment recording that every recipient is an administrator and no mobile persona renders it, following feature 016's precedent for its exchange types
- [X] T102 [P] [US6] Create `src/modules/announcements/schemas/announcement.schema.ts` with **no scoping marker** and a comment saying why — its author has no tenant, so marking it would make an announcement unreadable by its own sender (data-model.md §3)
- [X] T103 [US6] Create `src/modules/announcements/schemas/announcement-delivery.schema.ts` with **no scoping marker** and the unique index on `{ announcementId: 1, recipientUserId: 1 }` — this index, not the queue and not a prior read, is the FR-053 guarantee (data-model.md §4.1)
- [X] T104 [US6] Create `src/modules/announcements/announcements.service.ts` resolving recipients as every `isActive` `FUEL_COMPANY_ADMIN`/`TRANSPORT_COMPANY_ADMIN` in an `ACTIVE` company, creating the `Announcement` and enqueuing the fan-out
- [X] T105 [US6] Create `src/modules/announcements/announcement-fanout.queue.ts` following `src/modules/assignment-escalation/`'s existing `*QueueService.schedule/cancel` shape
- [X] T106 [US6] Create `src/modules/announcements/announcement-fanout.processor.ts` writing one `Notification` per recipient and **stamping `companyId` explicitly** — a BullMQ worker has no request context, so `pre('save')` stamps nothing and an unstamped or wrongly-stamped notification is invisible to its recipient (research R9)
- [X] T107 [US6] Catch the duplicate-key error in the processor with the existing `isDuplicateKeyError` idiom and skip, rather than failing the job — BullMQ is at-least-once and `Worker.close()` deliberately releases an unfinished job for redelivery (data-model.md §4.1)
- [X] T108 [US6] Add an `'error'` event handler to the new queue via `src/common/queues/queue-error-handling.ts`, since an unhandled one crashes the process (feature 012's finding)
- [X] T109 [US6] Create `src/modules/announcements/announcements.controller.ts` with `POST /announcements` (202), `GET /announcements` and `GET /announcements/:id`, all `@Roles(UserRole.SUPER_ADMIN)` (FR-048, FR-052, FR-056)
- [X] T110 [US6] Create `src/modules/announcements/announcements.module.ts` registering the queue and processor, and register it in `src/app.module.ts`
- [X] T111 [P] [US6] Create `<dashboard>/src/admin/notifications/api/notifications.api.ts` and hooks for the existing notification routes
- [X] T112 [US6] Wire `<dashboard>/src/admin/notifications/components/AdminNotificationsPage.tsx` to the live list with mark-one-read and mark-all-read (FR-046, FR-047)
- [X] T113 [US6] Build the announcement composer in `<dashboard>/src/admin/notifications/components/AdminAnnouncementComposer.tsx`, handling **202 as queued rather than delivered**, rendering `intendedRecipientCount`, and offering the outcome via `GET /announcements/:id` rather than blocking (FR-055)

**Checkpoint**: the operator can reach every company administrator, exactly once, with a record of who was missed.

---

## Phase 9: User Story 7 — The operator's own account and sign-in (Priority: P3)

**Goal**: the operator reads their real identity, session count and last sign-in, and changes the
mobile number they sign in with.

**Independent Test**: sign in from two devices; the profile reports two sessions and the correct last
sign-in; change the number and the new one signs in while the old does not.

> Most of this story already works (research R10). The one real defect is that the duplicate-phone
> pre-check cannot see administrator accounts.

### Tests for User Story 7

- [X] T114 [P] [US7] Write `test/e2e/operator-profile.e2e-spec.ts` asserting `GET /auth/me/account` returns the operator's real name, email and sign-in number (FR-057, scenario 1)
- [X] T115 [P] [US7] Add the session case: signing in from two devices reports `activeSessionCount: 2` and a `lastSignInAt` matching the most recent sign-in in `test/e2e/operator-profile.e2e-spec.ts` (FR-058, FR-059, SC-010)
- [X] T116 [US7] **The FR-061 test** — in `test/e2e/operator-profile.e2e-spec.ts`, attempt a phone change to a number held by **another administrator** and assert 409 at the **request** step with **no SMS sent** and the existing number unchanged. The current pre-check calls `findByPhoneForAuth`, which is scoped to `CLIENT`/`DRIVER`, so this presently spends a message and fails only at confirm (research R10)
- [X] T117 [P] [US7] Add the deactivated-holder case: a number held by a **deactivated** account is also refused — a deactivated account still holds its identifier in `test/e2e/operator-profile.e2e-spec.ts` (spec edge case)
- [X] T118 [P] [US7] **The FR-062 regression test** — in `test/e2e/operator-profile.e2e-spec.ts`, confirm a number change leaves `sessionGeneration` and `activeSessions` untouched and the operator's other session still works. A future "re-authenticate after a credential change" instinct would silently destroy feature 015's concurrent administrator sessions
- [X] T119 [P] [US7] Add the authorization case: non-operator roles receive 403 from `GET /auth/me/account` in `test/e2e/operator-profile.e2e-spec.ts` (FR-074, SC-012)

### Implementation for User Story 7

- [X] T120 [US7] Add `findAnyByPhone(phone)` to `src/modules/users/users.service.ts` — role-agnostic and active-agnostic, used **only** by the phone-change pre-check. Do **not** modify `findByPhoneForAuth` or `findSingleActiveAdminByPhone`; both are load-bearing for sign-in and their scoping is deliberate and commented (FR-075)
- [X] T121 [US7] Change the holder lookup in `PhoneVerificationService.requestVerification` in `src/modules/users/services/phone-verification.service.ts` to use `findAnyByPhone`, restoring the method's own documented promise that "a message is never spent on a doomed change" (FR-061)
- [X] T122 [P] [US7] Create `src/modules/auth/dto/operator-account.dto.ts` with the shape from `contracts/rest-api-delta.md` §7
- [X] T123 [US7] Add `GET /auth/me/account` to `src/modules/auth/auth.controller.ts` with `@Roles(UserRole.SUPER_ADMIN)`, reading `activeSessionCount` from `User.activeSessions.length` and `lastSignInAt` from the newest `SessionEvent` with `type: SIGNED_IN` for this user — the append-only, TTL-free audit log, which stays correct after a sign-out empties the array (research R10)
- [X] T124 [P] [US7] Create `<dashboard>/src/admin/profile/api/operator-account.api.ts` and its hook
- [X] T125 [US7] Wire `<dashboard>/src/admin/profile/components/AdminProfilePage.tsx`, `AdminProfileHeader.tsx`, `AdminProfileAccountCard.tsx` and `AdminProfileSecurity.tsx` to the live account, replacing the masked placeholder number with the real sign-in identifier (FR-057, FR-058, FR-059)
- [X] T126 [US7] Wire `<dashboard>/src/admin/profile/components/AdminChangePhoneModal.tsx` to the existing verification routes, rendering `409 PHONE_IN_USE` as a stated refusal at the first step (FR-060, FR-061)
- [X] T127 [US7] **Delete** `<dashboard>/src/admin/profile/components/AdminProfilePermissions.tsx` and its usage — the platform has no permission model beyond `UserRole`, so there is nothing to fetch now or later without a new feature. Record the removal in the Removals table at the foot of this file (FR-063, FR-078)
- [X] T128 [US7] Reduce `<dashboard>/src/admin/profile/components/AdminProfileStats.tsx` and `AdminProfileAdditionalData.tsx` to only the fields `GET /auth/me/account` returns, removing the rest rather than zeroing them and recording each in the Removals table at the foot of this file (FR-063)

**Checkpoint**: the operator can read and change their own access without losing their other sessions.

---

## Phase 10: User Story 8 — Settling a cashback owed to a fuel company (Priority: P3)

**Goal**: the operator sees what the platform owes a fuel company and records a payout against it,
with the company's balance falling by exactly that amount.

**Independent Test**: accrue a cashback balance, record a payout, and confirm the balance falls by
exactly that amount and the payout appears in both ledgers.

### Tests for User Story 8

- [X] T129 [P] [US8] Write `test/unit/cashback-owed.spec.ts` asserting `getCashbackOwed` nets confirmed `CASHBACK_PAID_OUT` against confirmed `CASHBACK_CREDITED`
- [X] T130 [US8] **Guard test (trap 1)** — write `test/e2e/cashback-payout.e2e-spec.ts` asserting that after a payout the **owed balance actually falls**. A payout recorded under a new kind leaves `getConfirmedBalance(CASHBACK_CREDITED)` untouched, so an implementation that reuses the per-kind method passes every other test here and violates FR-067 silently (research R11)
- [X] T131 [P] [US8] Add the partial and full cases: a partial payout reduces the balance by exactly the amount with the remainder still owed, and a payout for the remainder reaches zero in `test/e2e/cashback-payout.e2e-spec.ts` (FR-067, SC-011, scenarios 2/3)
- [X] T132 [P] [US8] Add the over-balance case: a payout greater than the owed balance returns 409 and records nothing, verified by movement count in `test/e2e/cashback-payout.e2e-spec.ts` (FR-068, scenario 4)
- [X] T133 [P] [US8] Add the duplicate-reference case: a reference already recorded for that company is refused, not applied twice in `test/e2e/cashback-payout.e2e-spec.ts` (FR-070, spec edge case)
- [X] T134 [P] [US8] Add the FR-069 case: the payout is evaluated against the balance **at the moment it is recorded**, by mutating the accrual between reading the screen's figure and submitting in `test/e2e/cashback-payout.e2e-spec.ts`
- [X] T135 [P] [US8] Add the recipient case: the fuel company's own administrator sees the payout in their platform-account ledger identified as money received from the platform in `test/e2e/cashback-payout.e2e-spec.ts` (FR-071, scenario 5)
- [X] T136 [P] [US8] Add the authorization case: a `FUEL_COMPANY_ADMIN` attempting to record a payout receives 403 — a company must never record money as having been paid to it in `test/e2e/cashback-payout.e2e-spec.ts` (FR-072, SC-012)

### Implementation for User Story 8

- [X] T137 [P] [US8] Add `CASHBACK_PAID_OUT` to `src/common/enums/account-movement-kind.enum.ts` and create `src/common/enums/account-movement-direction.enum.ts` with `INBOUND`/`OUTBOUND`
- [X] T138 [US8] Add the partial unique index on `{ companyId: 1, kind: 1, reference: 1 }` to `src/modules/platform-account/schemas/account-movement.schema.ts`, partial on **both** `kind: CASHBACK_PAID_OUT` and `reference: { $exists: true }` — without the kind clause it would constrain existing `PAYMENT_RECORDED` rows that have never been unique on reference (data-model.md §5.2)
- [X] T139 [US8] Add `getCashbackOwed(companyId, session?)` to `src/modules/platform-account/platform-account.service.ts` as a **new two-kind derivation** beside the existing per-kind `getConfirmedBalance`, which is left unchanged (research R11)
- [X] T140 [US8] Add `recordCashbackPayout` to `src/modules/platform-account/platform-account.service.ts` as **one transaction** that re-reads the owed balance **inside** the session before comparing, creating the movement already `CONFIRMED` — there is no second party to confirm an operator's own assertion, and leaving it `RECORDED` would mean it did not reduce the balance (FR-069, Constitution V)
- [X] T141 [US8] Catch the duplicate-key error from the T138 index in `recordCashbackPayout` in `src/modules/platform-account/platform-account.service.ts` and convert it to `CASHBACK_PAYOUT_DUPLICATE_REFERENCE` (409), using the existing `isDuplicateKeyError` idiom (FR-070)
- [X] T142 [P] [US8] Create `src/modules/platform-account/dto/record-cashback-payout.dto.ts` with `amount` (> 0), `method`, a **required** `reference` and an optional evidence file
- [X] T143 [US8] Add `GET /platform-account/cashback/:companyId/owed` and `POST /platform-account/cashback/:companyId/payouts` to `src/modules/platform-account/platform-account.controller.ts`, both `@Roles(UserRole.SUPER_ADMIN)`, routing evidence through the existing `FilesService`. **No payment provider is integrated** — these routes record that money moved elsewhere (FR-065, FR-066, FR-072, FR-073)
- [X] T144 [US8] Add the derived `direction` to every movement in the `GET /platform-account/movements` response in `src/modules/platform-account/platform-account.service.ts`, computed from `kind` at serialisation and **not** added to the schema — no existing row migrates and feature 013's dashboard reads it unchanged (FR-064, research R11)
- [X] T145 [P] [US8] Create `<dashboard>/src/admin/payment/api/cashback.api.ts` and its hook
- [X] T146 [US8] Replace the hardcoded `TOTAL_AMOUNT = 299060.50` in `<dashboard>/src/admin/payment/components/AdminPaymentPage.tsx` with the live owed figure, and correct the file's comment asserting the platform "never pays a company out through this flow" — true when written, false after this story (FR-065)
- [X] T147 [US8] Make the submit real in `AdminPaymentPage.tsx`, wiring method, required reference and evidence, rendering 409 refusals as refusals and **not** optimistically decrementing the displayed balance — the authoritative figure is re-read server-side (FR-066, FR-068, FR-069, FR-070)
- [X] T148 [US8] Render the derived `direction` in `<dashboard>/src/petrol_company/platform_account/` ledger rows so a payout reads as money received from the platform and is never indistinguishable from a payment the company made (FR-064, FR-071, scenario 6)

**Checkpoint**: all eight stories complete.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T149 [P] Add the per-capability authorization refusal test for every remaining new route to `test/e2e/operator-authorization.e2e-spec.ts`, using `contracts/rest-api-delta.md` §9's matrix as the checklist — SC-012 requires this **per capability**, not once for the feature
- [X] T150 [P] Add the FR-012 non-regression assertions to `test/e2e/company-type-filter.e2e-spec.ts` and `test/e2e/order-buckets.e2e-spec.ts`: an absent filter returns exactly today's result for every existing caller (FR-075, isolation contract §5.1)
- [X] T151 [P] Add bilingual strings for every screen this feature wired to `<dashboard>/src/lib/i18n/ar.json` and `<dashboard>/src/lib/i18n/en.json`, preserving key parity for `<dashboard>/tests/unit/i18n-rtl.test.tsx`, and verify RTL layout. Do **not** retrofit screens this feature did not touch (FR-077)
- [X] T152 [P] Sweep every operator screen under `<dashboard>/src/admin/` wired by this feature and confirm each distinguishes loading, empty and failed with a retry, adding the states to any screen whose own story task did not already (T037 covers the home dashboard; this is the check that nothing was missed, not a second pass over it) — an empty list and a failed fetch must never render identically (FR-076)
- [X] T152a Confirm the Removals table at the foot of `specs/017-super-admin-dashboard-backend/tasks.md` has one row for every element dropped by T033, T036, T060, T074, T089, T127 and T128, each naming the file and why the platform has no source for it — SC-007 requires every remaining gap to be a recorded removal, not merely a deleted line
- [X] T153 Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` with the five new and four changed routes so the canonical contract matches the platform
- [X] T154 Review the full diff against `contracts/isolation-contract.md` §1 and confirm neither scoping plugin, nor `findByPhoneForAuth`, nor `findSingleActiveAdminByPhone`, nor the transporter-resolution routing query was modified (FR-032, FR-075)
- [X] T155 Run `npm run build`, `npx tsc --noEmit`, `npm run test` and `npm run test:e2e` in `E:zeyadciro_fuel_backend` and compare against the T003 baseline, confirming any e2e failure is in the known pre-existing flaky set and passes in isolation
- [X] T156 Run `npx tsc -b --force` and `npx vitest run` in `E:\zeyad\web_dashboard_ciro_fuel` and compare against the T004 baseline — no new errors and no new failures (FR-075, SC-013)
- [X] T157 Walk `quickstart.md` Parts 1–8 against a running server and record each result in its Results table — **done**: walked against the branch build on a real MongoDB replica set + Redis. Every figure reconciled against independently derived database counts rather than against the API's own output. Found four defects the suites could not see, all fixed (see *Corrections found while walking the quickstart*), plus a full order lifecycle driven end to end through the public API: quote → order → approve → route → assign → NFC departure verification → geofenced depot re-verification → loading → in transit → arrival code → unloading → delivery code → DELIVERED → rating → invoice
- [ ] T158 Walk `quickstart.md` Part 9 and run `flutter test` in the mobile repository — **required before deploy** because this feature adds `NotificationType.PLATFORM_ANNOUNCEMENT` and spec 007 installed a parity test pinning the Flutter enum to the backend's wire values (SC-013)

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies
- **Phase 2 (Foundational)**: depends on Setup — **blocks every user story**
- **Phase 3 (US2)**: depends on Foundational. **Blocks US1 and US4**
- **Phase 4 (US1)**: depends on US2 (company-type chart)
- **Phase 5 (US3)**: depends on Foundational only
- **Phase 6 (US4)**: depends on US2 (parent select and transporter list both use the type filter) **and on US1's T029/T030**, which create the `platform` module that T068a/T068b extend with the order-volume route. In the recommended sequence US1 lands first anyway, so this costs no parallelism
- **Phases 7–10 (US5, US6, US7, US8)**: depend on Foundational only — mutually independent
- **Phase 11 (Polish)**: depends on all desired stories

### Story dependency graph

```
Setup → Foundational ─┬→ US2 ──→ US1 ──→ US4
                      │                 (US4 extends the platform module US1 creates)
                      ├→ US3
                      ├→ US5
                      ├→ US6
                      ├→ US7
                      └→ US8
```

US2 blocks US1; US1 blocks US4 (the `platform` module). US3, US5, US6, US7 and US8 are fully
independent of one another and of that chain, and can be staffed in parallel.

### Within each story

- Guard tests before the implementation they guard (T047→T049, T079→T084, T094→T106, T130→T140)
- **Wire before removing** on any screen where both happen (T091a→T092), or the screen is emptied
  with no signal that the wiring step is still outstanding
- Dashboard constants (T008a) before any dashboard `api/` file, or every client writes a literal a
  later task has to undo
- Enums and constants before the services that consume them
- Schemas and indexes before the services that write through them
- Services before controllers
- Backend before the dashboard wiring that calls it

---

## Parallel Opportunities

**Within Setup**: T003 and T004 (different repositories).

**Within Foundational**: T007 and T008 (different files).

**Within any story's test block**: every task marked [P] writes a distinct case and can be authored
together — for example US1's T017–T023, US5's T075–T078 plus T080–T081, US8's T131–T136.

**Across stories, once Foundational and US2 are done**: US3, US5, US6, US7 and US8 involve disjoint
modules and can proceed simultaneously.

```bash
# US5's independent test cases, authored together:
Task: "T076 never-connected driver appears with dutyState UNKNOWN"
Task: "T077 never-driven driver shows lastOperatedTruck null"
Task: "T078 two-truck driver shows the most recent"
Task: "T080 SC-014 — response body carries no positional or trip field"
Task: "T081 filters narrow and non-operator roles receive 403"
```

```bash
# Five independent stories in parallel after US2:
Developer A: Phase 5  (US3 — orders)
Developer B: Phase 7  (US5 — driver roster)
Developer C: Phase 8  (US6 — announcements)
Developer D: Phase 9  (US7 — profile)
Developer E: Phase 10 (US8 — cashback)
```

---

## Implementation Strategy

### MVP — Setup + Foundational + US2

T001 through T016, including T008a. Seventeen tasks fix a live defect that has been misinforming the
platform's only oversight role since feature 013, on their most-used screen. It ships on its own,
and US1's company chart cannot be correct without it.

### Increment 2 — the P1 set

Add US1 (T017 through T037, including T021a and T024a) and US3 (T038 through T061, including T045a,
T045b, T049a and T056a). At this point the operator's home screen reconciles against
the platform and they can work any order on it. This is the first coherent release: the three stories
the spec marks P1 are exactly the ones whose absence makes the surface untrustworthy.

### Increment 3 — the P2 set

Add US4 (T062 through T074, including T064a, T064b, T068a, T068b and T070a) and US5 (T075 through
T092, including T091a). The operator can now act on both halves of the platform and
answer "who is this driver and who employs them".

### Increment 4 — the P3 set

Add US6, US7 and US8 (T093–T148). Three independent capabilities, deliverable in any order.

### Then Polish

T149 through T158, including T152a. Note that **T158 is a deploy gate, not a nicety** — it runs in a repository not present on
this machine.

---

## Notes

- `[P]` means a different file with no incomplete dependency.
- Commit after each task or logical group.
- **Do not edit either scoping plugin.** No task requires it.
- The four guard tests exist because their traps produce passing happy-path tests. Write them first.
- `npm run lint:check` is unusable on this Windows checkout — `core.autocrlf=true` with no
  `.gitattributes` makes eslint-plugin-prettier flag `␍` repo-wide. Pre-existing, documented by
  feature 015. Git still normalises to LF, so commits are clean.

### Baselines

> Recorded by T003 and T004 before any implementation begins.

| Suite | Baseline | Date |
|---|---|---|
| backend `npm run test` | **40 suites / 316 tests, all passing.** With this feature's `order-status-buckets.spec.ts` added: 41 suites / 323 tests, all passing. | 2026-09-12 |
| backend `npm run test:e2e` | **97 of 102 suites, 756 of 766 tests passing.** **All ten suites this feature wrote pass — in isolation AND inside the full run.** The 5 failing suites are each accounted for and none is a regression: `request-logging` passes in isolation (8/8) and is the documented sequential-`MongoMemoryReplSet` resource-pressure set; `file-storage` fails deterministically on this Windows checkout for a path-separator reason in files this feature never touched; and `login-code`, `login-abuse` and `admin-multi-session` fail deterministically with **429** from the pre-existing per-IP login throttle (10/min) — each suite makes more throttled calls than its own limit allows. Feature 015 recorded all three as written but **never executed**, so they have never been green on any machine. | 2026-09-12 |
| known-flaky e2e suites | the sequential-`MongoMemoryReplSet` resource-pressure set feature 011 documented and feature 016 re-confirmed: 6–9 suites of ~93 fail on any given FULL run, a different set each time, and every one passes in isolation. **An e2e failure counts as a regression only if it reproduces in isolation.** | 2026-09-12 |
| dashboard `tsc -b --force` | **31 errors, every one `TS6133`/`TS6192` unused-import** (30 × TS6133, 1 × TS6192). None is in a file this feature touches. The pre-existing set feature 009 left behind and features 011/015/016 each re-disclosed. | 2026-09-12 |
| dashboard `vitest run` | **127 tests passing across 27 suites** (the repository has moved on from the 116 feature 016 recorded) | 2026-09-12 |
| dashboard load-failing suites | `accessibility.test.tsx` and `orders.mutations.test.tsx` — both fail to *load*, importing `@/features/*` paths feature 009 deleted. Pre-existing. | 2026-09-12 |

> Redis was available on this machine, so `assignment-escalation-queue.service.spec.ts` — the one
> suite feature 015 recorded as failing for want of it — passes here. A machine without Redis will
> see it fail; that is environmental, not a regression.

### Removals (SC-007, FR-078)

> One row per element dropped because the platform has no source for it. SC-007 requires every
> remaining gap to be **a recorded removal**, not merely a deleted line — a reader must be able to
> tell a deliberate omission from an oversight. Filled by T033, T036, T060, T074, T089, T127 and
> T128; checked complete by T152a.

| Element | File | Why the platform has no source |
|---|---|---|
| trend / trendUp / date captions (×6) | `<dashboard>/src/admin/dashboard/components/AdminDashboard.tsx` | the platform computes no period-over-period comparison anywhere (FR-009). `StatCard`'s three props are already optional — feature 009 made them so — so nothing is passed and the shared component is untouched |
| `MapTrackingCard` | `<dashboard>/src/admin/dashboard/components/AdminDashboard.tsx` | its four-way legend was invented; feature 009 already deleted it from the transport composition for the same reason (T036) |
| `InvoicesSection` | `<dashboard>/src/admin/dashboard/components/AdminDashboard.tsx` | a revenue breakdown the platform computes nowhere (T036) |
| duplicate `ProgressOrdersCard` | `<dashboard>/src/admin/dashboard/components/AdminDashboard.tsx` | rendered twice, identically, side by side — not a data gap but a mock artefact (T036) |
| `FuelIcon` import | `<dashboard>/src/admin/dashboard/components/AdminDashboard.tsx` | imported and never rendered (T036) |
| platform-commission column | `<dashboard>/src/admin/orders/components/AdminDesktopOrdersTable.tsx` | **`Order` carries no commission field of any kind.** The platform records commission as `COMMISSION_CHARGED` movements on a COMPANY ledger, sourced from an invoice, never from an order — so FR-022's condition is never satisfied for an order and the element is ALWAYS absent, not conditionally hidden (FR-022, FR-024, T060) |
| street-level loading→delivery leg | `<dashboard>/src/admin/orders/components/AdminDesktopOrdersTable.tsx` | the origin warehouse is unknown before assignment and has no street address on the order (T060) |
| payment-method badge column | `<dashboard>/src/admin/orders/components/AdminDesktopOrdersTable.tsx`, `AdminMobileOrdersList.tsx` | the mock's value was an index parity (`index % 2`), not a field (T060) |
| performance rating | `<dashboard>/src/admin/transport_companies/components/AdminTransportCompanyDetailsPage.tsx` | the platform rates DRIVERS (`User.ratingAverage` via `DeliveryRating`) and has never rated a transport COMPANY (FR-037, T074) |
| average delivery time | `<dashboard>/src/admin/transport_companies/components/AdminTransportCompanyDetailsPage.tsx` | no per-company delivery duration is recorded anywhere; `deliveredAt` exists but no corresponding start timestamp that would make a duration meaningful across the platform's stages (FR-037, T074) |
| manager name / job title / notes editor | `<dashboard>/src/admin/transport_companies/components/AdminTransportCompanyInfoCard.tsx` | `Company` carries no such fields, and the "Save" button wrote to local state and nowhere else — there is no route for an operator to edit a transport company's contact details (T074) |
| `capacity` column | `<dashboard>/src/admin/drivers/components/AdminDriversPage.tsx` | a TANK attribute; no driver-level source exists (FR-044, T089) |
| `tripsMonth` column | `<dashboard>/src/admin/drivers/components/AdminDriversPage.tsx` | a per-driver trip aggregate FR-044 forbids — the roster is scoped as identification, not surveillance (T089) |
| `lastShipment` column | `<dashboard>/src/admin/drivers/components/AdminDriversPage.tsx` | same: a per-driver delivery date FR-044 forbids (T089) |
| `DriverStatsRow`, `DriverRecentTripsCard`, `DriverTruckCard`, `DriverMapCard` | `<dashboard>/src/admin/drivers/components/AdminDriverDetailsPage.tsx` | each shows either a per-driver trip aggregate (FR-044) or the driver's live position (FR-043) — the anti-surveillance boundary feature 011 drew. **Dropped, not rendered empty**: an empty card reads as "nothing yet", which invites someone to fill it (FR-045, T092) |
| `AdminProfilePermissions.tsx` (file deleted) | `<dashboard>/src/admin/profile/components/` | **the platform has no permission model beyond `UserRole`.** There is nothing to fetch now and nothing to fetch later without a new feature (FR-063, T127) |
| `AdminProfileStats.tsx` (file deleted) | `<dashboard>/src/admin/profile/components/` | four per-account statistics the platform records nowhere against a USER; the same figures exist platform-wide on the home dashboard, where they are real (FR-063, T128) |
| `AdminProfileAdditionalData.tsx` (file deleted) | `<dashboard>/src/admin/profile/components/` | a contract start date and a covered-cities count, neither of which exists on any account record (FR-063, T128) |
| joined-date / `DRV-2024-011` caption | `<dashboard>/src/admin/profile/components/AdminProfileHeader.tsx` | neither value exists on an account record, and the first was a DRIVER-shaped identifier on the platform operator's own profile (FR-063, T128) |
| name/email edit form | `<dashboard>/src/admin/profile/components/AdminProfileAccountCard.tsx` | no route exists for an operator to change their own name or email; the Save button closed the form and wrote nothing (T128) |
| `TOTAL_AMOUNT = 299060.50` | `<dashboard>/src/admin/payment/components/AdminPaymentPage.tsx` | replaced by the live owed figure (FR-065, T146) — not a removal for want of a source but a literal standing in for one that now exists |

---|---|---|
| trend / trendUp / date captions (×6) | `<dashboard>/src/admin/dashboard/components/AdminDashboard.tsx` | the platform computes no period-over-period comparison anywhere (FR-009) |
| | | |

---
### Corrections found while implementing

> Each is a case where following the plan verbatim would have shipped something plausible and wrong,
> or where the plan named a value the platform does not have.

· **`SettlementMethod` has exactly TWO values, not four.** The cashback payout screen was first
written against `BANK_TRANSFER | SADAD | CASH` — invented. The platform's enum is
`BANK_TRANSFER | NATIONAL_PAYMENT_SERVICE` (`settlement-method.enum.ts`), and "Sadad" is the
*client's* order payment channel (`PaymentMethod`), a different concept on a different document.
A payout submitted with `SADAD` would have been refused by the DTO with a validation error naming
a value the operator could see in the dropdown. Now read from the shared constant with
`Object.values`, never re-listed (Constitution I).

· **`AnnouncementDelivery.recipientUserId` cannot be required.** The data model specifies it as
required AND specifies `NO_ACTIVE_ADMIN` as a failure reason recorded "against the company, since
there is no person to record it against". Those two cannot both hold. Made optional, with the
unique index split in two: `(announcementId, recipientUserId)` partial on the id EXISTING, plus
`(announcementId, companyId)` partial on it being ABSENT. Without the first index's partial clause
every company-addressed row would collide with every other on a missing key, and one such company
per announcement would be the most the platform could ever record.

· **The fan-out resolver could not report a suspended company at all.** As first written,
`resolveRecipients` filtered to active administrators of ACTIVE companies — so a suspended
company's administrators never appeared, and FR-054's "skipped, with a named reason" had nothing to
name them from. Split into `resolveCandidates` (every candidate, each marked reachable or not, with
a reason) and `resolveRecipients` (the reachable ones, for the 202's count). The filtering now
happens in the open, where each exclusion produces a reason instead of a silence.

· **`it.each` evaluates its table at COLLECTION time.** `operator-authorization.e2e-spec.ts`
first built its role table from `fixtures.companyA.*`, which `beforeAll` had not yet populated —
the whole suite failed to load with "Cannot read properties of undefined". The table now lists role
NAMES and resolves the token inside each test body. Worth recording because the failure mode is a
suite that reports **zero tests**, which reads as "nothing to run" rather than as a defect.

· **Two operator-profile tests tripped feature 015's admin session cap.** Signing the shared fixture
operator in repeatedly to exercise `activeSessionCount` evicted the oldest session — which was the
token every other test in the file authenticates with — so six unrelated tests failed with 401s that
said nothing about what they were testing. The session-churn cases now get their own operator
account that nobody else holds a token for.

· **`findForUser` needed an ObjectId guard the contract did not mention.** `?orderId=` comes from
a free-text search box, so a malformed value reaches Mongoose and raises a CastError — a 500 on the
operator's most-used screen. It now returns an empty page: to the person typing, "that is not an
order identifier" and "no such order" are the same answer.

· **`DoughnutSection`'s legend takes a Tailwind CLASS, not a colour.** The operator's charts drive
their ring and their legend from one colour map so the two cannot disagree about which slice is
which — but Tailwind only emits classes it can see literally in the source, so a class name cannot be
derived from a map at runtime. Added an optional `swatchColor` (a raw CSS colour) that takes
precedence, leaving the transport company's existing callers untouched.

· **T090's column-configuration approach was not taken, deliberately.** The task asks for the shared
`DesktopDriversTable`/`MobileDriversList`/`DriversStats` to accept a column config with the
operator's screen omitting the excluded columns. The operator's screen renders its own table
instead. Two reasons: the row shape is genuinely different (`DriverRosterRow` has seven fields;
the transport driver type has the excluded ones), and a dedicated component makes the forbidden
columns **unreachable** rather than switched off by a flag a later change could flip. It also leaves
the transport company's own screen untouched, which FR-075 requires. Same goal, stronger guarantee.

· **The mock's `Pagination` component asks for a `totalItems` the platform has never produced.**
`GET /orders` returns `{ items, nextCursor }`; cursor pagination cannot yield a total. The orders
screen uses first/next cursor controls instead — the same conclusion feature 009 reached for the
transport list.

· **`AdminTransportCompanyInfoCard` was an edit form over a capability that does not exist.** Its
Save button wrote to local `useState` and nowhere else. There is no route for an operator to edit a
transport company's contact details — `PUT /companies/:id/*` covers prices, pricing config, regions,
delivery rates and the commission ceiling, none of which is this. Rendered read-only. The same call
was made for `AdminProfileAccountCard`.

· **Three spec-015 auth suites fail deterministically, and it is NOT the flaky set.** `login-code`, `login-abuse` and `admin-multi-session` were first assumed to be the documented sequential-`MongoMemoryReplSet` flakiness. **Running them in isolation disproved that** — they fail alone, every time, with **429 Too Many Requests** on `POST /auth/login` and `POST /auth/login/code/verify`. Both carry `@Throttle({ default: { limit: 10, ttl: 60_000 } })`, keyed per IP, and every e2e request comes from 127.0.0.1: a suite whose whole subject is *multiple concurrent sessions* necessarily signs in more than ten times inside a minute and trips its own limit. `test-app.factory.ts` already resets the counter store per app, so this is not stale state — it is structural to the suites. Feature 015's own notes record all three as written but **never executed** (no Redis in that session), so they have never passed anywhere. **Nothing in this feature's diff touches them**: `src/common/throttler/`, `src/modules/auth/services/` and `auth.service.ts` are all untouched, and the only auth change is +41 lines adding `GET /auth/me/account` to the controller. **Left for feature 015's own test-infrastructure fix** — raising or resetting the throttle for the e2e environment is a change to shared auth config, and making it here would put a rate-limit change inside a dashboard feature. Recorded rather than waved through, because "pre-existing" and "flaky" are different claims and only the second was checkable by re-running.

· **Disclosed, out of scope — `AdminStationOwnerDetailsPage.tsx` still holds a `MOCK_ORDERS`
array.** It is the only remaining mock under `src/admin/`. It belongs to feature 013's station-owner
surface, not to any of this feature's eight stories, so it was deliberately left alone rather than
wired in passing — recorded here so a later reader does not mistake it for something spec 017
missed.

· **Disclosed, NOT fixed — `buildStorageKey` builds an object key with `path.join`.** The full
e2e run surfaced `file-storage.e2e-spec.ts` failing on this Windows checkout:
`expect(storagePath).toContain('sys_storge/')` sees
`sys_storge<companyId><uuid>.jpg`. It is pre-existing and untouched by this feature — but it
is more than a test artefact: `files.service.ts` uses that one value as `storagePath` for BOTH
storage drivers, so on a Windows host the GCS object key would carry literal backslashes in its
name. Production runs Linux (feature 012), where `join` yields `/`, so the runtime risk on the
actual deployment target is nil. **Left for its own change**: the fix touches feature 012's
deliberately frozen `storagePath` payload (FR-038), and burying it in this diff would put a storage
change inside a dashboard feature.

· **One pre-existing e2e test encoded the rule this feature deliberately reverses.**
`fuel-company-rbac.e2e-spec.ts` asserts `PATCH /orders/:id/force-complete` **refuses**
`SUPER_ADMIN` — true before spec 017 and false after it, since FR-020/T054 admits the operator on
purpose. Its `alsoAdmits` union had no way to express "deliberately admitted" about that role, so
it was widened and the row marked. The three OTHER roles are still asserted refused, which is what
the row was always really for; the operator's positive admission is asserted by
`order-buckets` and `operator-authorization`. **Found only by the full-suite run** — every suite
this feature wrote passes in isolation, and so does this one; the contradiction lives between two
files.

· **"Both are read as whole-day boundaries" is not what the platform does, and this feature did NOT
change that.** `contracts/rest-api-delta.md` §1 says the overview reads `from`/`to` as whole-day
boundaries; the resolution FR-005 tells it to reuse (`OrdersController.summary`) is a bare
`new Date(to)`, so a date-only `to=2026-03-31` is MIDNIGHT on the 31st and an order delivered at
14:00 that day falls outside the period. The two instructions conflict, and consistency won:
FR-005 and FR-026a both require this route to resolve its period identically to the existing
summary and to the transporter-volume route, and diverging would make the operator's home screen
count a different set of orders than the orders screen for the same dates — exactly the drift this
feature keeps guarding against. **Recorded rather than silently fixed**: correcting it means
changing `OrdersController.summary` too, which FR-075 freezes, so it is a deliberate follow-up that
must move all three call sites together. The dashboard sends full ISO datetimes, so no screen hits
it today.

· **The fan-out left a LYING delivery row if the notification write failed.** The delivery row is
inserted first, because it is the row the unique index guards — but it MEANS "this recipient has
been processed". If the notification insert then failed for any non-duplicate reason, the row
survived carrying neither a `notificationId` nor a `failureReason`, so the next (at-least-once)
redelivery skipped that person permanently and nothing anywhere said they had been missed: the row
reads as neither delivered nor failed, and the tallies never counted them. The processor now
removes the row before rethrowing, restoring the pre-attempt state so the retry can redo it
cleanly. Found by reading the failure path rather than by a test — no test in this feature
exercises a failing notification write, and one that did would have to fault-inject Mongo.

· **The suspend/reinstate button on the transport detail screen only flipped local state.** It
looked like it worked and changed nothing on the platform. Now calls the existing
`PATCH /companies/:id/status`, which was already operator-only and already type-agnostic — this
story needed no backend change for it at all (FR-033).


### Corrections found while walking the quickstart against a running server (T157)

> The walkthrough T157 asks for. Each of these is invisible to the suites: they pass because a
> fresh `MongoMemoryReplSet` hides the first, and because no test asserted the others at all.

· **The company-addressed unique index was never created — MongoDB refuses `$exists: false` in a
`partialFilterExpression`.** The correction logged above ("partial on it being ABSENT") is not a
shape MongoDB will build: the expression compiles to `$not`, and the server rejects the index with
"Expression not supported in partial index: $not". **Mongoose's `autoIndex` swallows that
rejection** — it surfaces on the model's `index` event, which nothing listens to — so the
application booted clean, every user-addressed idempotency test passed, and FR-053 was simply not
enforced for the `NO_ACTIVE_ADMIN` row. A redelivered fan-out (BullMQ is at-least-once) duplicated
it freely; verified by hand against the real database, two rows accepted.
  The discriminator is now a stored `AnnouncementDelivery.companyAddressed: true`, written only on
  the company-addressed row, with the second index partial on `{ companyAddressed: true }` — an
  equality filter, the shape `Station.isDefault` already uses on this platform.
  **The first index is deliberately UNCHANGED.** Mongoose never redefines an index that already
  exists under the same name, so altering its filter would leave every deployed database enforcing
  the old definition while the code claimed the new one — a first attempt at this fix wrote an
  explicit `recipientUserId: null` and would have done exactly that, silently collapsing every
  company-addressed row onto one key on any database that already had the index.
  Two new guards in `announcements.e2e-spec.ts`: a re-run that asserts the `NO_ACTIVE_ADMIN` row is
  not duplicated, and an assertion that **both indexes actually exist in the database** — because a
  swallowed index build is invisible to every test that only exercises behaviour it is not guarding.
  Both fail against the original schema; both pass against this one.

· **`direction` was stated from the PLATFORM's point of view while its own doc comment said the
COMPANY's, and SC-011 requires the company's.** `/platform-account/movements` is named for the
platform but is read scoped to one company, so a payout the platform made to a company — money that
company RECEIVED — was labelled `OUTBOUND` in that company's own ledger. Coherent in isolation and
the opposite of what its only reader means by the word. The mapping now reads from the company's
side throughout: `CASHBACK_CREDITED`/`CASHBACK_PAID_OUT` are INBOUND, `COMMISSION_CHARGED`/
`PAYMENT_RECORDED` are OUTBOUND. FR-064's actual purpose — telling a payout received apart from a
payment made — holds either way, which is why no test caught the reversal; the unit test now pins
the frame per kind rather than pinning one kind.

· **`GET /dispatch/orders/:id/candidates` returned whole driver `User` documents, `passwordHash`
included.** `User.passwordHash` is declared `select: false`, which protects `find()` and **not**
`aggregate()` — and spec 010 rewrote `findCandidates` around a `$geoNear` aggregate. Every driver's
bcrypt hash, `activeSessions`, `sessionGeneration` and live GPS `location` went to the transporter's
assignment screen on every load. Pre-existing (spec 010), found by acting as the transport admin.
Closed with an explicit `$project` allowlist shared by both branches — an allowlist, not a
deny-list, so a field added to `User` later is absent by default. Guarded by a new assertion in
`dispatch-candidates.e2e-spec.ts` that fails on any field outside the list.

· **The operator's force-complete `reason` reached the CUSTOMER.** spec 017 FR-020 adds
`SUPER_ADMIN` to `forceComplete`, whose reason is free text written for the platform's own record.
It is stored on the `statusHistory` entry, and `statusHistory` is client-readable — so the internal
note and the operator's user id were published to the customer whose order it was. `toRoleScopedShape`
now strips `overrideReason`, `actorId` and `actorRole` from every history entry for a CLIENT. The
transitions and the `manualOverride` flag stay: that an order was completed by an administrator
rather than by the usual handover is the customer's business; who wrote what about them is not.

· **`npm run seed:dashboard` could not complete, so quickstart Part 0 was unwalkable.** The seed
died at its first `/orders/quote` with `409 TRANSPORT_PRICE_NOT_SET`: delivery pricing moved onto
the hauling party (`Company.deliveryRates`, written by the TRANSPORT admin) after this script was
last updated, and one unpriced serving transporter blocks a quote outright rather than being
skipped. The script now sets the rate right after the transport admin signs in. T002's description
was also corrected — it claimed to seed a mix (all six buckets, a never-connected driver, an accrued
cashback balance) that the script's own closing message says it deliberately does not seed.

· **Noted, NOT changed — each is pre-existing and outside this feature's scope**:
  · `verify-vehicle` is `@Throttle({ limit: 5, ttl: 15 min })` per driver and counts **every**
    outcome, including `LOCATION_REQUIRED` (which the platform says records nothing, because nothing
    about the vehicle was evaluated) and `NOT_AT_WAREHOUSE` (where the card was CORRECT and only the
    place was wrong). A driver circling a depot while their GPS settles can lock themselves out for
    fifteen minutes holding the right card at the right gate. The lockout exists to stop UID
    guessing; a correct-card attempt is not guessing.
  · `classifyEligibility` tests OFFLINE before BUSY, so a driver who is **both** offline and already
    booked reports `OFFLINE` — which FR-008 says is assignable with a recorded reason. The operator
    is offered the reason dialog and the assignment then refuses with `409 DRIVER_NOT_ELIGIBLE`.
    BUSY is the stronger and more informative fact and should probably win.
  · `POST /orders` without a `quoteToken` takes the documented pre-005 fallback and prices the order
    at the fuel line ALONE — 16,800 against a quoted 19,858.20 on the same order, with no delivery
    fee, service fee or tax, and no breakdown retained. Deliberate, so the pre-005 e2e suites keep
    working, and correct for the real client app which always sends the token. It is discipline
    rather than validation that keeps a client from under-charging itself by ~18%.
  · `GET /tanks` answers with raw documents (`_id`, `__v`, timestamps) while `GET /trucks` answers
    with a shaped DTO (`id`) — the same "spread the raw document" habit as the candidates leak,
    though nothing on `Tank` is sensitive.
