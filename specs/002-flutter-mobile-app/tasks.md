---
description: "Task list for Client & Driver Mobile Application"
---

# Tasks: Client & Driver Mobile Application

**Input**: Design documents from `/specs/002-flutter-mobile-app/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (backend-integration, ui-state-contract), quickstart.md

**Tests**: Included for the guarantees the constitution marks testable — single-flight token refresh (SC-002), client-side OTP/state guards and location emit gate (SC-004/SC-008), and the two P1 end-to-end journeys. UI-only widgets are not test-gated.

**Organization**: By user story. US1 → US2 → US3 are all P1; US4 is P2. All paths are under the standalone `mobile_app/` root (never mixed with the NestJS backend).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 (auth/session), US2 (client orders), US3 (driver delivery), US4 (tracking/notifications)

## Path Conventions

- App code: `mobile_app/lib/...`; tests: `mobile_app/test/...`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Standalone Flutter project initialization and structure

- [X] T001 Create the Flutter project at repository-sibling root `mobile_app/` (org id, iOS + Android platforms) — separate from the NestJS backend
- [X] T002 Declare dependencies in `mobile_app/pubspec.yaml`: flutter_bloc, dio, socket_io_client, get_it, freezed_annotation, json_annotation, dartz, flutter_secure_storage, google_maps_flutter, geolocator, go_router, equatable, intl; dev: build_runner, freezed, json_serializable, bloc_test, mocktail, integration_test
- [X] T003 [P] Configure strict analysis in `mobile_app/analysis_options.yaml` (enable `strict-casts`, `strict-inference`, no implicit-dynamic; lint against literal role/status strings) per Constitution Principle I
- [X] T004 [P] Create the layered folder tree under `mobile_app/lib/` (`core/{config,di,error,network,realtime,router,widgets}`, `features/{auth,orders,delivery,tracking,notifications}/{data,domain,presentation}`, `shared/{enums,entities}`) per plan Project Structure
- [X] T005 [P] Add `mobile_app/lib/core/config/env.dart` reading `API_BASE_URL`, `WS_BASE_URL`, `GOOGLE_MAPS_API_KEY` from `--dart-define`
- [X] T006 [P] Add named constants (timeouts, reconnect delay, `kLocationStaleWindow`, displacement 50 m, heartbeat 3 min, emit floor 5 s) in `mobile_app/lib/core/config/constants.dart` — no magic numbers
- [X] T007 [P] Configure Google Maps platform keys in `mobile_app/android/app/src/main/AndroidManifest.xml` and `mobile_app/ios/Runner/AppDelegate.swift`, plus location + Android foreground-service permissions
- [X] T008 Wire `build_runner` and add root `mobile_app/lib/main.dart` + `mobile_app/lib/app.dart` placeholders that boot with `MaterialApp.router`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core cross-cutting infrastructure every user story depends on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T009 [P] Define enums (`UserRole`, `OrderStatus`, `OtpPurpose`, `NotificationType`, `FuelType`) with `fromWire`/`toWire` in `mobile_app/lib/shared/enums/` per data-model.md
- [X] T010 [P] Define value objects `Money` and `GeoPoint` (freezed) in `mobile_app/lib/shared/entities/value_objects.dart`
- [X] T011 [P] Define the sealed `Failure` hierarchy (`NetworkFailure`, `AuthFailure`, `NotFoundFailure`, `ValidationFailure`, `ThrottledFailure`, `ServerFailure`) in `mobile_app/lib/core/error/failure.dart` and app exceptions in `mobile_app/lib/core/error/exceptions.dart`
- [X] T012 Implement `TokenStore` over `flutter_secure_storage` (get/save/clear access+refresh) in `mobile_app/lib/core/network/token_store.dart`
- [X] T013 Implement `AuthInterceptor` (QueuedInterceptor: Bearer injection + single-flight `/auth/refresh` via in-flight Completer, `skipAuth`/`retried` guards) in `mobile_app/lib/core/network/auth_interceptor.dart` (depends on T012)
- [X] T014 Implement `ErrorInterceptor` mapping `DioException` → `Failure` per contracts/backend-integration.md (401→Auth, 404→NotFound uniform, 409/422→Validation, 429→Throttled, timeout→Network, 5xx→Server) in `mobile_app/lib/core/network/error_interceptor.dart` (depends on T011)
- [X] T015 Implement `buildDioClient` (base options `/api/v1`, primary + refresh-only Dio, interceptor wiring) in `mobile_app/lib/core/network/dio_client.dart` (depends on T013, T014)
- [X] T016 [P] Add `socket_events.dart` (event-name + reason constants) in `mobile_app/lib/core/realtime/socket_events.dart`
- [X] T017 Implement `TrackingSocket` (connect with `auth:{token}` on `/tracking`, autoConnect off, infinite reconnect, `reauthenticate()` cycle, emit/on wrappers) in `mobile_app/lib/core/realtime/tracking_socket.dart` (depends on T012, T016)
- [X] T018 Define `Order`, `AuthUser`, `LocationSample`, `OtpChallenge`, `AppNotification` domain entities (freezed) in `mobile_app/lib/shared/entities/` and feature `domain/entities/` per data-model.md
- [X] T019 Implement `SessionCubit` (unknown/authenticated/unauthenticated) driving auth state in `mobile_app/lib/features/auth/presentation/cubit/session_cubit.dart` (depends on T018)
- [X] T020 Implement `go_router` config with role-gated redirects (reads SessionCubit) per contracts/ui-state-contract.md route table in `mobile_app/lib/core/router/app_router.dart` (depends on T019)
- [X] T021 Register core singletons (TokenStore, Dio, TrackingSocket, SessionCubit, router) in `mobile_app/lib/core/di/injector.dart` and initialize in `main.dart` (depends on T012–T020)
- [X] T073 Add a global Flutter error boundary — `runZonedGuarded` + `FlutterError.onError` routing uncaught widget/zone errors through the centralized presenter (Constitution Principle III; complements the Dio `ErrorInterceptor`) in `mobile_app/lib/main.dart` and `mobile_app/lib/core/error/error_boundary.dart`

**Checkpoint**: Networking, realtime, DI, routing, error types, error boundary, and shared entities exist — user stories can begin.

---

## Phase 3: User Story 1 - Secure sign-in & uninterrupted session (Priority: P1) 🎯 MVP

**Goal**: A CLIENT/DRIVER signs in, stays signed in across restarts, and has the access token renewed silently mid-use; only an unrecoverable session returns to login.

**Independent Test**: Sign in per role; restart app (session persists); expire access token and act (transparent success, one refresh); revoke refresh (single redirect to login).

### Tests for User Story 1

- [X] T022 [P] [US1] Unit test single-flight refresh: concurrent 401s trigger exactly one `/auth/refresh`, others replay once, no double refresh — `mobile_app/test/unit/auth_interceptor_test.dart`
- [X] T023 [P] [US1] `bloc_test` for `AuthCubit` (idle→submitting→success/failure) and session restore/expiry in `mobile_app/test/unit/auth_cubit_test.dart`
- [X] T024 [P] [US1] Integration test: login → restart-restore → token-expiry transparent retry → revoke→login-once — `mobile_app/test/integration/auth_session_test.dart`
- [X] T074 [P] [US1] Unit test tenant-scope invariant: no request body/query carries a client-set `companyId` (scope derives only from JWT) — `mobile_app/test/unit/tenant_scope_test.dart` (FR-023)

### Implementation for User Story 1

- [X] T025 [P] [US1] `AuthRemoteDataSource` (`POST /auth/login`, `POST /auth/refresh`, `GET /auth/me`, `skipAuth` on login/refresh) in `mobile_app/lib/features/auth/data/datasources/auth_remote_data_source.dart`
- [X] T026 [P] [US1] Auth DTO/models (login response, user) with json_serializable in `mobile_app/lib/features/auth/data/models/`
- [X] T027 [US1] `AuthRepositoryImpl` returning `Either<Failure, AuthUser>`, persisting tokens via TokenStore in `mobile_app/lib/features/auth/data/repositories/auth_repository_impl.dart` (depends on T025, T026)
- [X] T028 [P] [US1] Abstract `AuthRepository` + use cases (`SignIn`, `RestoreSession`, `SignOut`) in `mobile_app/lib/features/auth/domain/`
- [X] T029 [US1] `AuthCubit` (submit/validate credentials, non-enumerating failure message) in `mobile_app/lib/features/auth/presentation/cubit/auth_cubit.dart` (depends on T028)
- [X] T030 [US1] Wire `onSessionExpired` from `AuthInterceptor` → `SessionCubit.unauthenticated` → router redirect (single fire) in `mobile_app/lib/core/di/injector.dart`
- [X] T031 [US1] Login screen (phone/password, loading/error states) in `mobile_app/lib/features/auth/presentation/view/login_screen.dart`
- [X] T032 [US1] Register auth dependencies in `injector.dart` and hydrate SessionCubit on launch from TokenStore + `GET /auth/me`

**Checkpoint**: Auth + silent refresh fully functional and independently testable (MVP foundation).

---

## Phase 4: User Story 2 - Client orders fuel, pays, and follows to delivery (Priority: P1)

**Goal**: A CLIENT creates an order, sees the approved final price + payment window, pays via the native gateway, watches the driver live, and surfaces arrival/delivery codes at the right moments.

**Independent Test**: Place order → receive approved price → pay (state flips only on backend webhook) → watch marker move → arrival code shown only to CLIENT.

### Tests for User Story 2

- [X] T033 [P] [US2] `bloc_test` for `PaymentCubit`: `confirmed` set ONLY on backend `inTransit`, `windowExpired` on lapse — `mobile_app/test/unit/payment_cubit_test.dart`
- [X] T034 [P] [US2] `bloc_test` for `OrderDetailCubit` reconciling REST + `order:status` by timestamp (no local transition assertion) in `mobile_app/test/unit/order_detail_cubit_test.dart`
- [X] T035 [P] [US2] Integration test: create → approve → pay → track → arrival-code-CLIENT-only — `mobile_app/test/integration/client_order_flow_test.dart`

### Implementation for User Story 2

- [X] T036 [P] [US2] `OrdersRemoteDataSource` (`POST /orders` `{fuelType,quantityLiters,deliveryLocation?}`, `GET /orders`, `GET /orders/:id`, `GET /orders/:id/otp/current`, `PATCH /orders/:id/cancel`, `POST /orders/:id/redispatch`) — **no `/pay` endpoint; payment is native-SDK-initiated (R3)** — in `mobile_app/lib/features/orders/data/datasources/orders_remote_data_source.dart`
- [X] T037 [P] [US2] Order DTO/mappers (wire ↔ `Order`, `Money`, `paymentWindowEndsAt`) in `mobile_app/lib/features/orders/data/models/`
- [X] T038 [US2] `OrdersRepositoryImpl` (`Either<Failure, …>`) in `mobile_app/lib/features/orders/data/repositories/orders_repository_impl.dart` (depends on T036, T037)
- [X] T039 [P] [US2] Abstract `OrdersRepository` + use cases (`CreateOrder`, `GetOrders`, `GetOrder`, `GetCurrentOtp`, `CancelOrder`, `Redispatch`) in `mobile_app/lib/features/orders/domain/`
- [X] T040 [P] [US2] Abstract `PaymentGateway` domain interface + native-SDK `PaymentGatewayImpl` in `mobile_app/lib/features/orders/{domain/gateways,data/gateways}/` (backend state is sole confirmation, research R3)
- [X] T041 [US2] `OrdersCubit` (list: loading/loaded/failure) in `mobile_app/lib/features/orders/presentation/cubit/orders_cubit.dart` (depends on T039)
- [X] T042 [US2] `OrderDetailCubit` (subscribe to `order:status` for the order, reconcile) in `mobile_app/lib/features/orders/presentation/cubit/order_detail_cubit.dart` (depends on T039, T017)
- [X] T043 [US2] `PaymentCubit` (initiate via gateway → awaitingConfirmation → confirmed on backend `inTransit`; windowExpired) in `mobile_app/lib/features/orders/presentation/cubit/payment_cubit.dart` (depends on T040, T042)
- [X] T044 [US2] `TrackingCubit` watch path: `order:watch`, consume `order:location`, render marker; handle NOT_TRACKABLE/NOT_FOUND acks in `mobile_app/lib/features/tracking/presentation/cubit/tracking_cubit.dart` (depends on T017)
- [X] T045 [P] [US2] Create-order screen (fuel type + quantity, client-side validation) in `mobile_app/lib/features/orders/presentation/view/create_order_screen.dart`
- [X] T046 [P] [US2] Orders list (home) screen in `mobile_app/lib/features/orders/presentation/view/orders_list_screen.dart`
- [X] T047 [US2] Order detail screen: status, finalPrice + payment-window countdown, Pay (native SDK) + **Decline** (`PATCH cancel`) actions, redispatch-after-timeout, Google Map live marker, CLIENT-only OTP display (`order:otp` push + `otp/current` fallback) in `mobile_app/lib/features/orders/presentation/view/order_detail_screen.dart` (depends on T042, T043, T044)

**Checkpoint**: CLIENT order→payment→live-tracking journey works end-to-end and independently.

---

## Phase 5: User Story 3 - Driver executes an assigned delivery (Priority: P1)

**Goal**: A DRIVER sees the assigned job, streams location (foreground + active-delivery background, gated), and runs the two-step OTP; wrong codes are rejected/throttled; codes never shown to the driver.

**Independent Test**: Open assigned in-transit order → confirm emits only past 50 m/3 min → correct arrival code advances to unloading → correct delivery code completes → wrong codes rejected then throttled.

### Tests for User Story 3

- [X] T048 [P] [US3] Unit test location emit gate: emits only when > 50 m OR ≥ 3 min, honors 5 s floor — `mobile_app/test/unit/location_gate_test.dart`
- [X] T049 [P] [US3] Unit test OTP verify guards + throttle mapping (422→rejected, 429→throttled retryAfter) and that no code is ever held/rendered on driver build — `mobile_app/test/unit/otp_verify_test.dart`
- [X] T050 [P] [US3] `bloc_test` for `DeliveryCubit` (noActiveOrder/active/streaming) in `mobile_app/test/unit/delivery_cubit_test.dart`
- [X] T051 [P] [US3] Integration test: assigned→stream→arrival OTP→unloading→delivery OTP→delivered — `mobile_app/test/integration/driver_delivery_test.dart`

### Implementation for User Story 3

- [X] T052 [P] [US3] `DeliveryRemoteDataSource` (`GET /orders?status=…` auto-scoped to driver, `POST /orders/:id/arrive`, `POST /orders/:id/verify-arrival`, `POST /orders/:id/request-delivery-otp`, `POST /orders/:id/verify-delivery`) in `mobile_app/lib/features/delivery/data/datasources/delivery_remote_data_source.dart`
- [X] T053 [US3] `DeliveryRepositoryImpl` (`Either<Failure, …>`) in `mobile_app/lib/features/delivery/data/repositories/delivery_repository_impl.dart` (depends on T052)
- [X] T054 [P] [US3] Abstract `DeliveryRepository` + use cases (`GetActiveOrder`, `MarkArrived`, `VerifyArrivalOtp`, `RequestDeliveryOtp`, `VerifyDeliveryOtp`) in `mobile_app/lib/features/delivery/domain/`
- [X] T055 [US3] `LocationStreamService` (geolocator stream, Android foreground-service notification + iOS background config, apply 50 m/3 min gate, emit `location:update`, start on active order/stop on terminal) in `mobile_app/lib/features/delivery/data/services/location_stream_service.dart` (depends on T017, T006)
- [X] T056 [US3] `DeliveryCubit` (active order + streaming lifecycle, subscribe `order:status`) in `mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart` (depends on T054, T055)
- [X] T057 [US3] `OtpVerifyCubit` — two-step: **Arrived** (generate arrival OTP) → verify-arrival; **Request delivery OTP** → verify-delivery; states verifying→advanced/rejected/throttled; **never stores or renders a code** — in `mobile_app/lib/features/delivery/presentation/cubit/otp_verify_cubit.dart` (depends on T054)
- [X] T058 [P] [US3] Driver home / active-delivery screen (empty state + job details + destination map) in `mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart`
- [X] T059 [US3] Delivery detail screen: **Arrived** and **Request delivery code** action buttons (trigger OTP generation), OTP entry inputs (arrival then delivery), rejection/throttle feedback, **NO code display** in `mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart` (depends on T056, T057)

**Checkpoint**: DRIVER delivery execution works end-to-end and independently; all three P1 stories complete = full core loop.

---

## Phase 6: User Story 4 - Real-time tracking resilience & notifications (Priority: P2)

**Goal**: Live connection auto-recovers after network loss and re-auths after refresh; stale location is flagged when heartbeats stop; correct persona receives in-app notifications.

**Independent Test**: Drop/restore network (reconnect ≤ 15 s), stop heartbeat (view marks stale), trigger notifiable event (correct persona notified).

### Tests for User Story 4

- [X] T060 [P] [US4] Unit test staleness: `LocationSample.isStale` against `kLocationStaleWindow` in `mobile_app/test/unit/staleness_test.dart`
- [X] T061 [P] [US4] Unit test socket re-auth after refresh + auto-reconnect resume in `mobile_app/test/unit/socket_reauth_test.dart`

### Implementation for User Story 4

- [X] T062 [US4] Add reconnection + `reauthenticate()`-on-refresh hook (SessionCubit refresh event → TrackingSocket) in `mobile_app/lib/core/realtime/tracking_socket.dart` and `injector.dart` (depends on T017, T030)
- [X] T063 [US4] Staleness indicator in `TrackingCubit.watching(stale:)` + order detail map UI in `mobile_app/lib/features/tracking/presentation/cubit/tracking_cubit.dart` (depends on T044)
- [X] T064 [P] [US4] `NotificationsRemoteDataSource` (`GET /notifications?unread=`, `PATCH /notifications/:id/read`) + repository in `mobile_app/lib/features/notifications/data/`
- [X] T065 [US4] `NotificationsCubit` consuming `notification:new` (direct socket) + REST backfill, deep-link to order in `mobile_app/lib/features/notifications/presentation/cubit/notifications_cubit.dart` (depends on T017, T064)
- [X] T066 [P] [US4] Notifications screen + in-app banner presenter in `mobile_app/lib/features/notifications/presentation/view/notifications_screen.dart`

**Checkpoint**: Tracking is resilient and both personas receive notifications.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T067 [P] Central error presenter (Failure → user-friendly SnackBar/dialog, no internal detail) wired app-wide in `mobile_app/lib/core/widgets/error_presenter.dart` (Principle III, FR-025)
- [X] T068 [P] Verify no OTP/token values reach logs, crash reports, or analytics; add a redaction guard/lint note in `mobile_app/lib/core/config/` (SC-008)
- [X] T069 [P] Background/foreground lifecycle audit for socket + location stream (pause/resume, stop when idle) per FR-024
- [X] T070 [P] Loading/empty/error states pass on every list/detail screen (FR-025)
- [X] T071 [P] README + run instructions in `mobile_app/README.md` (mirrors quickstart.md dart-defines)
- [X] T072 Run `mobile_app/` quickstart.md validation end-to-end against a live backend (US1–US4 checks)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories**.
- **US1 (Phase 3)**: after Foundational. Provides the live session that US2–US4 exercise, but each story is independently testable with a seeded session.
- **US2 (Phase 4)** / **US3 (Phase 5)**: after Foundational; both P1; independent of each other (client vs driver side). Naturally paired at demo time via one order but each testable alone with backend fixtures.
- **US4 (Phase 6)**: after Foundational; extends tracking (US2) and adds notifications; degrade-gracefully so US2/US3 stand without it.
- **Polish (Phase 7)**: after all targeted stories.

### Within Each User Story

- Tests written first and failing → data source → models → repository → use cases → cubit → view.
- Repositories before cubits; cubits before screens.

### Parallel Opportunities

- Setup: T003–T007 in parallel.
- Foundational: T009, T010, T011, T016 in parallel; then T012→T013→T015 chain and T014 alongside.
- Once Phase 2 done, **US1, US2, US3 can be built by three developers in parallel** (distinct feature folders); US4 follows tracking.
- Within a story, all `[P]` test tasks and all `[P]` data-source/model tasks run together.

---

## Parallel Example: User Story 2

```bash
# Tests together:
Task: "bloc_test PaymentCubit in mobile_app/test/unit/payment_cubit_test.dart"
Task: "bloc_test OrderDetailCubit in mobile_app/test/unit/order_detail_cubit_test.dart"
Task: "Integration client_order_flow in mobile_app/test/integration/client_order_flow_test.dart"

# Data layer together:
Task: "OrdersRemoteDataSource in .../orders/data/datasources/orders_remote_data_source.dart"
Task: "Order DTO/mappers in .../orders/data/models/"
Task: "OrdersRepository + use cases in .../orders/domain/"
```

---

## Implementation Strategy

### MVP scope (recommended)

The core delivery loop needs **all three P1 stories** (US1 auth + US2 client + US3 driver) to demonstrate an order flowing to a proven delivery. Minimum viable = Phase 1 + Phase 2 + US1, then US2 + US3.

1. Setup + Foundational → foundation ready.
2. US1 → validate silent refresh & session persistence → demo login.
3. US2 + US3 → validate a full order create→pay→track→two-step-OTP→delivered against the backend.
4. **STOP & VALIDATE** the P1 loop (SC-001/002/003/004/005/006/008).

### Incremental delivery

- +US4 → resilience (auto-reconnect, staleness) + in-app notifications (SC-007).
- Polish → error presenter, redaction audit, lifecycle audit, quickstart validation.

---

## Notes

- `[P]` = different files, no incomplete-task dependency.
- Every task names an exact `mobile_app/...` path; no task touches the NestJS backend.
- Backend is the source of truth: no cubit asserts an order transition locally (research R7) — enforced by T034.
- Commit after each task or logical group. Stop at any checkpoint to validate a story independently.
