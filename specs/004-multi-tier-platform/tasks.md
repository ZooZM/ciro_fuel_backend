# Tasks: Multi-Tier Accounts, Regional Routing & Billing

**Input**: Design documents from `/specs/004-multi-tier-platform/`

**Prerequisites**: `plan.md` (required), `spec.md` (required)

**Tests**: Test tasks ARE included. The spec mandates them — FR-032 requires every retained
capability to keep passing its tests, and SC-001…SC-008 are stated as measurable test outcomes.
`plan.md` §7 further requires the suite green at every phase boundary.

**Organization**: Tasks are grouped by user story so each can be implemented and verified
independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[US#]**: The user story this task serves (user-story phases only)

## Path Conventions

Backend (NestJS): `src/modules/**`, `src/common/**`, `test/e2e/**`, `test/unit/**`, `scripts/**`
Mobile (Flutter): `mobile_app/lib/**`, `mobile_app/test/**`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Reference data and enums every later phase depends on.

- [X] T001 [P] Add `CompanyType` enum (`FUEL`, `TRANSPORT`) in `src/common/enums/company-type.enum.ts`
- [X] T002 [P] Add `PaymentMethod` enum (`DIRECT`, `DEFERRED`, `CREDIT`) in `src/common/enums/payment-method.enum.ts`
- [X] T003 [P] Add `InvoiceState` enum (`ISSUED`, `SETTLED`, `VOID`) in `src/common/enums/invoice-state.enum.ts`
- [X] T004 [P] Add `RegionCode` and `GovernorateCode` enums for the 13 Saudi regions in `src/common/enums/region.enum.ts`
- [X] T005 [P] Add region reference data (13 regions + governorates, Arabic and English names) in `src/modules/regions/regions.constants.ts`
- [X] T006 Create `RegionsModule` exposing `GET /api/v1/regions` (public, cacheable) in `src/modules/regions/regions.module.ts`, `regions.controller.ts`, `regions.service.ts`
- [X] T007 [P] Add `ORDER_AVERAGE_SPEED_KMH` and `GOOGLE_MAPS_API_KEY` to `.env.example` and the config schema in `src/config/configuration.ts`
- [X] T008 [P] Unit test for region lookup and code validation in `test/unit/regions.service.spec.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The account hierarchy and the new isolation model. This is the security backbone.

**⚠️ CRITICAL**: No user story work may begin until this phase is complete and the full existing
suite is green. Per `plan.md` §1, this lands alone.

- [X] T009 Add `type` and `parentFuelCompanyId` to the company schema in `src/modules/companies/schemas/company.schema.ts`
- [X] T010 Add `FUEL_COMPANY_ADMIN` and `TRANSPORT_COMPANY_ADMIN` to `UserRole`, retiring `COMPANY_ADMIN`, in `src/common/enums/user-role.enum.ts`
- [X] T011 Add `markMultiParty()` marker alongside the existing tenant marker in `src/common/plugins/multi-party.marker.ts`
- [X] T012 Implement the role-derived scoping plugin (filter table in `plan.md` §1) in `src/common/plugins/multi-party-scope.plugin.ts` — `fuelCompanyId` injected for every non-CIRO role with no exception, filter injected never caller-supplied, missing scoping identity throws, owning tenant forced on write
- [X] T013 Register the multi-party plugin in the Mongoose setup in `src/app.module.ts`, keeping the existing tenant plugin unchanged for single-tenant collections
- [X] T014 Extend the request context to carry `userId`, company type and — for a Transport Company admin — the resolved `parentFuelCompanyId`, so their multi-party filter can still require `fuelCompanyId` per plan.md §1, in `src/common/context/tenant-context.ts`
- [X] T015 Update `RolesGuard` and role decorators for the new roles in `src/common/guards/roles.guard.ts`
- [X] T016 [P] Unit tests for the multi-party plugin covering each role's injected filter (asserting `fuelCompanyId` is present for every non-CIRO role, including Client and Driver), caller-supplied override attempts, and the missing-identity throw in `test/unit/multi-party-scope.plugin.spec.ts`
- [X] T017 Update existing test fixtures for the new roles and company types in `test/utils/fixtures.ts`
- [X] T018 Run the full existing suite and repair fallout from the role rename — no behaviour changes, only role/type migration in `test/e2e/**`

**Checkpoint**: Hierarchy and isolation infrastructure in place; full suite green.

---

## Phase 3: User Story 1 - CIRO onboards an isolated Fuel Company (P1) 🎯 MVP

**Goal**: CIRO creates Fuel Companies; each is a fully isolated tenant.

**Independent Test**: Create two Fuel Companies as CIRO; confirm each admin sees only its own
records and that fetching the other's record by id is indistinguishable from absent.

- [X] T019 [US1] Add `POST /companies` fuel-company creation restricted to `SUPER_ADMIN` in `src/modules/companies/companies.controller.ts`
- [X] T020 [US1] Implement fuel-company creation with its initial admin in `src/modules/companies/companies.service.ts`
- [X] T021 [P] [US1] Add `CreateFuelCompanyDto` with type and admin fields in `src/modules/companies/dto/create-fuel-company.dto.ts`
- [X] T022 [US1] Scope company listing so CIRO sees all and a fuel admin sees only its own in `src/modules/companies/companies.service.ts`
- [X] T023 [P] [US1] E2E: CIRO creates a Fuel Company and its admin can sign in — `test/e2e/hierarchy-onboarding.e2e-spec.ts`
- [X] T024 [P] [US1] E2E: expand cross-tenant isolation to every role pair in both directions, asserting 404 (never 403) — `test/e2e/tenant-isolation.e2e-spec.ts`
- [X] T025 [P] [US1] E2E: a non-CIRO context missing its scoping identity is rejected rather than served unscoped — `test/e2e/tenant-isolation.e2e-spec.ts`
- [X] T026 [US1] Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` with the new roles and company endpoints

**Checkpoint**: US1 independently demonstrable — SC-001 verifiable.

---

## Phase 4: User Story 2 - Fuel Company assigns regions to a Transportation Company (P1)

**Goal**: Transport companies exist under a Fuel Company and serve assigned regions.

**Independent Test**: Create a transporter, assign two regions, confirm it lists exactly those
and that its own admin cannot change them.

- [X] T027 [US2] Add `servedRegions: RegionCode[]` to the company schema in `src/modules/companies/schemas/company.schema.ts`
- [X] T028 [US2] Add `POST /companies/:id/transporters` (fuel admin only) in `src/modules/companies/companies.controller.ts`
- [X] T029 [US2] Implement transporter creation under the acting Fuel Company in `src/modules/companies/companies.service.ts`
- [X] T030 [P] [US2] Add `CreateTransportCompanyDto` and `AssignRegionsDto` validating region codes against the reference list in `src/modules/companies/dto/`
- [X] T031 [US2] Add `PUT /companies/:id/regions` for region assignment, rejecting unknown codes, in `src/modules/companies/companies.controller.ts`
- [X] T032 [US2] Expose read-only served regions to the transporter's own admin in `src/modules/companies/companies.service.ts`
- [X] T033 [P] [US2] E2E: region assignment, read-back, transporter cannot self-assign, unknown code rejected — `test/e2e/region-assignment.e2e-spec.ts`
- [X] T034 [P] [US2] E2E: a transporter of Fuel Company A is invisible to Fuel Company B — `test/e2e/tenant-isolation.e2e-spec.ts`

**Checkpoint**: US1 and US2 both independently functional.

---

## Phase 5: User Story 3 - Client registers a station with a structured address (P1)

**Goal**: Client stations carry region, governorate, coordinates and editable address text,
created by the Fuel Company only (FR-004a).

**Independent Test**: Create a client as a fuel admin with region + governorate + pin; confirm
the geocoded address is editable, the edited text is stored, and that creation still succeeds
when the lookup fails.

- [X] T035 [US3] Add the `station` sub-document (region, governorate, location, addressText, name) and `creditLimit` to `src/modules/users/schemas/user.schema.ts`
- [X] T036 [US3] Restrict client creation to `FUEL_COMPANY_ADMIN` and reject it for transporters in `src/modules/users/users.controller.ts`
- [X] T037 [P] [US3] Extend `CreateUserDto` with the station fields, validating region/governorate pairing, in `src/modules/users/dto/create-user.dto.ts`
- [X] T038 [US3] Implement a geocoding service wrapping the Google Geocoding API in `src/modules/geocoding/geocoding.service.ts`
- [X] T039 [US3] Add `POST /geocoding/reverse` returning a suggested address for a pin, used only at registration, in `src/modules/geocoding/geocoding.controller.ts`
- [X] T040 [US3] Make geocoding failure non-fatal — log and return an empty suggestion (FR-013) in `src/modules/geocoding/geocoding.service.ts`
- [X] T041 [P] [US3] Unit test: geocoding failure and timeout return an empty suggestion rather than throwing — `test/unit/geocoding.service.spec.ts`
- [X] T042 [P] [US3] E2E: client created with station data; stored address text is the edited value; creation succeeds with geocoding unavailable — `test/e2e/client-station.e2e-spec.ts`
- [X] T043 [P] [US3] E2E: a transporter attempting to create a client is refused — `test/e2e/client-station.e2e-spec.ts`
- [X] T044 [US3] Expose the station block on `/auth/me` in `src/modules/auth/auth.controller.ts`

**Checkpoint**: US1–US3 functional; every client has a routable region.

---

## Phase 6: User Story 4 - Order routes Client → Fuel Co → Transport Co → Driver (P1)

**Goal**: The core journey, with the existing dispatch engine retained as the ranking and
commit layer.

**Independent Test**: Place an order, approve it as the Fuel Company, see the designated
transporter, assign a driver from the ranked list, and confirm concurrent assignment yields
exactly one driver.

- [X] T045 [US4] Add `AWAITING_ROUTING` and `ROUTED_TO_TRANSPORT` to `src/common/enums/order-status.enum.ts` and the transition table in `src/modules/orders/order-state.service.ts`
- [X] T046 [US4] Replace `companyId` with participants (`fuelCompanyId`, `clientId`, `transportCompanyId`, `driverId`) and mark the schema multi-party in `src/modules/orders/schemas/order.schema.ts`
- [X] T047 [US4] Copy the client's `station.addressText` onto the order as `deliveryAddressText` at creation in `src/modules/orders/orders.service.ts`
- [X] T048 [US4] Implement region → transporter resolution (one / many / none per FR-014, FR-016) in `src/modules/dispatch/routing.service.ts`
- [X] T049 [US4] Return candidate transporters with the order for the approval screen (FR-015) in `src/modules/orders/orders.controller.ts`
- [X] T050 [US4] Extend approval to accept a chosen transporter when several serve the region, and to park the order in `AWAITING_ROUTING` with a notification when none do, in `src/modules/orders/orders.service.ts`
- [X] T051 [US4] Extend the notifications module for the new roles — unroutable-order alerts to the Fuel Company, new-order alerts to the Transportation Company, scoped through the multi-party filter — in `src/modules/notifications/notifications.service.ts`
- [X] T052 [US4] Add `GET /dispatch/orders/:id/candidates` returning the transporter's available drivers ranked by the existing eligibility query in `src/modules/dispatch/dispatch.controller.ts`
- [X] T053 [US4] Repurpose `DispatchService.assignDriver` as the transactional commit for a transporter-chosen driver, preserving its race protection, in `src/modules/dispatch/dispatch.service.ts`
- [X] T054 [US4] Add `POST /dispatch/orders/:id/assign` (transport admin only) in `src/modules/dispatch/dispatch.controller.ts`
- [X] T055 [P] [US4] Rewrite order-lifecycle E2E for the new routing hop — `test/e2e/order-lifecycle.e2e-spec.ts`
- [X] T056 [P] [US4] Update dispatch-selection E2E so eligibility now ranks rather than auto-assigns — `test/e2e/dispatch-selection.e2e-spec.ts`
- [X] T057 [P] [US4] Update dispatch-race E2E to assert exactly one winner under concurrent transporter assignment (SC-003) — `test/e2e/dispatch-race.e2e-spec.ts`
- [X] T058 [P] [US4] E2E: unroutable region parks the order and notifies the Fuel Company — `test/e2e/order-routing.e2e-spec.ts`
- [X] T059 [P] [US4] E2E: each participant sees the order through its own scope only, and a driver sees only assigned trips — `test/e2e/tenant-isolation.e2e-spec.ts`
- [X] T060 [P] [US4] E2E: a client-supplied `status` field on any order request is ignored — the backend remains the sole authority for transitions (FR-019) — `test/e2e/order-lifecycle.e2e-spec.ts`

**Checkpoint**: The end-to-end delivery journey works — SC-002 and SC-003 verifiable.

---

## Phase 7: User Story 5 - Order is paid by one of three methods (P2)

**Goal**: Invoices issued at approval, with direct / deferred / credit settlement.

**Independent Test**: Approve one order per method; confirm direct blocks routing until settled,
deferred routes immediately and is payable only by the transporter, credit reduces available
credit and restores it on settlement, and a credit shortfall refuses approval.

- [X] T061 [P] [US5] Create the invoice schema (single payer, method, state, settlement) in `src/modules/invoices/schemas/invoice.schema.ts`, marked multi-party
- [X] T062 [US5] Create `InvoicesModule` with service and controller in `src/modules/invoices/`
- [X] T063 [US5] Add `paymentMethod` to order creation in `src/modules/orders/dto/create-order.dto.ts`
- [X] T064 [US5] Issue the invoice inside the approval transaction, using the final price (FR-020) in `src/modules/orders/orders.service.ts`
- [X] T065 [US5] Implement available credit as `creditLimit − Σ(ISSUED credit invoices)` (FR-024a) in `src/modules/invoices/invoices.service.ts`
- [X] T066 [US5] Refuse approval when a credit order exceeds available credit, naming the shortfall, with no invoice issued (FR-025) in `src/modules/orders/orders.service.ts`
- [X] T067 [US5] Route direct orders to `PENDING_PAYMENT` and deferred/credit orders straight to routing in `src/modules/orders/orders.service.ts`
- [X] T068 [US5] Schedule the payment-timeout job for direct invoices only (FR-020b) in `src/modules/payments/payment-timeout.processor.ts`
- [X] T069 [US5] Settle invoices from the existing signed webhook, idempotent on `paymentReference`, in one transaction with credit restoration in `src/modules/payments/payments.service.ts`
- [X] T070 [US5] Restrict deferred settlement to the transporter and expose the invoice read-only to the client (FR-022) in `src/modules/invoices/invoices.controller.ts`
- [X] T071 [US5] Add `PUT /users/:id/credit-limit` (fuel admin only) in `src/modules/users/users.controller.ts`
- [X] T072 [US5] Add `GET /invoices` and `GET /invoices/:id` scoped per role in `src/modules/invoices/invoices.controller.ts`
- [X] T073 [P] [US5] Unit tests for credit arithmetic across issue/settle/void sequences (SC-004) in `test/unit/invoices.service.spec.ts`
- [X] T074 [P] [US5] E2E: all three methods end to end, including deferred visibility and payer restriction — `test/e2e/billing-methods.e2e-spec.ts`
- [X] T075 [P] [US5] E2E: credit shortfall refuses approval; placement reserves nothing so two orders race the same limit — `test/e2e/billing-credit.e2e-spec.ts`
- [X] T076 [P] [US5] E2E: repeated webhook notifications settle exactly once (SC-005) — `test/e2e/payment-idempotency.e2e-spec.ts`
- [X] T077 [P] [US5] E2E: settlement after cancellation is recorded and credited, never silently applied — `test/e2e/billing-edge-cases.e2e-spec.ts`
- [X] T078 [P] [US5] E2E: a forced failure mid-settlement (e.g. a rejected credit-restoration write) leaves both the invoice unsettled and credit unrestored — proving FR-027's one-transaction guarantee, not just its happy path — `test/e2e/billing-transaction-integrity.e2e-spec.ts`

**Checkpoint**: Billing complete — SC-004 and SC-005 verifiable.

---

## Phase 8: User Story 6 - Live delivery shows driver, vehicle, destination and ETA (P2)

**Goal**: Remove every placeholder from the mobile client.

**Independent Test**: With a driver assigned and a position reported, the client sees driver
name, plate, address and an ETA; with no position, no ETA is shown and nothing is fabricated.

- [X] T079 [US6] Snapshot `{ fullName, phone, truck.plateNumber }` onto the order at assignment (FR-008) in `src/modules/dispatch/dispatch.service.ts`
- [X] T080 [US6] Add the driver summary to the order schema in `src/modules/orders/schemas/order.schema.ts`
- [X] T081 [US6] Compute `etaMinutes` from the driver's last position, omitting it when unknown (FR-029), in `src/modules/orders/eta.service.ts`
- [X] T082 [P] [US6] Unit tests for ETA including the unknown-position case in `test/unit/eta.service.spec.ts`
- [X] T083 [P] [US6] E2E: client sees driver name/plate for their own order but cannot read the driver's user record — `test/e2e/order-visibility.e2e-spec.ts`
- [X] T084 [US6] Extend the mobile order entity and mapper with driver summary, address text and ETA in `mobile_app/lib/shared/entities/order.dart` and `mobile_app/lib/features/orders/data/models/order_mapper.dart`
- [X] T085 [US6] Realign the mobile role enum with the backend's renamed roles (`FUEL_COMPANY_ADMIN`, `TRANSPORT_COMPANY_ADMIN`; retire `COMPANY_ADMIN`) — the sole place role wire strings are parsed (Principle I) — in `mobile_app/lib/shared/enums/user_role.dart`
- [X] T086 [US6] Replace the `—` placeholders with real driver, plate and ETA in `mobile_app/lib/features/home/presentation/view/client_home_screen.dart`
- [X] T087 [US6] Show `deliveryAddressText` instead of coordinates in `mobile_app/lib/features/orders/presentation/constants/order_presentation.dart`
- [X] T088 [US6] Replace the station card placeholders with the client's stored station in `mobile_app/lib/features/home/presentation/view/client_home_screen.dart`
- [X] T089 [US6] Wire the finance cards to the credit/invoice endpoints in `mobile_app/lib/features/home/presentation/widgets/finance_cards_row.dart`
- [X] T090 [US6] Add a payment-method selector to the create-order form in `mobile_app/lib/features/orders/presentation/view/create_order_screen.dart`
- [X] T091 [P] [US6] Update mobile fixtures and render tests for the real fields in `mobile_app/test/support/orders_test_di.dart` and `mobile_app/test/home_screen_render_test.dart`

**Checkpoint**: SC-006 verifiable — no placeholder data on any client screen.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T092 Write the re-runnable migration script per `plan.md` §6 in `scripts/migrate-multi-tier.ts`
- [X] T093 [P] Migration test: re-running is idempotent and loses no data in `test/e2e/migration.e2e-spec.ts`
- [X] T094 [P] Assert order read paths make zero external geocoding calls (SC-007) in `test/e2e/order-visibility.e2e-spec.ts`
- [X] T095 [P] Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` with invoices, regions, routing and assignment endpoints
- [X] T096 [P] Update `specs/002-flutter-mobile-app/plan.md` for the new roles and payment methods
- [X] T097 [P] Update `specs/003-web-admin-dashboard/` role and route tables for CIRO, fuel and transport admins
- [X] T098 [P] Update the Postman collection with the new roles, regions, invoices and assignment requests in `postman/ciro-fuel-api.postman_collection.json`
- [X] T099 [P] Update `CLAUDE.md` and `specs/001-fuel-delivery-platform/quickstart.md` for the new hierarchy
- [X] T100 Run the full backend and mobile suites and confirm SC-001…SC-008 are each covered by a passing test (FR-032)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** → no dependencies
- **Foundational (Phase 2)** → depends on Setup; **blocks every user story**
- **US1 (Phase 3)** → depends on Foundational
- **US2 (Phase 4)** → depends on US1 (needs a Fuel Company to own transporters)
- **US3 (Phase 5)** → depends on US1; independent of US2
- **US4 (Phase 6)** → depends on US2 **and** US3 (needs regions assigned and a client with a region)
- **US5 (Phase 7)** → depends on US4 (invoices issue at approval, which routes)
- **US6 (Phase 8)** → depends on US4 (needs an assigned driver)
- **Polish (Phase 9)** → depends on all stories

### Within Each User Story

Schema → DTOs → service logic → endpoints → tests. Tasks touching the same file are sequential;
`[P]` tasks touch distinct files.

### Parallel Opportunities

- Phase 1: T001–T005, T007, T008 are all `[P]` — the entire setup phase can run concurrently
- Phase 3: T023, T024, T025 (three distinct e2e concerns)
- Phase 5: T041, T042, T043
- Phase 6: T055–T060 (six separate spec files) once the service work lands
- Phase 7: T073–T078
- Phase 9: T093–T099 (docs and fixtures are mutually independent)
- **US2 and US3 can be built in parallel by two people** — both depend only on US1

---

## Parallel Example: User Story 4

```
# After T045–T054 land, run the six test files concurrently:
T055  test/e2e/order-lifecycle.e2e-spec.ts
T056  test/e2e/dispatch-selection.e2e-spec.ts
T057  test/e2e/dispatch-race.e2e-spec.ts
T058  test/e2e/order-routing.e2e-spec.ts
T059  test/e2e/tenant-isolation.e2e-spec.ts
T060  test/e2e/order-lifecycle.e2e-spec.ts  # client-supplied status is ignored (FR-019)
```

---

## Implementation Strategy

**MVP scope**: Phases 1–3 (Setup + Foundational + US1). That delivers the isolated multi-tenant
hierarchy — the change's highest-risk element — and is demonstrable on its own.

**Incremental delivery**:

1. Phases 1–2, alone, with the full existing suite green. Do not begin story work until it is.
2. US1 → isolation proven (SC-001)
3. US2 + US3 → in parallel; every client is routable
4. US4 → the core journey (SC-002, SC-003)
5. US5 → billing (SC-004, SC-005)
6. US6 → placeholders removed (SC-006)
7. Polish → migration and documentation

**Out of scope for this task list**: the web dashboard (`plan.md` §7 Phase 7). CIRO, Fuel Company
and Transportation Company dashboards are the whole of feature 003 plus two new roles, and
`web_dashboard/` has no code yet. Plan it separately once these phases settle the API surface.

**Prerequisite**: a Google Maps API key with Geocoding enabled is required before Phase 5 (US3).
