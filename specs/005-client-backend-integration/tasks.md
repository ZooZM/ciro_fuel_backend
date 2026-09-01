---

description: "Task list for feature 005 — Client Mobile App Backend Integration"
---

# Tasks: Client Mobile App — Backend Integration

**Input**: Design documents from `/specs/005-client-backend-integration/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Test tasks ARE included. Not optional here — Constitution §"Development Workflow &
Quality Gates" requires automated tests for every guarantee the spec marks testable (tenant
isolation, lifecycle validity, payment idempotency), and FR-046a requires an ownership-isolation
test on every capability added to the platform.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story the task serves (US1–US9)
- Exact file paths included in every task

## Path Conventions

**Two repository roots.** Backend paths are relative to this repo
(`/Volumes/Zeyad/Documents/work/Ciro/ciro_fuel/`). Mobile paths are prefixed `mobile_app/` and
live in a **separate root** (`/Volumes/Zeyad/Documents/work/Ciro/mobile_app/`). Never mix them.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Named constants, enums and configuration every later phase references. Principle I
forbids the literals these replace.

- [X] T001 [P] Add `SupportTopic` enum in `src/common/enums/support-topic.enum.ts`, mirroring the app's `mobile_app/lib/features/support/presentation/constants/support_topics.dart`
- [X] T002 [P] Add `SupportRequestState` enum (`SUBMITTED`, `ACKNOWLEDGED` — two members only, per FR-039a) in `src/common/enums/support-request-state.enum.ts`
- [X] T003 [P] Add `SUPPORT_REQUEST_RAISED` member to `src/common/enums/notification-type.enum.ts`
- [X] T004 [P] Add feature error codes (`PRICING_NOT_CONFIGURED`, `QUOTE_STALE`, `QUOTE_EXPIRED`, `PHONE_IN_USE`, `SMS_SEND_FAILED`, `LAST_STATION`) as named constants in `src/common/enums/error-code.enum.ts`
- [X] T005 [P] Add pagination constants (`DEFAULT_PAGE_SIZE = 20`) and money constants (`CURRENCY_DECIMAL_PLACES = 2`) in `src/common/constants/pagination.constants.ts` and `src/common/constants/money.constants.ts`
- [X] T006 Add SMS configuration (`SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID`) to `src/config/configuration.ts` and `.env.example`, and extend the Joi schema in `src/config/validation.ts` so `SMS_PROVIDER=none` is rejected when `NODE_ENV=production` (quickstart: the dev no-op must be impossible to ship)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared-ground changes plus the mechanisms multiple stories depend on.

**⚠️ CRITICAL**: No user story work begins until this phase completes.

**⚠️ SEQUENCING (research R11)**: T007–T010 (OTP extraction) and T011–T017 (station migration)
each touch code the **driver app** depends on. They land **separately**, each with the full
backend suite green before the next begins. Do not bundle them, and do not start story work on
top of an un-verified one — a driver-side regression discovered later gets attributed to the
wrong change.

### Stage 0a — OTP extraction (lands alone, suites green)

- [X] T007 Extract subject-agnostic OTP primitives (generate, salt, hash, cache-with-TTL, verify-with-attempts, invalidate) from `src/modules/orders/services/otp.service.ts` into `src/common/otp/otp-primitives.service.ts`, keyed by an arbitrary subject string rather than an `orderId`
- [X] T008 Refactor `src/modules/orders/services/otp.service.ts` to delegate to `OtpPrimitivesService`, preserving every existing behaviour — Redis key shape, `MAX_ATTEMPTS`, expiry, the `order:otp` realtime emit, and the plaintext-only-via-`peekCurrent` rule (FR-045)
- [X] T009 [P] Add unit tests for `OtpPrimitivesService` in `test/unit/otp-primitives.service.spec.ts` covering hash-at-rest, single-use, expiry, and attempt lockout
- [X] T010 **GATE**: run `npm test && npm run test:e2e` — the pre-existing delivery-OTP coverage must be green before any further task. Do not proceed on a red suite.

### Stage 0b — Station collection & migration (lands alone, suites green)

- [X] T011 Create `Station` schema in `src/modules/stations/schemas/station.schema.ts` per data-model.md — `companyId`, `clientId`, `name`, `regionCode`, `governorateCode`, `location`, `addressText`, `isDefault`, `isFavourite`, `isActive` — marked with `markTenantScoped` (the original `companyId` plugin, **not** multi-party)
- [X] T012 Add indexes to the `Station` schema: `{ clientId: 1, isActive: 1 }` and a **partial unique** index on `{ clientId: 1, isDefault: 1 }` where `isDefault: true`, enforcing one default per client at the data layer (Principle V)
- [X] T013 Create `StationsModule` and `StationsService` in `src/modules/stations/` with a `findForClient(clientId)` read that adds `clientId = currentUser.userId` **on top of** the tenant plugin — company scoping alone is insufficient, since two clients share a fuel company
- [X] T014 Add `GET /stations` (CLIENT) in `src/modules/stations/stations.controller.ts` returning the caller's active stations, default first (needed by US2, US7 and US8 — hence foundational, not US8)
- [X] T015 Add `stationId` (optional, ref Station) to `src/modules/orders/schemas/order.schema.ts`, and `clientId` (ref User) to `src/modules/payments/schemas/payment-event.schema.ts`
- [X] T016 Write the migration in `scripts/migrate-005-stations.ts` and register `npm run migrate:005-stations`: create a default `Station` per client from the embedded `user.station`; back-fill `order.stationId`; back-fill `paymentEvent.clientId`. Idempotent. **`priceBreakdown` is deliberately NOT back-filled** (research R2 — no fabricated financial records)
- [X] T017 Update `GET /auth/me` in `src/modules/auth/auth.controller.ts` to source `station` from the client's default `Station` document, **holding the response shape byte-identical** — the driver app calls this endpoint and must not notice
- [X] T018 [P] Extend `test/e2e/migration.e2e-spec.ts` to cover the 005 migration: idempotency, default-station uniqueness, order/payment back-fill, and that `/auth/me` returns an unchanged shape for CLIENT, DRIVER and both admin roles
- [X] T019 **GATE**: run `npm test && npm run test:e2e` — the full suite, especially driver-facing coverage, must be green before any further task.

### Shared mechanisms

- [X] T020 [P] Implement the cursor codec in `src/common/pagination/cursor.util.ts` — opaque base64 of `{ sortValue, _id }`, encode/decode, and a **400 on a malformed cursor** (never a silent fallback to page one, which turns an infinite scroll into an infinite loop)
- [X] T021 [P] Add a `PaginatedQueryDto` (`cursor?`) and a `PaginatedResponse<T>` shape (`{ items, nextCursor }`) in `src/common/pagination/`, with page size fixed platform-side and **not** client-supplied
- [X] T022 [P] Unit-test the cursor codec in `test/unit/cursor.util.spec.ts`: round-trip, tiebreaker ordering, malformed input rejection, and stability when a record is inserted at the head mid-scroll (FR-048c)
- [X] T023 Add the compound indexes from research R3 — `orders {clientId,statusChangedAt,_id}` and `{clientId,status,statusChangedAt,_id}`, `invoices {clientId,state,createdAt,_id}` (`state` in the prefix, because FR-048f sorts outstanding first), `paymentevents {clientId,createdAt,_id}`, `notifications {recipientUserId,createdAt,_id}` — to their respective schemas. **Without these SC-004a fails invisibly in dev and visibly for the largest client.**
- [X] T024 [P] Define the `SmsSender` port in `src/common/sms/sms-sender.port.ts` and a logging no-op implementation in `src/common/sms/noop-sms-sender.ts`, wired by `SMS_PROVIDER=none` so Story 7 is buildable before a provider is procured (research R4)

### Mobile foundation

- [X] T025 [P] Add typed failures for the six new error codes in `mobile_app/lib/core/network/error_interceptor.dart`, routed through the existing centralized handler (Principle III — no new error path)
- [X] T026 [P] Add a shared paginated-response parser in `mobile_app/lib/core/network/paginated_response.dart`, treating `nextCursor: null` as end-of-list and a missing field as an error
- [X] T027 Verify in `mobile_app/lib/core/network/auth_interceptor.dart` that single-flight refresh fires on **401 only** and that 403/404 pass through untouched (FR-043) — verify, do not assume
- [X] T028 Register `OrdersCubit`, `FinanceCubit`, `NotificationsCubit` and `StationsCubit` as lazy singletons in `mobile_app/lib/core/di/injector.dart`, and reset them on sign-out (FR-047). **A singleton cubit holding the previous user's data across an account switch is a data leak** — cover it in T029
- [X] T029 [P] Add a test in `mobile_app/test/unit/session_cubit_reset_test.dart` asserting every cached cubit is cleared on sign-out

**Checkpoint**: Foundation ready. Both shared-ground refactors verified green. User stories can begin.

---

## Phase 3: User Story 1 — See my real orders (Priority: P1) 🎯 MVP

**Goal**: The orders list and order detail show the client's real orders, paginated, with actions
derived from real status.

**Independent Test**: Sign in as a seeded client; the list matches the platform record and no
sample order appears. If `ORD-2024-256` is visible, the screen is still static.

### Tests for User Story 1

- [X] T030 [P] [US1] E2E test in `test/e2e/orders-pagination.e2e-spec.ts`: 25+ orders page correctly, no repeats, no skips, `nextCursor: null` on the last page, malformed cursor → 400
- [X] T031 [P] [US1] E2E test in `test/e2e/orders-pagination.e2e-spec.ts`: a record inserted at the head mid-scroll causes neither a repeat nor a skip (FR-048c)
- [X] T032 [P] [US1] E2E test in `test/e2e/order-visibility.e2e-spec.ts` (extend): a CLIENT paging `GET /orders` never receives another client's order, including across page boundaries
- [X] T033 [P] [US1] Cubit test in `mobile_app/test/unit/orders_cubit_pagination_test.dart`: `loadMore` is a no-op when `nextCursor` is null or a load is in flight; `refresh` discards the cursor

### Implementation for User Story 1

- [X] T034 [US1] Paginate `GET /orders` in `src/modules/orders/orders.controller.ts` and `orders.service.ts` using the cursor utility, sorted `statusChangedAt` desc with `_id` desc as tiebreaker
- [X] T035 [US1] Apply the `status` filter **server-side across the client's whole set** in `src/modules/orders/orders.service.ts` (FR-048d) — never as a post-filter on a fetched page
- [X] T036 [US1] Extend the `GET /orders/:id` response in `src/modules/orders/orders.controller.ts` to include `station` (resolved from `stationId`, readable even when `isActive: false` — FR-036c)
- [X] T037 [P] [US1] Extend `OrdersState` in `mobile_app/lib/features/orders/presentation/cubit/orders_state.dart` with `nextCursor`, `isLoadingMore` and `loadMoreFailed` — the last **distinct** from `OrdersLoadFailure`, so a failed page leaves loaded pages on screen (FR-048e). Re-run `build_runner`
- [X] T038 [US1] Add `loadMore()` and `refresh()` to `mobile_app/lib/features/orders/presentation/cubit/orders_cubit.dart`, and a filter setter that resets the cursor
- [X] T039 [US1] Write `cardKindFor(OrderStatus, PaymentMethod)` in `mobile_app/lib/features/orders/presentation/constants/order_presentation.dart` as a single **exhaustive** switch over `OrderStatus` (Dart exhaustiveness makes a missed status a compile error). `deferred` is a payment method, not a status; `pendingPayment` under DEFERRED/CREDIT shows no pay action (research R9)
- [X] T040 [US1] Rewrite `mobile_app/lib/features/orders/presentation/view/orders_list_screen.dart` to mount the existing `OrdersCubit`, removing the hardcoded `_MockOrder` array and `_ordersFor`, with infinite scroll, empty state, and error-with-retry
- [X] T041 [US1] Rewrite `mobile_app/lib/features/orders/presentation/view/order_detail_screen.dart` to mount the existing `OrderDetailCubit` and select status cards via `cardKindFor`, removing the `MockOrderState` parameter and the `export` at line 22
- [X] T042 [US1] Remove the `state.extra as MockOrderState` branch from `mobile_app/lib/core/router/app_router.dart` (~lines 158–160), passing only the order id
- [X] T043 [US1] Wire real cancel and re-dispatch actions in the order detail screen through the existing `CancelOrder` / `Redispatch` use cases, showing only the actions the platform permits for the current status (FR-007)

**Checkpoint**: A client sees their real orders, pages through them, and opens real detail. MVP.

---

## Phase 4: User Story 2 — Place an order at the real price (Priority: P1)

**Goal**: Real grades, real stations, a real itemised quote, and an order created at that price.

**Independent Test**: Quote matches the platform's configuration; components sum to the total;
placing the order records matching details.

### Tests for User Story 2

- [X] T044 [P] [US2] Unit test in `test/unit/pricing.service.spec.ts`: components sum **exactly** to the total across many quantity/rate combinations. Round each component, then sum (research R2) — rounding the sum instead produces one-halala drift that reaches production
- [X] T045 [P] [US2] Unit test in `test/unit/pricing.service.spec.ts`: derivation order per FR-011g (tax applies to fuel + delivery + service), and inapplicable components emit `0`, never omitted (FR-011d)
- [X] T046 [P] [US2] E2E test in `test/e2e/pricing-breakdown.e2e-spec.ts`: a company with no `pricingConfig` yields `409 PRICING_NOT_CONFIGURED`, never a zero total (FR-011j)
- [X] T047 [P] [US2] E2E test in `test/e2e/pricing-breakdown.e2e-spec.ts`: changing `pricingConfig` after an order is placed leaves that order's `priceBreakdown` untouched (FR-011i)
- [X] T048 [P] [US2] E2E test in `test/e2e/pricing-breakdown.e2e-spec.ts`: a stale quote token yields `409 QUOTE_STALE` carrying the new breakdown; an expired one yields `409 QUOTE_EXPIRED`
- [X] T048a [P] [US2] E2E test in `test/e2e/pricing-breakdown.e2e-spec.ts`: the quote, the order's stored `priceBreakdown` and the issued invoice's `priceBreakdown` are identical for one order, and each `total` equals the invoice `amount` (FR-011e, SC-008a)
- [X] T048b [P] [US2] E2E test in `test/e2e/billing-methods.e2e-spec.ts` (extend): an order on DEFERRED or CREDIT terms reaches approval **without** entering a payment state (FR-014) — assumed spec-004 behaviour, but a P1 acceptance scenario here and therefore verified rather than trusted
- [X] T048c [P] [US2] E2E test in `test/e2e/billing-methods.e2e-spec.ts`: an order on DIRECT terms advances past payment **only** on the webhook, never on any client-initiated call (FR-015)

### Implementation for User Story 2

- [X] T049 [P] [US2] Add the `PricingConfig` sub-document (`deliveryFee`, `serviceFeePercent`, `taxRatePercent`, `tankerCapacitiesLiters`, `updatedAt`) to `src/modules/companies/schemas/company.schema.ts`, beside the existing `fuelPrices`. `tankerCapacitiesLiters` is non-empty and ascending
- [X] T050 [P] [US2] Add the `PriceBreakdown` sub-document to `src/modules/orders/schemas/order.schema.ts` — four components, three input rates, `currency`, `pricedAt` — **optional**, since orders predating this feature have none
- [X] T050a [P] [US2] Add the same optional `priceBreakdown` sub-document to `src/modules/invoices/schemas/invoice.schema.ts` (FR-011e). Copied at issuance, never recomputed — an invoice must stay self-consistent even if its order is later amended
- [X] T051 [US2] Implement `PricingService` in `src/modules/orders/services/pricing.service.ts`: derive the breakdown per FR-011g, round half-up to 2dp per component, sum the rounded components for the total
- [X] T052 [US2] Add quote-token generation and validation to `PricingService` — a hash of the pricing inputs (fuel price + all three rates) plus a short expiry. **The server always recomputes from its own configuration and never trusts a number from the app** (research R10)
- [X] T053 [US2] Add `GET /companies/:id/pricing-config` (FUEL_COMPANY_ADMIN, CLIENT) and `PUT /companies/:id/pricing-config` (FUEL_COMPANY_ADMIN) to `src/modules/companies/companies.controller.ts`, reusing the existing `assertCompanyAccess`
- [X] T054 [US2] Add `POST /orders/quote` (CLIENT) to `src/modules/orders/orders.controller.ts`, returning breakdown + `quoteToken` + `expiresAt`
- [X] T055 [US2] Extend `POST /orders` in `src/modules/orders/orders.service.ts` to require `stationId` and `quoteToken`, revalidate the token inside the existing creation transaction, persist `priceBreakdown`, and return `409 QUOTE_STALE` with the current breakdown on mismatch
- [X] T055a [US2] Copy the order's `priceBreakdown` onto the invoice at issuance in `src/modules/invoices/invoices.service.ts`, **inside the existing issuance transaction**, asserting `priceBreakdown.total === invoice.amount` before commit (Principle V). If they can diverge, the client sees two figures for one debt
- [X] T056 [US2] Return `tankerCapacitiesLiters` from `GET /companies/:id/pricing-config` so the app stops using its own hardcoded ladder (FR-017). **Source it from the fuel company's own configuration only** — deriving it from `Truck.maxCapacityLiters` would read transport companies' fleet records across a tenant boundary (FR-017a)
- [X] T057 [P] [US2] Add the quote datasource and `GetQuote` use case under `mobile_app/lib/features/orders/data/datasources/` and `domain/usecases/`, registered in `injector.dart`
- [X] T058 [US2] Wire `mobile_app/lib/features/orders/presentation/widgets/create_order/station_section.dart` to `GET /stations`, deleting `kFavouriteStations` and `kStationOptions` from `create_order_data.dart`
- [X] T059 [US2] Wire grade selection in `mobile_app/lib/features/orders/presentation/widgets/create_order/grade_section.dart` to the supplier's real fuel prices, offering only grades sold (FR-010)
- [X] T060 [US2] Replace the hardcoded quantity ladder in `create_order_data.dart` with platform-supplied capacities from T056
- [X] T061 [US2] Display the itemised breakdown in `mobile_app/lib/features/orders/presentation/widgets/order_detail/receipt_breakdown.dart`, and render a **total-only** receipt when `priceBreakdown` is absent (pre-feature orders — absence is not an error and not zeros)
- [X] T062 [US2] Handle `QUOTE_STALE` in `mobile_app/lib/features/orders/presentation/view/create_order_screen.dart`: show the new total and require explicit re-confirmation — never silently adopt either figure
- [X] T063 [US2] Submit `stationId` and `quoteToken` from `mobile_app/lib/features/orders/presentation/widgets/create_order/confirm_button.dart`, surfacing the platform's rejection reason verbatim (FR-016)

**Checkpoint**: A client orders at a real, itemised, server-authoritative price.

---

## Phase 5: User Story 3 — Follow a delivery as it happens (Priority: P2)

**Goal**: Real driver, position, distance and ETA on the tracking screen, with staleness reported.

**Independent Test**: Driver identity and position match the platform; stopping updates surfaces
a stale state within one window.

### Tests for User Story 3

- [X] T064 [P] [US3] Cubit test in `mobile_app/test/unit/tracking_cubit_stale_test.dart`: staleness is reported after `AppDurations.locationStaleWindow` with no update, evaluated against the wall clock

### Implementation for User Story 3

- [X] T065 [US3] Mount the existing `TrackingCubit` and `OrderDetailCubit` in `mobile_app/lib/features/orders/presentation/view/track_order_screen.dart`, removing all static values
- [X] T066 [P] [US3] Bind real driver name, plate and ETA in `mobile_app/lib/features/orders/presentation/widgets/track_order/driver_card.dart` and `tracking_stats_card.dart`, from `driverSummary` / `etaMinutes`
- [X] T067 [P] [US3] Bind the live marker and remaining distance in `mobile_app/lib/features/orders/presentation/widgets/track_order/tracking_map.dart`. Real `GoogleMap` with driver/destination markers and a camera that follows updates; distance via `Geolocator.distanceBetween`. **Needs a real `GOOGLE_MAPS_API_KEY` (`--dart-define`) and on-device verification** — the platform-side key plumbing (`AndroidManifest.xml`, `AppDelegate.swift`, `Info.plist`, `build.gradle.kts`) was already in place; untestable in `flutter test` since no platform channel is registered there
- [X] T068 [US3] Render the stale-position state (FR-020) and the not-yet-trackable state (FR-021) in `track_order_screen.dart` — the latter explanatory, not an error or an empty map
- [X] T069 [US3] Bind the handover code in `mobile_app/lib/features/orders/presentation/widgets/track_order/pickup_code_card.dart` to the real `GET /orders/:id/otp/current`, reflecting expiry, shown on the **client build only**

**Checkpoint**: Live tracking reflects reality, including when it goes stale.

---

## Phase 6: User Story 4 — Know what I owe and what I have paid (Priority: P2)

**Goal**: Real invoices and real payment history, with settlement only on platform confirmation.

**Independent Test**: Every amount, date and status matches the platform; settling changes the
platform record.

### Tests for User Story 4

- [X] T070 [P] [US4] E2E test in `test/e2e/payments-history.e2e-spec.ts`: a CLIENT sees only their own payments, and **`rawPayload` is absent from every response** (Principle II — it can carry gateway card metadata)
- [X] T071 [P] [US4] E2E test in `test/e2e/payments-history.e2e-spec.ts`: pagination across 25+ payment events, no repeats or skips
- [X] T072 [P] [US4] E2E test in `test/e2e/billing-edge-cases.e2e-spec.ts` (extend): settling an already-settled invoice is refused, with no double payment
- [X] T072a [P] [US4] E2E test in `test/e2e/billing-edge-cases.e2e-spec.ts`: with 30+ settled invoices newer than one outstanding invoice, the outstanding one still appears on the **first** page (FR-048f). Newest-first alone would bury it past where any client scrolls, while it keeps counting against their credit

### Implementation for User Story 4

- [X] T073 [US4] Paginate `GET /invoices` in `src/modules/invoices/invoices.controller.ts` using the cursor utility, sorted **outstanding before settled** then newest-first within each group (FR-048f). The cursor must encode `state` alongside `createdAt` and `_id`, or the ordering is unstable across pages
- [X] T073a [US4] Include `priceBreakdown` in the `GET /invoices` and `GET /invoices/:id` responses, tolerating its absence on pre-feature invoices (already present — Mongoose returns the full document and nothing projects it away; T072a's fixture invoices and the pre-existing pricing-breakdown suite both confirm it round-trips)
- [X] T074 [US4] Add `GET /payments` (CLIENT, paginated) to `src/modules/payments/payments.controller.ts`, filtered to terminal outcomes, **projecting `rawPayload` away explicitly** rather than relying on it being forgotten
- [X] T075 [US4] Set `clientId` on every new `PaymentEvent` at write time in `src/modules/payments/payments.service.ts`
- [X] T075a **GATE** [US4] Immediately after T075, run `npx jest --config ./test/jest-e2e.json --runInBand payment-idempotency billing-transaction-integrity`. T075 modifies the payment-webhook write path, and payment idempotency is a constitution-named guarantee (§Development Workflow & Quality Gates). Do not defer this to T132 — 50+ tasks of distance makes a regression here expensive to attribute
- [X] T076 [P] [US4] Add the payments datasource, repository, `GetPayments` use case and `PaymentsCubit` under `mobile_app/lib/features/payments/{data,domain,presentation}/`, registered in `injector.dart`
- [X] T077 [US4] Rewrite `mobile_app/lib/features/payments/presentation/view/client_payments_screen.dart` to mount `PaymentsCubit`, removing the hardcoded `'ORD-2024-256'` rows. **Card fields changed**: `PaymentEvent` carries no fuel type/quantity/address/progress (those are order-level, not payment-level) — the card now shows reference/gateway/date/amount only, never a fabricated field
- [X] T078 [US4] Mount `InvoicesCubit` (new, mirroring `OrdersCubit`) in `mobile_app/lib/features/invoices/presentation/view/client_invoices_screen.dart` with pagination, empty and error states. **Deviation**: task text said "the existing FinanceCubit" — kept `FinanceCubit` scoped to the home dashboard's totals (now looping every page internally) and gave the scrolling list its own cubit instead of overloading one cubit with two different jobs; tabs also renamed to the real `InvoiceState` values (outstanding/paid/voided) since "deferred"/"failed" never mapped to a real state
- [X] T078a [US4] Render the invoice's itemised breakdown in a new `invoice_detail_screen.dart` (`/client/invoices/:id`, reached from the invoices list), reusing `ReceiptBreakdown` from T061 so the two cannot drift apart, and falling back to total-only when absent (FR-011e)
- [X] T079 [US4] Mount `PaymentCubit` in `mobile_app/lib/features/orders/presentation/view/invoice_payment_screen.dart`, removing the mock invoice-number/pay-button placeholder; the invoice stays outstanding until the platform confirms (`PaymentAwaitingConfirmation`), with a pending-confirmation message (FR-024), and a distinct window-expired message when `paymentDeadline` lapses first

**Checkpoint**: A client sees and settles real money.

---

## Phase 7: User Story 5 — Understand my credit standing (Priority: P2)

**Goal**: Real limit, consumed and available, agreeing everywhere they appear.

**Independent Test**: Figures match the platform's own calculation and agree between the
dashboard and the credit screen.

### Tests for User Story 5

- [X] T080 [P] [US5] E2E test in `test/e2e/billing-credit.e2e-spec.ts` (extend): `GET /users/me/credit` agrees with the value the order path uses to refuse over-limit orders, and returns `creditLimit: null` when no facility is assigned

### Implementation for User Story 5

- [X] T081 [US5] Add `GET /users/me/credit` (CLIENT) to `src/modules/users/users.controller.ts`, delegating to the **existing** `InvoicesService.getAvailableCredit` and deriving `consumed = limit − available`. Compute live; store nothing (research R6)
- [X] T082 [P] [US5] Add the credit datasource, `GetCreditStanding` use case and `CreditCubit` under `mobile_app/lib/features/invoices/{data,domain,presentation}/`, registered in `injector.dart`
- [X] T083 [US5] Mount `CreditCubit` in `mobile_app/lib/features/more/presentation/view/client_credit_limit_screen.dart`, with a distinct "no facility assigned" state (FR-027) — added the real-facility display too, since the screen previously had UI for the empty state only
- [X] T084 [US5] Source the home dashboard's finance cards from the same endpoint in `mobile_app/lib/features/home/presentation/view/client_home_screen.dart` so the two screens cannot disagree (FR-026). **Known remaining gap**: `order_detail_screen.dart`'s `CreditLimitCard` (a third place credit figures appear, on a CREDIT order's own detail page) is still its mock hardcoded default — out of this task's literal scope (dashboard + credit screen only) and not assigned anywhere else in this task list
- [X] T085 [US5] **(after T062 — same file)** Add the pre-submission over-limit warning with shortfall in `mobile_app/lib/features/orders/presentation/view/create_order_screen.dart` — a **courtesy check, not a gate**; the server-side refusal inside the order transaction remains authoritative (FR-028). **Prerequisite gap closed**: `PaymentSection` had no payment-method selector at all (CREDIT was unreachable, so this warning would have been permanently dead code) — the title/subtitle translation keys already existed unused, confirming this was the intended design; built the 3-way DIRECT/DEFERRED/CREDIT selector now, wired into `CreateOrder`'s `paymentMethod`

**Checkpoint**: Credit standing is real and internally consistent.

---

## Phase 8: User Story 6 — Be told when something changes (Priority: P3)

**Goal**: A real unread badge and a real notification list.

**Independent Test**: Raising a notification increases the badge; marking read persists.

### Tests for User Story 6

- [X] T086 [P] [US6] E2E test in `test/e2e/notifications.e2e-spec.ts`: `unreadCount` reflects the caller's **whole** set, not the current page, and drops on mark-read

### Implementation for User Story 6

- [X] T087 [US6] Paginate `GET /notifications` and add `unreadCount` (a `countDocuments` on the existing `readAt: null` filter — no stored counter, which would only drift) in `src/modules/notifications/notifications.controller.ts` and `notifications.service.ts`
- [X] T088 [US6] Mount `NotificationsCubit` in `mobile_app/lib/features/notifications/presentation/view/notifications_screen.dart` with pagination. **Also replaced**: the design's order/invoice/system filter chips never matched the real `AppNotification` shape (no such category exists on it) — replaced with the one real, server-applied filter (`?unread=true`); "mark all read" is now a real loop over `PATCH .../read` per visible unread item, no bulk endpoint existing
- [X] T089 [US6] **(after T084 — same file)** Replace the hardcoded `notificationCount: 3` in `mobile_app/lib/features/home/presentation/view/client_home_screen.dart` **and all 8 other client-facing `AppTopBar`/`MainNavBar` call sites** with the real unread count (`NotificationsCubit`, provided at the app root, same singleton everywhere), showing nothing when the count is zero (FR-030) — `AppTopBar` already had that zero-hides behavior built in
- [X] T090 [US6] Navigate to the referenced order on notification tap in `notifications_screen.dart` (FR-032), reusing the same role-aware (client vs driver) routing `NotificationBannerPresenter` already does for a pushed notification's banner

**Checkpoint**: Notifications are real and actionable.

---

## Phase 9: User Story 7 — Manage my own profile (Priority: P3)

**Goal**: Real profile, editable name and picture, and phone change gated on SMS verification.

**Independent Test**: Edits persist; a phone change takes effect only after the code is accepted.

### Tests for User Story 7

- [X] T091 [P] [US7] E2E test in `test/e2e/phone-verification.e2e-spec.ts`: the user's phone is **unchanged** until a correct code is submitted; an abandoned or expired verification leaves the original in force (FR-035c)
- [X] T092 [P] [US7] E2E test in `test/e2e/phone-verification.e2e-spec.ts`: a number already registered to another account yields `409 PHONE_IN_USE` and **no SMS is sent** (FR-035e)
- [X] T092a [P] [US7] E2E test in `test/e2e/phone-verification.e2e-spec.ts`: the code is dispatched to the **new** number and never to the user's existing one (FR-035b), asserted against the `SmsSender` test double. Sending to the current number would still "work" end to end while proving nothing about possession of the new one — a failure no manual test would notice
- [X] T093 [P] [US7] E2E test in `test/e2e/phone-verification.e2e-spec.ts`: 3 requests / 15 min and 5 attempts / code both throttle with `429` and `retryAfterSeconds`
- [X] T094 [P] [US7] E2E test in `test/e2e/phone-verification.e2e-spec.ts`: the code appears in **no** response body and no log line (FR-035g)

### Implementation for User Story 7

- [X] T095 [P] [US7] Create the `PhoneVerification` schema in `src/modules/users/schemas/phone-verification.schema.ts` per data-model.md, with a TTL index on `expiresAt` and **no plaintext code field**
- [X] T096 [US7] Implement `PhoneVerificationService` in `src/modules/users/services/phone-verification.service.ts` on top of `OtpPrimitivesService` (T007), superseding any prior unconsumed record on a new request
- [X] T097 [US7] Add `POST /users/me/phone/verification` and `POST /users/me/phone/verification/confirm` to `src/modules/users/users.controller.ts`, checking `PHONE_IN_USE` **before** sending, and returning `502 SMS_SEND_FAILED` rather than `202` when the provider rejects the send (FR-035f)
- [X] T098 [US7] Apply throttles via `@nestjs/throttler` on both endpoints — 3 requests / 15 min per user, 5 confirm attempts per code
- [X] T099 [P] [US7] Add the profile datasource, repository, use cases and `ProfileCubit` under `mobile_app/lib/features/profile/{data,domain,presentation}/`, registered in `injector.dart`
- [X] T100 [US7] Mount `ProfileCubit` in `mobile_app/lib/features/profile/presentation/view/profile_screen.dart`, showing real name, phone, stations and picture, with name editing via `PATCH /users/:id`
- [X] T101 [P] [US7] Add `PhoneVerificationCubit` under `mobile_app/lib/features/profile/presentation/cubit/`
- [X] T102 [US7] Wire `mobile_app/lib/features/profile/presentation/view/change_phone_screen.dart` and `verify_phone_screen.dart` to the cubit, handling send-failure with retry, throttle messages with a retry time, and `PHONE_IN_USE`
- [X] T103 [US7] Wire profile-picture upload in `profile_screen.dart` to the existing `PATCH /users/:id/profile-picture`

**Checkpoint**: A client manages their own profile; phone changes are verified.

---

## Phase 10: User Story 8 — Choose among my stations (Priority: P3)

**Goal**: The client sees and selects among their registered stations and marks favourites.

**Independent Test**: All registered stations listed; a non-default selection is recorded on the
order; no create/rename/delete control exists.

### Tests for User Story 8

- [X] T104 [P] [US8] E2E test in `test/e2e/client-station.e2e-spec.ts` (extend): a CLIENT cannot create, rename or delete a station — those routes do not exist for them (FR-036b) — and `PATCH /stations/:id/favourite` rejects any field but `isFavourite` via DTO whitelisting
- [X] T105 [P] [US8] E2E test in `test/e2e/client-station.e2e-spec.ts`: a CLIENT cannot read or favourite another client's station, **including one in their own fuel company** — the case company-scoping alone would miss
- [X] T106 [P] [US8] E2E test in `test/e2e/client-station.e2e-spec.ts`: deleting the last active station yields `409 LAST_STATION`; deleting the default promotes the next

### Implementation for User Story 8

- [X] T107 [US8] Add `PATCH /stations/:id/favourite` (CLIENT) in `src/modules/stations/stations.controller.ts` with a DTO whitelisting `isFavourite` alone
- [X] T108 [US8] Add the FUEL_COMPANY_ADMIN routes — `GET/POST /users/:id/stations`, `PATCH /stations/:id`, `DELETE /stations/:id` (soft delete) — in `src/modules/stations/stations.controller.ts`, with default promotion and the `LAST_STATION` guard
- [X] T109 [P] [US8] Add the stations datasource, repository, use cases and `StationsCubit` under `mobile_app/lib/features/stations/{data,domain,presentation}/`, registered in `injector.dart`
- [X] T110 [US8] Rewrite `mobile_app/lib/features/stations/presentation/view/client_stations_screen.dart` to mount `StationsCubit`, removing every hardcoded station, order and statistic — and presenting **no** create/rename/delete affordance
- [X] T111 [US8] Persist favourite toggling through the cubit (currently local-only `setState` in `station_section.dart`) so it survives restart and reaches other devices (FR-037)
- [X] T112 [US8] Implement the previously no-op "change station" action in `mobile_app/lib/features/home/presentation/view/client_home_screen.dart`
- [X] T113 [US8] Auto-select and demand no choice when a client has exactly one station (FR-036d), in `station_section.dart`

**Checkpoint**: Station selection is real; the client cannot exceed their permissions.

---

## Phase 11: User Story 9 — Get help with a specific order (Priority: P3)

**Goal**: A problem raised from an order reaches the client's fuel company with the order attached.

**Independent Test**: The client's fuel company admins receive it; no other company can see it.

### Tests for User Story 9

- [X] T114 [P] [US9] E2E test in `test/e2e/support-routing.e2e-spec.ts`: a request reaches **only** the client's own fuel company admins; another company's admin gets 404
- [X] T115 [P] [US9] E2E test in `test/e2e/support-routing.e2e-spec.ts`: attaching an order the client does not own yields 404; state transitions `SUBMITTED → ACKNOWLEDGED` only, with no reverse

### Implementation for User Story 9

- [X] T116 [P] [US9] Create the `SupportRequest` schema in `src/modules/support/schemas/support-request.schema.ts` per data-model.md, `markTenantScoped`, two states only
- [X] T117 [US9] Implement `SupportModule` / `SupportService` in `src/modules/support/`, raising a `SUPPORT_REQUEST_RAISED` notification to fuel company admins via the **existing** `NotificationsService.notify` (FR-038b — no second delivery path)
- [X] T118 [US9] Add `POST /support/requests`, `GET /support/requests` (CLIENT own / FUEL_COMPANY_ADMIN company-wide) and `PATCH /support/requests/:id/acknowledge` in `src/modules/support/support.controller.ts`
- [X] T119 [P] [US9] Add the support datasource, repository, use cases and `SupportCubit` under `mobile_app/lib/features/support/{data,domain,presentation}/`, registered in `injector.dart`
- [X] T120 [US9] Wire `mobile_app/lib/features/support/presentation/widgets/support_order_problem_card.dart` to submit with the order attached automatically (FR-038)
- [X] T121 [US9] Show submitted / acknowledged state in `mobile_app/lib/features/support/presentation/view/support_screen.dart`, keeping the phone and messaging channels prominent and **not implying a written reply will arrive in the app** (FR-039b)

**Checkpoint**: All nine stories independently functional.

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: Removal, verification and the checks that keep this from regressing.

**⚠️ Deliberately last**: deleting the sample data before the screens are wired leaves the app
unrunnable mid-feature.

- [X] T122 Delete `mobile_app/lib/features/orders/presentation/constants/order_mock_data.dart` and `mobile_app/lib/features/orders/presentation/widgets/order_detail/mock_order_state.dart` (FR-002)
- [X] T123 Verify `mobile_app/lib/features/auth/presentation/view/role_selection_mock_screen.dart` is unreachable in a release build; remove its route from `app_router.dart` if it is not
- [X] T124 Add a CI check failing the build when any `mock` identifier is reachable from a client route — a grep is sufficient and is the only thing that holds FR-002 over time
- [X] T125 [P] Add Arabic and English strings for every new state and error to `mobile_app/assets/translations/{ar,en}.json` with keys in `mobile_app/lib/core/localization/translation_keys.dart` — no literal in any widget (Principle I)
- [X] T125a [P] Route **every** monetary amount on the newly connected screens through the existing `NumberFormatting.currency` helper so currency and locale numerals are consistent (FR-029). Sweep for raw `toString()`/`toStringAsFixed()` on money values — the breakdown, payments and credit screens each introduce several
- [ ] T126 [P] Review every newly connected screen in Arabic (RTL) and English for clipping, mis-ordering and untranslated content (FR-044, SC-009)
- [ ] T126a Audit all 15 client screens for the full state set — loading indication, content, empty, and error-with-retry (FR-041). Only the orders list has this stated explicitly per-task; the rest inherit it by convention, which is how one screen ends up with a silent blank state
- [X] T127 Audit logs across a full client journey for credentials, OTPs and payment detail (FR-045, SC-010)
- [ ] T128 Seed a client with 500+ orders and verify first-page time matches a 5-order client (SC-004a) — this is what proves the T023 indexes are actually being used
- [X] T129 [P] Extend `npm run seed:dashboard` in `scripts/seed-dashboard-actors.ts` with a `pricingConfig`, multiple stations and 25+ orders, so the whole feature is exercisable locally
- [X] T130 Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` to absorb the delta in `contracts/rest-api-delta.md`, keeping one authoritative contract
- [ ] T130a Run every client screen under three network conditions — normal, throttled, and disconnected — confirming each reaches content, empty or error-with-retry, and that none blanks or hangs (SC-007). Use the emulator's network profiles; this is the check that catches a missing timeout path
- [ ] T131 Run the full `quickstart.md` verification for all nine stories
- [X] T132 Final gate: `npm test`, `npm run test:e2e`, `npm run lint:check`, `npm run lint:no-index`, and in `mobile_app/`: `flutter analyze`, `flutter test`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
  - Internal order is strict: T007–T010 → T011–T019 → T020–T029. The two gates (T010, T019) are
    hard stops, not formalities
- **User Stories (Phase 3–11)**: all depend on Foundational
- **Polish (Phase 12)**: depends on every story you intend to ship

### User Story Dependencies

- **US1 (P1)**: Foundational only. Fully independent — this is the MVP
- **US2 (P1)**: Foundational only. Needs `GET /stations` (T014, foundational) — not US8
- **US3 (P2)**: Foundational. Best demoed after US1, but independently testable
- **US4 (P2)**: Foundational only
- **US5 (P2)**: Foundational only. T085 must follow T062 — same file (`create_order_screen.dart`)
- **US6 (P3)**: Foundational only. T089 must follow T084 — same file (`client_home_screen.dart`)
- **US7 (P3)**: Foundational, specifically the OTP extraction (T007)
- **US8 (P3)**: Foundational, specifically the Station collection (T011–T014)
- **US9 (P3)**: Foundational only

No story depends on another story's completion. The two file-level collisions above are ordering
constraints recorded inline on T085 and T089, not cross-story dependencies — either story is still
independently testable.

**Two hard gates inside stories**, in addition to the Foundational gates: T075a (payment
idempotency, immediately after the webhook write path changes) and, in Phase 4, T055a must land
with T050a since an invoice cannot carry a breakdown its schema does not define.

### Within Each Story

Tests → schemas → services → endpoints → mobile data layer → mobile presentation. Backend
capability always precedes the screen consuming it.

### Parallel Opportunities

- Setup: T001–T005 all parallel (T006 touches config alone)
- Foundational: T020–T022 and T024 parallel; T025–T027 and T029 parallel. **T007–T019 are strictly
  serial** — that is the point of Stage 0
- Once Foundational lands, all nine stories can proceed in parallel across developers
- Within a story, every `[P]` task touches a different file

---

## Parallel Example: User Story 2

```bash
# Tests first (all different files or independent cases):
Task: "T044 Unit test — components sum exactly to total in test/unit/pricing.service.spec.ts"
Task: "T046 E2E test — PRICING_NOT_CONFIGURED in test/e2e/pricing-breakdown.e2e-spec.ts"

# Then the two schema changes, which touch different files:
Task: "T049 PricingConfig on src/modules/companies/schemas/company.schema.ts"
Task: "T050 PriceBreakdown on src/modules/orders/schemas/order.schema.ts"

# T051–T056 are serial (same service, then the controller that depends on it).
# T057 can start in the mobile repo as soon as the contract shape is fixed.
```

---

## Implementation Strategy

### MVP First

1. Phase 1 (Setup) → Phase 2 (Foundational, respecting both gates)
2. Phase 3 (US1)
3. **STOP and VALIDATE**: a client sees their real orders. If `ORD-2024-256` still appears
   anywhere, the phase is not done
4. Demo

US1 alone is a genuine MVP: the app's central falsehood — showing every client the same five
fabricated orders — is gone.

### Incremental Delivery

US1 → US2 (real pricing; the pair makes the app commercially usable) → US3/US4/US5 → US6–US9 →
Polish. Each increment ships without breaking the last.

### Parallel Team Strategy

Foundational is the bottleneck and cannot be parallelised — T007–T019 are serial by design.
Afterwards: one developer per story, with the three flagged file collisions (create-order screen,
home screen) coordinated rather than merged blind.

---

## Notes

- **The single largest risk is Foundational.** T010 and T019 are gates on the driver app, which
  this feature is not supposed to touch. A red suite there means stop, not proceed carefully
- Roughly half the mobile work is **mounting cubits that already exist** — any task that
  reimplements a registered repository, use case or cubit has misread the codebase
- `priceBreakdown` absent ≠ error ≠ zeros. Pre-feature orders **and invoices** legitimately have
  none; the app falls back to a total-only view in both places
- Tanker capacities come from the **fuel company's** configuration, never from `Truck.maxCapacityLiters` — those trucks belong to transport companies, a different tenant
- Company scoping is **not** client scoping — two clients share a fuel company. Every
  client-facing query needs `clientId` on top of the tenant plugin
- Commit per task or logical group; stop at any checkpoint to validate a story independently

---

## Task Summary

| Phase | Story | Tasks | Count |
|---|---|---|---|
| 1 | Setup | T001–T006 | 6 |
| 2 | Foundational | T007–T029 | 23 |
| 3 | US1 — Real orders (P1) 🎯 | T030–T043 | 14 |
| 4 | US2 — Real price (P1) | T044–T063 (incl. T048a–c, T050a, T055a) | 25 |
| 5 | US3 — Tracking (P2) | T064–T069 | 6 |
| 6 | US4 — Money (P2) | T070–T079 (incl. T072a, T073a, T075a, T078a) | 14 |
| 7 | US5 — Credit (P2) | T080–T085 | 6 |
| 8 | US6 — Notifications (P3) | T086–T090 | 5 |
| 9 | US7 — Profile (P3) | T091–T103 (incl. T092a) | 14 |
| 10 | US8 — Stations (P3) | T104–T113 | 10 |
| 11 | US9 — Support (P3) | T114–T121 | 8 |
| 12 | Polish | T122–T132 (incl. T125a, T126a, T130a) | 14 |
| | **Total** | | **145** |

**Test tasks**: 32 · **Parallelisable `[P]`**: 62 · **MVP scope**: T001–T043 (43 tasks)

**On the suffixed IDs** (T048a, T050a, …): these were inserted during the `/speckit-analyze`
remediation pass. Suffixes rather than a full renumber, so every cross-reference in this file and
in `plan.md` stays valid — a suffixed task executes in the position its number implies.
