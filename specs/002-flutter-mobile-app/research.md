# Phase 0 Research: Client & Driver Mobile Application

All Technical Context unknowns are resolved below. The four highest-impact choices were fixed during `/speckit-clarify` (R2, R3, R4, R6); the rest follow from the constitution and backend contracts.

## R1 — State management: Cubit over full Bloc

- **Decision**: `flutter_bloc` using **Cubit** as the MVVM ViewModel; reserve event-driven `Bloc` only where a screen has genuinely concurrent, replayable event streams (none required in v1).
- **Rationale**: The order state machine and two-step OTP are method-call driven ("submit order", "pay", "verify arrival code") — Cubit's imperative methods map cleanly to use-case calls and keep boilerplate low. `bloc_test` gives deterministic state-sequence assertions for the lifecycle guards.
- **Alternatives considered**: Full `Bloc` (unneeded event ceremony for v1 flows); Riverpod / Provider (constitution and task both name Bloc/Cubit); `setState` (violates Principle IV UI/logic decoupling).

## R2 — Map provider: Google Maps *(clarified)*

- **Decision**: `google_maps_flutter`.
- **Rationale**: Strong KSA coverage (Sadad/Mada indicate a Saudi market), mature marker/camera APIs for live driver tracking, first-class Flutter plugin. Only a live position marker + camera follow is needed — not routing.
- **Alternatives considered**: Mapbox (smaller regional ecosystem); OpenStreetMap via `flutter_map` (no key/cost but weaker tiles/support). API keys are injected per-flavor via `--dart-define`, never committed.

## R3 — Payment: native Sadad/Mada SDK behind an abstract gateway *(clarified)*

- **Decision**: Integrate the **native payment SDK** through an abstract `PaymentGateway` domain interface; the app initiates payment and then treats the **backend webhook-driven order state** (`PENDING_PAYMENT → IN_TRANSIT`) as the sole confirmation, observed via REST refresh and the `order:status` socket event.
- **Rationale**: Keeps the client out of the trust path for confirmation (matches backend idempotent webhook design, Principle V), while the native SDK gives a smooth in-app card experience. The abstraction keeps Domain framework-free (Principle IV) and lets tests fake the gateway.
- **Alternatives considered**: In-app WebView to hosted checkout (simpler but a less native feel); external browser + deep link (jarring app-switch). App **never** asserts payment success locally — it waits for backend state to flip.

## R4 — Driver location: foreground + active-delivery background *(clarified)*

- **Decision**: `geolocator` position stream started only when the driver has an active delivery, configured with an **Android foreground-service notification** (`AndroidSettings.foregroundNotificationConfig`) and iOS `allowBackgroundLocationUpdates` + `pausesLocationUpdatesAutomatically = false`; stream is **stopped** the moment the order reaches a terminal/idle state.
- **Rationale**: Meets FR-014/024 — the trail survives the driver locking the phone or switching to navigation mid-trip — without always-on tracking's battery/review cost. Permission requested is "while in use" escalated to background only for the active trip.
- **Client-side emit gate**: the app applies the backend's **> 50 m displacement OR ≥ 3 min heartbeat** policy before emitting `location:update`; the server re-enforces and may drop below-threshold frames (contract). A local 5 s floor mirrors the server abuse ceiling.
- **Alternatives considered**: `flutter_background_geolocation` (paid, heavier than needed); always-on background (rejected in clarification); foreground-only (loses trail).

## R5 — Secure session storage & single-flight refresh

- **Decision**: `flutter_secure_storage` (iOS Keychain / Android EncryptedSharedPreferences-backed Keystore) holds `accessToken` + `refreshToken`. A `QueuedInterceptor` injects `Authorization: Bearer` and, on a `401`, runs **one** `POST /auth/refresh` guarded by an in-flight `Completer`; concurrent 401s await the same future, then their requests replay once (`extra['retried']`). A separate refresh-only `Dio` (no auth interceptor) prevents recursion. Failure to refresh clears the session and routes to login exactly once.
- **Rationale**: Directly satisfies FR-004/005/006 and SC-002 (zero visible errors, one refresh per expiry). v1 ships **no biometric/PIN app-lock** per clarification.
- **Alternatives considered**: `dio_smart_retry` / `fresh_dio` (extra dependency for behavior small enough to own and unit-test); plain `SharedPreferences` (insecure for tokens — rejected under Principle II).

## R6 — Realtime client: socket_io_client against `/tracking`

- **Decision**: `socket_io_client` v2 (Socket.io 4 protocol), `io('<wsBase>/tracking', { transports:['websocket'], auth:{ token } })`, autoConnect disabled until authenticated, infinite reconnection attempts with 1 s base delay. On silent token refresh the socket's `auth` is updated and the connection is cycled (handshake context is fixed at connect time, per the WS contract). CLIENT/watcher emits `order:watch`/`order:unwatch`; DRIVER emits `location:update`; inbound `order:location`, `order:status`, `order:otp` (CLIENT only), `notification:new` are routed to the relevant Cubits.
- **Rationale**: Matches the backend namespace/handshake/event contract exactly and satisfies FR-018/020 auto-recovery + re-auth. Staleness (FR-021) is computed from `receivedAt`/`recordedAt` against a named window, not a spinner.
- **Alternatives considered**: raw `web_socket_channel` (would re-implement the Socket.io handshake/ack/room protocol — rejected).

## R7 — Backend as source of truth; no local transition assertion

- **Decision**: The client mirrors order state read-only. UI enables an action for a state (e.g., "Pay" only in `APPROVED`/`PENDING_PAYMENT`) but the **authoritative** transition always comes back from the backend response or `order:status`. The app assumes no event ordering and reconciles REST + socket by `updatedAt`/`at` timestamps.
- **Rationale**: Honors Principle V at the client boundary — dispatch, payment, and OTP transitions are transactional server-side; the app must never present a locally-inferred state as committed. Prevents optimistic-UI drift on payment-window lapses and raced dispatch.
- **Alternatives considered**: Optimistic local state machine (risks showing "paid"/"delivered" the backend didn't commit — rejected).

## R8 — DI, models, and error typing

- **Decision**: `get_it` for DI (no build-time codegen needed for wiring); `freezed` + `json_serializable` for immutable entities/DTOs and Cubit states with exhaustive `when`; `dartz` `Either<Failure, T>` as the repository return type; a single sealed `Failure` set (`NetworkFailure`, `AuthFailure`, `NotFoundFailure`, `ThrottledFailure`, `ValidationFailure`, `ServerFailure`) produced solely by `ErrorInterceptor`.
- **Rationale**: Satisfies Principles I, III, IV — typed boundaries, one error-shaping layer, exhaustive state handling. `NotFoundFailure` carries no existence detail, preserving the 404-indistinguishable rule.
- **Alternatives considered**: `injectable` codegen (unnecessary for this size); hand-rolled result type (freezed/dartz are standard and tested).

## Resolved unknowns summary

| Unknown | Resolution |
|---------|-----------|
| State management flavor | Cubit (R1) |
| Map provider | Google Maps (R2) |
| Payment mechanism | Native SDK behind abstract gateway (R3) |
| Background location scope | Foreground + active-delivery background via geolocator (R4) |
| Token storage & refresh | secure storage + single-flight interceptor (R5) |
| Realtime transport | socket_io_client on `/tracking` (R6) |
| State authority | Backend source of truth, no local assertion (R7) |
| DI / models / errors | get_it + freezed + dartz Either/Failure (R8) |
