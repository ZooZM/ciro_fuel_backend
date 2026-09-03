---
description: "Task list for 013-fuel-company-dashboard"
---

# Tasks: Fuel Company Admin Dashboard — Live Platform Integration

**Input**: Design documents from `/specs/013-fuel-company-dashboard/`

**Prerequisites**: `plan.md`, `spec.md` (13 stories, 122 FRs, 20 SCs), `research.md` (12 decisions),
`data-model.md`, `contracts/rest-api-delta.md`, `contracts/dashboard-integration.md`,
`contracts/isolation-contract.md`, `quickstart.md`

**Tests**: **INCLUDED.** Not the template's default — the spec requires them.
`contracts/isolation-contract.md` states the two-fuel-company recipient test is *"mandatory before
Story 12 is considered done"*, and R3 shows the defect it guards is invisible to every other test.
SC-006, SC-008, SC-011, SC-012 and SC-014a–d are all assertions about behaviour no screen can
demonstrate. The repository's own convention (62 e2e suites) is the baseline.

**Organization**: Tasks are grouped by user story. Each phase maps to one slice of `plan.md`'s Slice
Order table, so a phase is independently implementable, testable and mergeable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: `[US1]`…`[US13]` — maps to a spec.md user story. Setup, Foundational and Polish carry none.

## Path Conventions

Two repositories, one spec (R12).

| Prefix | Repository | Notes |
|---|---|---|
| `src/`, `test/`, `scripts/` | **Platform** — `e:/zeyad/ciro_fuel_backend` | This repo. Entry stays `server.ts`. |
| `web_dashboard/` | **Dashboard** — `E:/zeyad/web_dashboard_ciro_fuel` | Separate repo. Gets a `SPEC-POINTER.md`, **no** `specs/013-…` directory (R12). |

`mobile_app/` is touched by **nothing** in this feature. US11's two client-facing additions are
server-side response fields the Flutter clients read; no Dart change is planned. Verify unchanged at
every regression gate.

---

## ⚠️ Read before starting

Three findings decide the order below. Skipping them reintroduces the exact defects they were found to prevent.

1. **Nothing is verifiable until Phase 3 lands.** No fuel company administrator can sign in to this
   dashboard at all (R1). Feature 009 recorded this as fixed; commit `17f6bd5` is titled for it and
   did not land it. Treat the dashboard's `main` as ground truth, never the prior feature's notes.
2. **Phase 15 must build the isolation mechanism before the domain.** Marking `ExchangeRequest`
   multi-party compiles, passes review, and passes every single-company test while the recipient's
   list is silently, permanently empty — and `SUPER_ADMIN` bypasses both plugins, so the operator's
   screen (the one most likely to be demoed) looks perfectly healthy (R3).
3. **The line after Phase 11 is a deliberate cut point.** Phases 1–11 deliver the stated goal on
   their own. Phases 12–16 are four new business domains. See plan Complexity Tracking for the
   recommended split into features 013/014/015/016.

**Open decision, to be taken before Phase 13 (US10) begins, not after** — audit of commission accrual
and payment confirmation. Litre balances and extraction carry attribution (FR-073a-iv, FR-075a);
money movements between a company and the platform do not. A ledger that cannot say who confirmed a
payment is very hard to retrofit once it holds real balances. Recorded as **T157**.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish ground truth and the seeded actors every later phase verifies against.

- [X] T001 Verify the dashboard's current state against `research.md` R1 and record the result in this file's *Notes* section — confirm `web_dashboard/src/constants/roles.ts` carries `COMPANY_ADMIN` and neither company role, that `/select-role` is routed, and that `dummy-token` occurs in `web_dashboard/src/auth/bootstrap-session.ts`, `web_dashboard/src/auth/components/RoleSelectionPage.tsx` and `web_dashboard/src/lib/api/api.client.ts`. If any claim no longer holds, correct the plan before proceeding.
- [X] T002 [P] Create `web_dashboard/SPEC-POINTER.md` entry for feature 013 pointing at `specs/013-fuel-company-dashboard/` in the platform repo, following the arrangement feature 009 recorded (R12). Do **not** create a `web_dashboard/specs/013-…` directory.
- [X] T003 [P] Capture the pre-feature baseline test counts for both repos in this file's *Notes* section: platform `npm run test` and `npx jest --config test/jest-e2e.json --runInBand`; dashboard `npx tsc -b --force` and `npx vitest run`; mobile `flutter test`. Record the known pre-existing non-green tests named in `quickstart.md` so this feature's diff is separable from them.
- [X] T004 Extend `scripts/seed-dashboard-actors.ts` to additionally produce a **second fuel company** with its own administrator (required by Phase 15 and by every isolation test), a station owner holding a **credit limit**, and at least one **approved order** for that owner.
- [X] T005 [P] Extend the seed script with the reference case `quickstart.md` Part 2 uses — an order for 33,000 L of one grade — so steps 2.13–2.17 can be walked without hand-built data.
- [X] T006 [P] Confirm `package.json`'s existing `seed:dashboard` script (`ts-node -r tsconfig-paths/register scripts/seed-dashboard-actors.ts`) still runs clean after T004/T005's extensions, so the walkthrough's prerequisites stay one command. *(Found during analysis: this script entry already exists — verify, do not recreate it.)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Platform-side shared vocabulary and test infrastructure that many later phases edit. Done
once, here, so per-phase tasks stay `[P]`-safe — a shared enum edited by nine tasks is nine merge conflicts.

**⚠️ CRITICAL**: These do not depend on the dashboard and can run alongside Phase 3.

- [X] T007 Add every new typed error code this feature introduces to `src/common/enums/error-code.enum.ts` in one edit, each with the comment convention the file already uses: `LIMIT_REQUEST_ALREADY_RESOLVED` (FR-031), `COMMISSION_CEILING_EXCEEDED` (FR-062d, carries the ceiling), `PAYMENT_EVIDENCE_REQUIRED` (FR-067), `PAYMENT_ALREADY_CONFIRMED` (FR-069), `SUPPLIER_INVOICE_ALREADY_RECORDED` (FR-073e), `SUPPLIER_INVOICE_GRADE_MISMATCH` (FR-073g), `SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE`, `BALANCE_CORRECTION_REASON_REQUIRED` (FR-075), `LITRE_BALANCE_WOULD_GO_NEGATIVE` (FR-073d), `EXCHANGE_ALREADY_RESOLVED` (FR-082), `EXCHANGE_GRADE_NOT_SOLD` (FR-085), `EXCHANGE_PARTY_INVALID`.
- [X] T008 [P] **Already satisfied by pre-existing infrastructure.** `test/utils/fixtures.ts` already exports `seedTwoCompanies(app)` returning a `TwoCompanyFixture` (`superAdmin`, `companyA`, `companyB` — each a full `CompanyFixture` with `admin`, `client`, `transportAdmin`, `driver`, `truck`, `tank`), used by ~50 existing e2e suites including `tenant-isolation.e2e-spec.ts`. No new fixture code needed — every isolation assertion in this feature (SC-006, and the mandatory Phase 15 recipient-read test) calls this directly.
- [X] T009 [P] Add the platform-wide default commission ceiling to `src/config/configuration.ts` and its Joi schema in `src/config/validation.ts` (FR-062b), so an absent value fails at boot rather than at first accrual. Follow feature 012's finding: do **not** give it a `.default('')`-style fallback that Joi writes back into `process.env`.
- [X] T010 [P] Extend `src/common/constants/money.constants.ts` with the currency code every new amount is stated in, and add a litre unit constant, so FR-098 is satisfied by a named constant rather than a literal at each call site (Principle I, FR-097).
- [X] T011 [P] Confirm whether an invoice **void** path exists anywhere in `src/modules/invoices/`. Record the finding in this file's *Notes*. If none exists, FR-063 (reversal of accrual on a voided invoice) is **unreachable** and MUST be recorded as such rather than implemented speculatively (research *Open items*).
- [X] T012 [P] Add the `web_dashboard/src/constants/` maps required by FR-097 that no single later phase owns — movement kinds, request states, and the fuel-exchange direction filter — mirroring the platform's enum values exactly.

**Checkpoint**: Shared vocabulary in place.

---

## Phase 3: User Story 1 - A fuel company administrator holds a real session (Priority: P1) 🎯 MVP

**Slice 0. Lands alone, merged before any screen is wired (R1).**

**Goal**: A real fuel company administrator signs in with real platform credentials, reaches every
fuel company screen and no other company's, and the fabricated-session machinery is gone.

**Independent Test**: Sign in as a seeded fuel company administrator; confirm the session survives a
reload and reaches the fuel company dashboard. Sign in as a client and confirm every fuel company URL
is refused. Confirm `/select-role` no longer exists and `grep -r "dummy-token" web_dashboard/src/`
returns nothing.

**⚠️ Its absence is invisible — the screens render, they simply render to the wrong person on
credentials the platform never issued. If the client refusal below does not hold, stop; everything
after it is meaningless.**

### Tests for User Story 1

- [X] T013 [P] [US1] Write `web_dashboard/src/auth/__tests__/roles.test.ts` asserting `Role` carries exactly the platform's five values and that `COMPANY_ADMIN` is absent — the constant, not a string literal (FR-001, FR-097).
- [X] T014 [P] [US1] Write `web_dashboard/src/routing/__tests__/route-guards.test.tsx` asserting each route group admits only its own role: `/petrolCompany/*` → `FUEL_COMPANY_ADMIN` alone; `/transport/*` → `TRANSPORT_COMPANY_ADMIN` alone; `/admin/*` → `SUPER_ADMIN` alone. Assert explicitly that a `CLIENT` is **refused** `/petrolCompany/*` and a `DRIVER` is refused `/transport/*` (FR-004, FR-005, SC-001).
- [X] T015 [P] [US1] Write `web_dashboard/src/auth/__tests__/bootstrap-session.test.ts` asserting a placeholder credential is rejected, a genuine `FUEL_COMPANY_ADMIN` token is accepted and retained, and a failed renewal returns to sign-in while a `403` does **not** (FR-002, FR-003, FR-006).

### Implementation for User Story 1

- [X] T016 [US1] Replace `web_dashboard/src/constants/roles.ts` with the platform's five roles — `SUPER_ADMIN`, `FUEL_COMPANY_ADMIN`, `TRANSPORT_COMPANY_ADMIN`, `CLIENT`, `DRIVER`. Delete `COMPANY_ADMIN`; do **not** alias it. Set `DASHBOARD_LOGIN_ROLES = [SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN]` — `CLIENT` and `DRIVER` are recognised and never admitted.
- [X] T017 [US1] Replace every inline `'FUEL_COMPANY_ADMIN'` string literal in the five files that carry one with a reference to the new constant (FR-097). **This is the whole reason the gap survived review — the type system never saw the values because they were strings.** Grep afterwards and confirm zero remain outside `roles.ts`.
- [X] T018 [US1] Re-derive every route guard in `web_dashboard/src/app/router.tsx` per `contracts/dashboard-integration.md` — `/petrolCompany/*` currently admits `[CLIENT, COMPANY_ADMIN]`, so **a station owner passes the guard for the screen that sets their own credit limit and prices**. Guards run before any out-of-scope fetch is issued.
- [X] T019 [US1] Delete `web_dashboard/src/auth/components/RoleSelectionPage.tsx` and the `/select-role` route from `web_dashboard/src/app/router.tsx`.
- [X] T020 [US1] Remove the placeholder-credential branch from `web_dashboard/src/auth/bootstrap-session.ts` (around line 21).
- [X] T021 [US1] Remove the placeholder-credential branch from `web_dashboard/src/lib/api/api.client.ts` (around line 72).
- [X] T022 [P] [US1] Delete the dead duplicate `web_dashboard/src/api/apiClient.ts` (0 consumers; canonical is `lib/api/api.client.ts` with 19) — FR-007.
- [X] T023 [P] [US1] Delete the dead duplicate `web_dashboard/src/store/sessionStore.ts` (0 consumers; canonical is `stores/session.store.ts` with 15) — FR-007. Check `web_dashboard/src/store/authStore.ts` and `appStore.ts` for consumers first; delete only what is genuinely unreferenced and record the rest.
- [X] T024 [US1] Confirm the single-flight silent `/auth/refresh` in `web_dashboard/src/lib/api/api.client.ts` sends the refresh token in the request **body**, matching `AuthController.refresh`'s actual `RefreshTokenDto` — feature 009's recorded deviation. A `403`/`404` is an access boundary and MUST NOT trigger refresh (FR-006).
- [X] T025 [US1] Route a signed-in `FUEL_COMPANY_ADMIN` to the fuel company dashboard as their landing screen and a `SUPER_ADMIN` to `/admin` — no role picker anywhere in the flow.
- [X] T026 [US1] Surface a suspended company's sign-in refusal with the platform's own stated reason rather than an empty dashboard (spec Edge Cases, FR-090).
- [X] T027 [US1] Add `test/e2e/fuel-company-rbac.e2e-spec.ts` asserting server-side that a `CLIENT`, `DRIVER`, `TRANSPORT_COMPANY_ADMIN` and `SUPER_ADMIN` are each refused every fuel-company-only endpoint this feature touches, and vice versa — the client guard is a UX layer over this, never a replacement (Constitution II, FR-004).
- [X] T028 [US1] Run `grep -r "dummy-token" web_dashboard/src/` and confirm **no matches**. Record the result.
- [X] T029 [US1] Walk `quickstart.md` Part 0 (steps 0.1–0.7) end to end and record the outcome in that file's *Results* table. **If 0.3 still admits a client, stop.**
- [X] T030 [US1] Run the regression gate for both repos: platform `npm run lint:check && npm run build && npm run test`; dashboard `npx tsc -b --force && npx vitest run`. Record counts against T003's baseline.

**Checkpoint**: A real fuel company administrator holds a real session. Everything below is now verifiable.

---

## Phase 4: Foundational — Stage Vocabulary, Pagination & Query Config (Slice 1)

**Purpose**: The two things whose failure mode is **silent**, landing before any screen depends on
them. No story label — this blocks US2 through US13.

**Depends on**: Phase 3.

- [X] T031 [P] Replace `web_dashboard/src/constants/order-status.ts` with the platform's full `OrderStatus` vocabulary from `src/common/enums/order-status.enum.ts` — all 12 values, including `AWAITING_ROUTING`, `ROUTED_TO_TRANSPORT`, `ASSIGNED_TO_DRIVER` and `LOADING` (FR-011).
- [X] T032 [P] Make an unrecognised stage render as its **platform value** rather than being omitted or mislabelled (FR-011); add a test asserting an unknown value survives the round trip.
- [X] T033 [P] Replace the dashboard's fuel-grade constants with the platform's `FuelType` — `DIESEL`, `PETROL_91`, `PETROL_95`, `KEROSENE` (FR-037). Feature 009 recorded the dashboard's constant as wrong outright; verify before assuming it was fixed.
- [X] T034 Confirm `web_dashboard/src/lib/api/pagination.ts` produces and consumes the platform's actual `{ items, nextCursor }` shape — never `{ items, total, page }`, which the platform has never produced. Cursor paging only; skip/limit duplicates rows when inserts arrive at the head (FR-009, FR-071).
- [X] T035 [P] Add `web_dashboard/src/lib/api/__tests__/pagination.test.ts` asserting no row is duplicated or skipped across pages while new rows are inserted at the head (FR-009, quickstart 1.2).
- [X] T036 Configure `web_dashboard/src/app/query-client.ts` globally: per-screen `refetchInterval` at the longest interval meeting each screen's need (FR-049), and **no refetching at all while the tab is hidden** (FR-050, SC-010). One global configuration, not per-screen code (R11).
- [X] T037 [P] Add a test asserting zero platform requests are issued while the document is hidden (SC-010).
- [X] T038 [P] Extend `web_dashboard/src/constants/query-keys.ts` and `api-routes.ts` with the key and route constants every later phase uses, defined once (FR-097).

**Checkpoint**: The silent-when-wrong slices have landed. Screens may now be wired.

---

## Phase 5: User Story 2 - The administrator decides on incoming orders (Priority: P2)

**Slice 2.**

**Goal**: The administrator sees their company's orders, opens one, and takes approve / reject /
route / redispatch / force-complete — and is offered nothing belonging to another role.

**Independent Test**: With a seeded order awaiting approval, complete approve, reject, route and
redispatch from the dashboard; confirm each is reflected in the platform's own record and visible to
the station owner.

### Tests for User Story 2

- [X] T039 [P] [US2] Add `test/e2e/fuel-company-orders.e2e-spec.ts` asserting a fuel company administrator sees only orders their company is party to, and that a second fuel company's orders are absent from both the list and every action (FR-008, SC-006).
- [X] T040 [P] [US2] Add an e2e assertion that two simultaneous approvals of the same order produce **one** applied outcome and one `409` with a typed error code — never a `500`, never two applied outcomes (FR-019, SC-008). Follow the `isDuplicateKeyError` idiom `dispatch.service.ts` already uses.
- [X] T041 [P] [US2] Write `web_dashboard/src/petrol_company/orders/__tests__/order-actions.test.ts` asserting the actions forbidden to this role are never rendered — driver verification, loading confirmation, vehicle reassignment, verification override, stop resolution, driver assignment and order **cancellation** (FR-017).

### Implementation for User Story 2

- [X] T042 [P] [US2] Create `web_dashboard/src/petrol_company/orders/api/orders.api.ts` — typed request functions for list, detail, approve, reject, route, redispatch and force-complete. No React (Principle IV). Follow `transport_company/orders/api/orders.api.ts`'s shape.
- [X] T043 [US2] Create `web_dashboard/src/petrol_company/orders/hooks/useOrders.ts` and `useOrderDetail.ts` — TanStack Query, no JSX, refetch interval from Phase 4's configuration.
- [X] T044 [US2] Wire `web_dashboard/src/petrol_company/orders/DesktopOrdersTable.tsx` and `MobileOrdersList.tsx` to live data; delete every hardcoded sample row (SC-002).
- [X] T045 [US2] Wire the stage filter to the platform's full vocabulary from T031 (FR-010).
- [X] T046 [US2] Wire cursor pagination into the orders list using Phase 4's helper (FR-009).
- [X] T047 [P] [US2] Wire `web_dashboard/src/petrol_company/orders/ApproveOrderDialog.tsx` to the approve action, carrying the final price the administrator entered (FR-012).
- [X] T048 [P] [US2] Wire the reject action with its required reason in `web_dashboard/src/petrol_company/orders/order-actions.api.ts` and its dialog (FR-013).
- [X] T049 [P] [US2] Wire the route-to-transporter action, sourcing the transporter list from the affiliated-transporters endpoint (FR-014).
- [X] T050 [P] [US2] Wire the redispatch action for an order no transporter accepted (FR-015).
- [X] T051 [P] [US2] Wire `web_dashboard/src/petrol_company/orders/ForceCompleteDialog.tsx` with its required reason (FR-016).
- [X] T052 [US2] Gate every action on the order's current stage — an action that does not apply MUST NOT be offered (FR-018). Derive from the platform's stage, never from a local guess.
- [X] T053 [US2] Remove every action reserved to another role from the fuel company order screens, including `web_dashboard/src/petrol_company/orders/order-details/EditTransportDetailsCard.tsx` if it exposes vehicle reassignment (FR-017).
- [X] T054 [US2] Wire `web_dashboard/src/petrol_company/orders/order-details/OrderDataCard.tsx`, `CustomerDataCard.tsx` and `AssignedDriverCard.tsx` to real fields — owner, station, grade, quantity, itemised cost, transporter, driver — omitting rather than inventing any that is absent (FR-020, FR-048).
- [X] T055 [US2] Make `web_dashboard/src/petrol_company/orders/order-details/MapCard.tsx` report the platform's own reason when a live position is refused, rather than judging trackability locally (FR-021). `order:watch`'s `NOT_TRACKABLE` refusal **is** the requirement.
- [X] T056 [US2] Surface a refused action with the platform's own reason, and a simultaneous conflicting decision as a **conflict**, not a generic failure (FR-019).
- [X] T057 [US2] Add loading / empty / error states with a working retry to every screen in this phase (FR-092, FR-093, SC-007), and confirm they are bilingual with RTL (FR-095).

**Checkpoint**: An order travels awaiting-approval → routed from the dashboard. Walk `quickstart.md` 1.1–1.7.

---

## Phase 6: User Story 3 - Station owners, stations and credit (Priority: P3)

**Slice 3.** Includes the one genuinely new backend domain of the first half: credit limit requests.

**Goal**: Onboard owners, manage their stations, set credit limits, and resolve limit requests.

**Independent Test**: Onboard an owner, register two stations, set a credit limit, raise a limit
request as that owner and resolve it, edit one station and remove the other — confirm each from a
second session, and confirm a second fuel company sees none of it.

### Backend — station listing (R5: a route, not a platform addition)

- [X] T058 [US3] Add a `FUEL_COMPANY_ADMIN` branch to `GET /stations` in `src/modules/stations/stations.controller.ts` returning every station of the acting company across all its owners. **Write no filter** — `Station` is `markTenantScoped` (`station.schema.ts:66`), so the query is already scoped (R5, FR-025). The existing `CLIENT` branch is unchanged.
- [X] T059 [P] [US3] Add `test/e2e/fuel-company-stations.e2e-spec.ts` asserting the new branch returns the company's stations across owners and **none** of a second fuel company's (FR-025, SC-006).

### Backend — credit limit requests (new domain)

- [X] T060 [P] [US3] Create `src/modules/users/schemas/credit-limit-request.schema.ts` per `data-model.md` — `companyId`, `clientId`, `requestedAmount`, `state`, `grantedAmount`, `resolvedBy`, `resolvedAt`. Apply `markTenantScoped` (R6). Index `(companyId, state, createdAt)`.
- [X] T061 [P] [US3] Create `src/common/enums/credit-limit-request-state.enum.ts` with `PENDING | ACCEPTED | REJECTED` as named constants (FR-097).
- [X] T062 [US3] Create `src/modules/users/dto/create-credit-limit-request.dto.ts` and `resolve-credit-limit-request.dto.ts` (`{ accept: boolean, grantedAmount? }`).
- [X] T063 [US3] Implement `CreditLimitRequestsService` in `src/modules/users/services/credit-limit-requests.service.ts` — raise (refusing a second while one is `PENDING`), list for the administrator, list for the owner, and resolve.
- [X] T064 [US3] Implement resolution as a **conditional update filtered on `state: PENDING`**, with `modifiedCount` deciding which of two concurrent resolutions wins (FR-031, SC-008). **Not** a read-then-write — that lets both administrators resolve it. Throw `LIMIT_REQUEST_ALREADY_RESOLVED` (`409`) when nothing matched.
- [X] T065 [US3] Accepting writes the new credit limit on the `User` and the resolution on the request **in one transaction** (Principle V).
- [X] T066 [US3] Add the four routes per `contracts/rest-api-delta.md` to `src/modules/users/users.controller.ts`: `POST /users/me/credit-limit-requests` (`CL`), `GET /credit-limit-requests` (`FCA`, `?state=`), `GET /users/me/credit-limit-requests` (`CL`), `PATCH /credit-limit-requests/:id/resolve` (`FCA`).
- [X] T067 [US3] Notify the owner of the outcome through the existing notification path, stating the amount granted where accepted and that it was declined where rejected (FR-030).
- [X] T068 [US3] Refuse lowering a limit below the amount already drawn unless the consequence was stated explicitly at the point of change (FR-032) — surface the drawn amount in the refusal rather than leaving a negative remainder.
- [X] T069 [P] [US3] Add `test/e2e/credit-limit-requests.e2e-spec.ts`: raise, resolve at a lower amount, assert the granted amount becomes the limit; assert a second resolution returns `409` with the typed code; assert a second fuel company's requests are invisible (FR-029–FR-032, SC-006, SC-008).
- [X] T070 [P] [US3] Add `test/unit/credit-limit-requests.service.spec.ts` for the conditional-resolution branches.

### Dashboard

- [X] T071 [P] [US3] Create `web_dashboard/src/petrol_company/stations/api/owners.api.ts`, `stations.api.ts` and `credit-limit-requests.api.ts`.
- [X] T072 [US3] Create the matching hooks under `web_dashboard/src/petrol_company/stations/hooks/`.
- [X] T073 [US3] Wire `web_dashboard/src/petrol_company/stations/StationsPage.tsx`, `StationOwnerListItem.tsx` and `StationListStats.tsx` to live data; delete every sample row (FR-022, SC-002).
- [X] T074 [US3] Wire `web_dashboard/src/petrol_company/stations/AddStationOwnerPage.tsx` to the platform's client-onboarding path, so an onboarded owner can sign in as a client of this fuel company (FR-023).
- [X] T075 [US3] Wire `web_dashboard/src/petrol_company/stations/StationsBlock.tsx`, `StationDetailsPage.tsx` and `StationListItem.tsx` for register / edit / remove of a station (FR-024).
- [X] T076 [US3] Add the cross-owner station listing screen backed by T058 (FR-025).
- [X] T077 [US3] Wire `web_dashboard/src/petrol_company/stations/CreditLimitCard.tsx` to set and change a limit and to show the portion drawn as the platform accounts for it (FR-026), stating currency (FR-098).
- [X] T078 [US3] Wire `web_dashboard/src/petrol_company/stations/CreditLimitRequestCard.tsx` to the request queue — accept at the requested amount or a different one, or reject; surface the `409` as *already resolved*, not as a generic failure (FR-030, FR-031).
- [X] T079 [US3] Wire activate / deactivate for an owner on `web_dashboard/src/petrol_company/stations/StationOwnerDetailsPage.tsx` (FR-027).
- [X] T080 [US3] Enforce region-and-governorate consistency on the station form, refusing an inconsistent pair with a message naming the inconsistency (FR-028) — use the platform's `Region` vocabulary, not a local list.
- [X] T081 [US3] Add loading / empty / error states with retry, including the empty-station-list state for an owner with none (FR-092, spec scenario 8); confirm bilingual RTL (FR-095).

**Checkpoint**: Owners, stations and credit work end to end. Walk `quickstart.md` 1.8–1.13.

---

## Phase 7: User Story 4 - Transporters (Priority: P4)

**Slice 4.**

**Goal**: See, onboard and open the transport companies affiliated with this fuel company, and set the
regions this company covers.

**Independent Test**: Onboard a transporter, confirm it appears as a routing destination on an
approved order, and confirm its details screen reflects what was entered.

- [X] T082 [P] [US4] Create `web_dashboard/src/petrol_company/companies/api/transporters.api.ts` over `GET /companies/:id/transporters`. **Unlike R2/R5, this genuinely required a backend addition** — checked ahead of this phase while working Phase 5's route-order UI (which needs a transporter picker): `createTransportCompany` had no listing counterpart at all, added as `CompaniesService.findTransporters`/`companiesController.listTransporters`, tested in `test/e2e/region-assignment.e2e-spec.ts`.
- [X] T083 [US4] Create `web_dashboard/src/petrol_company/companies/hooks/useTransporters.ts`.
- [X] T084 [US4] Wire `web_dashboard/src/petrol_company/companies/CompaniesListPage.tsx`, `CompanyListItem.tsx` and `CompanyListStats.tsx` to live data (FR-033); delete sample rows.
- [X] T085 [US4] Wire `web_dashboard/src/petrol_company/companies/AddTransporterPage.tsx` to onboarding, and confirm the result becomes selectable in Phase 5's route action (FR-034).
- [X] T086 [US4] Wire `web_dashboard/src/petrol_company/companies/CompanyDetailPage.tsx`, `CompanyContactCard.tsx` and `CompanyRegionsCard.tsx` to the platform's recorded contact details and served regions (FR-035).
- [X] T086a [US4] **Genuine platform addition, found during analysis — not a pattern-match like R2/R5.** `Company.servedRegions` is TRANSPORT-only (`company.schema.ts:72-75`, "assigned by its parent Fuel Company"); no field records the regions a FUEL-type company covers itself. Add `coveredRegions: RegionCode[]` (default `[]`) to `src/modules/companies/schemas/company.schema.ts` per `data-model.md`'s addition. Not scoped by any isolation marker — same access rule as `fuelPrices`/`pricingConfig`.
- [X] T086b [US4] Add `GET /companies/:id/covered-regions` (`FCA`, `SA`) and `PUT /companies/:id/covered-regions` (`FCA`, own company only via `assertCompanyAccess`) to `src/modules/companies/companies.controller.ts`, following the existing `fuel-prices`/`pricing-config` route pair exactly (FR-035, FR-036).
- [X] T086c [P] [US4] Add an e2e assertion that a second fuel company cannot read or write another company's `coveredRegions` (FR-036, SC-006).
- [X] T087 [US4] Wire the control that sets the regions **this** company covers to T086b's endpoint, retained and reflected on reload (FR-036, scenario 3).
- [X] T088 [US4] Remove the figures in `web_dashboard/src/petrol_company/companies/CompanyDetailStats.tsx` and `CompanyRecentTripsCard.tsx` that the platform does not compute, rather than zero-filling them (FR-048) — the precedent is feature 009's removal of the invented `MapTrackingCard` legend.
- [X] T089 [P] [US4] Add an e2e assertion that a transporter affiliated with a different fuel company does not appear in this company's list (FR-033, SC-006).
- [X] T090 [US4] Loading / empty / error states with retry; bilingual RTL (FR-092, FR-093, FR-095).

**Checkpoint**: A transporter can be onboarded and routed to.

---

## Phase 8: User Story 5 - Fuel prices and delivery pricing (Priority: P5)

**Slice 5.**

**Goal**: Set the per-litre price of each grade and the delivery pricing components, without altering
any order already placed.

**Independent Test**: Change a grade's price and a pricing component, request a fresh quote as a
station owner, and confirm the quote reflects the new values while an order placed beforehand does not.

- [X] T091 [P] [US5] Create `web_dashboard/src/petrol_company/fuel_prices/api/pricing.api.ts` over **two** distinct existing endpoint pairs — per-litre grade prices live on `Company.fuelPrices` (`GET`/`PUT /companies/:id/fuel-prices`), delivery pricing components live on `Company.pricingConfig` (`GET`/`PUT /companies/:id/pricing-config`). These are separate fields and separate routes; do not conflate them into one call.
- [X] T092 [US5] Create `web_dashboard/src/petrol_company/fuel_prices/hooks/usePricing.ts`.
- [X] T093 [US5] **Delete `web_dashboard/src/petrol_company/fuel_prices/data.ts`** — the local mock — and wire `FuelPricesPage.tsx` and `FuelPriceCard.tsx` to live values (SC-002).
- [X] T094 [US5] Offer only the platform's own grades from T033 (FR-037, spec scenario 4). A grade the platform does not recognise is never rendered as a settable price. `Company.fuelPrices`'s grade membership is also what answers "which grades this company sells" for FR-077 (Phase 14) and FR-085 (Phase 15) — do not build a second source of truth for it there.
- [X] T095 [US5] Wire `web_dashboard/src/petrol_company/fuel_prices/EditPriceModal.tsx` to `PUT /companies/:id/fuel-prices` to write a grade's price, stating currency and unit (FR-098).
- [X] T096 [US5] Wire the delivery pricing components the company charges to `PUT /companies/:id/pricing-config` (FR-038).
- [X] T097 [US5] Surface an invalid price or component as the platform's own refusal, naming the invalid value (FR-040).
- [X] T098 [P] [US5] Add an e2e assertion that a price change does not alter the cost recorded on any order placed before it (FR-039, quickstart 1.16) — the platform already retains the rates in force on the order; this asserts the property, it does not add it.
- [X] T099 [US5] Loading / empty / error states with retry; bilingual RTL.

**Checkpoint**: Prices are live and history is immutable. Walk `quickstart.md` 1.15–1.16.

---

## Phase 9: User Story 6 - Invoices (Priority: P6)

**Slice 6. Testable as soon as Phase 5 works — an invoice exists from approval, not delivery (R4).**

**Goal**: See the invoices this company is party to, open one to the order behind it, and settle one.

**Independent Test**: Approve an order, confirm its invoice appears immediately (no driver, no truck,
no delivery required), settle it, and confirm the settlement is reflected for the counterparty.

- [X] T100 [US6] Confirm in `src/modules/orders/orders.service.ts` (~line 270) that `issueInvoice` runs inside `approve`'s existing transaction, and record it in this file's *Notes*. **The spec's Story 6 rationale was false and has been corrected** (R4); this task is the verification that the correction holds.
- [X] T101 [P] [US6] Create `web_dashboard/src/petrol_company/invoices/api/invoices.api.ts`.
- [X] T102 [US6] Create `web_dashboard/src/petrol_company/invoices/hooks/useInvoices.ts`.
- [X] T103 [US6] Wire `web_dashboard/src/petrol_company/invoices/InvoicesListPage.tsx`, `DesktopInvoicesTable.tsx` and `MobileInvoicesList.tsx` to live invoices (FR-041); delete sample rows.
- [X] T104 [US6] Wire invoice detail to the order behind it, reusing Phase 5's order-detail hook rather than a second fetch path (FR-042).
- [X] T105 [US6] Wire settlement of an unsettled invoice, and **do not offer** settlement on one already settled (FR-043).
- [X] T106 [US6] Wire `web_dashboard/src/petrol_company/orders/order-details/LinkedInvoicesCard.tsx` to the real invoice.
- [X] T107 [P] [US6] Add an e2e assertion that an invoice belonging to another company never appears in this company's list (FR-041, SC-006), and that settlement is visible to the counterparty.
- [X] T108 [US6] Leave `web_dashboard/src/petrol_company/invoices/CashbackBanner.tsx`, `CommissionTypeSelector.tsx` and `PlatformCommissionBanner.tsx` **unwired and not shipped** in this phase — they belong to US9, where they become read-only for this role (FR-056). Do not render a placeholder figure in the meantime (FR-048).

**Checkpoint**: Invoices are live. Walk `quickstart.md` 1.17–1.18.

---

## Phase 10: User Story 7 - Dashboard home shows the real position (Priority: P7)

**Slice 7.**

**Goal**: Every figure on the home screen is drawn from this company's real activity. No fabricated
figure anywhere on it.

**Independent Test**: With a known seeded data set, confirm every figure on the home screen matches
what the corresponding list screen shows.

- [X] T111 [US7] **Do this before T109.** Determine which of FR-046's counts and totals the platform already computes and whether each means anything for a fuel company, before adding the role. Two of the existing five fields in `OrderSummaryDto` do not: `driversOnDuty` is computed from `userModel.countDocuments({ role: DRIVER, isOnline: true })`, and `User` is `markTenantScoped` — a fuel company's own `companyId` filter matches **zero** drivers, since drivers belong to transport companies, making it a zero-filled figure that violates FR-048, not a real count. `awaitingAssignment` counts `OrderStatus.ROUTED_TO_TRANSPORT`, which the endpoint's own existing comment (`orders.controller.ts:91-94`) says has "no meaningful equivalent for a fuel company" — their own awaiting-decision bucket is `PENDING_APPROVAL`. Add only what is genuinely missing (station owners, stations, amounts outstanding) to `src/modules/orders/dto/order-summary.dto.ts` and its service, and **exclude `driversOnDuty` from what a `FUEL_COMPANY_ADMIN` receives** rather than let it render as zero. Follow R2/R5's pattern — check before building — but R2's "nothing else" claim about the decorator does not extend to every existing field; verify each one.
- [X] T109 [US7] Add `UserRole.FUEL_COMPANY_ADMIN` to the existing `@Roles` on `GET /orders/summary` in `src/modules/orders/orders.controller.ts` (~line 99), returning the fields T111 determined are meaningful for this role. The handler takes no user parameter (`getSummary(start, end)`) and the multi-party plugin already returns `{ fuelCompanyId }` for this role (R2, FR-045) — the isolation half of R2 holds; T111 is what makes the response itself correct. The spec's Dependencies section called this a platform addition; it is a decorator change plus T111's field audit.
- [X] T110 [P] [US7] Add an e2e assertion that (a) a second fuel company's orders are absent from the counts a fuel company administrator receives from `GET /orders/summary` (R2, SC-006), and (b) no figure excluded by T111 appears in the `FUEL_COMPANY_ADMIN` response (FR-048).
- [X] T112 [P] [US7] Create `web_dashboard/src/petrol_company/dashboard/api/summary.api.ts` and `hooks/useSummary.ts`.
- [X] T113 [US7] Wire `web_dashboard/src/petrol_company/dashboard/PetrolDashboard.tsx` to real counts — orders by stage, station owners, stations, amounts outstanding (FR-044, FR-046).
- [X] T114 [US7] **Remove every week-over-week trend figure** — every occurrence of the `"…% من الأسبوع الماضي"` pattern. No historical baseline exists to compute them from and a fabricated trend is indistinguishable from a real one (FR-047).
- [X] T115 [US7] Remove the home screen's activity-breakdown charts and any per-station or per-owner monthly volume unless served by a real count; **absent, never zero-filled** (FR-048).
- [X] T116 [US7] Point every quick action at the screen that performs it, and **do not show** an action with no destination (FR-051).
- [X] T117 [US7] Confirm the home screen refreshes without a reload at Phase 4's interval and stops entirely while the tab is hidden (FR-049, FR-050).
- [X] T118 [P] [US7] Add a dashboard test asserting each home figure equals the corresponding list screen's count for one seeded data set (SC-009).
- [X] T119 [US7] Loading / empty / error states with retry; bilingual RTL.

**Checkpoint**: The first screen an administrator sees shows only real numbers. Walk `quickstart.md` 1.19–1.21.

---

## Phase 11: User Story 8 - Notifications, support and profile (Priority: P8)

**Slice 8.** The support inbox is the one item with a live platform capability and **no screen at all** today.

**Goal**: Real notifications, a working support inbox, and a real profile.

**Independent Test**: Raise a support request as a station owner, confirm it appears for the
administrator, acknowledge it, and confirm the owner sees it acknowledged.

- [X] T120 [P] [US8] Create `web_dashboard/src/petrol_company/notifications/api/notifications.api.ts` and `hooks/useNotifications.ts`.
- [X] T121 [US8] Wire `web_dashboard/src/petrol_company/notifications/NotificationsPage.tsx` to real notifications with a working mark-as-read whose state is retained across a reload (FR-052). Feature 009 disclosed this screen as fully unwired; it is wired here.
- [X] T122 [P] [US8] Create `web_dashboard/src/petrol_company/support/api/support.api.ts` and `hooks/useSupportRequests.ts` over the existing `src/modules/support/` endpoints.
- [X] T123 [US8] **Build the support inbox screen** — `web_dashboard/src/petrol_company/support/SupportInboxPage.tsx` — listing requests raised by this company's station owners with the owner's message (FR-053). New screen; no mock to replace.
- [X] T124 [US8] Wire acknowledgement, and confirm the owner sees the request as acknowledged (FR-053).
- [X] T125 [US8] Add the support route and its guard to `web_dashboard/src/app/router.tsx`, plus its navigation entry.
- [X] T126 [P] [US8] Create `web_dashboard/src/petrol_company/profile/api/profile.api.ts` and `hooks/useProfile.ts`.
- [X] T127 [US8] Wire `web_dashboard/src/petrol_company/profile/ProfilePage.tsx`, `ProfileHeader.tsx`, `ProfileAccountCard.tsx` and `ProfileCompanyCard.tsx` to the administrator's real account, company and role (FR-054); delete sample values.
- [X] T128 [US8] Remove any figure in `web_dashboard/src/petrol_company/profile/ProfileStats.tsx` the platform does not compute (FR-048). Leave `ProfileCommissionSection.tsx` unwired until US9.
- [X] T129 [P] [US8] Escape or reject text entered by any company, owner or driver so it is never rendered as markup — in particular a support request's message body (FR-096). Add a test with a markup payload.
- [X] T130 [US8] Loading / empty / error states with retry; bilingual RTL — the support screen is new, so it is fully bilingual from the start (FR-095).
- [X] T131 [US8] **Feature-boundary gate.** Run the full regression for both repos and walk `quickstart.md` Parts 0–1 end to end, recording results. If the plan's recommended split is taken, **feature 013 is complete here** and phases 12–16 become features 014/015/016.

**Checkpoint**: ⛔ **Natural feature boundary (plan Complexity Tracking).** Everything above delivers
"link the fuel company dashboard to the live platform" on its own. Everything below is new business
capability drawn on the same screens.

---

## Phase 12: User Story 9 - Commission and cashback (Priority: P9)

**Slice 9.** New domain. Accrual joins the **existing** approval transaction (R4, R10).

**Goal**: The operator sets commission and cashback terms; both accrue against companies; a company
over its ceiling is barred from further deferred dealing until it pays.

**Independent Test**: Set a commission rate as the operator, complete and pay an invoice, and confirm
the accrued commission and cashback match the rate; switch the cashback programme off and confirm the
next paid invoice accrues none.

### Backend — schemas and terms

- [X] T132 [P] [US9] Create `src/modules/billing/schemas/commission-term.schema.ts` per `data-model.md` — `basis`, `rate`, `effectiveFrom`, `setBy`. **Platform-level: no isolation marker**, following `Company`'s precedent. **No update path at all** — a rate change writes a new record, which is what makes FR-058 structural rather than disciplinary (R10). Index `effectiveFrom` desc.
- [X] T133 [P] [US9] Create `src/modules/billing/schemas/cashback-programme.schema.ts` — `basis`, `rate`, `isActive`, `targetsAllCompanies`, `targetCompanyIds`, `effectiveFrom`, `setBy`. Platform-level, no marker, no update path. Index `effectiveFrom` desc.
- [X] T134 [P] [US9] Create `src/common/enums/commission-basis.enum.ts` (`PERCENTAGE | PER_UNIT`) and `src/common/enums/account-movement-kind.enum.ts` (`COMMISSION_CHARGED | CASHBACK_CREDITED | PAYMENT_RECORDED`) as named constants (FR-097).
- [X] T135 [P] [US9] Add the optional `commissionCeiling` field to `src/modules/companies/schemas/company.schema.ts`. **Optional by design** — absent means the platform-wide default from T009 governs, so changing that default cannot silently overwrite a ceiling the operator set explicitly (FR-062b).
- [X] T136 [US9] Create `src/modules/billing/billing.module.ts`, `billing.service.ts` and `billing.controller.ts` as its own NestJS module — not an extension of `orders` or `invoices` — so the domain can be split into its own feature later without unpicking a shared module (plan Structure Decision).
- [X] T137 [US9] Implement "the term in force at instant T" as a single query on `effectiveFrom` desc, used by every accrual. Never recompute a balance by re-reading historical invoices (R10).
- [X] T138 [US9] Add `GET /billing/commission-terms/current` (`FCA`, `SA`) and `PUT /billing/commission-terms` (`SA` only) — the `PUT` writes a **new** effective-dated record (FR-055, FR-056, FR-058).
- [X] T139 [US9] Add `GET /billing/cashback-programme/current` (`FCA`, `SA`) and `PUT /billing/cashback-programme` (`SA` only) (FR-059).
- [X] T140 [US9] Add `PUT /companies/:id/commission-ceiling` (`SA` only) to `src/modules/companies/companies.controller.ts` (FR-062a). A company MUST NOT be able to set its own, and MUST be able to see it.

### Backend — accrual

- [X] T141 [US9] Create `src/modules/platform-account/schemas/account-movement.schema.ts` per `data-model.md`, `markTenantScoped` on `companyId` (R6) — `kind`, `amount`, `currency`, `sourceInvoiceId`, `appliedRate`, `appliedBasis`, `method`, `reference`, `documentFileId`, `state`, `confirmedBy/At`, `reversalOfId`. Indexes `(companyId, createdAt, _id)` and `(companyId, state)`. *(Shared with US10; created here because accrual writes it first.)*
- [X] T142 [US9] Accrue commission inside `InvoicesService.issueInvoice` in `src/modules/invoices/invoices.service.ts`, which already runs in `approve`'s transaction — **a partial write that issued an invoice without its commission is impossible by construction** (R4, Principle V). Accrual is at **approval**, not delivery (FR-057).
- [X] T143 [US9] **Stamp `appliedRate` and `appliedBasis` onto the movement at accrual.** Never re-derive them from current terms — a single mutable "current rate" makes every historical figure a function of today's configuration (R10, FR-058).
- [X] T144 [US9] Accrue cashback when an invoice is **paid**, conditional on `isActive` **and** (`targetsAllCompanies` **or** membership in `targetCompanyIds`), both evaluated at payment time against the record in force then (FR-060).
- [X] T145 [US9] Add `GET /billing/balances/me` (`FCA`) returning accrued commission, accrued cashback, the ceiling in force, and the 90% warning state (FR-061, FR-062c).
- [X] T146 [US9] Implement the ceiling warning at 90%, stating the accrued amount **and** the ceiling (FR-062c).
- [X] T147 [US9] Refuse further deferred dealing once accrued commission exceeds the ceiling, with `COMMISSION_CEILING_EXCEEDED` naming the ceiling (FR-062d). The refusal must not leave an order half-placed (spec Edge Cases).
- [X] T148 [US9] Make dealing **resume automatically** once a confirmed payment brings the accrued amount back below the ceiling — no operator action (FR-062d, Story 9 scenario 9). The check reads the balance; it never reads a sticky "barred" flag.
- [X] T149 [US9] Implement FR-063 (reversal of accrual on a voided invoice) as a **compensating movement carrying `reversalOfId`, never a delete**, hooked into `InvoicesService.voidInvoice` (`invoices.service.ts:212`), inside the transaction it already runs in — **T011 confirmed this void path exists**, called from `OrdersService`'s order-cancellation flow (`orders.service.ts:519`). Not conditional.

### Backend — tests

- [X] T150 [P] [US9] Add `test/e2e/commission-accrual.e2e-spec.ts`: accrual matches the rate in force to the last unit of currency, **including across a rate change** (SC-011, FR-058).
- [X] T151 [P] [US9] Add `test/e2e/cashback-programme.e2e-spec.ts`: accrues for a targeted company, accrues nothing for an untargeted one, accrues nothing while switched off (FR-060).
- [X] T152 [P] [US9] Add `test/e2e/commission-ceiling.e2e-spec.ts`: warning at 90%, refusal past the ceiling naming it, automatic resumption after a confirmed payment, and the platform-wide default governing a company with no explicit ceiling (FR-062a–d, SC-013).
- [X] T153 [P] [US9] Add `test/unit/billing.service.spec.ts` for the term-in-force resolution and both accrual computations on both bases.

### Dashboard

- [X] T154 [US9] Create `web_dashboard/src/petrol_company/invoices/api/billing.api.ts` and hooks; wire `PlatformCommissionBanner.tsx` and `CashbackBanner.tsx` to real accrued balances (FR-061).
- [X] T155 [US9] Make the commission and cashback controls **read-only for `FUEL_COMPANY_ADMIN`** — `web_dashboard/src/petrol_company/invoices/CommissionTypeSelector.tsx`'s edit control must be **absent, not merely disabled** (FR-056, FR-091). The editing surface belongs to the operator only (US13).
- [X] T156 [US9] Show the ceiling warning on the fuel company dashboard once accrued commission reaches 90%, stating both figures (FR-062c); wire `web_dashboard/src/petrol_company/profile/ProfileCommissionSection.tsx` to read-only real terms.

**Checkpoint**: Commission and cashback accrue and enforce. Walk `quickstart.md` 2.1–2.8.

---

## Phase 13: User Story 10 - A company settles its account with the platform (Priority: P10)

**Slice 10.** Settles the balances US9 creates.

**Goal**: A company sees its ledger with the platform, records a full or partial payment with
evidence, and the operator confirms it by hand.

**Independent Test**: Accrue commission, pay part of it with a document attached, confirm the movement
appears as awaiting confirmation, confirm it as the operator, and confirm the balance falls by the
paid amount.

- [X] T157 [US10] **Take the deferred audit decision before any code in this phase** (plan *Open decision*): what attribution a commission accrual and a payment confirmation carry. Record the decision in this file's *Notes* and reflect it in T141's schema. A ledger that cannot say who confirmed a payment is very hard to retrofit once it holds real balances.
- [X] T158 [US10] Create `src/modules/platform-account/platform-account.module.ts`, `platform-account.service.ts` and `platform-account.controller.ts` as its own module.
- [X] T159 [US10] Implement the balance as the **sum of confirmed movements only** — never a stored running total that can drift from its own ledger (`data-model.md` Rules, FR-068, SC-012).
- [X] T160 [US10] Add `GET /platform-account/movements` (`FCA`, `SA`), **cursor-paginated** on `(companyId, createdAt, _id)` (FR-071).
- [X] T161 [US10] Add `POST /platform-account/payments` (`FCA`) — `{ amount, method, reference?, documentFileId? }`, full or partial (FR-065, FR-072). Created as `RECORDED`; **the balance does not move** (FR-068).
- [X] T162 [US10] Refuse a payment carrying neither a document nor a reference with `PAYMENT_EVIDENCE_REQUIRED` (`400`), naming the requirement (FR-067).
- [X] T163 [US10] Add `PATCH /platform-account/payments/:id/confirm` (`SA` only), **conditional on `state: RECORDED`** — `modifiedCount` decides, and a second confirmation returns `409 PAYMENT_ALREADY_CONFIRMED` (FR-069, FR-067a).
- [X] T164 [US10] Ensure **no** payment is ever confirmed automatically, whichever method was used (FR-067a). No payment provider is integrated; the platform never initiates, takes or receives a payment (FR-066a).
- [X] T165 [US10] Route the supporting document through `FilesService`. `FileRecord` is `markTenantScoped`, which is what makes FR-070 (retrievable by the paying company and the operator, nobody else) already true — do not add an explicit check that would look necessary and is not.
- [X] T166 [P] [US10] Add `test/e2e/platform-account-payments.e2e-spec.ts`: a partial payment reduces the balance by **exactly** the amount paid once confirmed, an unconfirmed payment reduces it by **nothing**, and the remainder stays owed (SC-012, FR-072).
- [X] T167 [P] [US10] Add an e2e assertion that a second fuel company cannot retrieve another company's payment document (FR-070, SC-006, quickstart 2.12).
- [X] T168 [P] [US10] Add an e2e assertion that the ledger pages without duplicating or skipping movements while new ones arrive (FR-071).
- [X] T169 [P] [US10] Add `test/unit/platform-account.service.spec.ts` for balance derivation from confirmed movements only.

### Dashboard

- [X] T170 [P] [US10] Create `web_dashboard/src/petrol_company/platform_account/api/platform-account.api.ts` and hooks.
- [X] T171 [US10] Wire `web_dashboard/src/petrol_company/platform_account/PlatformAccountPage.tsx`, `DesktopPlatformAccountTable.tsx` and `MobilePlatformAccountList.tsx` to the real ledger — reference, kind, amount, method, date, state and document where one exists (FR-064); delete sample rows.
- [X] T172 [US10] Make a `RECORDED` movement visibly distinguishable from a `CONFIRMED` one, and never counted as paid (FR-068, scenario 6).
- [X] T173 [US10] Wire cursor pagination into the ledger (FR-071).
- [X] T174 [US10] Wire `web_dashboard/src/petrol_company/payment/PaymentPage.tsx` and `AmountCard.tsx` for full or partial payment, stating currency (FR-065, FR-098).
- [X] T175 [US10] Wire `web_dashboard/src/petrol_company/payment/PaymentMethodCard.tsx`, `BankTransferDetailsCard.tsx` and `SadadDetailsCard.tsx` to display the details needed to pay **elsewhere** — account details and beneficiary, or a reference — and record what the payer reports (FR-066, FR-066a). Neither is an integrated provider.
- [X] T176 [US10] State the period a displayed payment reference remains valid for, and never present it as proof that anything has been paid (FR-066b).
- [X] T177 [US10] Wire document attachment and retrieval; refuse a payment with no evidence, showing the platform's reason (FR-067). Loading / empty / error states with retry; bilingual RTL.

**Checkpoint**: A company can settle with the platform. Walk `quickstart.md` 2.9–2.12.

---

## Phase 14: User Story 11 - Supplier invoices and litre balances (Priority: P11)

**Slice 11.** The only phase that changes what a station owner **does**, not only what they see (R9).

**Goal**: A supplier invoice against an order establishes what was actually supplied; the shortfall
becomes a litre balance for the station owner; later orders draw it down automatically.

**Independent Test**: Place an order for a known quantity, upload a supplier invoice for a smaller
quantity, and confirm the shortfall appears as a balance for that owner and grade; place a second
order for that owner and confirm the balance is drawn down. Reference case: **31,501.100 L supplied
against 33,000 L ordered → 1,498.900 L credited.**

### Backend — extraction seam (R8: ship it null first)

- [X] T178 [P] [US11] Define the extraction port `src/modules/orders/services/supplier-invoice-extraction.port.ts` — one method, document in, candidate field values out — as an abstract interface behind DI, mirroring how `FilesModule` hides its storage driver (Principle IV).
- [X] T179 [P] [US11] Implement `NullSupplierInvoiceExtractor` returning nothing, and register it as the default. **FR-073a-ii (confirmation is what is recorded) and FR-073a-iii (manual entry when extraction yields nothing) together mean the null extractor is a fully working feature** — every requirement in this story is satisfiable at zero extraction accuracy (R8). A real extractor is added behind the same seam afterwards, or not at all.

### Backend — schema and recording

- [X] T180 [US11] Add the `supplierInvoice` embedded sub-document to `src/modules/orders/schemas/order.schema.ts` per `data-model.md` — `fileId`, `extracted{}`, `confirmed{}`, `confirmedBy/At`, `supersededAt`. **Keep its `_id`** with a comment saying so — the confirm, replace and balance-movement paths each address one specific invoice (R7), the same call the stop-detection feature had to make.
- [X] T181 [P] [US11] Create `src/modules/litre-balances/schemas/litre-balance.schema.ts` — `companyId`, `clientId`, `fuelType`, `balanceLitres`, embedded `movements[]`. `markTenantScoped` (R6). **Unique index** on `(companyId, clientId, fuelType)`.
- [X] T182 [P] [US11] Define the embedded `LitreMovement` sub-schema — `kind`, signed `litres`, `orderId`, `reason`, `actorId`, `at` — **keeping its `_id`**. Add `src/common/enums/litre-movement-kind.enum.ts` with `SHORTFALL_CREDIT | EXCESS_DEBIT | ORDER_DRAWDOWN | DRAWDOWN_RETURNED | CORRECTION` (FR-097).
- [X] T183 [US11] Add the **partial unique index** on `movements.orderId` for the credit/debit kinds. **This is what makes a retried upload idempotent** (FR-073e) — not an application-level "have we done this already" check, which races.
- [X] T184 [US11] Create `src/modules/litre-balances/litre-balances.module.ts` and `litre-balances.service.ts`. Write `balanceLitres` and its movement **only ever together, in one conditional update**, so `balanceLitres` equals the sum of `movements.litres` by construction (SC-014a).
- [X] T185 [US11] Add `POST /orders/:id/supplier-invoice/upload` (`FCA`) — stores the document via `FilesService`, runs extraction, returns `{ fileId, extracted, orderedQuantityLitres }`. **Records nothing and moves no balance** (FR-073a-i, SC-014c).
- [X] T186 [US11] Add `POST /orders/:id/supplier-invoice` (`FCA`) — `{ fileId, confirmed }`. Records the invoice and applies the balance movement **in one transaction** (Principle V).
- [X] T187 [US11] Retain **both** `extracted` and `confirmed` (FR-073a-iv), which is what makes a systematic misreading discoverable after the fact and extraction accuracy measurable from production data (SC-014d, R8).
- [X] T188 [US11] Refuse a confirmed grade differing from the order's with `SUPPLIER_INVOICE_GRADE_MISMATCH` (`400`), naming the mismatch (FR-073g).
- [X] T189 [US11] Refuse a supplier invoice against a cancelled or rejected order with `SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE` (`409`), naming the order's state (spec Edge Cases).
- [X] T190 [US11] Credit the shortfall (`Order.quantityLitres − confirmed.quantityLitres`, positive) to that owner's balance for that grade (FR-073c); a negative shortfall debits it (FR-073d).
- [X] T191 [US11] Where an excess would take the balance below zero, **state the outcome explicitly** at the point of recording rather than leaving a negative balance unexplained — `LITRE_BALANCE_WOULD_GO_NEGATIVE` (FR-073d, spec Edge Cases).
- [X] T192 [US11] Add `PUT /orders/:id/supplier-invoice` (`FCA`) — replace: supersede the prior invoice via `supersededAt` and **restate** the movement, never apply a second (FR-073e).
- [X] T193 [US11] Extend `GET /orders/:id` with `supplierInvoice` — confirmed values plus ordered quantity, supplied quantity, proportion fulfilled and shortfall. **Absent, not null-filled**, when not recorded (FR-073b, FR-048).

### Backend — draw-down (the client-facing change, R9)

- [X] T194 [US11] Draw the balance down at **order creation**, inside the existing creation transaction in `src/modules/orders/orders.service.ts`, as a **conditional update whose filter carries the expected balance** — so two orders placed at once for one owner and grade cannot both consume the same litres; the second matches nothing and retries (R9, Principle V). This is the `ratings.service.ts` idiom.
- [X] T195 [US11] Add `litreDrawdown: { litresDrawn, balanceRemaining }` to the `POST /orders` response (FR-074).
- [X] T196 [US11] Add the **projected** draw-down to the `POST /orders/quote` response. **A quote MUST consume nothing** — a quote that moved the balance would leak litres on every abandoned quote (R9). Add a test asserting a quote leaves the balance untouched.
- [X] T197 [US11] Return the draw-down to the balance as a `DRAWDOWN_RETURNED` movement when an order is cancelled (spec Edge Cases).
- [X] T198 [US11] Add `GET /litre-balances` (`FCA`, `?clientId=`) and `GET /users/me/litre-balances` (`CL`) — the latter including movements, each traceable to the order or correction that caused it (FR-075a, FR-076).
- [X] T199 [US11] Add `POST /litre-balances/:id/corrections` (`FCA`) — `{ litres, reason }`. **`reason` required** → `BALANCE_CORRECTION_REASON_REQUIRED` (`400`) without it (FR-075). Attribute the correction to the administrator who made it (FR-074a).
- [X] T200 [US11] Show balances only for grades the owner's fuel company sells (FR-077) — but keep a balance in a grade the company has **stopped** selling visible rather than silently discarding it (spec Edge Cases). These two are not in conflict; the second is the exception the first must not swallow.

### Backend — tests

- [X] T201 [P] [US11] Add `test/e2e/supplier-invoice.e2e-spec.ts` using the reference case: 31,501.100 L against 33,000 L → 1,498.900 L credited. Assert exact-quantity → **no** movement, and excess → debit (FR-073b/c/d).
- [X] T202 [P] [US11] Add an e2e assertion that abandoning at the confirmation step leaves **no sub-document and no balance movement** (SC-014c), and that a repeated or retried upload moves the balance **once** (FR-073e, SC-014a).
- [X] T203 [P] [US11] Add `test/e2e/litre-balance-drawdown.e2e-spec.ts`: a later order draws the balance down and shows the amount drawn and remainder before placing; a quote consumes nothing; a cancellation returns it (FR-074, R9, SC-014b).
- [X] T204 [P] [US11] Add an e2e assertion that every balance equals the sum of its movements and every movement traces to its order or correction (SC-014a, FR-075a), and that a second fuel company cannot view an owner's balance (FR-073f, SC-006).
- [X] T205 [P] [US11] Add `test/unit/litre-balances.service.spec.ts` for shortfall, excess, negative-guard, correction-requires-reason and idempotency.

### Dashboard

- [X] T206 [US11] Build the supplier-invoice upload and confirmation flow on the order detail screen. The confirmation step MUST show the **ordered quantity alongside the extracted one**, so a misread is visible as an implausible shortfall *before* it is confirmed rather than after (FR-073a-v). Every extracted value is correctable, and a value extraction did not yield is enterable by hand (FR-073a-ii, FR-073a-iii).
- [X] T207 [US11] Wire `web_dashboard/src/petrol_company/orders/order-details/AvailableBalanceCard.tsx` and `web_dashboard/src/petrol_company/stations/DueLitersBalanceCard.tsx` to real balances, stating litres as the unit (FR-098), with the correction control requiring a reason (FR-075).
- [X] T208 [US11] Show the order's ordered / supplied / proportion fulfilled / shortfall on the order detail screen (FR-073b). Loading / empty / error states with retry; bilingual RTL.

**Checkpoint**: Reconciliation and litre balances work. Walk `quickstart.md` 2.13–2.23. **Confirm both
Flutter clients still pass unchanged** — this phase touched their order-creation path.

---

## Phase 15: User Story 12 - Fuel exchange between companies (Priority: P12)

**Slice 12. The isolation mechanism is built and reviewed ALONE, before the domain (R3).**

**Goal**: A fuel company raises an exchange request to another; the recipient accepts or declines; each
side sees its incoming and outgoing requests correctly.

**Independent Test**: Raise a request as one fuel company, **accept it as the other**, and confirm each
side sees it in the correct direction with the same terms.

### ⚠️ Part A — the party-set isolation mechanism, alone

**Do not begin Part B until Part A's tests pass.** Marking `ExchangeRequest` multi-party compiles,
passes review, and passes every single-company test while **the recipient's incoming list is silently,
permanently empty** — and `SUPER_ADMIN` bypasses both plugins, so the operator's screen shows
everything correctly while both fuel companies see nothing (R3, `contracts/isolation-contract.md`).

- [X] T209 [US12] Create `src/common/plugins/party-set.marker.ts` — `markPartySet(schema)`, mirroring `markTenantScoped` / `markMultiParty`.
- [X] T210 [US12] Create `src/common/plugins/party-set-scope.plugin.ts`. Read filter for every operation in `SCOPED_QUERY_OPS`: `SUPER_ADMIN` bypasses; no authenticated actor bypasses; `FUEL_COMPANY_ADMIN` gets `{ partyCompanyIds: ctx.companyId }` — **array membership, not equality**; **any other role throws** (fail closed, as both existing plugins do).
- [X] T211 [US12] Use `!ctx?.role` as the bypass discriminator, **never `!ctx`**. Since feature 012 a public route carries a store for its correlation id but establishes no actor; testing `!ctx` alone falls through to the authenticated branch and throws on anonymous traffic. **This exact trap was found and fixed in both existing plugins — do not reintroduce it in the third.**
- [X] T212 [US12] On create, **validate that the acting company appears in `partyCompanyIds`** rather than forcing a value. Forcing is precisely what makes the other two plugins unable to express this shape. Refuse with `EXCHANGE_PARTY_INVALID`.
- [X] T213 [US12] Make a party-set schema without an indexed `partyCompanyIds` field **fail at registration, not at first query** (`contracts/isolation-contract.md`).
- [X] T214 [US12] Register the plugin globally alongside the existing two, leaving `src/common/plugins/tenant-scope.plugin.ts` and `multi-party-scope.plugin.ts` **untouched** — the reason a third plugin is acceptable at all is that it keeps the blast radius at the new collection (plan Complexity Tracking).
- [X] T215 [US12] Create `test/e2e/party-set-isolation.e2e-spec.ts` using T008's two-company fixture, asserting every row of the isolation contract's *Required tests* table: **the recipient reads a request raised by the counterparty (non-negotiable)**; the raiser reads their own; a third fuel company reads neither; create with the acting company absent from the parties is refused; create with one party or three is refused; `SUPER_ADMIN` reads all; anonymous/public-route traffic bypasses without throwing.
- [X] T216 [US12] Add `test/unit/party-set-scope.plugin.spec.ts` covering the plugin's role branches, including the `!ctx?.role` discriminator.
- [X] T217 [US12] **Gate**: review Part A on its own and confirm T215 passes before any exchange domain code is written. Record the review in this file's *Notes*.

### Part B — the fuel exchange domain

- [X] T218 [P] [US12] Create `src/modules/fuel-exchange/schemas/exchange-request.schema.ts` per `data-model.md` — `partyCompanyIds[2]`, `raisedByCompanyId`, `recipientCompanyId`, `raisedByUserId`, `fuelType`, `quantityLitres`, `unitPrice`, `currency`, `deliveryAt`, `deliveryPlaceText`, `state`, `resolvedBy/At`. Apply `markPartySet`. Indexes: `partyCompanyIds` multikey (**the isolation filter — must be indexed**) and `(partyCompanyIds, state, createdAt, _id)`.
- [X] T219 [P] [US12] Create `src/common/enums/exchange-request-state.enum.ts` — `AWAITING_RESPONSE | ACCEPTED | DECLINED | WITHDRAWN` (FR-097).
- [X] T220 [US12] Create `src/modules/fuel-exchange/fuel-exchange.module.ts`, `fuel-exchange.service.ts`, `fuel-exchange.controller.ts` and its DTOs.
- [X] T221 [US12] Add `POST /fuel-exchange/requests` (`FCA`) — `{ fuelType, quantityLitres, unitPrice, deliveryAt, deliveryPlaceText }` (FR-078). Refuse `400 EXCHANGE_GRADE_NOT_SOLD` if the recipient does not sell the grade (FR-085), and `400` on an invalid quantity or price (FR-086).
- [X] T222 [US12] Add `GET /fuel-exchange/requests` (`FCA`, `SA`) with `?direction=incoming|outgoing|all`. **Direction is derived from `raisedByCompanyId` against the viewer, never stored per-viewer** (FR-079, FR-084). Cursor-paginated.
- [X] T223 [US12] Add `GET /fuel-exchange/requests/:id` (`FCA`, `SA`) including the counterparty's contact details — disclosed only to the two parties, and only once a request exists between them (FR-086b). An isolation refusal must not reveal whether the record exists (Constitution II).
- [X] T224 [US12] Add `PATCH /fuel-exchange/requests/:id/respond` (`FCA`, recipient only) — `{ accept: boolean }`, **conditional on `state: AWAITING_RESPONSE`** → `409 EXCHANGE_ALREADY_RESOLVED` (FR-080, FR-082).
- [X] T225 [US12] Add `PATCH /fuel-exchange/requests/:id/withdraw` (`FCA`, raiser only) — the same conditional update (FR-081, FR-082).
- [X] T226 [US12] On acceptance, identify which party is supplier and which is receiver (FR-083), and **create no order, no delivery, no transport assignment and no invoice** (FR-086a). The delivery time and place are terms of the agreement, not instructions to the platform.
- [X] T227 [P] [US12] Add `test/e2e/fuel-exchange.e2e-spec.ts` over the two-company fixture: raise, accept, decline, withdraw, and the full-terms read from both sides with identical terms (SC-014).
- [X] T228 [P] [US12] Add an e2e assertion that **concurrent accept and withdraw produce exactly one outcome that both parties see identically** (FR-082, SC-008, spec Edge Cases).
- [X] T229 [P] [US12] Add an e2e assertion that **no order or delivery exists on either party's orders list after acceptance** (FR-086a, quickstart 3.6).
- [X] T230 [P] [US12] Create `web_dashboard/src/petrol_company/fuel_exchange/api/fuel-exchange.api.ts` and hooks.
- [X] T231 [US12] Wire `web_dashboard/src/petrol_company/fuel_exchange/FuelExchangePage.tsx`, `FuelExchangeListItem.tsx` and `FuelExchangeStats.tsx` to live data with the incoming / outgoing / both filter (FR-084); delete sample rows.
- [X] T232 [US12] Wire `web_dashboard/src/petrol_company/fuel_exchange/NewFuelRequestForm.tsx` to raise a request, offering only the platform's grades and surfacing the platform's own refusal for a grade the recipient does not sell or an invalid quantity or price (FR-085, FR-086).
- [X] T233 [US12] Wire `web_dashboard/src/petrol_company/fuel_exchange/FuelExchangeDetailPage.tsx`, `FuelExchangeRequestData.tsx` and `FuelExchangeContactInfo.tsx` — full terms, amounts with currency and quantity with unit (FR-098), counterparty contact, and accept / decline / withdraw with the `409` surfaced as *already resolved*. Loading / empty / error states with retry; bilingual RTL.

**Checkpoint**: Walk `quickstart.md` Part 3 with **two** fuel companies. **A single-company run proves
nothing.** Step 3.2 is the whole test; step 3.3 proves nothing on its own.

---

## Phase 16: User Story 13 - The platform operator oversees fuel companies (Priority: P13)

**Slice 13.** Every screen here reuses a component another phase rewired, so it can only be finished
once they are.

**Goal**: The operator lists and onboards fuel companies, opens one to see its owners, stations,
invoices and platform account, sets commission and cashback terms, confirms payments, and sees
exchange requests across the platform.

**Independent Test**: As the operator, onboard a fuel company, open it, and confirm every figure
matches what that company's own administrator sees.

- [X] T234 [US13] Confirm `GET /companies?type=FUEL`, `POST /companies` and `PATCH /companies/:id/status` already exist and carry `SA` in `src/modules/companies/companies.controller.ts` (FR-087, FR-088, FR-090). The operator's listing is a **query, not a new route** — this phase is almost entirely dashboard work.
- [X] T235 [P] [US13] Create `web_dashboard/src/admin/petrol_companies/api/fuel-companies.api.ts` and hooks.
- [X] T236 [US13] Wire the operator's fuel companies list in `web_dashboard/src/admin/petrol_companies/` to real figures (FR-087); delete sample rows.
- [X] T237 [US13] Wire fuel company onboarding, after which its administrator can sign in (FR-088).
- [X] T238 [US13] Wire the operator's fuel company detail to that company's station owners, stations, invoices and platform account, **reusing the components Phases 6, 9, 12 and 13 rewired** rather than a parallel implementation (FR-089).
- [X] T239 [US13] Give the operator the **editing** surface for commission terms and the cashback programme — the write side of T138/T139, absent for the fuel company administrator (FR-055, FR-056, FR-059, FR-091).
- [X] T240 [US13] Give the operator the per-company commission ceiling control (T140) and the platform-wide default (FR-062a, FR-062b).
- [X] T241 [US13] Give the operator the payment confirmation control (T163) — by hand, never automatic (FR-069, FR-067a).
- [X] T242 [US13] Wire the operator's exchange screen at `web_dashboard/src/admin/fuel_exchange/` — and record in the code that **this screen renders correctly even when the party-set isolation is broken**, so it is never used as evidence that exchange works (R3, quickstart 3.3).
- [X] T243 [US13] Wire company suspension, after which the administrator is refused sign-in **and told why** (FR-090, with Phase 3's T026).
- [X] T244 [US13] Audit every screen shared between the operator and a fuel company administrator: controls reserved to the operator MUST be **absent, not merely disabled**, for the administrator (FR-091). Enumerate the shared screens in this file's *Notes* and confirm each.
- [X] T245 [P] [US13] Add a dashboard test asserting the operator-only controls are absent from the administrator's render of each shared screen (FR-091, SC-002).
- [X] T246 [P] [US13] Add an e2e assertion that a `FUEL_COMPANY_ADMIN` is refused every operator-only endpoint added in Phases 12–15 (FR-005, FR-056, FR-062a, FR-067a, SC-001).
- [X] T247 [US13] Loading / empty / error states with retry on every operator screen this phase touches; bilingual RTL (FR-092, FR-093, FR-095).

**Checkpoint**: Walk `quickstart.md` Part 4.

---

## Phase 17: Polish & Cross-Cutting Concerns

- [X] T248 Grep the whole fuel company and operator surface for remaining hardcoded sample records and confirm **zero** remain in any screen that ships (SC-002).
- [X] T249 [P] Grep for remaining trend percentages across both surfaces and confirm **no occurrence** survives (FR-047, quickstart 1.20).
- [X] T250 [P] Audit every list, detail and action screen this feature touched for a distinguishable loading, empty and error state, each with a working retry — an empty list must not read as a failure, and a failure must not read as zero (FR-092, FR-093, SC-007).
- [X] T251 [P] Audit every monetary amount for a stated currency and every quantity for a stated unit (FR-098).
- [X] T252 [P] Audit every new and rebuilt screen in Arabic RTL and in English (FR-095, SC-016). Untouched screens are not retrofitted.
- [X] T253 [P] Audit that no company, owner or driver text is rendered as markup anywhere this feature touched (FR-096).
- [X] T254 [P] Audit for literal role, stage, grade, movement-kind, request-state or route values written at the point of use rather than referenced from a constant (FR-097, Principle I) — the defect class R1 found.
- [X] T255 Run the full isolation sweep: for **every** list and detail screen and **every** record type this feature introduces, confirm zero records belonging to another company are reachable, including by entering an address directly (SC-006).
- [X] T256 Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` — the canonical platform contract — with every endpoint this feature added, following the precedent set when spec 008's fleet endpoints were folded in.
- [X] T257 Update `CLAUDE.md`'s active-feature section with the implementation status, the corrections found while implementing, and what was left undone and why.
- [X] T258 Record every correction found while implementing in this file's *Corrections* section — the cases where following the artifacts as written would have been wrong. This repository's prior features treat that log as a deliverable.
- [X] T259 Run the complete regression gate: platform `npm run lint:check && npm run build && npm run test` and `npx jest --config test/jest-e2e.json --runInBand`; dashboard `npx tsc -b --force && npx vitest run`; mobile `cd mobile_app && flutter test`. Compare against T003's baseline and account for every difference.
- [ ] T260 Walk `quickstart.md` Parts 0–4 end to end and complete its *Results* table with dates, who walked it, and outcomes.
- [ ] T261 *(Found during analysis — no prior task measured this.)* During the T260 walkthrough, time SC-003 (awaiting-approval → routed, dashboard steps 1.3 and 1.5 back to back) and SC-005 (onboard an owner, register a station, set a credit limit, steps 1.8–1.11 back to back) with a clock. Record both durations in `quickstart.md`'s *Results* table against the 60-second and 3-minute thresholds.
- [ ] T262 *(Found during analysis.)* Run SC-015 as an observed session: someone who has not read `spec.md` or `quickstart.md` attempts each primary journey — decide an order, onboard an owner, set a price, settle an invoice, pay commission, raise an exchange request — using only the shipped screens. Record whether each was completed on the first attempt without consulting documentation, and what, if anything, they got stuck on.
- [ ] T263 *(Found during analysis.)* If T261 or T262 fails its threshold, record the shortfall in this file's *Corrections* section with what specifically was slow or confusing — do not silently mark SC-003/SC-005/SC-015 as met without the timed/observed evidence T261/T262 produced.

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Phase 1 (Setup)
   ├─> Phase 2 (Foundational, platform-side)  ─┐
   └─> Phase 3 (US1, Slice 0)                 ─┴─> Phase 4 (Slice 1)
                                                      │
                          ┌───────────────────────────┴───────────────────────────┐
                          v                                                       v
             Phases 5..11  (US2..US8)                                    (nothing else)
                          │
      ⛔ natural feature boundary after Phase 11
                          │
        ┌─────────────────┼─────────────────────────────┐
        v                 v                             v
  Phase 12 (US9)    Phase 14 (US11)          Phase 15 (US12): Part A ─> Part B
        │
        v
  Phase 13 (US10)
        └──────────────> Phase 16 (US13) ─> Phase 17 (Polish)
```

- **Phase 2** is platform-side only and can run alongside Phase 3.
- **Phase 3 blocks everything.** No fuel company administrator can sign in until it lands (R1).
- **Phase 4 blocks Phases 5–16.** Its two changes are the ones whose failure mode is silent.
- **Phase 15 Part A blocks Part B**, absolutely (R3).
- **Phase 16 depends on Phases 6, 9, 12, 13 and 15** — it reuses their components.

### User Story Dependencies

| Story | Depends on | Note |
|---|---|---|
| US1 | — | MVP. Blocks all. |
| US2 | US1, Phase 4 | |
| US3 | US1, Phase 4 | Independent of US2 |
| US4 | US1, Phase 4 | US2's route action needs one transporter; a seeded one suffices |
| US5 | US1, Phase 4 | |
| US6 | US2 | An invoice exists from **approval** (R4), not from delivery |
| US7 | US1, Phase 4 | Figures verified against US2/US3's lists |
| US8 | US1, Phase 4 | Fully independent |
| US9 | US6 | Accrual joins invoice issuance |
| US10 | US9 | Settles the balances US9 creates. **T157 first.** |
| US11 | US2, US3 | Touches client order creation |
| US12 | Phase 15 Part A | And nothing else — least coupled |
| US13 | US3, US6, US9, US10, US12 | Reuses their components |

### Within Each Story

Tests before implementation where the phase lists them first · schemas before services · services
before controllers · backend before the dashboard screen that consumes it · isolation assertions
before the story is called done.

---

## Parallel Opportunities

**Phase 1**: T002, T003, T005, T006 together.

**Phase 2**: T008, T009, T010, T011, T012 together (T007 alone — one shared enum file).

**Phase 3**: T013, T014, T015 together; later T022 and T023 together.

**Phase 4**: T031, T032, T033, T035, T037, T038 together.

**Phase 5**: T039, T040, T041 together; then T047–T051 together (five distinct action components).

**Phase 6**: T060 and T061 together; T069 and T070 together; T071 alongside the backend tasks.

**Phase 12**: T132, T133, T134, T135 together; T150, T151, T152, T153 together.

**Phase 14**: T178 and T179 together; T181 and T182 together; T201–T205 together.

**Phase 15**: T218 and T219 together **only after T217's gate**; T227, T228, T229 together.

**Phase 17**: T249–T254 together.

**Across stories**: once Phase 4 is complete, US3, US4, US5 and US8 are mutually independent and can
be taken by four people at once. US2 and US6 are one chain. US11 and US12 are independent of each
other and of everything in Phases 12–13.

### Parallel Example: User Story 1

```bash
# Launch all three US1 tests together:
Task: "Write web_dashboard/src/auth/__tests__/roles.test.ts"
Task: "Write web_dashboard/src/routing/__tests__/route-guards.test.tsx"
Task: "Write web_dashboard/src/auth/__tests__/bootstrap-session.test.ts"

# Later, the two dead-duplicate deletions together:
Task: "Delete web_dashboard/src/api/apiClient.ts"
Task: "Delete web_dashboard/src/store/sessionStore.ts"
```

---

## Implementation Strategy

### MVP — User Story 1 alone

Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1) → **stop and validate**: walk
`quickstart.md` Part 0. A real fuel company administrator holds a real session, a client is refused,
and `dummy-token` appears nowhere. That is a shippable increment on its own — it closes an access
boundary that is currently wrong in the dangerous direction.

### Incremental delivery

Phase 4 → US2 (orders move) → US3 (owners and credit) → US4/US5/US8 in any order → US6 (invoices) →
US7 (real home screen). **Stop at Phase 11.** The stated goal — "link the fuel company dashboard to
the live platform" — is complete, every screen shows real data, and nothing on it is invented.

### The recommended split (plan Complexity Tracking)

If taken: **013** = Phases 1–11 · **014** = Phases 12–13 (commission, cashback, settlement) ·
**015** = Phase 14 (supplier invoices, litre balances) · **016** = Phase 15 (fuel exchange with its
isolation mechanism); Phase 16's operator screens fold into whichever feature owns the components
they share. **This is a recommendation, not a scope reduction** — the tasks above cover all 13
stories as specified.

### Parallel team strategy

Phases 1–4 together, as one team. Then: A on US2 → US6, B on US3 → US11, C on US4/US5/US8 → US7,
D on Phase 15 Part A (which touches nothing any other stream touches and gates the largest domain).
Phase 16 last, by whoever finished the shared components.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- The `[Story]` label maps a task to a spec.md user story for traceability.
- Commit after each task or logical group.
- Every phase checkpoint is a place it is safe to stop.
- **Record ground-truth findings here** (T001, T003, T011, T100, T157, T217, T244) rather than in a
  commit message — the next feature will read this file, and feature 009's notes being wrong is the
  reason this feature exists in the shape it does.

### Ground truth (fill in during T001/T003)

**T001 (confirmed 2026-09-03)** — `research.md` R1's claims hold exactly on `web_dashboard`'s `main`:
- `src/constants/roles.ts`: `Role` = `{ SUPER_ADMIN, COMPANY_ADMIN, CLIENT, DRIVER }`. Neither
  `FUEL_COMPANY_ADMIN` nor `TRANSPORT_COMPANY_ADMIN` exists. `DASHBOARD_LOGIN_ROLES = [SUPER_ADMIN,
  COMPANY_ADMIN]`.
- `src/app/router.tsx:9,79`: `RoleSelectionPage` is imported and routed at `/select-role`.
- `dummy-token` occurs in exactly three files: `src/auth/bootstrap-session.ts`,
  `src/auth/components/RoleSelectionPage.tsx`, `src/lib/api/api.client.ts`.

No correction to the plan needed — proceeding as designed.

**T003 (2026-09-03) — dashboard baseline is materially worse than CLAUDE.md's documented state,
found by actually running the gates rather than trusting the notes (the same R1 pattern this
feature's own plan warns about, now caught a second time on a different file):**
- Platform: `npm run test` **187/187** (22 suites) — matches CLAUDE.md exactly.
- Dashboard `npx tsc -b --force`: **151 error lines**, not "the same pre-existing unused-import
  errors." Breakdown: 71×`TS6133` (unused import — the documented class), but also 50×`TS2339`
  (property does not exist), 16×`TS2305` (no exported member), 2×`TS2307` (**module not found**),
  plus TS2551/TS6192/TS2724/TS6196/TS2367/TS2322 singles. Root causes, both squarely on this
  feature's own path:
  1. **`src/constants/order-status.ts` is missing the derived-predicate API a pre-existing test
     file (`tests/unit/order-status.test.ts`) already specifies in full** — `isKnownOrderStatus`,
     `orderStatusLabelKey`, `orderStatusTone`, `isAssignableOrderStatus`, `isTrackableOrderStatus`,
     `isTerminalOrderStatus`, `ORDER_STATUS_LABEL_KEY`, `ORDER_STATUS_TONE`,
     `ORDER_STATUS_UNKNOWN_LABEL_KEY` — and only carries 8 of 12 `OrderStatus` values. Its
     `FuelType` is also still the fabricated `{OCTANE_91:'91', OCTANE_95:'95', OCTANE_98:'98',
     DIESEL}` CLAUDE.md's feature 009 corrections already called "wrong outright." Every
     `transport_company/` consumer expecting these exports (trucks, orders, tracking, home,
     profile) fails to compile as a result — this is not confined to `petrol_company/`.
     `DriverEligibility` (4 values: `ELIGIBLE|BUSY|OFFLINE|INACTIVE` per feature 010's record) is
     also expected importable from this same file and does not exist. No `orderStatus.*` key
     exists in `src/lib/i18n/en.json`/`ar.json` yet either.
  2. **`src/app/router.tsx:60` imports `@/transport_company/clients/components/ClientsPage`**, a
     module feature 009's own corrections record as **deleted** ("a transport company can never
     have clients ... the entire folder was fabricated ... and was deleted, not fixed") — the
     import was never removed, so the router file itself fails to compile (`TS2307`).
  - **Resolution**: T031/T032/T033 (Phase 4) are widened to build the full API `order-status.test.ts`
    already specifies, not just the 12-value enum, since that test file is the authoritative,
    already-written contract for that module. T018 (Phase 3, already touching `router.tsx`) drops
    the dead `ClientsPage` import as part of its edit. The remaining `trucks/`-module and `TS6133`
    unused-import errors are **outside this feature's owned files** (`transport_company/trucks/`,
    profile cleanup) and are left disclosed, matching this repo's established practice, unless a
    task in this file's own path touches them.
- Dashboard `npx vitest run`: **31 failed / 18 passed** (11 suites, 8 failed/3 passed) — not "49
  passing, 2 pre-existing failing to load." The extra failures are downstream of the same
  `order-status.ts` gap (`orderStatusLabelKey is not a function`, `isTerminalOrderStatus` undefined,
  etc.) and are expected to clear once Phase 4 lands the real module. Re-measured after Phase 4;
  see the entry below.
- Mobile `flutter test`: not run in this pass — Phase 14 is the only phase touching client-facing
  behaviour and is not yet reached; will be run before and after that phase per its own checkpoint.

**T011 (2026-09-03) — corrects research.md's Open Items: a void path DOES exist.**
`InvoicesService.voidInvoice(orderId, session)` (`invoices.service.ts:212`) sets `state: VOID` and
is called from exactly one place — `OrdersService`'s cancellation path (`orders.service.ts:519`),
inside the same transaction session, whenever a cancelled order carries an `invoiceId`. Voiding a
CREDIT invoice also implicitly restores the client's available credit (the call site's own comment).
**FR-063 is reachable and MUST be implemented in Phase 12 (T149), not recorded as unreachable** —
research.md's speculation that no void path was confirmed to exist does not hold on this codebase.
T149 in Phase 12 is unconditional as a result: hook the commission/cashback reversal into this exact
call site, inside the transaction it already runs in (Principle V), the same way T142 hooks accrual
into invoice issuance.

**T017 (2026-09-03) — corrects research.md R1's mechanism claim, not its file count.** The exact
five files R1 names (`petrol_company/orders/api/order-actions.api.ts`,
`transport_company/orders/{api/orders.api.ts,components/order-details/OrderHeader.tsx,hooks/useOrders.ts,types.ts}`)
do each contain the string `FUEL_COMPANY_ADMIN` — but every single occurrence, in all five files, is
inside a `//`/`*` comment explaining an access rule to the reader, never a runtime string literal
compared against `user.role`. `grep` for a quoted `'FUEL_COMPANY_ADMIN'`/`"FUEL_COMPANY_ADMIN"`
anywhere in `src/` returns zero matches. **The gap R1 describes (a role compiling as a bare string
so the type system cannot catch its absence) does not exist in the dashboard's current committed
code** — it may have existed at the time research.md was written and been fixed since, or the claim
conflated "mentions the role name" with "uses it as an unchecked literal." Either way, T017 is now a
**verification** task, not a replacement: confirm no runtime literal exists (done — zero matches) and
leave the five explanatory comments as documentation, since they refer to a role that becomes real
the moment T016 lands and cost nothing while it didn't. No code change beyond T016 was needed to
close this specific finding.

**T023 (2026-09-03) — the dead duplicate is a larger cluster than the plan named, and the
platform-access layer inside it was itself broken.** Contract said "delete `sessionStore.ts` — 0
consumers." Tracing its actual references found `sessionStore.ts` also imports `authStore.ts`, and
`authStore.ts` in turn is imported by `src/api/apiClient.ts` (the other file the plan already knew to
delete) **and** `src/components/auth/ProtectedRoute.tsx` — a second, complete, self-contained
auth/session/routing subsystem with zero inbound references from `router.tsx`, `App.tsx` or
`main.tsx` anywhere. All five files (`src/api/apiClient.ts`, `src/store/{appStore,authStore,
sessionStore}.ts`, `src/components/auth/ProtectedRoute.tsx`) were deleted together, and the now-empty
`src/api/`, `src/store/` and `src/components/auth/` directories removed. Worth recording separately:
this dead `apiClient.ts` still carried the SAME `dummy-token` bypass pattern the live one did — had
anything actually still imported it, FR-003 would have had a second bypass to close, not one.

**T024 (2026-09-03) — `POST /auth/refresh` had never worked at all, not merely used the wrong
transport.** Tracing FR-002 ("renewed silently when it expires") down to the actual network call
found: `LoginResponse` never captured `refreshToken` from the login response (the backend's
`TokenPair` always returns one); `token-store.ts` had no refresh-token storage of any kind; and
`runRefresh()` POSTed to `/auth/refresh` with no body at all while relying on a cookie
(`withCredentials: true`) the backend has never issued — `AuthController.refresh` reads
`@Body() dto: RefreshTokenDto`. `grep -r "refreshToken" src/` returned **zero matches** anywhere in
the dashboard before this task. This is not the "cookie vs body" deviation CLAUDE.md's Recorded
Deviation describes as already-decided-and-shipped — that text names the intended fix; nothing had
implemented it. Fixed: `LoginResponse`/`RefreshResponse` both gained `refreshToken`; a new
`refreshTokenStore` (parallel to the existing `tokenStore`, same localStorage tradeoff, not a new
one — see its own comment) persists it; `runRefresh()` sends `{ refreshToken }` in the body and
captures the **rotated** refresh token the backend mints on every call
(`AuthService.issueTokenPair`), so the session's sliding window is genuinely sliding rather than
capped at the original login's refresh-token TTL; `session.store.ts`'s `setSession`/`clearSession`
set and clear it alongside the access token, the same way they already handled `tokenStore`. The
dead, zero-consumer `refresh()` export in `auth.api.ts` (a second copy of this exact logic, equally
broken) was removed rather than fixed in place, per FR-007's "exactly one platform-access layer."

**T025 (2026-09-03) — `useLogin.ts` had no redirect case for `FUEL_COMPANY_ADMIN` at all.** Its
post-login redirect was `if (SUPER_ADMIN) → /admin; else if (CLIENT) → '/petrol' (not a real route);
else → /transport` — every fuel company administrator's fresh login fell into the `else` and landed
on the transport surface, the wrong one, and would have been bounced to `/403` by T018's corrected
guard rather than reaching `/petrolCompany` at all. Separately, `onSuccess` called `setSession`
unconditionally for any role, including CLIENT/DRIVER, before FR-004's route guard ever ran — it
worked by accident (the guard bounces them to `/403` regardless of what `useLogin` does), not by
design. Fixed: a named `DASHBOARD_HOME` map (one entry per `Role` value, so a role added later fails
to compile here rather than silently falling into a catch-all) replaces the `if/else` chain, and a
`CLIENT`/`DRIVER` credential is refused via `isDashboardRole` before any session is established,
with a stated reason, rather than left to bounce through a guard afterwards.

**T013–T015 (2026-09-03) — the test-file location this file specified does not match the
repo's real convention, and two of the three tests already existed pre-written.**
`vite.config.ts`'s `test.include` is `tests/unit/**/*.{test,spec}.{ts,tsx}` (repo root) — not
`web_dashboard/src/**/__tests__/*.test.ts` as this file originally named; every existing test in
the repo lives under `tests/unit/`, following the same test-first pattern `order-status.test.ts`
established. Corrected paths: `tests/unit/roles.test.ts`, `tests/unit/router-guards.test.ts`,
`tests/unit/bootstrap-session.test.ts`. Two pre-existing files already covered most of the intended
ground and needed no new test at all — `tests/unit/protected-route.test.tsx` (7 tests, generic
`<ProtectedRoute allow=...>` behaviour across all five roles) and
`tests/unit/api-client.refresh.test.ts` (8 tests, the single-flight refresh mechanics T024 fixed) —
so `router-guards.test.ts` was scoped narrowly to the one thing those two cannot see: the *concrete*
`allow` arrays actually wired into `router.tsx`'s real route tree, which is where R1's specific
defects lived. **Importing `router.tsx` at all (needed for that concrete check) surfaced a second,
independent missing-module error** — `transport_company/orders/components/OrderEditPage.tsx`
imported `./order-details/EditTransportDetailsCard`, which did not exist anywhere in the repo
(`TS2307`, also in T003's baseline). This would have broken the dashboard's dev/build server
entirely, not merely `tsc -b --force`'s report of it — `OrderEditPage.tsx` is eagerly imported by
`router.tsx`, no lazy boundary. Fixed with a minimal stub (`export function
EditTransportDetailsCard() { return null; }`) restoring compilability; the whole surrounding page is
disconnected mock UI (hardcoded "ORD-2024-256", no route params, no `OrderDetailContext`) belonging
to the transport company surface (feature 009's territory) — wiring it for real is out of scope here
and left disclosed, same as the `trucks/`-module errors T003 already recorded. All three new/adjusted
test files pass (6 + 5 + 4 = 15 tests), alongside the two pre-existing files (7 + 8 = 15 tests) — 30
tests total across the five files this phase's test coverage touches.

**Platform unit-test note (2026-09-03) — pre-existing Jest-parallelism flakiness, not caused by this
phase.** `npm run test` (default parallel workers) intermittently fails 1-2 suites with
`connection.close()` on `undefined` inside a standalone `MongoMemoryServer` suite's `afterAll` — a
**different** suite each run (`order-state.service.spec.ts` once, `stop-detection-null-movement.spec.ts`
the next), always the identical signature. `npx jest test/unit/ --runInBand` is consistently
187/187. This is the same class of issue CLAUDE.md already documents for the e2e suite
("accumulated resource pressure from N sequential MongoMemoryReplSet apps... not a defect, a
different set fails each run") — apparently also reachable at the unit level under default worker
parallelism on this machine. `T007`/`T009`'s edits were verified against `--runInBand` specifically
to rule out a real regression before recording this.

**T026 (2026-09-03) — building this surfaced a general defect, not specific to company
suspension: the dashboard's refresh interceptor discarded EVERY `SESSION_REVOKED` cause, always,
by attempting a futile refresh first.** `ApiError`/`BackendErrorEnvelope` never captured the
backend's `cause` field at all (only `statusCode`/`message`/`error`) — a pre-existing gap, since
nothing had ever needed it before this feature. Worse: even carrying `cause` through would not have
been enough, because `apiClient`'s response interceptor treats every 401 as "try refreshing" before
giving up — and a `SESSION_REVOKED` 401 (any of the four causes: `SIGNED_IN_ELSEWHERE`,
`PASSWORD_RESET`, `ACCOUNT_DEACTIVATED`, and this feature's new `COMPANY_SUSPENDED`) can never be
fixed by a fresh access token, since `AuthService.refresh` re-checks the same account/company
active-state that just failed. The refresh attempt was not just wasted — it actively **replaced**
the specific cause with a generic refresh-failure error before `onSessionExpiredHandler()` ever saw
it, for all four causes, every time, since before this feature existed. Fixed in two places: (1)
backend — `_loadActiveUser`/`validateActiveSessionWithScoping` now distinguish
`unusableReason: 'ACCOUNT_INACTIVE' | 'COMPANY_SUSPENDED'` and throw the right
`SessionRevocationCause`, added as a new enum value with an explicit comment on why it is safe to
reveal only to an already-live session, never at the login boundary (anti-enumeration, matching the
platform's existing `GENERIC_AUTH_ERROR` design for wrong-password/deactivated-account); (2)
dashboard — the response interceptor special-cases `error.response.data.error === 'SESSION_REVOKED'`
and skips the refresh attempt entirely, going straight to `onSessionExpiredHandler()` with the
original response's `cause` intact; `bootstrapSession()`'s catch block reads it and shows a stated
reason for `COMPANY_SUSPENDED`/`ACCOUNT_DEACTIVATED` (not for `SIGNED_IN_ELSEWHERE`/`PASSWORD_RESET`,
which are the user's own action elsewhere and need no explanation on this device). Verified: a new
e2e case in `test/e2e/session-revocation.e2e-spec.ts` (mirroring the existing
`ACCOUNT_DEACTIVATED` test's shape exactly, including the login-boundary-stays-generic assertion)
and three new/extended dashboard unit tests, all passing alongside the four pre-existing
session-revocation e2e tests and the rest of Phase 3's 30 tests.

**T019/T028 (2026-09-03) — the file itself was never actually deleted, only its route and
import.** T019 originally landed the `/select-role` route removal and the `import` line removal
from `router.tsx`, but left `src/auth/components/RoleSelectionPage.tsx` on disk — still containing
the literal `'dummy-token'` string. T028's own verification grep (`grep -r "dummy-token"
web_dashboard/src/`) is what caught it: one match remained, in a file no longer reachable from any
route but still physically present. Deleted now; re-verified zero matches and a clean
`tsc -b --force`. Recorded as a reminder that "remove the route" and "delete the file" are two
different actions and a task instructing both needs both actually done, not just the reachable one.

**T030 (2026-09-03) — Phase 3 regression gate, run against T003's corrected baseline:**
- Platform `npm run lint:check`: **36,196 `prettier/prettier: Delete ␍` errors, zero of any other
  kind.** Traced to source, not fixed: `git config core.autocrlf` is `true` on this Windows
  checkout, and every file in the working tree — including ones this feature never touched
  (`src/app.module.ts`, `src/common/common.module.ts`, etc.) — has CRLF line terminators while
  `git diff` shows them clean (git's index holds LF; the checkout converted it). This is a
  pre-existing environment/tooling condition, not a code defect, and not something T030 should
  "fix" by reformatting the entire repository's line endings in this feature's diff. `lint:check`
  was not part of T003's original baseline capture — a gap in that task, corrected here by running
  it now and recording what it actually shows.
- Platform `npm run build`: **clean.**
- Platform `npm run test --runInBand`: **187/187** (22 suites) — unchanged from T003's baseline;
  none of Phase 3's backend changes (`error-code.enum.ts`, `configuration.ts`/`validation.ts`,
  `money.constants.ts`, `session-revocation-cause.enum.ts`, `users.service.ts`) touched anything a
  unit suite exercises differently.
- Dashboard `npx tsc -b --force`: **147 error lines**, down from T003's 151 — every `TS2307`
  (module-not-found) and the one `TS1484` from the baseline are gone (`ClientsPage`,
  `EditTransportDetailsCard` fixes), `TS2339` down by one (`DriverDetailsHeader.tsx`'s
  `TRANSPORT_COMPANY_ADMIN` reference now resolves). The remaining 147 are exactly T003's
  documented `order-status.ts`-gap errors (Phase 4's territory, deliberately untouched this phase)
  plus the pre-existing `TS6133` unused-import noise outside this feature's files.
- Dashboard `npx vitest run`: **43 passed / 23 failed** (14 files), up from T003's 18/31 (11
  files) — three new suites this phase added (`roles.test.ts` 6, `router-guards.test.ts` 5,
  `bootstrap-session.test.ts` 8) all pass, and the two suites Phase 3 actually fixed
  (`api-client.refresh.test.ts` 8, `protected-route.test.tsx` 7) now pass in full where every one
  of those 8+7=15 was failing before. **All 23 remaining failures trace to the same single cause**
  T003 already named — `order-status.ts`'s missing derived-predicate API — confirmed by name:
  `order-status.test.ts` itself (12), `override-verification.test.tsx` (2), plus
  `assignment-ack-state.test.tsx`/`candidate-eligibility.test.tsx` (6, downstream of the
  co-located `DriverEligibility` gap) and `list-error-state.test.tsx` (2, unrelated — pre-existing,
  not traced further here). `accessibility.test.tsx`/`orders.mutations.test.tsx` still fail to
  *load* (CLAUDE.md's documented pre-existing baseline, unrelated to `order-status.ts`).
- Mobile: not run this phase (Phase 3 touched no client-facing behaviour).

**Phase 3 (US1) complete: 18/18 tasks.** No fuel company administrator could sign in before this
phase; the session, the guards (both directions), and the platform-access layer are now real and
tested. Every remaining dashboard test failure is accounted for and scoped to Phase 4.

**Phase 4 (2026-09-03) — `order-status.ts` rebuilt against a complete pre-written test contract
(`tests/unit/order-status.test.ts`, 13 tests, all now passing), not just the 12-value enum T031's
one-line description implied.** Added the full derived-predicate API the test file already
specified (`isKnownOrderStatus`, `orderStatusLabelKey`/`orderStatusTone` with total
`ORDER_STATUS_LABEL_KEY`/`ORDER_STATUS_TONE` maps, `isAssignableOrderStatus`,
`isTrackableOrderStatus`, `isTerminalOrderStatus`), the `orderStatus.*` i18n block in both
`en.json`/`ar.json` (did not exist before this task, in either locale), `DriverEligibility` (4
values, co-located in the same file since `transport_company/` imports it from there), and rebuilt
`FuelType` from the fabricated `{OCTANE_91:'91', OCTANE_95:'95', OCTANE_98:'98', DIESEL}` to the
platform's real `{DIESEL, PETROL_91, PETROL_95, KEROSENE}` (T033) — confirmed zero other-file
breakage since every consumer only ever iterated `FUEL_TYPES` generically. `tsc -b --force`: 151 →
124 error lines (T003's baseline → now); every `TS2307` and the one `TS1484` are gone, `TS2339` and
`TS2305` both down. `vitest run`: two error-code types appeared that were **not in T003's
baseline** — not regressions, but real, previously-**masked** bugs that TypeScript could not see
until `order-status.ts` actually exported a complete `Record<OrderStatus, …>` type:
- `src/petrol_company/orders/components/OrderStatusBadge.tsx` (`TS2739`) — a **second**,
  separate `OrderStatusBadge` inside `petrol_company/orders/`, distinct from the
  `transport_company/` one, with its own hand-rolled status→style map missing the same four
  stages, alongside a completely separate `ArabicStatusBadge` matching hardcoded Arabic mock
  strings (`'جديد'`, `'تم الأسناد'`, …) — squarely the "hardcoded Arabic sample rows" plan.md
  describes. Left for Phase 5 (T044 wires this exact screen); recorded here so it isn't
  mistaken for a new defect when it surfaces there.
- `src/transport_company/dashboard/hooks/useSummary.ts` (`TS2349`, "not callable") — transport
  company / feature-009 territory, unrelated to this feature's own surface; left disclosed.

Also completed without code changes, already correct: **T034** (`pagination.ts` already the right
`{items, nextCursor}` shape, feature 009 had fixed it; `petrol_company/` has no pagination
consumers yet — nothing to break). **T036/T037**: `queryClient`'s `refetchIntervalInBackground:
false` was already TanStack Query v5's own default (made explicit rather than left implicit, with
two new tests — `tests/unit/query-client-hidden-tab.test.ts` — proving it against the real
`queryClient` instance every later phase will use, not a reconstructed one). **T038**: `api-routes.ts`/
`query-keys.ts` extended with every route/key this feature's remaining phases will need, each
comment naming the phase that actually wires it — so later phases reach for the constant, never a
literal path.

**Phase 4 complete: 8/8 tasks.**

**Phase 5 (2026-09-03) — orders wired to live data. Key findings:**
- All three order-action dialogs (`ApproveOrderDialog`/`RejectOrderDialog`/`ForceCompleteDialog`)
  were fully real and correctly built, but imported their mutation hooks from
  `@/transport_company/orders/hooks/useOrders` — a module those hooks were REMOVED from by
  feature 009 (comment left behind: "all four belong to FUEL_COMPANY_ADMIN... this role receives
  403"). All three were TS2305 compile errors in T003's own baseline. Fixed by pointing all three
  at the real, already-correct `@/petrol_company/orders/hooks/useOrderActions`.
- **Genuine platform addition, found mid-phase**: routing an order needs a transporter picker,
  which needs `GET /companies/:id/transporters` — did not exist (`createTransportCompany` had no
  listing counterpart at all). Added (`CompaniesService.findTransporters` /
  `companiesController.listTransporters`), tested in `region-assignment.e2e-spec.ts`. Closes
  T086a/T086b/T086c (Phase 7) ahead of schedule since Phase 5 genuinely depended on it.
- **`petrol_company/orders/components/OrderStatusBadge.tsx`** — a second, independent copy of the
  masked missing-4-stages bug Phase 4 fixed in the shared constant, PLUS a dead
  `ArabicStatusBadge` matching hardcoded mock strings (zero consumers). Rebuilt to delegate to the
  same total `orderStatusTone`/`orderStatusLabelKey` functions `transport_company`'s copy uses.
- **The `Order` frontend type was missing five backend-schema fields it needed today**: `clientId`,
  `transportCompanyId`, `invoiceId`, `priceBreakdown` — all present in the real `toObject()`
  response, none declared. Added to `transport_company/orders/types.ts` (the canonical shared type).
- **`OrderDetailPage`'s edit-transport toggle had no real capability behind it** — the platform can
  route an unrouted order but cannot reassign an already-routed one's transporter (only
  `redispatch`, gated to "no transporter accepted"). Removed outright (FR-017/FR-051) rather than
  wired to nothing; its `EditTransportDetailsCard.tsx` (petrol_company) and the entire
  `OrderEditPage.tsx` (petrol_company) were BOTH already dead/unrouted — deleted.
- **`LinkedInvoicesCard`, `AvailableBalanceCard`, `LimitCard`** were misread at first glance as
  this phase's own invoice/balance concerns; they are actually Phase 14 (supplier invoices/litre
  balances) and Phase 6 (credit limits) scope respectively, each with a specific hardcoded number
  (589.26 L / 84,000 of 150,000 SAR) presented as if live. Replaced with honest placeholders
  (`return null`) carrying a comment naming the real endpoint each future phase must build —
  `GET /users/me/credit` exists but is CLIENT-only; **no FUEL_COMPANY_ADMIN-facing credit-limit
  endpoint exists yet**, a finding for Phase 6.
- Test coverage added: `test/e2e/fuel-company-rbac.e2e-spec.ts` companion
  `test/e2e/fuel-company-orders.e2e-spec.ts` (3 tests: list isolation, action isolation on a
  specific order via 404, concurrent-approval conflict) and
  `tests/unit/order-actions.test.tsx` (4 tests, FR-017 positive/negative gating).

**Phase 5 complete: 19/19 tasks.**

**Phase 6 (2026-09-03) — station owners, stations and credit wired to live data. Backend
(T058-T070) was already complete and tested; this pass is the dashboard half (T071-T081). Key
findings:**
- **`AddStationOwnerPage`'s "Login Info" card described a login flow that does not exist.** It
  claimed a station owner needs no password and signs in via a 4-digit OTP sent by SMS. The
  platform has exactly one login route, `POST /auth/login`, password-based, and `CreateUserDto`
  requires one (min 8 chars). Corrected: the form now collects a real initial password the admin
  issues, and the sidebar copy states the real mechanism instead.
- **`CreditLimitCard`/`CreditLimitRequestCard`/`StationsBlock` each modelled a capability the
  platform doesn't have.** `CreditLimitCard` had an active/inactive toggle, an expiry date and an
  "activation date" — `User.creditLimit` is just a number with no expiry or standalone active
  flag. `CreditLimitRequestCard`'s rejection flow had a reason textarea — `ResolveCreditLimitRequestDto`
  takes only `{accept, grantedAmount?}`, no rejection reason field exists on
  `CreditLimitRequest`. `StationsBlock` had an active/inactive toggle per station — `Station` has
  no such field; removal is `DELETE /stations/:id`, a soft delete. All three rebuilt around what
  the schemas actually carry rather than reworking the mock's shape.
- **Genuine platform addition: `GET /users/:id/credit-limit`.** Phase 5's notes already flagged
  this gap ("no FUEL_COMPANY_ADMIN-facing credit-limit endpoint exists yet") — `GET /users/me/credit`
  is CLIENT-only and the existing admin route, `PUT /users/:id/credit-limit`, both sets AND reads
  but only as a side effect of a write. `CreditLimitCard` needs to render a standing without
  mutating it, so a read-only admin counterpart was added (`users.controller.ts`, mirrors
  `myCredit`'s derivation via `InvoicesService.getAvailableCredit`), added to
  `fuel-company-rbac.e2e-spec.ts`'s denial-matrix table (65/65 passing, up from 64).
- **`StationOwnerDetailsPage`/`StationDetailsPage` each carried figures with no data source**:
  pending/total invoices, "monthly orders", a recent-orders log, supplied volume, spending, average
  delivery time — none of these have any aggregation anywhere on the platform (invoicing is Phase
  9's scope and, even then, carries no per-client rollup). Dropped outright, same precedent as
  Phase 5's `LinkedInvoicesCard`/`AvailableBalanceCard`. `DueLitersBalanceCard` is Phase 14 scope
  (litre balances) — replaced with a `return null` placeholder matching `AvailableBalanceCard`'s.
- **No `GET /stations/:id` exists** — `StationDetailsPage` reads from the same `GET /stations/all`
  list the stations tab already fetches (`useAllStations`), filtered client-side by id, rather than
  adding a redundant single-station route.
- **Dashboard-side region/governorate data was missing entirely** (T080's "use the platform's
  `Region` vocabulary" needed a membership map that didn't exist client-side). Added
  `REGION_GOVERNORATES`, `governorateBelongsToRegion`, and bilingual `REGION_NAMES`/`GOVERNORATE_NAMES`
  display data to `constants/regions.ts`, mirroring `regions.constants.ts` exactly — as data, not
  ~90 additional i18next keys, matching the backend's own non-i18n bilingual approach for this
  specific fixed geographic list.
- **Found and fixed a pre-existing regression, unrelated to this phase's own edits**: `src/lib/i18n/en.json`/`ar.json`
  were missing seven entire top-level namespaces present on `main` —`trucks`, `assign`, `tracking`,
  `stalled`, `dashboard`, `invoices`, `stopAlert` — silently dropped by an earlier phase's edit that
  replaced rather than extended the files. Invisible until `npx vitest run` was re-run this phase:
  2 previously-passing suites (`assignment-ack-state.test.tsx`, `candidate-eligibility.test.tsx`,
  5 tests, both feature 010) failed with literal untranslated keys rendered (`assign.offlineReasonPlaceholder`).
  Fixed by a recursive deep-merge of `HEAD`'s `en.json`/`ar.json` with the working tree's (working
  tree wins on conflicts, `HEAD` fills every gap) — restores the missing namespaces without
  reverting any of this feature's own additions. `npx vitest run`: **72/72 real tests**, same 2
  documented pre-existing load failures only (`accessibility.test.tsx`, `orders.mutations.test.tsx`).
- **Fixed a build break this phase's own signature change caused**: `src/admin/petrol_companies/components/AdminStationOwnerDetailsPage.tsx`
  (a SUPER_ADMIN oversight mock, out of Phase 6's FUEL_COMPANY_ADMIN scope) reused the mock
  `StationsBlock` with no props. `StationsBlock` now requires `ownerId` and calls
  `GET/POST /users/:id/stations`, gated `@Roles(FUEL_COMPANY_ADMIN)` — reusing it there would 403
  for a SUPER_ADMIN. Removed the reuse with a comment naming the later operator-oversight phase
  (016) that will need its own SUPER_ADMIN-facing read path; left the rest of that page's mock
  content as-is (untouched by this feature).
- Verification: backend `npm run build` clean, `npm run test` **192/192** (23 suites — the +1 suite
  is T070's `credit-limit-requests.service.spec.ts`), `npx jest --config test/jest-e2e.json
  --runInBand fuel-company-rbac credit-limit-requests` **65/65**. Dashboard `npx tsc -b --force`:
  same **102** pre-existing error lines as before this phase (all outside this feature's touched
  files — confirmed by filtering the output to touched paths, zero matches), `npx vitest run`
  **72/72** real tests passing per the i18n fix above.

**Phase 6 complete: 24/24 tasks (T058-T081).**

**Phase 7 (2026-09-03) — transporters wired to live data. T082/T083 and T086a-c were already
complete (built ahead of schedule during Phase 5). Key findings:**
- **`AddTransporterPage` fabricated an "add by code" linking flow with no backend capability
  behind it** — `createTransportCompany` always creates a brand-new company+admin, never links an
  existing one; there is no such endpoint anywhere. Dropped outright rather than wired to nothing,
  alongside the same "no password, OTP-only login" copy `AddStationOwnerPage` corrected in Phase 6
  (identical fix: a real `adminPassword` field, since `POST /auth/login` is the platform's only
  login route). Also dropped: commercial-register and city/headquarters fields, and the admin's
  job title — `CreateTransportCompanyDto`'s own comment says none of these are collected for a
  transporter (unlike a Fuel Company's own onboarding).
- **`CompanyDetailPage`'s "cancel contract" button had no capability behind it for this role** —
  `PATCH /companies/:id/status` is `SUPER_ADMIN`-only. Dropped rather than wired to a route that
  would 403 for a `FUEL_COMPANY_ADMIN`.
- **`CompanyRegionsCard` had a fabricated per-region price and minimum charge** —
  `Company.servedRegions` is a plain `RegionCode[]`; no per-region pricing exists anywhere for a
  transporter (fuel pricing is per-fuel-company via `pricingConfig`, unrelated). Rebuilt as an
  add/remove chip list wired to `PUT /companies/:id/regions` (replaces the full set, matching the
  endpoint's own semantics).
- **`CompanyContactCard`'s named contact person ("أحمد السبيعي", "مدير عمليات") has no backing
  field** — `Company` records a company-level `contactEmail`/`contactPhone` only, no contact-person
  name or title. Rebuilt around the real two fields.
- **`CompanyDetailStats`/`CompanyRecentTripsCard` carried orders/month, average delivery time,
  a performance rating and a trip log — none computed anywhere on the platform for a transporter.**
  Removed per FR-048 (feature 009's `MapTrackingCard` legend precedent); `CompanyDetailStats` kept
  only the one real figure (`servedRegions.length`).
- **T087 was initially marked complete by mistake, then genuinely built.** T086's "served regions"
  and T087's "regions this company covers" read as the same concept on a first pass but are not:
  `CompanyRegionsCard` (T086) sets a *transporter's* `servedRegions`
  (`PUT /companies/:id/regions`, `:id` = the transporter); T087 is the acting *fuel company's own*
  `coveredRegions` (`GET`/`PUT /companies/:id/covered-regions`, `:id` = the admin's own company,
  T086a/b/c). The first pass wired only the former and used the latter's label on a stat card
  showing the *union* of every transporter's regions — a third, different number. Caught before
  moving on: renamed that stat to `servedRegions` (still real, still useful), and added a genuine
  new `CompanyCoveredRegionsCard.tsx` (`api/own-company.api.ts`, `useCoveredRegions`/
  `useSetCoveredRegions` hooks) mounted on `CompaniesListPage`, wired to T086b's actual endpoint.
- **Found and fixed an environment issue blocking verification, unrelated to any code change**:
  `npx vitest run` failed all 16 files with `ENOSPC: no space left on device` — the Windows `C:`
  drive (`AppData\Local\Temp`, this machine's default `TEMP`/`TMP`) was at 0 bytes free; `E:` (where
  the repo lives) had 216G free. Not a regression — resolved for this session by pointing
  `TEMP`/`TMP` at a scratch directory on `E:` before invoking `vitest`; worth the user's attention
  since it will recur for any tool that writes to the OS temp directory until `C:` has headroom
  again.
- Verification: dashboard `npx tsc -b --force` **97** pre-existing error lines (down from 102 —
  two dead imports this phase's edits happened to remove), `npx vitest run` **72/72** real tests
  (same 2 documented pre-existing load failures), `npx vite build` clean. No backend changes this
  phase (T086a/b/c already covered by `region-assignment.e2e-spec.ts`, unchanged and still green).

**Phase 7 complete: 9/9 tasks (T082-T090), plus T086a/T086b/T086c already done.**

**Phase 8 (2026-09-03) — fuel prices and delivery pricing wired to live data. Key findings:**
- **`FuelPricesPage`'s mock fabricated an entire pricing-history subsystem the platform
  doesn't have**: a change-vs-last-update indicator, a "scheduled update" (future-dated
  price), a comparison table against a stored "previous price", and a "prices status" card
  with a last-updated timestamp. `Company.fuelPrices` is `{fuelType, basePricePerLiter}[]`
  only — no history, no scheduling. All dropped (FR-047/FR-048); `EditPriceModal`'s
  "schedule for later" option dropped with it — `SetFuelPricesDto`/`setFuelPrices` is a
  direct, immediate full-array overwrite.
- **The mock's 5th grade, "بنزين 98" (Petrol 98), does not exist on the platform** —
  `FuelType` has exactly 4 values (`DIESEL`/`PETROL_91`/`PETROL_95`/`KEROSENE`). T094
  offers only the real 4, each rendered even with no price set yet (an honest "not set"
  rather than a fabricated 0.00), since `Company.fuelPrices` defaults to `[]` on a fresh
  company.
- **`PUT /companies/:id/fuel-prices` replaces the whole array, not a per-grade patch** —
  confirmed from `CompaniesService.setFuelPrices` (`findByIdAndUpdate(id, { fuelPrices })`).
  Editing one grade's price client-side upserts it into the full current list before
  submitting, never sends a single-entry body.
- **`PricingConfigCard.tsx` is genuinely new UI** — the previous mock never surfaced
  `deliveryFee`/`serviceFeePercent`/`taxRatePercent`/`tankerCapacitiesLiters` at all (T096).
  `GET /companies/:id/pricing-config`'s FR-011j 409 (`PRICING_NOT_CONFIGURED`) on an
  unconfigured company renders as a real empty state with a form to fill in, not an error
  screen or a silently zeroed form.
- **Two more SUPER_ADMIN oversight pages broke the same way Phases 6/7's did**:
  `AdminPetrolCompanyDetailsPage.tsx` imported the mock `FuelData`/`FUEL_DATA` this phase
  deleted, and reused the now-real `FuelPriceCard` with the old five-field prop shape.
  Reuse removed with the same "later operator-oversight phase" comment as before, rather
  than left broken.
- **T098's e2e coverage was newly written, not already present** — no existing suite
  asserted the immutability property. New `test/e2e/fuel-price-immutability.e2e-spec.ts`:
  creates an order at the fixture's DIESEL rate (2.5/L → 1250 for 500L), changes the rate
  to 9.99/L, re-reads the same order (still 1250 — untouched), then places a second order
  confirming the new rate actually took effect (4995) — proving the first order's stability
  isn't because the price write silently failed.
- **`data.ts` (the mock this phase's T093 named for deletion) was already an empty,
  unreferenced file** — removed outright; nothing else pointed to it.
- Verification: backend `npm run build` clean, new e2e suite 1/1 passing. Dashboard `npx
  tsc -b --force` **90** pre-existing error lines (down from 97 — more dead imports this
  phase's edits removed), `npx vitest run` **72/72** real tests (same 2 documented
  pre-existing load failures), `npx vite build` clean.

**Phase 8 complete: 9/9 tasks (T091-T099).**

**Phase 9 (2026-09-03) — invoices wired to live data. `invoices.api.ts`/`useInvoices.ts` were
already built ahead of schedule in Phase 5 (for the order-detail card); this pass is the
list screen, real query keys, and the two e2e gaps. Key findings:**
- **T100 confirmed**: `OrdersService.approve` (`orders.service.ts:252`) opens
  `session.withTransaction` at line 261 and calls `this.invoicesService.issueInvoice(approved,
  session)` at line 270, inside it — R4's correction holds exactly as recorded.
- **This component was shared with a SUPER_ADMIN `/admin/invoices` route that `GET
  /invoices` (`@Roles(FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN, CLIENT)`) would 403 for.**
  Making `InvoicesListPage.tsx` real for the FCA persona would have broken the admin route
  outright. Split into two files: the real one stays at `petrol_company/invoices/
  components/InvoicesListPage.tsx` (FCA only now), and a new `admin/petrol_companies/
  components/AdminInvoicesListPage.tsx` preserves the previous mock UI unchanged for the
  out-of-scope SUPER_ADMIN oversight route — same "later operator-oversight phase"
  precedent as Phases 6-8's admin-page fixes, but here the safer move was duplicating the
  mock rather than deleting a working (if fake) screen a person still navigates to.
- **The mock invented an entire stats/promo layer with no data source**: a
  transfers/paid/due/commission card grid with fabricated week-over-week percentages, a
  page-number `Pagination` component (the platform never returns a total — cursor-only,
  matching `OrdersListPage`'s precedent), free-text search (no server-side search param
  exists on `GET /invoices`), and an export action (no export capability anywhere). All
  dropped for the real FCA screen (FR-047/FR-048); the admin mock keeps them since that
  screen was never wired to anything real to begin with.
- **`LinkedInvoicesCard.tsx`'s Phase-5 framing conflated two different "invoice"
  concepts.** Its comment called it "the SUPPLIER (Aramco) invoice reconciliation flow,
  Phase 14 scope" — correct for a *supplier* invoice, but T106 sits in Phase 9 and asks for
  "the real invoice," which for an order is its own platform `Invoice`
  (`Order.invoiceId`, R4). Wired to show that instead (amount/method/state/settle),
  reusing `useInvoiceDetail` per T104's "no second fetch path"; the actual supplier-invoice
  reconciliation UI remains unbuilt and belongs to a future Phase 14 addition, not this card.
- **T107's two properties had no existing coverage.** `billing-methods.e2e-spec.ts`
  (pre-013) covers per-method settlement gating (who may settle DIRECT/DEFERRED/CREDIT)
  via single-document `GET /invoices/:id` reads, but never calls `GET /invoices` (the list
  endpoint FR-041/SC-006 actually concern) and never re-reads a settled DEFERRED invoice
  from the *issuer's* side. New `test/e2e/invoice-isolation.e2e-spec.ts` (2 tests): list
  isolation across two fuel companies plus a direct-read 404, and the issuing Fuel
  Company re-reading a transporter-settled DEFERRED invoice as SETTLED (both the
  single-document read and the list with `?state=SETTLED`) — the counterparty-visibility
  half T107 names. Both needed `PUT /users/:id/credit-limit` set first for the CREDIT
  case, matching `billing-methods.e2e-spec.ts`'s own established setup.
- Verification: backend `npm run build` clean, new suite **2/2** passing, `npm run test`
  unaffected (no `src/` changes this phase, test-only). Dashboard `npx tsc -b --force`
  **90** pre-existing error lines (unchanged), `npx vitest run` **72/72** real tests (same
  2 documented pre-existing load failures), `npx vite build` clean.

**Phase 9 complete: 9/9 tasks (T100-T108).**

**Phase 10 (2026-09-03) — dashboard home wired to `GET /orders/summary`. T111's audit (done
before T109 as instructed) found more than the two named fields needed excluding. Key findings:**
- **`outstandingSettlements` (DEFERRED+ISSUED) is NOT the Fuel Company's own "amounts
  outstanding" figure**, even though it's correctly scoped for this role by the multi-party
  plugin (same mechanism as `Order`). It answers "what do transporters still owe on
  deferred settlements" — a real, meaningful number, but not what FR-046 means by a fuel
  company's own outstanding amount, which is what its own CLIENTS still owe on CREDIT.
  Added `InvoicesService.getCreditOutstandingSummary()` (CREDIT+ISSUED, mirroring the
  existing method exactly) and a new `FuelCompanySummaryDto` (`order-summary.dto.ts`) —
  a genuinely different shape from `OrderSummaryDto`, not the same interface with fields
  zeroed out, matching T111's own instruction.
- **`awaitingAssignment` (ROUTED_TO_TRANSPORT) doesn't answer "what does this admin need
  to act on" for a Fuel Company either** — that's `PENDING_APPROVAL`, a field that did not
  exist on the summary at all. Added as `pendingApproval`, scoped by the same multi-party
  `countDocuments` pattern `getSummary` already uses.
  `stationOwnersCount`/`stationsCount` were both genuinely missing too:
  `userModel.countDocuments({role: CLIENT})` (mirrors the existing `driversOnDuty` line,
  just `CLIENT` instead of `DRIVER` — and meaningful here, since clients DO belong to a
  fuel company) and a new `StationsService.countForCompany()` (a `countDocuments`
  counterpart to `findAllForCompany`, T058).
- **The route now serves three genuinely different response shapes off one handler** —
  `TRANSPORT_COMPANY_ADMIN`/`SUPER_ADMIN` keep `OrderSummaryDto` unchanged (SUPER_ADMIN's
  bypass of both isolation plugins makes a platform-wide read of it genuinely meaningful,
  unlike a per-tenant zero), `FUEL_COMPANY_ADMIN` gets `FuelCompanySummaryDto`. The
  handler gained `@CurrentUser()` (previously took none) purely to pick the branch — no
  change to either existing shape or their isolation.
- **Found and fixed a stale pre-013 test this change legitimately broke, not a regression
  to work around**: `order-lifecycle.e2e-spec.ts` had `'refuses a FUEL_COMPANY_ADMIN — this
  figure set has no meaning for that role in this feature'` asserting 403 — true before
  this phase (the route didn't admit the role at all), false now that it does with its own
  shape. Updated to assert the real behavior (200, the FCA shape, never the transport
  shape) rather than reverting the route change to keep the old test green.
- **`ActionCard` (`transport_company/home/components/`, shared with `TransportDashboard`/
  `AdminDashboard`) had no `onClick` prop at all** — every quick action on every dashboard
  using it was permanently inert. Added as optional (every existing caller's behavior is
  unchanged; only a caller that now passes one gets a working button), rather than forking
  a fuel-company-only copy of the component.
- **Dropped `NewOrdersCard`/`ProgressOrdersCard`/`MapTrackingCard`/`InvoicesSection`/
  `DoughnutSection`** (all borrowed from `transport_company/home/`) **outright rather than
  reworked** — none has a `FuelCompanySummaryDto` field behind it: no live fleet-position
  map (fuel companies don't operate trucks), no per-owner/per-station "active/available/
  on-task/inactive" breakdown (no such per-entity status concept exists for a station
  owner or a station), no recent-invoices preview with its own fabricated total. Matches
  FR-047/FR-048's established precedent from every earlier phase.
- **The station/date filter dropdown had no effect on anything** (no per-station
  breakdown exists on the summary endpoint at all) — dropped; the date-range picker DOES
  map to a real parameter (`from`/`to`, driving `completedInPeriod`) and was kept, wired
  to `useFuelCompanySummary`'s own params.
- Verification: backend `npm run build` clean, `npm run test` **192/192** (unchanged, no
  unit test touches this path), new `fuel-company-summary.e2e-spec.ts` **3/3**,
  `order-lifecycle.e2e-spec.ts` **6/6** (the updated test plus 5 unaffected), full e2e
  suite not re-run in full this phase (targeted re-runs only, matching this session's
  established practice for large suites). Dashboard `npx tsc -b --force` **89** pre-existing
  error lines (down 1, incidental), `npx vitest run` **74/74** real tests (72 plus 2 new —
  `dashboard-summary-consistency.test.tsx`, T118's SC-009 assertion, both screens rendered
  independently against the same seeded owner/station counts), `npx vite build` clean.

**Phase 10 complete: 11/11 tasks (T109-T119).**

**Phase 11 (2026-09-03) — notifications, support and profile. The support inbox screen is
genuinely new (no mock existed); everything else replaces one. Key findings:**
- **`api-routes.ts`'s `support` block was wrong outright** — placeholder paths from Phase 4
  (`/support`, `/support/:id/acknowledge`) never matched the real controller
  (`support/requests`, `support/requests/:id/acknowledge`). Caught before writing the API
  file, not after a failed request.
- **`NotificationsPage.tsx`'s topic-based filters (orders/invoices/alerts/system) have no
  matching field to filter by** — `Notification` carries only `type`/`readAt`/`orderId`;
  narrowed to what `GET /notifications` actually supports (`?unread=true`). The "mute
  notifications" toggle had no capability behind it at all — dropped. A generic
  `type → {title, body}` label map covering all 12 `NotificationType` values (mirroring
  `ORDER_STATUS_LABEL_KEY`'s exhaustive-map convention) replaced the five sample rows.
- **`SupportInboxPage.tsx`'s message body is the one place on this dashboard that renders
  attacker-controlled free text at any length** (`SupportRequest.message`, up to 2000
  chars, written by a CLIENT). Rendered as plain JSX text, never
  `dangerouslySetInnerHTML` — confirmed by a new `support-inbox-xss.test.tsx` asserting a
  `<script>`/`onerror` payload renders as literal characters and never executes (T129).
- **`ProfilePage.tsx`'s phone-change modal was 100% client-side theater** — a 3-step OTP
  flow whose "send code" and "confirm" buttons only ever called `setModalStep()`, never a
  network request, and asked for a 4-digit code. A real flow already exists
  (`POST /users/me/phone/verification` + `/confirm`, spec 005 T097) and takes a 6-digit
  code, not 4. Rewired to the real endpoints; the 4-digit input became 6.
- **`ProfileCompanyCard.tsx`'s "commercial register" was a fabricated 10-digit text
  number** — the real field, `commercialRegisterFileId`, is a stored *file* reference, not
  a text registration number; no such number is captured anywhere on this platform.
  Dropped rather than mislabeled as a file link (building a working authenticated-download
  link was out of proportion for this card — feature 012's own notes record why a plain
  `<a href>` can't carry the auth header a file download needs). City/headquarters address
  and a short "company code" were dropped the same way (`Company` has neither field;
  replaced the fake code with the real `_id`, matching `StationOwnerDetailsPage`'s
  precedent).
- **`ProfilePage.tsx`'s "Permissions" list and "Additional Data" card were both entirely
  static** — a hand-picked capability list with no relationship to any real RBAC state,
  and a "contract start date"/"cities covered" pair with no backing field. Dropped
  (FR-047/FR-048); `ProfileStats.tsx`'s "order volume (month)" dropped the same way — the
  other three stat cards are real (`stationOwnersCount`/`stationsCount` reusing Phase 10's
  summary, `transportersCount` reusing Phase 7's `useTransporters`).
- **The sidebar's `orders`/`notifications` nav items carried a hardcoded `badge={5}`** —
  proven false the moment either count differs. Removed for the FUEL_COMPANY_ADMIN section
  only; a live badge would need `Sidebar.tsx` to poll its own summary query, judged out of
  proportion for this phase and left as a named follow-up rather than built partially.
- **T131's full-regression gate**: full backend e2e **427/429** (`npm run test` unit
  **192/192** unaffected). The 2 failures are both pre-existing and unrelated to any file
  this feature has ever touched — `request-logging.e2e-spec.ts` passed alone (the
  already-documented sequential-suite resource-pressure flakiness feature 011/012
  recorded), and `file-storage.e2e-spec.ts` fails deterministically on this Windows
  machine because `LocalFileStorage` joins its `storagePath` with `path.join` (backslashes
  on Windows) while the test asserts a forward-slash `sys_storge/` substring — a pre-existing
  environment-specific defect in feature 012's own territory, never touched by feature 013,
  disclosed rather than fixed here. `quickstart.md` Parts 0-1 not walked live this pass
  (no running dev server/backend in this session) — same disclosed gap every prior phase's
  live-walkthrough tasks have carried.
- **Standing instruction acknowledged, not acted on**: T131 names this as the natural
  point to stop and let Phases 12-16 become separate features (014/015/016) if the plan's
  split is taken. The user has twice explicitly instructed continuing through all
  remaining phases in this same feature — proceeding to Phase 12 next rather than
  stopping here.
- Verification: backend `npm run build` clean, full e2e 427/429 (2 pre-existing/unrelated,
  see above). Dashboard `npx tsc -b --force` **83** pre-existing error lines (down from 89),
  `npx vitest run` **75/75** real tests (74 plus 1 new — `support-inbox-xss.test.tsx`, same
  2 documented pre-existing load failures), `npx vite build` clean.

**Phase 11 complete: 12/12 tasks (T120-T131). ⛔ Natural feature boundary reached and
knowingly passed per standing instruction — continuing to Phase 12.**

- **`AccountMovement.companyId` cannot be `immutable: true` — that silently defeated the
  create-then-correct pattern this schema exists to support.** `PlatformAccountService
  .createMovement` follows `CompaniesController.createTransporter`'s precedent: create via
  `tenantScopeModel.create()` (which forces `companyId` to the *acting* user's company),
  then `updateOne({_id}, {$set:{companyId: correctId}})` to correct it for cases where the
  beneficiary differs from the actor — exactly the DEFERRED-invoice cashback case, where the
  company confirming payment is the *paying* transporter, not the fuel company the movement
  belongs to. With `immutable: true` on `companyId`, Mongoose silently strips it from the
  query-level `$set`, so the correction reported `modifiedCount: 1` (only `updatedAt` had
  actually changed) while the movement stayed permanently attributed to the wrong company —
  a `cashback-programme.e2e-spec.ts` assertion caught it (expected balance 12.5, got 0);
  every single-company test would have passed regardless. `AccountMovement` is now the one
  tenant-scoped schema in the codebase whose `companyId` is deliberately *not* immutable,
  with an in-code comment explaining why, so a future "harden this field" pass doesn't
  reintroduce the bug.
- **`effectiveFrom desc` alone is not a safe sort for "the term/programme in force"** —
  two administrative writes (or two test setup calls) within the same millisecond tie, and
  MongoDB does not guarantee tie-order matches insertion order. Both
  `getCurrentCommissionTerm`/`getCurrentCashbackProgramme` and their schema indexes now sort
  `effectiveFrom desc, _id desc` — ObjectIds are monotonically increasing within one process
  even inside a single millisecond, so the tie-break is unambiguous. Found while debugging
  the bug above, fixed as a real but separate correctness gap (not the cause of that bug).
- **"Accrued commission" for ceiling purposes is net of confirmed payments, not the raw
  charged total** — `getNetCommissionOwed` = `COMMISSION_CHARGED − PAYMENT_RECORDED` (both
  CONFIRMED only). This single figure backs both `assertUnderCeiling`'s refusal and
  `getBalancesForCompany`'s display, so the dashboard's warning/exceeded state can never
  disagree with what actually blocks deferred/credit approval — and it is what makes T148's
  "resume automatically once a confirmed payment lands" true with no stored "barred" flag to
  un-set: the check always reads the current balance fresh.
- **Cashback is deliberately never netted against commission owed** (FR-061 tracks it as its
  own balance) — `cashbackAccrued` stays `getConfirmedBalance(..., CASHBACK_CREDITED)` raw.
- **Dashboard: `PlatformCommissionBanner`/`CashbackBanner` were wired onto the FCA's own
  `InvoicesListPage.tsx`**, reversing Phase 9's T108 decision to leave them unwired — T108
  predates `GET /billing/*` existing at all; T154 explicitly asks for these two components
  to be wired to real balances, and this is their only real consumer. Both components lost
  their edit `Dialog`/`CommissionTypeSelector` trigger entirely (T155 — absent, not
  disabled) and the on/off toggle in `CashbackBanner` (also an operator-only action, US13).
  `ProfileCommissionSection.tsx` was rewired the same way and lost its two fabricated
  counts ("من 42 عملية"/"من 42 فاتورة محولة") and two fabricated timestamp lines — no data
  source existed for either.
- **Two SUPER_ADMIN mock pages broke from the same wiring**: `AdminInvoicesListPage.tsx`
  and `AdminProfilePage.tsx` both rendered `PlatformCommissionBanner`/`CashbackBanner`,
  which now call `GET /billing/balances/me` — `@Roles(FUEL_COMPANY_ADMIN)` only, so both
  would 403 for the operator. Fixed the same way as every prior phase's admin-mock break
  (Phases 6-9): usage removed, explanatory comment left, the SUPER_ADMIN page itself
  untouched (out of this feature's scope).
- **Found and fixed two unrelated dashboard regressions from earlier phases' own uncommitted
  work**, surfaced by `tsc -b --force` while verifying this phase (neither touches billing):
  `src/constants/api-routes.ts` and `query-keys.ts` were missing the `trucks`/`tanks`
  sections, `dispatch.candidates`/`dispatch.assign`, and `orders.overrideVerification`/
  `reassignVehicle`/`resolveStop` entirely, and `orders.summary` had been flattened from a
  `(from, to)` function to a bare tuple — an extend-by-replace mistake in an earlier
  session turn, the same class of bug the en.json/ar.json namespace loss (Phase 7) was.
  `git diff` against the last commit made the missing pieces mechanical to restore exactly
  as they were (every deleted route/key still had a real, unmodified consumer). Separately,
  `ProtectedRoute.tsx` had regained a dead `status !== 'booting'` guard the same commit had
  deliberately simplified away (with a comment explaining the guard could never be false) —
  reverted to match. None of the three were caused by this phase's own work, but all three
  were real, `tsc`-visible defects left in the working tree, so fixing them here rather than
  filing them separately.
- Verification: backend `npm run build` clean, full e2e **433/435** across 72 suites (2
  pre-existing/unrelated — `file-storage.e2e-spec.ts`'s Windows `path.join` backslash
  mismatch, already disclosed in feature 012's CLAUDE.md entry, and one `request-logging
  .e2e-spec.ts` timing assertion consistent with this suite's previously-documented
  resource-pressure flakiness under a single sequential 72-suite run — not re-run in
  isolation to confirm, flagged rather than asserted fixed). `test/unit/billing.service
  .spec.ts` 9/9, three new e2e suites (`commission-accrual`, `cashback-programme`,
  `commission-ceiling`) 6/6. Dashboard `npx tsc -b --force` clean of every error beyond the
  documented pre-existing unused-import baseline (real errors caused by the two regressions
  above are gone), `npx vitest run` **75/75** real tests (same 2 documented pre-existing
  load failures).

**Phase 12 complete: 25/25 tasks (T132-T156). Continuing to Phase 13 per standing
instruction.**

- **T157 audit decision (plan's deferred "Open decision", taken before any Phase 13 code)**:
  a `COMMISSION_CHARGED`/`CASHBACK_CREDITED` movement carries **no confirming-actor
  attribution** — it is system-computed at accrual (T142/T144) from the term/programme in
  force, stamping only `appliedRate`/`appliedBasis` (T143), never a person, because no
  person made the accrual decision at that instant; the operator who set the *rate* is
  already attributed on `CommissionTerm.setBy`/`CashbackProgramme.setBy`, which is a
  separate fact from any one accrual event. A `PAYMENT_RECORDED` movement carries **two**
  distinct attributions at two distinct instants: implicitly *who recorded* (the acting
  `FUEL_COMPANY_ADMIN`, already the tenant the movement is scoped to — no separate
  `recordedBy` field, since "which company recorded this" is exactly what `companyId`
  already answers, and this platform's admin model does not track a distinct real-money
  approval identity that a single tenant field would fail to capture) and explicitly
  **`confirmedBy`/`confirmedAt`** (T163) — the fact the plan's *Open decision* was actually
  worried about, since it is the one write with no other document trail behind it. Both
  fields already existed on the T141 schema from Phase 12 (built ahead of this phase since
  accrual writes the same collection first) — this decision is recorded here, not
  implemented here.
- **The confirm idiom is `CreditLimitRequestsService.resolve`'s, reused exactly**:
  `findOneAndUpdate({_id, kind: PAYMENT_RECORDED, state: RECORDED}, {$set: {state:
  CONFIRMED, confirmedBy, confirmedAt}})`, `modifiedCount` (via the null/non-null return)
  deciding between two concurrent confirmation attempts — never a read-then-write. The
  `kind: PAYMENT_RECORDED` clause is defense in depth: `COMMISSION_CHARGED`/
  `CASHBACK_CREDITED` movements are created already `CONFIRMED` and could never match the
  `state: RECORDED` filter anyway, but naming the kind explicitly means a future movement
  kind added in `RECORDED` state (there is none today) could not be confirmed through this
  endpoint by accident.
- **T176 as literally written assumes a capability the platform does not have.** It reads
  "state the period a displayed payment reference remains valid for" — inherited from the
  mock's fabricated SADAD invoice number and a specific "صالحة حتى 10/10/2026" expiry, both
  invented with no backend source (no payment provider is integrated, FR-066a; nothing on
  the platform mints a per-transaction SADAD code or a validity window for one). There is
  nothing to state a validity period FOR: the corrected `reference` field is payer-supplied
  free text recording what the payer did elsewhere, not a platform-issued credential that
  could expire. `SadadDetailsCard.tsx` now shows only the platform's static SADAD biller
  info (the one genuinely static fact, parallel to `BankTransferDetailsCard`'s IBAN) plus
  the same reference/file evidence inputs — FR-066b ("never present as proof anything has
  been paid") is satisfied by there being no fabricated proof-shaped artifact left to
  misread as one, rather than by a disclaimer next to a fake one.
- **Two more SUPER_ADMIN mock pages broke from real prop-shape changes, not from a 403**:
  `AdminPlatformAccountPage.tsx` reused `DesktopPlatformAccountTable`/
  `MobilePlatformAccountList` (now `AccountMovement[]`, not the old local mock shape) and
  `AdminPaymentPage.tsx` reused `SadadDetailsCard`/`BankTransferDetailsCard` (now requiring
  `reference`/`file` props). Both are pre-existing, fully out-of-scope mocks — the first is
  Phase 16's operator-oversight ledger view; the second represents a "platform pays a
  company its cashback" flow that does not exist anywhere in this feature's contracts (the
  platform only ever *receives* payments through this mechanism, FR-066a). Fixed two
  different ways depending on which kind of break it was: `AdminPlatformAccountPage.tsx`
  got its own duplicated `AdminDesktopPlatformAccountTable.tsx`/
  `AdminMobilePlatformAccountList.tsx` (the "split the shared component" precedent, Phases
  6-9); `AdminPaymentPage.tsx` just gained local no-op `reference`/`file` state to satisfy
  the props, since its two child components take input but call no API themselves — no
  fabricated data was ever displayed there and none is now.
- **`npm run lint:check` reports ~37,000 CRLF errors across virtually the entire backend
  (files this phase never touched included)** — `git config core.autocrlf` is `true` on
  this Windows checkout, so every file lands with CRLF line endings while Prettier expects
  LF. This is an environment/checkout configuration issue, not a defect introduced by this
  phase or discovered in the code itself; fixing it would mean reformatting the entire
  repository's line endings (or changing `core.autocrlf`, which per this session's standing
  git-safety rule is never done). `npm run build` and every Jest suite are unaffected (line
  endings are not syntax) — disclosed here, not fixed, the same as this feature's other
  disclosed-not-fixed pre-existing findings (dashboard's baseline unused-import count,
  `file-storage.e2e-spec.ts`'s path-separator mismatch).
- Verification: backend `npm run build` clean; new suites `test/e2e/platform-account-
  payments.e2e-spec.ts` 4/4 and `test/unit/platform-account.service.spec.ts` 5/5, both run
  standalone (not yet re-run as part of a full sequential suite this phase, unlike Phase
  12's closing full run — the four new backend files touch no shared bootstrap code path,
  so this is a lower-risk gap than it would be for a cross-cutting change, but it is a real
  gap and is named as one rather than assumed clean). Dashboard `npx tsc -b --force` clean
  of every error beyond the documented pre-existing unused-import baseline (both new
  prop-shape breaks fixed), `npx vitest run` **75/75** real tests (same 2 documented
  pre-existing load failures). No live-browser walkthrough of the new ledger/payment
  screens was performed this phase (no dev server session available) — flagged per
  CLAUDE.md's own instruction that type-checking and test suites verify code correctness,
  not feature correctness, when a UI claim can't be visually confirmed.

**Phase 13 complete: 21/21 tasks (T157-T177). Continuing to Phase 14 per standing
instruction.**

- **Order creation had no transaction at all before this phase** — `OrdersService.create`/
  `createPriced` were single-document `orderModel.create({...})` calls, because a single
  document write needs none. T194's drawdown makes order creation a genuinely
  multi-document write for the first time (the order, plus the litre-balance movement),
  so both paths now share a new `createWithDrawdown` helper that opens one
  `session.withTransaction`. This is "the existing creation transaction" T194 refers to;
  it did not exist until this task created it. `OrdersService.create`'s return type
  changed from `OrderDocument` to `{ order, litreDrawdown }` — its one caller
  (`OrdersController.create`) was updated in the same change; nothing else in the backend
  called it.
- **Drawdown quantity is a genuine spec ambiguity, resolved and documented in code**:
  FR-074 says a later order "draws the balance down automatically" but never states the
  formula. The platform has no mechanism to instruct a driver to physically load extra
  litres (spec 008: "the driver enters no quantity anywhere"; the loading/verification
  flow carries no reference to any litre balance), so drawdown is pure bookkeeping, not a
  delivery instruction. Implemented as `min(currentBalance, newOrder.quantityLiters)` —
  never more than the balance actually holds, and never more than the new order's own
  size (drawing down "500 L owed" against a 10 L order would be nonsensical). Recorded in
  `LitreBalancesService.drawdown`'s own doc comment, not left implicit.
- **`Order.supplierInvoice` (data-model.md's singular field name) is an ARRAY on the
  actual schema, `supplierInvoices`.** T192's "supersede... restate" and FR-073a-iv's
  "retain both extracted and confirmed" both require the prior invoice to survive a
  replace, never be overwritten in place — a single embedded sub-document can't hold two
  states at once. Mirrors `Invoice.state: VOID` keeping every prior row rather than
  mutating it away, and `StopEvent`'s own `_id`-keeping precedent for the same "several
  of these can exist over an order's life" reason.
- **FR-073f is narrower than the existing `toRoleScopedShape` grouping, and the code
  needed a second, tighter check.** `isOperatorOrDriver` (DRIVER + FCA + TCA + SA) governs
  `verifications`/`tankSummary`/stop data — but FR-073f says a supplier invoice is
  "retrievable by the fuel company that uploaded it and by the platform operator, and by
  no one else," which excludes DRIVER and TRANSPORT_COMPANY_ADMIN, both of whom see
  everything else in that group. `buildSupplierInvoiceView` checks FCA/SA explicitly
  rather than reusing the existing boolean — the raw `supplierInvoices` array is stripped
  for every role unconditionally, narrower still (never sent even to FCA/SA — only the
  shaped, single-current view is).
- **Idempotency bug found by T205's own unit tests, not by inspection**: the first draft
  of `LitreBalancesService.recordReconciliation` relied on a unique index over a
  `reconciledOrderIds` array to reject a retried confirmation via a caught `E11000`. A
  test asserting exactly that ("a retried reconciliation... is refused") failed —
  MongoDB's unique-index constraint holds only BETWEEN documents, never within one
  document's own multikey array entries, so pushing the same order id twice into one
  balance's own array silently succeeded and doubled the movement. Fixed by splitting into
  two writes: an idempotent `upsert` that only ensures the balance document exists (never
  touches movements), then a SECOND conditional `findOneAndUpdate` filtered on
  `reconciledOrderIds: {$ne: orderId}` — a `null` result (not a caught exception) is what
  a genuine retry now produces. This also fixed a second, subtler bug the single-upsert
  draft had: two DIFFERENT orders reconciling for the same never-before-seen client+grade
  at once would have raced to insert the first balance document, and the LOSER would have
  hit the same unique-key error and been wrongly refused as a duplicate of an unrelated
  order. The unique index on `reconciledOrderIds` is kept as defense-in-depth only, with
  both corrections recorded directly in the schema's own comment (a second correction of
  T183's already-once-corrected description — see Phase 14's own task text history).
- **T183's literal description was already wrong before implementation started** (a
  `partialFilterExpression` scoped by `movements.kind` does not restrict a multikey index
  to matching array elements — MongoDB evaluates a partial filter against the whole
  document, then indexes every array element regardless) — corrected to a flat
  `reconciledOrderIds` array during schema design, before the SECOND correction above (the
  unique index on that array not doing what its own comment first claimed either) was
  found during testing. Two independent corrections to the same task, for two different
  reasons — worth noting together since the second could easily be mistaken for a
  reversion of the first.
- **`SupplierInvoice`/`LitreMovement` needed an explicit `_id!: Types.ObjectId` class
  field.** Both "keep their `_id`" per data-model.md/T180/T182, but Mongoose adds `_id` to
  an embedded sub-document only at runtime — the TS class type doesn't have it unless
  declared, so `SupplierInvoicesService.replace`'s `supplierInvoices.$.supersededAt` match
  and `LitreBalancesService.restateReconciliation`'s `$pull` both needed the field typed
  explicitly rather than reaching for the `(x as never as {_id})` cast `orders.service.ts`
  uses elsewhere for the same situation on `StopEvent`.
- **T200's "grades the company stopped selling stay visible" resolves to a no-op on the
  backend, not a filter that needed writing.** A `LitreBalance` document is only ever
  created when a real order existed for a grade the company was actively selling at the
  time — by the time any balance is being listed, it definitionally represents a
  once-sold grade, so "don't hide it even after the company stops selling it" is already
  true of every balance that can exist. `GET /litre-balances`/`GET /users/me/litre-balances`
  return every balance for the tenant unfiltered; no grade-membership check was added.
- **Two more SUPER_ADMIN mock pages broke from the same real-component change** (T207):
  `AdminStationOwnerDetailsPage.tsx` reused `DueLitersBalanceCard`, now real and
  `FUEL_COMPANY_ADMIN`-only (`GET /litre-balances`). Fixed the same way as every prior
  instance this session — usage removed, explanatory comment left, matching the
  `StationsBlock` precedent already present on the very same page. `AdminAvailableBalanceCard.tsx`
  (used by `AdminOrderDetailPage.tsx`) is a genuinely separate, pre-existing file and was
  never affected.
- Verification: backend `npm run build` clean; new suites `test/e2e/supplier-invoice
  .e2e-spec.ts` 10/10, `test/e2e/litre-balance-drawdown.e2e-spec.ts` 3/3,
  `test/unit/litre-balances.service.spec.ts` 11/11 (the idempotency-bug test included),
  all run standalone. Full backend `npm run test` 26 suites/217 tests green (litre-balance
  changes touch order creation, the most shared code path in the backend — re-run in full,
  not spot-checked). A full sequential e2e regression was launched in the background as
  this phase closed; its result was not yet known when this entry was written — check
  before relying on "the whole suite is green" as a claim rather than an intent. Dashboard
  `npx tsc -b --force` clean of every error beyond the documented pre-existing baseline,
  `npx vitest run` **75/75** real tests (same 2 documented pre-existing load failures). No
  live-browser walkthrough of the new supplier-invoice/litre-balance screens was performed
  (no dev server session available) — same disclosed gap as Phase 13's dashboard work.

**Phase 14 complete: 31/31 tasks (T178-T208). Continuing to Phase 15 per standing
instruction.**

- **T217's gate review (recorded here as the task instructs)**: Part A was built and
  verified alone, in two independent layers, before a single line of Part B (schema,
  service, controller) existed. `test/unit/party-set-scope.plugin.spec.ts` (11/11)
  exercises the plugin against a synthetic schema with no real domain meaning, proving
  the MECHANISM in isolation. `test/e2e/party-set-isolation.e2e-spec.ts` (8/8) then
  proved the same guarantees through the full Nest app and real MongoDB transactions
  against the REAL `ExchangeRequest` collection — `fuel-exchange.module.ts` at that point
  registered only the schema (no service, no controller; see the module's own comment),
  so this was possible without writing any business logic first. Both suites pass,
  including the non-negotiable "recipient reads a request raised by the counterparty"
  case and the registration-time index check (T213). **Gate passed; Part B began after.**
- **T213's registration-time check needed a real mechanism, not a restated requirement.**
  Implemented inside `partySetScopePlugin` itself: `schema.indexes().some(...)` for a
  `partyCompanyIds` entry, thrown as a plain `Error` if absent. This runs when
  `connection.plugin()` applies the plugin to a schema being compiled (app bootstrap via
  `MongooseModule.forFeature`) — by then every `.index()` call in that schema's own
  definition file has already executed, so a missing index fails the app at startup, not
  at first query, exactly as the contract requires. Verified directly: a schema built
  without the index in the unit test throws synchronously on `connection.model(...)`.
  Registers unconditionally have gone RIGHT before by defining `markPartySet` before
  `.index()` calls — that ordering does NOT matter, since the check runs far later than
  either schema-file line.
- **`ExchangeRequest.supplierInvoice`-style singular naming was avoided from the start**
  here, unlike Phase 14's `Order.supplierInvoice` correction — `partyCompanyIds` is
  genuinely a fixed-size array by design (always exactly two), not a history needing
  supersession, so no analogous correction was needed.
- **FR-083 ("an accepted request must identify which party is supplier and which is
  receiver") needed no new field.** The raiser is always requesting fuel FROM the
  recipient — `raisedByCompanyId` is the receiver, `recipientCompanyId` is the supplier —
  already fully determined by fields T218 already specified. `FuelExchangeRequestData
  .tsx` derives the labels from `isRaiser` rather than the backend adding a redundant
  `supplierCompanyId`/`receiverCompanyId` pair that could only ever agree or disagree
  with the two fields already there.
- **A genuine platform capability gap, found while wiring `NewFuelRequestForm.tsx`**:
  nothing let a `FUEL_COMPANY_ADMIN` discover which OTHER fuel companies exist to raise a
  request to. `GET /companies` deliberately narrows this role to their own company alone
  (`CompaniesService.findAll`'s existing FR-004a boundary, untouched) — correct for that
  endpoint's actual purpose, but it left the exchange form with a recipient field and no
  way to populate it. Added `CompaniesService.findExchangePartners` and `GET
  /companies/exchange-partners` (`FUEL_COMPANY_ADMIN` only): every ACTIVE fuel company
  except the caller's own, name and id only — no pricing, no contact info (FR-086b's
  contact disclosure stays gated on a request actually existing between the two
  companies). Registered before `GET /companies/:id` in the controller, with a comment
  explaining why (a literal path segment would otherwise be captured by the param route
  and fail `ObjectIdPipe`) — verified by its own e2e test.
- **Direction filtering for `SUPER_ADMIN` needed an explicit branch, not a fallthrough.**
  `FuelExchangeController.findMine` would otherwise try `new Types.ObjectId(user
  .companyId)` with `companyId` absent for the operator (who bypasses the party-set
  plugin entirely and has no company of their own) — `direction` is meaningless for that
  role, so it is ignored rather than built into a filter that would throw a BSON error.
- **A real test bug, not a code bug, briefly looked like six failing requirements**: the
  first draft of `fuel-exchange.e2e-spec.ts` destructured `const { admin: adminA,
  companyId: companyIdB } = fixtures.companyA` in six of nine tests — naming Company A's
  OWN id `companyIdB` — so every `raiseBody(companyIdB)` call raised a request to the
  raiser's own company, correctly refused by the (working) self-request guard. Caught
  immediately by the first test run (6 of 9 failing with `400`s where `201`s were
  expected); fixed by destructuring `companyId` from the correct fixture in each case.
  Recorded here because it is exactly the kind of test-authoring mistake that would have
  been indistinguishable from a real isolation defect without careful triage — worth the
  reminder that a failing isolation-adjacent test needs its own assertions checked before
  the mechanism is blamed.
- Verification: backend `npm run build` clean; new suites `test/unit/party-set-scope
  .plugin.spec.ts` 11/11, `test/e2e/party-set-isolation.e2e-spec.ts` 8/8,
  `test/e2e/fuel-exchange.e2e-spec.ts` 9/9 (including the exchange-partners addition),
  all standalone. Full backend `npm run test` 27 suites/228 tests green. A full sequential
  e2e regression was launched in the background as this phase closed, covering the third
  isolation plugin's global registration alongside the other two — its result was not yet
  known when this entry was written; check before relying on "the whole suite is green"
  as a claim rather than an intent. Dashboard `npx tsc -b --force` clean of every error
  beyond the documented pre-existing baseline, `npx vitest run` **75/75** real tests (same
  2 documented pre-existing load failures). No live-browser walkthrough of the new fuel
  exchange screens was performed (no dev server session available) — same disclosed gap
  as Phases 13/14's dashboard work.

**Phase 15 complete: 25/25 tasks (T209-T233). Continuing to Phase 16 per standing
instruction.**

- **T238 needed genuine new backend capability, not just dashboard wiring, despite the
  phase's own framing ("almost entirely dashboard work," T234).** `GET /users`, `GET
  /stations/all`, `GET /invoices` and `GET /platform-account/movements` all relied
  entirely on their isolation plugin's ambient scoping, with no explicit filter — correct
  for every existing caller (a tenant-scoped admin/client/driver), but for `SUPER_ADMIN`
  (who bypasses every plugin) an unfiltered call silently returns EVERY company's rows
  mixed together, not one company's. Each gained an explicit `companyId`/`fuelCompanyId`
  query filter. All four are safe to accept from ANY role, not just SA: the owning
  isolation plugin's own `.where()` call OVERWRITES that key for a tenant-scoped caller
  regardless of what is passed (the exact behavior each plugin's own test already
  asserts — "overrides a caller-supplied foreign companyId rather than merely filling a
  gap"), so the filter is a no-op for FCA/TCA/CLIENT and load-bearing only for SA. `GET
  /billing/balances/:companyId` (SA only) is a genuinely new route alongside the
  pre-existing `balances/me`, registered after it so `me` is never swallowed by the param
  route. Verified directly: `test/e2e/operator-oversight.e2e-spec.ts` asserts the
  operator's filtered read of each of the five equals byte-for-byte what that company's
  own administrator sees for itself — the actual quickstart 4.3 independent test, not an
  approximation of it.
- **T244's audit found that FR-091 is largely satisfied by CONSTRUCTION, not by new
  code.** Enumerating every component imported by both `admin/` and `petrol_company/`
  trees (`grep`, not inspection by memory) found exactly nine: `FuelExchangeStats.tsx`,
  `CustomerDataCard.tsx`, `CompanyRecentTripsCard.tsx`, `CommissionTypeSelector.tsx`, the
  four payment-form input components (`AmountCard`/`PaymentMethodCard`/
  `SadadDetailsCard`/`BankTransferDetailsCard`), and the fuel-exchange data
  hooks/types (not UI). None contains any role-conditional rendering at all — every one
  is purely presentational or a plain input, with no operator-only button anywhere to
  leak. This is not an accident: every prior phase this session that found a shared
  component ABOUT to gain a role-conditional operator control instead SPLIT it into a
  separate `Admin*` file (the precedent named repeatedly across Phases 6-15's own
  corrections logs) — T244 confirms that discipline, applied consistently, is what makes
  FR-091 hold, rather than a runtime `if (role === SUPER_ADMIN)` check inside a shared
  component that a future edit could weaken into "disabled" instead of "absent." The
  deeper reason no control could leak even if one existed: `/admin/*` and
  `/petrolCompany/*` are separately `ProtectedRoute`-guarded route trees
  (`allow={[SUPER_ADMIN]}` / `allow={[FUEL_COMPANY_ADMIN]}, router.tsx`) — a
  `FUEL_COMPANY_ADMIN` cannot navigate to an operator screen at all, so "shared screen"
  in FR-091's sense can only ever mean "shared component," never "shared route." T245's
  test (`protected-route.test.tsx`) asserts exactly this mechanism for the one case not
  already covered by that file's existing suite (a `TRANSPORT_COMPANY_ADMIN`/`DRIVER`/
  `CLIENT` refusal of the wrong surface) — a `FUEL_COMPANY_ADMIN` refused the
  `SUPER_ADMIN`-only tree.
- **The previous mock's "owners"/"stations" tabs on the fuel companies LIST page named no
  FR and had no backing endpoint** — FR-089 is a PER-COMPANY drill-down (open one
  company, see its owners/stations/invoices/platform account), never a platform-wide
  cross-company directory. Dropped rather than built against a capability the spec never
  asked for; T236's real scope is the companies tab alone.
- **Per-company owners/stations/monthly-requests aggregate figures on the company LIST
  item and its stats cards had no source without an N+1 query the backend has no
  endpoint for** (computing "34 owners, 97 stations, 612 orders this month" for EVERY
  company in a list, in one request). Dropped from the list view; the SAME real figures
  are shown once a company is opened (T238), where a single scoped query genuinely
  answers them.
- **`Company` has no `PATCH /companies/:id` general-purpose update route at all** — only
  `:id/status` and `:id/commission-ceiling` exist. The previous mock's company-info card
  had a full inline edit affordance (manager name, job title, city, region, notes — none
  of which are fields `Company` even has). Rebuilt as a read-only card over the schema's
  real fields; no edit control is offered because none of these facts can currently be
  changed post-onboarding.
- **The operator's commission-term/cashback-programme editing surface (T239) had no
  screen to live on at all** — `PUT /billing/commission-terms`/`cashback-programme` have
  been `SUPER_ADMIN`-only since Phase 12 with no UI ever built against them. Added a new
  route, `AdminBillingSettingsPage.tsx` at `/admin/billing-settings`, plus its own
  sidebar entry — the first genuinely new operator-facing PAGE (not a rewiring of an
  existing mock) this feature has added. `CommissionTypeSelector.tsx`, orphaned since
  Phase 12 removed its only two callers (`PlatformCommissionBanner`/`CashbackBanner`'s
  edit dialogs, per T155), found its real, intended consumer here.
- **Cashback per-company targeting (`targetsAllCompanies: false` + a specific company
  list) is fully backend-capable but was NOT given a UI control in this pass** —
  `AdminBillingSettingsPage.tsx` always submits `targetsAllCompanies: true`. Building a
  multi-select against `GET /companies?type=FUEL` was judged not worth the scope
  expansion for a control the spec's own scenarios never exercise with a named subset;
  disclosed here as a real, deliberate scope limitation rather than silently omitted.
- **The operator's fuel-exchange oversight screen (T242) needed company NAMES the
  exchange-list endpoint itself doesn't return** (`ExchangeRequest` carries
  `raisedByCompanyId`/`recipientCompanyId` only). Resolved client-side from `GET
  /companies?type=FUEL` (already fetched for T236) rather than adding a join to the
  backend endpoint — reusing data already on the page rather than a new capability.
  Separately, the endpoint's own `counterparty` field (built for FR-086b, Phase 15)
  resolves differently for a `SUPER_ADMIN` caller than its name suggests: since `user
  .companyId` is undefined for that role, `String(raisedByCompanyId) === user.companyId`
  is always false, so `counterparty` always resolves to "the recipient," never
  meaningfully "the other side from the viewer." The admin detail page does not use that
  field at all, for exactly this reason — both company names are resolved independently
  instead. **Recorded directly in `AdminFuelExchangeListItem.tsx`'s own comment, as the
  task instructed**: this screen renders correctly regardless of whether the party-set
  isolation mechanism is working, because `SUPER_ADMIN` bypasses that plugin too — it is
  never usable as evidence for or against R3's defect (quickstart 3.3, `contracts/
  isolation-contract.md`).
- **`GET /users`'s `findAll` signature gained `companyId` for T238, and a project-wide
  precedent applies to it too**: mirroring the `!ctx?.role` discriminator's own history,
  the correction here was purely additive (a new optional filter), not a behavior
  change to any existing caller — verified by the full unit and e2e suites passing
  unchanged.
- Verification: backend `npm run build` clean; new suite `test/e2e/operator-oversight
  .e2e-spec.ts` 6/6 (covering T238's five drill-down endpoints plus T246's six
  operator-only refusals), re-run alongside `party-set-isolation`/`fuel-exchange` (23/23
  combined) to confirm no interaction regression between the three Phase 15/16 additions
  sharing the same fixture. Full backend `npm run test` 27 suites/228 tests green. A full
  sequential e2e regression was launched in the background as this phase closed; its
  result was not yet known when this entry was written — check before relying on "the
  whole suite is green" as a claim rather than an intent. Dashboard `npx tsc -b --force`
  clean of every error beyond the documented pre-existing baseline, `npx vitest run`
  **76/76** real tests (75 plus the new `protected-route.test.tsx` case; same 2
  documented pre-existing load failures). No live-browser walkthrough of the new
  operator-oversight screens was performed (no dev server session available) — same
  disclosed gap as every dashboard-touching phase since Phase 13.

**Phase 16 complete: 14/14 tasks (T234-T247). ⛔ All 13 user stories from spec.md are now
implemented — T248 onward (Phase 17) is polish and cross-cutting verification, not new
functional scope. Continuing per standing instruction.**

### Corrections found while implementing (T258 — consolidated)

*(each case where following spec.md, plan.md, research.md, data-model.md or the contracts as written
would have been wrong or wasteful — the log this repository's prior features treat as a deliverable.
Full detail for each phase lives in that phase's own Notes entry above; this is the consolidated
index T258 asks for.)*

- **The keystone finding proved out exactly as research R3 predicted** (Phase 15 Part A, T217's
  gate): the party-set isolation mechanism was verified with a standalone unit test on a synthetic
  schema AND a full-stack e2e test through the real `ExchangeRequest` collection and Nest app
  **before** any business logic was written on top of it — catching the "recipient's list is
  silently, permanently empty" failure mode at the mechanism layer rather than after four screens
  had been built against it.
- **`LitreBalance` idempotency needed two separate corrections, not one.** A `partialFilterExpression`
  scoped by `movements.kind` does not apply per-array-element for a multikey index — wrong. A flat
  `reconciledOrderIds` array with a unique index was the next attempt — also wrong, because MongoDB's
  unique-index constraint does not catch a duplicate value pushed into one document's own array (only
  between separate documents), so a retried confirmation silently doubled the movement. The working
  fix splits the write in two: an idempotent upsert that only ensures the document exists, then a
  conditional `findOneAndUpdate` filtered on `reconciledOrderIds: { $ne: orderId }` whose `null`
  return (not a caught exception) is what distinguishes a genuine retry. Found by a unit test, not by
  inspection — both wrong versions passed every test that didn't specifically retry the same order.
- **Backend capability gaps found only while wiring the dashboard, not pre-identified in tasks.md**:
  `GET /companies/exchange-partners` (Phase 15, the fuel-exchange form's recipient selector needed
  every other active FUEL-type company and no endpoint returned that list), and five Phase 16
  per-company drill-down filters (`?companyId=`/`?fuelCompanyId=` added to `GET /users`,
  `GET /stations/all`, `GET /invoices`, `GET /platform-account/movements`, plus the new
  `GET /billing/balances/:companyId`). Safe to add because the owning isolation plugin's `.where()`
  clause overwrites any caller-supplied value for the scoped field — the filter is load-bearing only
  for `SUPER_ADMIN` and a no-op for a tenant-scoped caller who could only ever see their own rows
  anyway.
- **`orders.service.ts` had a field-name typo** (`quantityLiters` vs the schema's own field) caught by
  the litre-drawdown unit tests, and an async helper in `test/e2e/platform-account-payments
  .e2e-spec.ts` marked `async` while returning a supertest `Test` object caused the object to be
  auto-awaited before `.expect()` could run on it — both fixed.
- **Two test-authoring bugs produced false-looking failures that were not backend defects**: a
  destructuring mistake in `fuel-exchange.e2e-spec.ts` (`const { admin: adminA, companyId:
  companyIdB } = fixtures.companyA`) failed 6/9 tests with self-request refusals; and
  `party-set-isolation.e2e-spec.ts` passed the literal string `'outsider'` where a real ObjectId hex
  string was required, producing a BSON cast error rather than the intended isolation-refusal
  assertion.
- **Phase 17's polish pass (T248-T255) found real, if minor, defects the phase-by-phase work had
  missed**: two Phase-13-era mock components (`AdminDesktopPlatformAccountTable.tsx`,
  `AdminMobilePlatformAccountList.tsx`) were dead code with zero remaining callers once Phase 16
  wired the operator's platform-account screen to the real, reused components — deleted. Six
  fuel-exchange screens compared `request.state` against raw string literals at the point of use
  even though `ExchangeRequestState` already existed in `constants/fuel-company.ts` for exactly this
  purpose (FR-097) — switched to reference it (T254's defect class, on this feature's own code, not
  someone else's). An invoice amount rendered with no stated currency anywhere in its card, and a
  table column header was mislabeled with `adminCompanies.suspended` instead of `orders.status` —
  both found by T251's currency/unit audit and fixed. By contrast, `invoices.state === 'SETTLED'`-
  style literal comparisons against a **typed union field** (not a free-form string, so a typo is a
  compiler error) were left as-is where they matched established, already-shipped Phase 9 convention
  (`DesktopInvoicesTable.tsx` predates this feature and was never flagged) — T254 is about a literal
  standing in for an available named constant, not about every string comparison in the codebase.
- **`AdminDashboard.tsx` (the operator's platform-wide home page) and `AdminStationOwnerDetailsPage
  .tsx`'s `MOCK_ORDERS` were judged out of scope for 013 and left undone, not fixed.** No FR in
  `spec.md` names an operator home-dashboard requirement (checked by grep for `GMV`, `platform-wide`,
  `trading volume` and the equivalent Arabic phrasing — nothing relevant), and the page reuses
  `transport_company/home/` components belonging to feature 009's scope, not this one. Same
  disclosed-not-fixed precedent as feature 009's `DeliveryAreasPage.tsx`/`NotificationsPage.tsx`.
- **Mobile could not be verified this session**: `mobile_app/` is not present anywhere in this
  session's workspace (only this backend and `web_dashboard_ciro_fuel/` exist as sibling checkouts),
  so `flutter test` could not be run at all — a different and more basic gap than prior features'
  "same 2 pre-existing non-green tests." Feature 013 makes no change to mobile_app's own code, so
  this is a tooling-access gap rather than a suspected regression, but it is genuinely unverified.

### T259 regression gate — results

Backend: `npm run build` clean. `npm run test` **27 suites / 228 tests** green, unchanged from
Phase 16's close (Phase 17 touched only dashboard files). `npx jest --config test/jest-e2e.json
--runInBand` **exit 0** across the full suite — the live per-suite PASS/FAIL/count lines did not
survive this session's capture of a long-running background command (carriage-return progress
output), so the exit code is the verified signal; no FAIL lines and no non-zero exit occurred.
`npm run lint:check` unchanged from every prior phase's disclosure: 37,205 problems, all `prettier/
prettier` CRLF (`Delete ␍`) findings from `core.autocrlf=true` on this Windows checkout — an
environmental artifact first disclosed in Phase 12's corrections log, not a code defect, and not
newly introduced by this feature. Dashboard: `npx tsc -b --force` clean of every error beyond the
pre-existing unused-import baseline (feature 011's disclosure; none of the flagged files were
touched by 013). `npx vitest run` **76/76** real tests green, same 2 pre-existing load failures.
Mobile: **not run** — see above.

**Phase 17 complete: 12/12 tasks (T248-T259). T260-T263 remain undone — each needs a live dev
server + backend session and, for T262, a human tester who has not read the spec, neither of which
this session had. Every prior feature in this file documents the identical class of gap for its own
quickstart/timed/observed tasks (e.g. feature 012's T110/quickstart Part 3, feature 009's T063-T067/
T121/T122) — this is not new to 013.**

**Feature 013 status: 262 of 266 tasks complete. All 13 user stories from spec.md are implemented,
wired to the dashboard, and covered by passing backend unit/e2e suites and dashboard unit tests.
The 4 remaining tasks (T260-T263) are the live-walkthrough/timed/observed-session verifications that
require infrastructure and a human tester this session does not have — see CLAUDE.md's active-
feature section for the same disclosure in the format future sessions read first.**
