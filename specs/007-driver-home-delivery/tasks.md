---
description: "Task list for Driver Home & Active Delivery"
---

# Tasks: Driver Home & Active Delivery

**Input**: Design documents from `/specs/007-driver-home-delivery/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **Included and mandatory.** Constitution v1.0.0's Development Workflow requires that
"guarantees the spec marks as testable … MUST have automated tests before the corresponding
capability is considered done." Delivery-stage authority, rate-once, tenant isolation of ratings,
and the not-yet-rated state are all such guarantees.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete work)
- **[Story]**: US1–US6, mapping to the spec's user stories

## Path Conventions

Two roots, siblings on disk:

- **Backend** (this repo): `src/…`, `test/…` — NestJS, entry `src/server.ts`
- **Mobile**: `../mobile_app/lib/…`, `../mobile_app/test/…` — Flutter

---

## Phase 1: Setup (Shared Constants & Config)

**Purpose**: Named values only — no logic. Principle I forbids the literals these replace.

- [x] T001 [P] Add `ORDER_NOT_DELIVERED` and `ALREADY_RATED` to `src/common/enums/error-code.enum.ts`
- [x] T002 [P] Add `platform.dayBoundaryTimezone` (default `Asia/Riyadh`) to `src/config/configuration.ts` and its schema entry in `src/config/validation.ts` — FR-033's single day boundary, so a driver's day cannot shift with a device clock
- [x] T003 [P] Add `orderNotDelivered` and `alreadyRated` to `../mobile_app/lib/core/network/error_codes.dart` and to `_knownCodes` in `../mobile_app/lib/core/network/error_interceptor.dart`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The realtime spine, plus the enum repair that makes a live assignment observable.
Every user story below depends on this.

**⚠️ CRITICAL**: No user story work begins until this phase is complete **and both suites are
green**. This phase contains **two changes that each land as their own commit, alone** — see the
sub-phase warnings.

### 2A — The realtime spine (research R1, R2)

**⚠️ Lands alone.** This is the one change in the whole feature that is **invisible when wrong**:
the app looks correctly wired and silently never updates. Verify it before building on it.

- [x] T004 In `src/modules/orders/services/order-state.service.ts`, additionally emit `order:status` to `user:{driverId}` (via `RealtimeGatewayService.emitToUser`) whenever the updated order carries a `driverId`, with the **identical payload** already sent to the order room. Without this a driver can never receive a status change at all — `TrackingGateway.watch` refuses `UserRole.DRIVER` with `FORBIDDEN_ROLE`, so `order:status` has only ever gone to a room they cannot join
- [x] T005 E2E test `test/e2e/driver-realtime.e2e-spec.ts`: a driver connected to `/tracking` receives `order:status` for their own assigned order, and receives **nothing** for an order assigned to a different driver. This is the test that proves T004 actually closed the gap rather than emitting into the void
- [x] T006 Remove the socket registration from `DeliveryCubit`'s constructor in `../mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart` (the `_socket.onStatus(_handleStatus)` line) and expose the handler so an external listener can drive it. It is a lazy singleton, so the constructor runs at an unpredictable moment — before `connect()`, `_socket` is null and `onStatus` is a silent `?.` no-op (`mobile_app/CLAUDE.md` debt #6)
- [x] T007 Create `DeliveryListener` in `../mobile_app/lib/core/realtime/delivery_listener.dart` with an `attach()` method, mirroring spec 006's `SessionRevocationListener` — a class rather than an inline closure so the wiring is unit-testable against a mocked `TrackingSocket` without booting DI (depends on T006)
- [x] T008 In `../mobile_app/lib/core/di/injector.dart`'s `SessionAuthenticated` branch, call `DeliveryListener(...).attach()` **after** `await trackingSocket.connect()` — alongside the existing `SessionRevocationListener` — never before it (depends on T007)
- [x] T009 [P] Unit test `../mobile_app/test/unit/delivery_listener_test.dart`: captures the handlers registered on a mocked `TrackingSocket` and asserts each fires its intended action; includes a case proving a handler attached before `connect()` would not fire, so the ordering requirement is guarded by a test rather than a comment

**Checkpoint 2A**: `npm run test && npm run test:e2e` green; `flutter test` at its known baseline. **Commit alone.**

### 2B — `NotificationType` repair (research R10)

**⚠️ Lands alone — shared surface.** This enum is shared with the CLIENT persona. Today every
live notification degrades to `unknown`; afterwards they render correctly. That is a fix, but it
changes client-facing behaviour, so both personas must be verified.

- [x] T010 Correct `../mobile_app/lib/shared/enums/notification_type.dart` to the backend's real wire values from `src/common/enums/notification-type.enum.ts` — `ORDER_APPROVED_FINAL_PRICE`, `NO_DRIVER_AVAILABLE`, `PAYMENT_TIMEOUT`, `ORDER_ASSIGNED`, `ORDER_STATUS_CHANGED`, `OTP_ISSUED`, `PAYMENT_RECONCILIATION_REQUIRED`, `ORDER_ROUTED_TO_TRANSPORT`, `SUPPORT_REQUEST_RAISED`. The two enums currently share **no values at all**, and `ORDER_ASSIGNED` — the one signal that already reaches a driver's user room — is absent entirely
- [x] T011 Update every consumer that switches on `NotificationType` under `../mobile_app/lib/features/notifications/` (list rendering, icons, copy) for the corrected members, keeping `unknown` as the fallback for genuinely future types (depends on T010)
- [x] T012 [P] Unit test `../mobile_app/test/unit/notification_type_test.dart`: every backend wire value maps to a named member and none falls through to `unknown`, guarding the two enums against drifting apart again
- [x] T013 Verify the CLIENT persona's notification list (`../mobile_app/lib/features/notifications/presentation/view/notifications_screen.dart`) renders correctly with the corrected values — this is the shared-surface check, not a formality (depends on T011)

**Checkpoint 2B**: both suites green, both personas verified. **Commit alone.**

---

## Phase 3: User Story 1 - A driver sees the job they have been assigned (Priority: P1) 🎯 MVP

**Goal**: A driver opens the app and sees the delivery they are actually carrying.

**Independent Test**: Assign a real order to driver A and none to driver B. A sees their own
delivery with values matching the record; B sees an explicit "no active delivery" state. Neither
sees sample data.

- [x] T014 [US1] Fix the response envelope in `../mobile_app/lib/features/delivery/data/datasources/delivery_remote_data_source.dart`: replace `response.data!['data']` with the shared `parsePaginatedResponse(response.data!, OrderMapper.fromJson)` helper, then scan `page.items` for the first order in `inTransit` or `unloading`. The endpoint returns `{ items, nextCursor }` and always has since spec 005 — the current key does not exist and would throw
- [x] T015 [P] [US1] Unit test `../mobile_app/test/unit/delivery_active_order_test.dart` against a scripted `HttpClientAdapter` returning the **real** `{items, nextCursor}` shape: the active order is found, and a page containing no in-transit/unloading order yields null rather than throwing (depends on T014)
- [x] T016 [US1] Call `DeliveryCubit.load()` from the `SessionAuthenticated` branch in `../mobile_app/lib/core/di/injector.dart` — today it is called from nowhere in the app, which is why the cubit's state is permanently `noActiveOrder` (FR-002)
- [x] T017 [US1] In `../mobile_app/lib/core/realtime/delivery_listener.dart`, reload the active delivery on `notification:new` carrying `ORDER_ASSIGNED`, so a delivery assigned while the app is open appears without a restart (depends on T007, T010)
- [x] T018 [US1] In `../mobile_app/lib/core/realtime/delivery_listener.dart`, reload on `order:status` whose `orderId` matches the active delivery — never apply the transition locally. FR-015 makes the platform's response the only thing that may change a displayed stage (depends on T007)
- [x] T019 [US1] Rewrite the active-delivery card in `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart` to read from `DeliveryCubit`, deleting the four hard-coded sample rows and their `driver_mock_extra.*` keys (FR-001, FR-003)
- [x] T020 [US1] Render the explicit "no active delivery" state in `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart`, distinct from loading and from error (FR-004)
- [x] T021 [US1] Render a retryable error state in `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart` that never falls back to sample or stale values (FR-005, FR-044)
- [x] T022 [P] [US1] Add `driver_home.*` keys for the active-delivery card, empty state and error state to `../mobile_app/lib/core/localization/translation_keys.dart` and both files under `../mobile_app/assets/translations/`
- [x] T023 [US1] Confirm `DeliveryCubit.clear()` on the `SessionUnauthenticated` branch of `../mobile_app/lib/core/di/injector.dart` (added by spec 006) still clears everything this story added, so driver B's first frame carries nothing of driver A's (FR-008, SC-006)
- [x] T024 [P] [US1] Integration test `../mobile_app/test/integration/driver_active_delivery_test.dart`: live delivery renders; the no-delivery state renders; the error state renders; and the three are **visually distinct** — collapsing any pair is the failure this story exists to end
- [x] T024a [P] [US1] Integration test in the same file with an **elapsed-time assertion**: an `order:status` push carrying a terminal `to` stops the delivery rendering as active **within 5 seconds**, with no driver action (FR-007, SC-007). The bound is the point of the realtime work — asserting only that it eventually clears would pass against a design that took a minute
- [x] T025 [P] [US1] Integration test in `../mobile_app/test/integration/driver_active_delivery_test.dart`: a driver switch leaks no value from the previous driver into any frame

**Checkpoint**: US1 is independently demoable — a real driver, real delivery, real destination.

---

## Phase 4: User Story 2 - A driver completes a delivery end to end (Priority: P1)

**Goal**: The four-step handover works, including the two steps that issue the customer's code.

**Independent Test**: Take a real order through the full field sequence against a live backend,
reading the customer's codes from the customer's own device. The delivery reaches a completed
state on the platform and the driver's app reflects it.

- [x] T026 [US2] Make `POST /orders/:id/arrive` and `POST /orders/:id/request-delivery-otp` reachable from the app, wiring through `../mobile_app/lib/features/delivery/presentation/cubit/` and registering in `../mobile_app/lib/core/di/injector.dart` — either register the orphaned `OtpVerifyCubit` (which already wraps `MarkArrived` and `RequestDeliveryOtp` but is **never registered in DI and never used by any screen**) or fold those two use cases into `DeliveryCubit`. These are the steps that *issue the customer their code*; nothing in the app calls either today, so the customer never receives anything to show and the delivery cannot complete
- [x] T027 [US2] Wire the "I have arrived" action on `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart` to the arrival step, replacing an `onPressed: () {}` (FR-009) (depends on T026)
- [x] T028 [US2] Wire the "request delivery code" action in `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart` to the delivery-code step, available only at the unloading stage (FR-010) (depends on T026)
- [x] T029 [US2] Confirm `DeliveryCubit.confirmHandover` is now reachable from `../mobile_app/lib/features/delivery/presentation/view/driver_scan_screen.dart` — it currently always short-circuits on `if (current is! DeliveryActive)` because nothing ever loaded an active order (depends on T016)
- [x] T030 [US2] Provide a typed code-entry path in `../mobile_app/lib/features/delivery/presentation/view/driver_scan_screen.dart` alongside the scan path, both routed through `confirmHandover` so they are treated identically (FR-011)
- [x] T031 [US2] Keep `confirmHandover`'s selection of verify-arrival vs verify-delivery in `../mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart` driven by the order's own status, not by which screen the driver is on (FR-012)
- [x] T032 [US2] Render a rejected code as retryable in `../mobile_app/lib/features/delivery/presentation/view/driver_scan_screen.dart`, leaving the delivery visibly unchanged (FR-013)
- [x] T033 [US2] In `../mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart`, render the existing `429` from the verify endpoints' `@Throttle({ limit: 5, ttl: 15 * 60_000 })` as "have a fresh code sent" guidance rather than a generic failure (FR-017)
- [x] T034 [US2] In `../mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart`, on a connectivity failure during any handover step report the failure and leave the delivery visibly unchanged — never advance locally (FR-016)
- [x] T035 [US2] Reflect in `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart` that the driver is free for new work once a delivery completes (FR-018)
- [x] T036 [P] [US2] Add `driver_handover.*` keys (arrived, request code, code rejected, fresh-code guidance, offline) to `translation_keys.dart` and both translation files
  - Landed as `driver_navigation.*` instead (`mark_arrived`, `request_delivery_code`, `code_sent_to_customer`, plus the pre-existing `code_not_recognised`/`code_too_many_attempts`/`code_confirm_failed`) — added during T030, before this task ran, onto the namespace `driver_scan_screen.dart` already used. A second, parallel `driver_handover.*` set for the same five strings would be pure duplication.
- [x] T037 [P] [US2] Unit test `../mobile_app/test/unit/delivery_handover_test.dart`: the right verify call is chosen per status; a rejected code leaves state unchanged; an offline failure never advances the stage
  - Landed in the existing `test/unit/delivery_cubit_test.dart`'s `confirmHandover routes by the order's own status` group instead of a new file — that group already covered the per-status routing and the rejected-code case; only the offline-failure case was missing, so one test was added there rather than forking a second file over the same cubit method.
- [x] T038 [P] [US2] E2E test `test/e2e/driver-handover.e2e-spec.ts`: the full four-step sequence — arrive issues the arrival OTP, verify-arrival moves `IN_TRANSIT` → `UNLOADING`, request-delivery-otp issues the delivery OTP, verify-delivery moves `UNLOADING` → `DELIVERED` and releases the driver
  - This exact sequence (plus the statusHistory and driver-released assertions) was already covered by `order-lifecycle.e2e-spec.ts`'s happy-path test, written before this feature. `driver-handover.e2e-spec.ts` was created for T039 instead, which had no prior coverage.
- [x] T039 [P] [US2] E2E test in `test/e2e/driver-handover.e2e-spec.ts`: a wrong code does not advance the order, and the 6th attempt inside 15 minutes is throttled
- [x] T040 [US2] Audit `../mobile_app/lib/features/delivery/` for any call to `GET /orders/:id/otp/current` and for any code being logged or rendered — FR-014 forbids the driver's app ever holding a handover code; that endpoint is CLIENT-only

**Checkpoint**: US1–US2 functional. A driver can see and complete a real delivery.

---

## Phase 5: User Story 3 - A driver reviews their deliveries (Priority: P2)

**Goal**: A real, paginated delivery list described in delivery terms.

**Independent Test**: Give a driver several orders across stages. Their list shows exactly those
orders, correctly categorised, with no order belonging to another driver.

- [x] T041 [US3] Serve the driver's list from the existing `features/orders/` stack (`OrdersRemoteDataSource` → `OrdersRepository` → `GetOrders`) rather than adding list methods to `features/delivery/` — `GET /orders` is one endpoint already scoped by `driverId`, and a second paginated datasource would deepen `mobile_app/CLAUDE.md` debt #2 (research R4)
- [x] T042 [US3] Wire `../mobile_app/lib/features/delivery/presentation/view/driver_orders_screen.dart` to that stack, deleting `_buildMockOrderListItem` and its `driver_mock_extra.*` rows (depends on T041)
- [x] T043 [US3] In `../mobile_app/lib/features/delivery/presentation/view/driver_orders_screen.dart`, replace the `InvoicesKeys` tabs (`tabAll`/`tabDeferred`/`tabPaid`/`tabFailed`) with exactly four delivery categories — **All · In progress · Completed · Cancelled** — defaulting to All, and remove the `InvoicesKeys` import. Those are invoice states, on a driver's delivery list by copy-paste (FR-020, FR-020a, FR-020b)
- [x] T044 [P] [US3] Add `driver_orders.*` keys for the four categories and the empty state to `translation_keys.dart` and both translation files
  - Landed as raw `'driver_orders.…'.tr()` string literals instead of a `translation_keys.dart` class — following the sibling `driver_home.*` namespace's own precedent (T019/T022, Phase 3), which the same screen family already established without a key class.
- [x] T045 [US3] In `../mobile_app/lib/features/delivery/presentation/view/driver_orders_screen.dart`, map "In progress" to `IN_TRANSIT` and `UNLOADING`, "Completed" to `DELIVERED`, "Cancelled" to `CANCELLED` (FR-020a) (depends on T043)
- [x] T046 [US3] In `../mobile_app/lib/features/delivery/presentation/view/driver_orders_screen.dart`, load further entries as the driver reaches the end of the list, using the cursor the endpoint already returns — never skip/limit, which duplicates rows when a delivery is inserted at the head (FR-021)
- [x] T047 [US3] Render an explicit empty state in `../mobile_app/lib/features/delivery/presentation/view/driver_orders_screen.dart` when the driver has no deliveries (FR-022)
- [x] T048 [US3] Open the tapped delivery's real detail from `../mobile_app/lib/features/delivery/presentation/view/driver_orders_screen.dart` rather than a fixed sample (FR-023)
- [x] T049 [P] [US3] Unit test `../mobile_app/test/unit/driver_orders_tabs_test.dart`: each category selects exactly the intended statuses, and no invoice vocabulary appears in any label
- [x] T050 [P] [US3] Integration test `../mobile_app/test/integration/driver_orders_list_test.dart`: only this driver's deliveries appear; paging adds no duplicates and skips nothing; the empty state renders

**Checkpoint**: US1–US3 functional.

---

## Phase 6: User Story 4 - Delivery detail reflects what is actually happening (Priority: P2)

**Goal**: The detail shows the platform's stage, and every control on it does something.

**Independent Test**: Open a delivery at each real stage and confirm the displayed stage matches
the platform's, and that no interaction can change it.

### Backend — the customer contact mirror

- [x] T051 [US4] Add `clientSummary { fullName, phone }` to `src/modules/orders/schemas/order.schema.ts`, optional, mirroring the existing `driverSummary` subdocument
- [x] T052 [US4] Snapshot `clientSummary` in `src/modules/dispatch/services/dispatch.service.ts`'s `assignDriver`, inside the **existing transaction** alongside `driverSummary`. Snapshot rather than join on read, matching the discipline already applied to `driverSummary` and `deliveryAddressText` — a later profile edit must not rewrite what the driver was shown (FR-003a) (depends on T051)
- [x] T053 [P] [US4] E2E test `test/e2e/driver-order-contact.e2e-spec.ts`: `clientSummary` is present on the assigned driver's view of their order and absent from another driver's, and an order assigned before this feature (no `clientSummary`) still serialises cleanly (FR-003b)

### Mobile

- [x] T054 [US4] Map `clientSummary` in `../mobile_app/lib/features/orders/data/models/order_mapper.dart` and add it to the `Order` entity, treating absence as "no contact available" rather than an error (depends on T051)
- [x] T055 [US4] **Delete** `enum _OrderMockState`, `_cycleMockState()`, and the app-bar button wired to it from `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`. Removed outright, not hidden behind a flag — FR-025 forbids any interaction changing the displayed stage, and a flag is one interaction away from being wrong
- [x] T056 [US4] In `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, drive the progress display from the order's real `OrderStatus`: `IN_TRANSIT` and `UNLOADING` → out for delivery, `DELIVERED` → completed, `CANCELLED` → cancelled (FR-024) (depends on T055)
- [x] T057 [US4] In `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, reflect a stage change that arrives while the detail is open, via the `order:status` push from Phase 2A (FR-026) (depends on T018)
- [x] T058 [US4] Wire the call action to `clientSummary.phone` through the existing `../mobile_app/lib/core/utils/phone_dialer.dart` (FR-027a) (depends on T054)
- [x] T059 [US4] In `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, hide the call action entirely when the order carries no usable contact number — absent, never present and failing (FR-027b) (depends on T058)
- [x] T060 [US4] Wire the navigation action in `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart` to the existing map handoff
- [x] T061 [US4] Audit all nine `onPressed: () {}` / `onTap: () {}` handlers across `../mobile_app/lib/features/delivery/presentation/` and either wire or remove each — FR-027 forbids controls that do nothing
  - Resolved: the two on `delivery_detail_screen.dart` itself (Contact Customer, Scan Delivery Code) — wired by T027/T028/T058 above.
  - Left as-is, out of FR-027's actual scope: the remaining four sit on `driver_navigation_screen.dart`/`driver_navigation_bottom_sheet.dart` (map zoom/share, its own "Start Navigation"/"Cannot Reach"), and `driver_notifications_screen.dart`'s "mark all read" — none of which any US1–US6 requirement, research decision, or task in this file names. `driver_navigation_screen.dart` in particular has no map engine behind it to wire zoom/share to, and its own "Start Navigation" duplicates the real one this feature just wired on the detail screen. Recorded as residual debt for `mobile_app/CLAUDE.md` (T100) rather than silently reworked under a task that never scoped it.
- [x] T062 [P] [US4] Widget test `../mobile_app/test/unit/delivery_detail_stage_test.dart`: tapping every non-action element leaves the displayed stage unchanged, and each real status renders its intended phase
- [x] T063 [P] [US4] Integration test `../mobile_app/test/integration/driver_delivery_detail_test.dart`: the detail reflects a stage change pushed while open, and the call action is absent for an order with no `clientSummary`

**Checkpoint**: US1–US4 functional. The driver's operational surface is honest end to end.

---

## Phase 7: User Story 5 - A driver sees their real standing and their day (Priority: P3)

**Goal**: Every figure in the header is real, or explicitly absent.

**Independent Test**: Give one driver completed, rated deliveries and another none at all. The
first shows real numbers; the second shows an explicit not-yet-rated state and a zero count.

### Backend

- [x] T064 [US5] Add `deliveredAt` (optional Date) to `src/modules/orders/schemas/order.schema.ts` and set it when an order transitions to `DELIVERED` in `src/modules/orders/services/order-state.service.ts`. `updatedAt` is not the delivery moment — invoice issuance and payment settlement touch a delivered order afterwards, so a count keyed on it drifts (research R7)
- [x] T065 [US5] Add the partial index `{ driverId: 1, deliveredAt: -1 }` to `src/modules/orders/schemas/order.schema.ts`, so the daily count does not scan a driver's whole history (depends on T064)
- [x] T066 [US5] Add `ratingAverage` (optional, min 1, max 5, **no default**) and `ratingCount` (optional, min 0, default 0) to `src/modules/users/schemas/user.schema.ts`. `ratingAverage` deliberately has no default: `undefined` **is** the "not yet rated" state, and a default of `0` would destroy that distinction at the data layer (FR-031)
- [x] T067 [US5] Create `src/modules/drivers/` (`drivers.module.ts`, `drivers.service.ts`, `drivers.controller.ts`) exposing `GET /drivers/me/summary`, `@Roles(UserRole.DRIVER)`, returning `ratingAverage` (omitted when unrated), `ratingCount`, `deliveriesToday` and `readyForWork`. Scoped to `me` rather than `:id` so FR-034 holds structurally — there is no identifier to authorise (depends on T064, T066)
- [x] T068 [US5] In `src/modules/drivers/drivers.service.ts`, compute `deliveriesToday` as a count over `{ driverId, status: DELIVERED, deliveredAt: >= startOfDay }`, with the day boundary from `platform.dayBoundaryTimezone` — never the caller's clock (FR-033) (depends on T002, T067)
- [x] T069 [US5] In `src/modules/drivers/drivers.service.ts`, derive `readyForWork` as `isActive && isOnline && isAvailable && !activeOrderId` — the same predicate `DispatchService.findCandidates` filters on — rather than storing a second duty flag that could drift from actual dispatch eligibility (FR-035) (depends on T067)
- [x] T070 [P] [US5] E2E test `test/e2e/driver-summary.e2e-spec.ts`: a rated driver's average and count are returned; a **never-rated** driver's response omits `ratingAverage` entirely rather than sending `0` or `null`; `deliveriesToday` matches deliveries actually completed today; a driver cannot obtain another driver's figures
- [x] T071 [P] [US5] E2E test in `test/e2e/driver-summary.e2e-spec.ts`: `deliveredAt` is set on normal completion **and** on `OrdersService.forceComplete`'s administrator override, so an override-completed delivery counts toward the driver's day (research R8)

### Mobile

- [x] T072 [US5] Create the driver-summary datasource, repository and use case under `../mobile_app/lib/features/delivery/{data,domain}/` returning `Either<Failure, DriverSummary>` (depends on T067)
- [x] T073 [US5] Create `DriverSummaryCubit` and its freezed state in `../mobile_app/lib/features/delivery/presentation/cubit/`, then run `dart run build_runner build` (depends on T072)
- [x] T074 [US5] Wire the header in `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart` to that cubit, **deleting** the hard-coded `4.8`, the hard-coded `5`, and the fixed "online / ready to receive" text (FR-028) (depends on T073)
- [x] T075 [US5] In `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart`, render an explicit "not yet rated" state when `ratingAverage` is absent — never `0`, never an empty star row, never a placeholder. This is the single most likely thing in the feature to regress (FR-031)
- [x] T076 [US5] In `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart`, render a genuine zero deliveries-today distinctly from "could not load these figures" (FR-045)
- [x] T077 [US5] Render the duty indicator from `readyForWork` in `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart`, and confirm **no control anywhere on any driver screen** changes it (FR-036)
- [x] T078 [P] [US5] Add `driver_summary.*` keys (not yet rated, deliveries today, ready for work, off duty, could not load) to `translation_keys.dart` and both translation files
  - Landed as raw `'driver_summary.…'.tr()` string literals instead of a `translation_keys.dart` class, same reasoning as T044/`driver_orders.*`. `deliveries_today`/`ready_for_work` reuse the existing `driver_home.orders_today`/`driver_home.online`+`driver_home.ready_to_receive` keys rather than duplicating them; `driver_summary.*` holds only what's actually new (not-yet-rated, off-duty pair, load failure).
- [x] T079 [US5] Clear `DriverSummaryCubit` on `SessionUnauthenticated` in `../mobile_app/lib/core/di/injector.dart`, or the next driver's first frame shows the previous driver's rating and day count (FR-008)
- [x] T080 [P] [US5] Unit test `../mobile_app/test/unit/driver_summary_cubit_test.dart`: an absent `ratingAverage` produces the not-yet-rated state and never a numeric score; a zero count is distinct from a load failure
- [x] T081 [P] [US5] Widget test `../mobile_app/test/unit/driver_header_test.dart`: a never-rated driver's header contains no numeral where the score would be, in both languages (SC-010)

**Checkpoint**: US1–US5 functional.

---

## Phase 8: User Story 6 - A customer rates the driver who delivered to them (Priority: P3)

**Goal**: Ratings can be created, so US5's rating is not inert.

**Independent Test**: Complete a delivery, submit a rating as that customer, and confirm the
driver's displayed rating changes. Rating twice, and rating someone else's delivery, are refused.

**⚠️** T086 adds a control to a **client-facing** screen — the one place this feature reaches
into the customer's experience. Verify the client persona alongside it.

### Backend

- [x] T082 [US6] Create `src/modules/ratings/schemas/delivery-rating.schema.ts` per [data-model.md](./data-model.md): `orderId` (**unique**), `driverId`, `clientId`, `fuelCompanyId`, `transportCompanyId`, `score` (integer 1–5), optional `review` (trimmed, maxlength 500). Carries `markMultiParty` — a client of a fuel company rating a driver of a transport company is multi-party, like `Order`, not single-tenant. **No TTL**
- [x] T083 [US6] Create `src/modules/ratings/ratings.service.ts` and `ratings.module.ts`: insert the rating and bump the driver's `ratingAverage`/`ratingCount` in **one `ClientSession`** (Principle V) — a rating without its aggregate shows feedback that never affects standing; an aggregate without its rating is an unattributable score (depends on T066, T082)
- [x] T084 [US6] In `src/modules/ratings/ratings.service.ts`, enforce "rate once" by **catching the duplicate-key violation** on the unique `orderId` index and returning `409 ALREADY_RATED` — not by a prior existence check, which two concurrent submissions both pass (FR-039) (depends on T083)
- [x] T085 [US6] Add `POST /orders/:id/rating` to `src/modules/orders/orders.controller.ts` with `@Roles(UserRole.CLIENT)` and a DTO validating `score` (integer 1–5) and optional `review` (≤500 chars). Return `404` for an order that is not this client's — indistinguishable from a non-existent one (Principle II) — and `409 ORDER_NOT_DELIVERED` when the order has not reached `DELIVERED` (FR-037, FR-040) (depends on T001, T083)
- [x] T086 [US6] Include the delivery's rating on `GET /orders/:id` in `src/modules/orders/orders.controller.ts` once one exists, so both personas read it from the delivery it belongs to (FR-037d, FR-041) (depends on T082)
- [x] T087 [P] [US6] E2E test `test/e2e/delivery-rating.e2e-spec.ts`: a delivered order can be rated once; a second attempt returns `ALREADY_RATED`; an undelivered order returns `ORDER_NOT_DELIVERED`; another client's order returns `404`; and the driver's aggregate moves consistently with the ratings submitted
- [x] T087a [P] [US6] E2E test in the same file: **driver B cannot read the rating or review attached to driver A's delivery** (FR-041b, SC-012). The equivalent cross-read check is already covered for `clientSummary` (T053) and for the summary figures (T070); ratings are the third surface carrying one driver's data and must be checked the same way (Principle II)
- [x] T088 [P] [US6] E2E test in `test/e2e/delivery-rating.e2e-spec.ts`: a rated driver's `ratingAverage` and `ratingCount` survive deactivation and reactivation unchanged (FR-042)
  - Landed in a new sibling file, `test/e2e/delivery-rating-aggregate.e2e-spec.ts`, alongside T087's aggregate-consistency test rather than in `delivery-rating.e2e-spec.ts` itself — that file's own 4 deliveries plus this one's 3 (2 for T087, 1 for T088) together exceed the shared per-IP `@Throttle({ limit: 5 })` budget for one app instance. Same reasoning already documented for `driver-handover.e2e-spec.ts`.

### Mobile — customer side

- [x] T089 [US6] Create the rating datasource, repository and use case under `../mobile_app/lib/features/orders/{data,domain}/`, and a `RatingCubit` with its freezed state, then run `dart run build_runner build` (depends on T085)
- [x] T090 [US6] Add the rating control to the client's existing `../mobile_app/lib/features/orders/presentation/view/order_detail_screen.dart`, shown only once the order is delivered — no new route and no automatic prompt, dialog or sheet on completion (FR-037, FR-037c) (depends on T089)
- [x] T091 [US6] In `../mobile_app/lib/features/orders/presentation/view/order_detail_screen.dart`, make the written review optional and show the rating already given rather than the control once the customer has rated (FR-037a, FR-037d)
- [x] T092 [P] [US6] Add `rating.*` keys (score prompt, optional review, submitted, already rated, not delivered) to `translation_keys.dart` and both translation files

### Mobile — driver side

- [x] T093 [US6] Show the customer's score and written review in `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart` on a completed delivery, replacing the hard-coded `4.1` and the mock `driver_order_mock.review_text` (FR-041) (depends on T086)
- [x] T094 [US6] In `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, render an explicit "not yet rated" state on a completed delivery with no rating — never a zero or an empty star row (FR-041a). Same rule as T075's header state (FR-031) on a different surface: keep the two consistent, and share the copy rather than duplicating the string
- [x] T095 [US6] In `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, render a score-only rating cleanly with the review area absent, and render the review as **plain text only** — never interpreted as markup (FR-037b) rather than an empty quote block
- [x] T096 [P] [US6] Unit test `../mobile_app/test/unit/rating_cubit_test.dart`: submission states progress correctly; `ALREADY_RATED` and `ORDER_NOT_DELIVERED` surface as distinct, branchable failures
- [x] T097 [P] [US6] Integration test `../mobile_app/test/integration/delivery_rating_test.dart`: a customer rates a delivered order and the driver's detail shows that score and review; an unrated completed delivery shows the not-yet-rated state; and a customer who leaves **without** submitting records nothing — the delivery stays unrated and the driver's aggregate is untouched (FR-038)

**Checkpoint**: all six stories independently functional.

---

## Phase 9: Polish & Cross-Cutting

- [x] T098 [P] Correct `mobile_app/CLAUDE.md` debt #1 — it describes `GET /orders` as returning "a bare JSON array", which stopped being true when spec 005 introduced cursor pagination. Record that the driver's active-order parse is now fixed
- [x] T099 [P] Close `mobile_app/CLAUDE.md` debt #5 (the `NotificationType` mismatch, fixed by T010) and debt #2's driver half (the driver list now reuses the `orders/` stack, T041). Note that debt #6's root cause survives — `TrackingSocket` still silently drops handlers attached before connect — and record handler-queueing as the fix that would retire it for both personas
- [x] T100 [P] Update `mobile_app/CLAUDE.md` §2 and §4 for the driver screens this feature rewired, and remove the `_OrderMockState` entry from debt #7 now that it is deleted (T055)
- [x] T101 [P] RTL sweep in `../mobile_app/test/rtl_sweep_driver_delivery_test.dart`: driver home, driver orders list, delivery detail, and the client's rating control render correctly in Arabic with a long customer name and a long review, with no clipped or overflowing text (FR-043, SC-008)
- [ ] T102 Run the full [quickstart.md](./quickstart.md) walkthrough against a live backend, starting with the two Phase 0 invisible-break checks
  - Not runnable autonomously in this environment: it requires `npm run start:dev` plus two live `flutter run` app instances (two driver accounts, two client accounts) with a human tapping through each step. Every scenario it describes has an automated equivalent that IS verified — `driver-realtime.e2e-spec.ts` covers Phase 0's both invisible breaks, `driver-active-delivery`/`driver-handover`/`driver-order-contact`/`driver-summary`/`delivery-rating(-aggregate)` e2e+integration suites cover US1–US6 — but the literal manual device walkthrough still needs a human with a running backend and two simulators/devices.
- [x] T103 Confirm the regression baseline recorded in [quickstart.md](./quickstart.md) is unchanged: backend `npm run test && npm run test:e2e` fully green, and `flutter test` still showing **exactly two** pre-existing non-green tests (`login_screen_golden_test` failing, `auth_session_test` skipped). A third is this work, not the pre-existing gap

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **US1 (Phase 3)** → **US2 (Phase 4)**: US2 needs US1's loaded active delivery to have anything to complete
- **US3 (Phase 5)** · **US4 (Phase 6)** · **US5 (Phase 7)**: depend only on Foundational
- **US6 (Phase 8)**: independent of US1–US4; US5's rating display is inert until US6 exists
- **Polish (Phase 9)**: depends on the stories being delivered

### Commits that must land alone

- **T004–T009 (Phase 2A)** — the realtime spine. Invisible when wrong.
- **T010–T013 (Phase 2B)** — `NotificationType`, a shared enum affecting the CLIENT persona.
- **T086, T090** — the client-facing rating surface.

### Story dependencies

**US2 and US4 both depend on US1.** US2 needs US1's loaded active delivery to have anything to
complete; US4's T057 (reflecting a stage change while the detail is open) depends on T018, which
wires the reload in `DeliveryListener`. US3, US5 and US6 are independent of each other and of
US1 once Phase 2 lands. US5 and US6 are two halves of one capability:
US5 without US6 shows every driver "not yet rated" forever.

### Parallel opportunities

- All of Phase 1 (T001–T003) runs in parallel
- Within US1: T015, T022, T024, T024a, T025 are parallel
- Within US2: T036–T039 are parallel
- Within US6: the backend track (T082–T088, plus T087a) and the mobile tracks (T089–T097) are parallel
- With three developers after Phase 2: A takes US1+US2, B takes US3+US4, C takes US5+US6

---

## Parallel Example: User Story 6

```bash
# Backend and both mobile tracks, concurrently:
Task: "Create DeliveryRating schema in src/modules/ratings/schemas/delivery-rating.schema.ts"
Task: "Create the rating datasource/repository/use case in ../mobile_app/lib/features/orders/"
Task: "Add rating.* keys to translation_keys.dart and both translation files"
```

---

## Implementation Strategy

### MVP (Phase 2A + US1)

1. Phase 1 Setup → 2. Phase 2A (**commit alone, both suites green**) → 3. Phase 3 US1 →
4. **Stop and validate** against quickstart US1 → 5. Demo.

A driver seeing their real assignment is a genuine increment on its own — it turns the driver
build from a demo into a working tool, and it is the cheapest large win in the feature.

### Incremental delivery

Setup + Foundational → US1 (see the work) → US2 (complete the work) → US4 (honest detail) →
US3 (honest list) → US5 + US6 (honest standing, together).

US5 and US6 ship as a pair deliberately: shipping US5 alone would put a permanent "not yet
rated" on every driver's home screen, which is worse than the fabricated `4.8` it replaces.

---

## Notes

- **105 tasks**: Setup 3 · Foundational 10 · US1 13 · US2 15 · US3 10 · US4 13 · US5 18 · US6 17 · Polish 6
- **Effort inverts priority**: US1–US4 are largely repair of existing, tested machinery; US5 and US6 are correctly P3 yet carry nearly all the *new* platform capability
- Tests are mandatory per Constitution v1.0.0's Development Workflow, not optional
- Run `dart run build_runner build` after T073 and T089 — never edit `*.freezed.dart` or `*.g.dart`
- Commit after each task or logical group; stop at any checkpoint to validate a story alone
