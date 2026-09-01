# Implementation Plan: Client & Driver Mobile Application

**Branch**: `002-flutter-mobile-app` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-flutter-mobile-app/spec.md`

## Summary

A single Flutter application serving the **CLIENT** (fuel-station operator) and **DRIVER** personas of the existing multi-tenant fuel delivery backend (feature `001`). The app consumes the backend's REST contract (`/api/v1`) and the `/tracking` Socket.io namespace — it adds no server capability. It is built with Clean Architecture (Data / Domain / Presentation) + MVVM, with **Cubit** (from `flutter_bloc`) as the ViewModel driving the order state machine and two-step OTP flows. Networking is **Dio** with a queued auth interceptor that injects the Bearer token and performs single-flight `/auth/refresh` on 401; live tracking uses **`socket_io_client`** against `/tracking` with a JWT handshake. Clarified decisions: **Google Maps** for map rendering, the **native Sadad/Mada payment SDK** (behind an abstract gateway) for payment, **foreground + active-delivery background** driver location streaming, and **secure device storage only** (no app-lock) for the v1 session.

## Technical Context

**Language/Version**: Dart 3.5+ on Flutter 3.24+ (stable channel)

**Primary Dependencies**: `flutter_bloc` (Cubit) · `dio` · `socket_io_client` · `get_it` (DI) · `freezed` + `json_serializable` (immutable models/state) · `dartz` (`Either<Failure, T>`) · `flutter_secure_storage` (Keychain/Keystore) · `google_maps_flutter` · `geolocator` (foreground + active-trip background location with Android foreground-service notification) · `go_router` (role-gated routing) · `equatable` · `intl`

**Storage**: On-device only — `flutter_secure_storage` for tokens/session; in-memory + lightweight cache for the active order and last-known location. No local relational DB in v1 (backend is source of truth).

**Testing**: `flutter_test` + `bloc_test` (Cubit state assertions) · `mocktail` (repository/datasource fakes) · `integration_test` for the two P1 end-to-end journeys. Interceptor single-flight refresh and the client-side OTP/state-machine guards are unit-tested.

**Target Platform**: iOS 13+ and Android 8.0+ (API 26+), single installable build per platform.

**Project Type**: Mobile app (Flutter) in a dedicated root `mobile_app/`, never mixed with the NestJS backend.

**Performance Goals**: Warm launch to role home < 3 s on a persisted session (SC-001); driver position visible to watcher ≤ 10 s (SC-003); UI at 60 fps during live map updates; location emits gated to the backend's 50 m / 3 min policy — no per-second streaming (SC-004).

**Constraints**: Silent single-flight token refresh with zero visible errors and exactly one refresh per expiry (SC-002); OTP codes never rendered on the driver side, never logged, never in analytics (SC-008); cross-tenant/nonexistent resources presented as an indistinguishable "not found"; live socket auto-recovers within 15 s of a transient drop and re-auths after refresh (SC-007); location stream survives background only during an active delivery and stops when idle.

**Scale/Scope**: 2 personas, ~14–16 screens, 4 feature modules (auth, orders, delivery, tracking) + notifications, 1 REST client, 1 WebSocket client, order lifecycle of 7 sequential + 2 terminal states mirrored read-only from the backend.

**Backend contract reconciliation (verified against `001/contracts/rest-api.md`)**: There is **no app-facing payment endpoint** — payment is native-SDK-initiated and confirmed solely by the Sadad/Mada webhook flipping `PENDING_PAYMENT → IN_TRANSIT` (observed via `GET /orders/:id` and the `order:status` socket event); declining the final price is `PATCH /orders/:id/cancel`. Drivers fetch their job via `GET /orders?status=…` (auto-scoped), and the two-step OTP requires generation calls `POST /orders/:id/arrive` and `POST /orders/:id/request-delivery-otp` before each `verify-*`. The client's plaintext OTP has two sources: the `order:otp` socket push and `GET /orders/:id/otp/current`. **Open dependency**: if the native gateway needs a backend-issued payment reference token, feature `001` must surface it on the `GET /orders/:id` payload (`Order.paymentReference`); otherwise the SDK is keyed off `order.id` + `finalPrice`.

**Spec 004 addendum (roles & payment methods, as actually shipped)**: The backend's `COMPANY_ADMIN`
split into `FUEL_COMPANY_ADMIN`/`TRANSPORT_COMPANY_ADMIN` — the mobile app itself still serves
only CLIENT and DRIVER, so `shared/enums/user_role.dart` mirrors the full four-plus-SUPER_ADMIN
set (it must, since it's the one place role wire strings are parsed, Principle I) but the app's
own routing/screens are unaffected. `POST /orders` now takes an optional `paymentMethod`
(`DIRECT | DEFERRED | CREDIT`, spec 004 FR-021; defaults to `DIRECT` server-side) — the
create-order form exposes all three as a selector. `PENDING_PAYMENT` now sits earlier in the
lifecycle for a DIRECT order (right after approval, before routing — FR-020a) rather than
between assignment and `IN_TRANSIT`; DEFERRED/CREDIT orders skip it entirely. The earlier "open
dependency" on a `paymentReference` field never materialized — Sadad remains the only in-app
gateway (DIRECT only), keyed off `order.id` + `finalPrice` exactly as originally planned; the
backend's own settlement reference is server-side bookkeeping the app has no need to read.
`GET /orders/:id` (and the list) now also carry `driverSummary{fullName, phone, plateNumber}`
(FR-028) and `etaMinutes` (FR-029, `null` until a driver is assigned and has a position), and
`deliveryAddressText` (FR-030) — these were the fields with "no client-readable backend source"
noted when this plan was first written; they resolved once spec 004 landed and are wired end to
end (US6, T086/T087).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution v1.0.0 — Mobile (Flutter) constraints apply. All gates pass by design:

| Gate | Principle | Status | How this plan satisfies it |
|------|-----------|--------|----------------------------|
| Strict typing & no magic values | I | ✅ PASS | Dart with no implicit `any`; `freezed` models; roles/statuses/OTP purposes/socket event names/route paths as enums & named constants in `core/config` + `shared/enums` — no string literals at boundaries |
| Tenant isolation & security-first | II | ✅ PASS | Company scope derives from the JWT (never a client-set field); tokens in `flutter_secure_storage`; OTP codes shown only to the issuing CLIENT and never on driver screens/logs; cross-tenant → uniform "not found" |
| Centralized error handling | III | ✅ PASS | Single `ErrorInterceptor` maps `DioException` → typed `Failure`; repositories return `Either<Failure, T>`; one app-level error presenter — no ad-hoc swallowing `try/catch` |
| Clean Architecture & UI/logic decoupling | IV | ✅ PASS | Data / Domain / Presentation layers; Domain holds framework-free entities + abstract repository interfaces + use cases; Cubits (ViewModels) depend only on use cases; all network access via repository classes with structured error parsing; DI via `get_it` |
| Transactional integrity for state changes | V | ✅ PASS (client boundary) | All race-prone state changes (dispatch, payment, OTP transitions) are enforced server-side in transactions; the app treats backend state as source of truth, never asserts a transition locally, and reconciles via REST/`order:status` — it assumes no ordering (see research R7) |

**Post-Phase-1 re-check**: ✅ PASS — design added no unjustified complexity (Complexity Tracking empty).

## Project Structure

### Documentation (this feature)

```text
specs/002-flutter-mobile-app/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (client entities + Cubit state shapes)
├── quickstart.md        # Phase 1 output (run + verify against backend)
├── contracts/
│   ├── backend-integration.md   # REST + WS client contract, token/refresh, error→Failure map
│   └── ui-state-contract.md     # Screen ↔ state ↔ allowed actions; client view of order state machine
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root — separate from the NestJS backend)

```text
mobile_app/
├── pubspec.yaml
├── analysis_options.yaml          # strict lints (no implicit-dynamic), enforces Principle I
└── lib/
    ├── main.dart                  # bootstrap: DI init, secure-storage warmup, runApp
    ├── app.dart                   # MaterialApp.router + global BlocProviders (Session)
    ├── core/
    │   ├── config/
    │   │   ├── env.dart           # apiBaseUrl (/api/v1), wsBaseUrl, /tracking namespace
    │   │   └── constants.dart     # timeouts, retry, staleness window (named, no magic numbers)
    │   ├── di/injector.dart       # get_it registrations
    │   ├── error/
    │   │   ├── failure.dart       # sealed Failure hierarchy (Principle III)
    │   │   └── exceptions.dart
    │   ├── network/
    │   │   ├── dio_client.dart
    │   │   ├── auth_interceptor.dart   # Bearer inject + single-flight 401 refresh (FR-003/004/005)
    │   │   ├── error_interceptor.dart  # DioException → Failure
    │   │   └── token_store.dart        # secure access/refresh persistence
    │   ├── realtime/
    │   │   ├── tracking_socket.dart    # /tracking client, reauth on refresh
    │   │   └── socket_events.dart      # event-name + reason constants
    │   ├── router/app_router.dart      # role-gated routes (CLIENT vs DRIVER)
    │   └── widgets/                     # shared presentational widgets
    ├── features/
    │   ├── auth/
    │   │   ├── data/{datasources,models,repositories}/
    │   │   ├── domain/{entities,repositories,usecases}/
    │   │   └── presentation/{cubit,view,widgets}/     # AuthCubit, SessionCubit
    │   ├── orders/                       # CLIENT: create/list/detail, pricing, payment
    │   │   ├── data/ · domain/ · presentation/        # OrdersCubit, OrderDetailCubit, PaymentCubit
    │   ├── delivery/                     # DRIVER: assigned job, location stream, two-step OTP
    │   │   ├── data/ · domain/ · presentation/        # DeliveryCubit, OtpVerifyCubit, LocationStreamService
    │   ├── tracking/                     # live map (Google Maps), watcher room, staleness
    │   │   ├── data/ · domain/ · presentation/        # TrackingCubit
    │   └── notifications/
    │       ├── data/ · domain/ · presentation/        # NotificationsCubit
    └── shared/
        ├── enums/                        # UserRole, OrderStatus, OtpPurpose, NotificationType
        └── entities/                     # Order, AuthUser (cross-feature domain types)

mobile_app/test/
├── unit/          # interceptor single-flight, Failure mapping, OTP/state guards, Cubits (bloc_test)
├── widget/
└── integration/   # US2 client order→delivery, US3 driver delivery execution
```

**Structure Decision**: A standalone Flutter project at repository-sibling path `mobile_app/`, physically separate from the NestJS backend per the constitution's platform separation. Cross-cutting concerns (networking, realtime, DI, routing, error types) live in `lib/core/`; business capabilities are vertical feature modules under `lib/features/`, each internally split into `data / domain / presentation`, mapping 1:1 to the spec's user stories (auth→US1, orders→US2, delivery→US3, tracking+notifications→US4). The Domain layer of every feature is framework-free (pure Dart entities, abstract repository interfaces, use cases); Cubits are the MVVM ViewModels and depend only on use cases.

## Complexity Tracking

> No constitution violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| — | — | — |
