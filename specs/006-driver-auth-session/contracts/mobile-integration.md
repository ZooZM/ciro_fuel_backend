# Mobile Integration Contract — Driver Authentication & Session

How the Flutter app consumes this feature. Structure follows `mobile_app/CLAUDE.md` §1 —
`data/` and `domain/` are never split by persona; `presentation/` splits only where the UI
actually diverges. No files move: the structural migration in that file's §5 is Out of Scope
here, so new files land where the **current** structure dictates.

---

## 1. Mandatory app lock (US2)

### `AppLockGate` — placement

Installed in `app.dart`'s `MaterialApp.router builder:`, wrapping
`NotificationBannerPresenter`:

```dart
builder: (context, child) => AppLockGate(
  child: NotificationBannerPresenter(child: child ?? const SizedBox.shrink()),
),
```

**Why `builder:` and not a `go_router` redirect** — this is a correctness requirement, not a
preference. `DriverNavigationScreen` and `DriverScanScreen` are pushed with raw
`MaterialPageRoute` (`delivery_detail_screen.dart:213`,
`driver_navigation_bottom_sheet.dart:191`), bypassing go_router entirely. A redirect-based
gate would leave both screens reachable behind a lock that believes it is holding. A
`builder:` gate sits above the `Navigator` and covers every route however it was pushed.

### `AppLockCubit` (`features/auth/presentation/cubit/`)

- Implements `WidgetsBindingObserver`; records the timestamp on `paused`, evaluates on
  `resumed`.
- Engages the lock when background time exceeds **2 minutes**, and on every cold launch into
  an existing session (FR-012).
- Active **only** when `SessionCubit` holds an authenticated `DRIVER` (FR-010 scopes the
  mandate to the driver persona — the client keeps its existing optional behaviour).
- Injects `BiometricAuthenticator` from `core/security` directly. This follows the three
  precedents documented in `mobile_app/CLAUDE.md` §6 for device-local services with no domain
  abstraction, and is **not** a precedent for anything that touches the API.

States: `unlocked` · `locked` · `authenticating` · `unavailable` (no device lock at all).

### `LockScreen` (`features/auth/presentation/view/`)

- Presents the challenge; retry on failure; **sign out** is the only other exit (FR-014).
- A failed or dismissed challenge never ends the session by itself (FR-015).
- `unavailable` state → blocking screen: the app requires a device lock, here is why, sign
  out or go set one up (FR-013a).

### `BiometricAuthenticator` change

```dart
Future<bool> authenticate({
  required String localizedReason,
  bool allowDeviceCredential = false,   // NEW
});
```

Passes `biometricOnly: !allowDeviceCredential` to `local_auth`. The lock gate passes `true`
so the OS accepts the device passcode when biometrics fail or are absent (SC-004a — zero hard
lockouts). **Login's biometric sign-in keeps the default `false` and is unchanged**:
unlocking a stored session with a device passcode is a weaker proposition than unlocking a
running app, and that call was already made deliberately in the existing code.

### What the lock must NOT do

Per FR-018a: it must not disconnect the socket, stop location reporting, or change presence.
A locked device stays on duty and dispatchable. A screen lock is not a break.

---

## 2. Session revocation handling (US4, US5)

Handled in exactly one place — the `SessionCubit` lifecycle listener in
`core/di/injector.dart` — never per-screen.

**Socket path (primary)**: register a `session:revoked` handler alongside the existing
notification handler. On receipt: clear `TokenStore`, then
`SessionCubit.signOut(reason: <localized cause>)`.

> **Known trap.** `mobile_app/CLAUDE.md` debt #6 records that `NotificationsCubit` registers
> its socket handler in its constructor, before `TrackingSocket.connect()` has created a
> socket — so the handler silently never attaches, and a fresh socket object is built on each
> connect. The `session:revoked` handler must not repeat this: register it on the socket
> **after** connect, inside the `SessionAuthenticated` branch that already calls
> `trackingSocket.connect()`. A revocation handler that silently never attaches would fail
> exactly like the notification one already does — invisibly.

**HTTP path (backstop)**: `AuthInterceptor` already routes a failed refresh through
`onSessionExpired`. Extend it to read `error: "SESSION_REVOKED"` and pass the `cause` through,
so the driver is told which of the three happened rather than the generic expiry message.

**Handshake path (offline fallback)**: `connect_error` is already treated as a session
failure. No change.

### `signOut` becomes a network call

`AuthRepositoryImpl.signOut()` is currently `_tokenStore.clear()`. It gains a
`POST /auth/logout` call that is **fire-and-forget**: the local clear must happen whether or
not the call succeeds (FR-031). A driver out of coverage must never be trapped in a session
they cannot leave.

### Cubit clearing (FR-008)

The `SessionUnauthenticated` branch in `injector.dart` already clears `NotificationsCubit`,
`OrdersCubit` and `FinanceCubit`. Add `ProfileCubit` and `DeliveryCubit` — otherwise the next
driver's first frame renders the previous driver's identity and active delivery, which is
exactly what SC-002 forbids.

---

## 3. Driver identity (US1)

`DriverProfileDetailsScreen` currently hard-codes `5X XXX XXXX` and
`mohamed.ahmed@example.com`, and its edit affordance is `// Handle edit`. Rewire to the
existing `ProfileCubit` — the same one the client's `ProfileScreen` already uses. It already
calls `GET /users/:id` (`ProfileRemoteDataSource.getProfile`), the endpoint this feature adds
`companyName` to (**not** `/auth/me` — see `rest-api-delta.md`, corrected during
implementation after `AuthUser` turned out to carry none of email/phone/photo at all).

- Name, phone, email, photo from `ProfileUser`, already fetched from `GET /users/:id` (FR-001).
- Company name (new field) and truck (already present in that response today, just not
  surfaced in `ProfileUser`/`ProfileMapper` yet) — FR-002, FR-003; truck row states "no truck
  assigned" rather than rendering blank (FR-003).
- Missing photo → neutral placeholder avatar, never a broken image (FR-004).
- Load failure → retryable error state, **never** a fall back to placeholder values (FR-007).
- `DriverMainScaffold` line 28's `notificationCount: 3, // mock count from image` → the real
  unread count from `NotificationsCubit` (FR-009).

Editing name and photo (FR-005) and changing phone (FR-006) reuse the existing profile use
cases and the existing `driver_change_phone_screen` / `driver_verify_phone_screen` routes.

---

## 4. Password recovery (US3)

Full Clean Architecture stack under `features/auth/`, flat (not persona-split) — the endpoint
is role-agnostic and a duplicate stack for the client would be the exact duplicate-datasource
bug `mobile_app/CLAUDE.md` §4 debt #2 warns about.

```
data/datasources/password_reset_remote_data_source.dart
data/repositories/password_reset_repository_impl.dart      → Either<Failure, T>
domain/repositories/password_reset_repository.dart
domain/usecases/request_password_reset.dart
domain/usecases/verify_reset_code.dart
domain/usecases/complete_password_reset.dart
presentation/cubit/password_reset_cubit.dart
presentation/view/forgot_password_screen.dart   ← replaces today's placeholder
presentation/view/reset_password_screen.dart    ← NEW
```

All three calls set `RequestExtraKeys.skipAuth` — they run with no session.

**Screen flow**: phone entry → code entry (with resend) → new password → back to login.

**Error mapping** — the app shows one message for `RESET_CODE_INVALID` regardless of whether
the code was wrong, expired, superseded or attempt-limited. The backend deliberately does not
distinguish them (see `rest-api-delta.md`), and the app must not invent a distinction.
`RESET_RATE_LIMITED` renders the wait using `retryAfterSeconds` (FR-025).

**The 202 means nothing about existence.** The request step returns the same response for a
registered and an unregistered number, so the app must always advance to code entry and must
never imply the number was found.

---

## 5. Localization & theming (FR-039)

Every new string goes in `core/localization/translation_keys.dart` with Arabic and English
entries under `assets/translations/`. Arabic is default and RTL-first. New screens read colors
via `context.colors`, not `AppColors.light.*`.

New key groups: `lock.*` (challenge, retry, unavailable, sign out), `reset.*` (the three
steps, resend, rate-limit wait), `session.*` (the three revocation causes),
`driver_profile.*` (truck rows, no-truck-assigned).

---

## 6. Testing

`flutter test` — headless, scripted Dio adapters and mocked sockets, per
`mobile_app/CLAUDE.md` §7. Register feature DI through `test/support/orders_test_di.dart`;
reset in `tearDown`.

| Test | Covers |
|---|---|
| `unit/app_lock_cubit_test.dart` | threshold, cold launch, driver-only scoping, no-device-lock state |
| `unit/password_reset_cubit_test.dart` | the three steps, error mapping, resend |
| `integration/driver_session_test.dart` | revocation push → login screen with the right cause |
| `integration/driver_identity_test.dart` | live identity renders; nothing leaks across a driver switch |

**Three tests fail before this feature starts** — `login_screen_golden_test` (pixel diff),
`auth_session_test` (router timing), `order_flow_render_test` "canceled" (mock-only state
gap). All pre-existing and documented. Do not treat them as regressions from this work — but
do confirm the count is still exactly three, since this feature touches `auth_session_test`'s
subject matter directly.
