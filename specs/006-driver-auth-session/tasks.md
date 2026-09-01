---
description: "Task list for Driver Authentication & Session"
---

# Tasks: Driver Authentication & Session

**Input**: Design documents from `/specs/006-driver-auth-session/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **Included and mandatory.** Not a stylistic choice — Constitution v1.0.0's
Development Workflow requires that "guarantees the spec marks as testable … MUST have
automated tests before the corresponding capability is considered done." Session revocation,
tenant isolation of the audit trail, and enumeration safety are all such guarantees.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete work)
- **[Story]**: US1–US5, mapping to the spec's user stories

## Path Conventions

Two roots, siblings on disk:

- **Backend** (this repo): `src/…`, `test/…` — NestJS, entry `src/server.ts`
- **Mobile**: `../mobile_app/lib/…`, `../mobile_app/test/…` — Flutter

---

## Phase 1: Setup (Shared Constants & Config)

**Purpose**: Named values only — no logic. Principle I forbids the literals these replace.

- [x] T001 [P] Add `RESET_CODE_INVALID`, `RESET_RATE_LIMITED`, `SESSION_REVOKED` to `src/common/enums/error-code.enum.ts`
- [x] T002 [P] Create `SessionEventType` enum (`SIGNED_IN`, `SIGNED_OUT`, `REVOKED`) in `src/common/enums/session-event-type.enum.ts`
- [x] T003 [P] Create `SessionRevocationCause` enum (`SIGNED_IN_ELSEWHERE`, `PASSWORD_RESET`, `ACCOUNT_DEACTIVATED`) in `src/common/enums/session-revocation-cause.enum.ts`
- [x] T004 [P] Add `passwordReset.expiryMinutes` (5), `maxAttempts` (5), `maxRequestsPerWindow` (3), `windowMinutes` (15) to `src/config/configuration.ts` and their schema entries in `src/config/validation.ts`
- [x] T005 [P] Add `sessionRevoked = 'session:revoked'` under "Server → Client" in `../mobile_app/lib/core/realtime/socket_events.dart`
- [x] T006 [P] Add `AppDurations.appLockThreshold` (2 minutes) in `../mobile_app/lib/core/config/constants.dart`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The session-generation spine (research R1) and the audit trail. Every user story
below depends on this.

**⚠️ CRITICAL**: No user story work begins until this phase is complete **and both suites are
green**. T007–T014 change session validation on the hot path for the **CLIENT persona too** —
per `CLAUDE.md`'s standing rule, they land as their own commit, alone.

### The generation spine

- [x] T007 Add `sessionGeneration: number` (`default: 0`, `min: 0`, no index) to the `User` class in `src/modules/users/schemas/user.schema.ts`
- [x] T008 Add optional `sgen?: number` to `JwtPayload` in `src/common/interfaces/jwt-payload.interface.ts`
- [x] T009 Change `UsersService.validateActiveSessionWithScoping` in `src/modules/users/users.service.ts` to accept the full `JwtPayload` and reject on `(payload.sgen ?? 0) !== (user.sessionGeneration ?? 0)` with `UnauthorizedException`, throwing the same generic message as the inactive-user path. Keep the `validateActiveSession(userId)` wrapper on its current signature for login/refresh, which establish the generation rather than checking it (depends on T007, T008)
- [x] T010 Update `JwtStrategy.validate` in `src/modules/auth/strategies/jwt.strategy.ts` to pass the whole payload, not `payload.sub` (depends on T009)
- [x] T011 Update `authenticateSocket` in `src/common/guards/ws-jwt.guard.ts` to pass the whole verified payload, so a revoked session fails the `/tracking` handshake with no gateway change (depends on T009)
- [x] T012 Make `AuthService.issueTokenPair` in `src/modules/auth/auth.service.ts` include `sgen: user.sessionGeneration ?? 0` in the signed payload for **both** the access and the refresh token (depends on T007, T008)
- [x] T013 Make `AuthService.refresh` compare the refresh token's `sgen` against the user's current `sessionGeneration` and throw `UnauthorizedException` on mismatch — without this, every revocation in this feature survives only until the next silent refresh (depends on T012)
- [x] T014 Backward-compatibility test in `test/auth-session-generation.e2e-spec.ts`: a token minted **without** `sgen` against a user document **without** `sessionGeneration` still authenticates. This is the deploy-safety check — if it fails, shipping drops every live session. Not parallel: it validates T007–T013, the work immediately above it, so it runs after them, not alongside them

### Audit trail (FR-043–046)

- [x] T015 [P] Create `SessionEvent` schema in `src/modules/sessions/schemas/session-event.schema.ts` per [data-model.md](./data-model.md) — `companyId` **optional** (`SUPER_ADMIN` has none), `markTenantScoped`, indexes on `{userId, occurredAt}` and `{companyId, occurredAt}`, **no TTL index**
- [x] T016 Create `SessionAuditService` in `src/modules/sessions/session-audit.service.ts` with one method per `SessionEventType` — including `recoveryRequested` and `recoveryVerifyFailed` (FR-028), each accepting an optional `ClientSession`. This is the only writer of `SessionEvent` (depends on T015)
- [x] T017 Create `SessionsModule` in `src/modules/sessions/sessions.module.ts` exporting `SessionAuditService`, and register it in `src/app.module.ts` — a leaf module both `auth/` and `users/` can import without depending on each other (depends on T016)
- [x] T018 Write `SessionEventType.SIGNED_IN` from `AuthService.login` (depends on T017)
- [x] T019 [P] Unit test in `test/unit/session-audit.service.spec.ts`: no row ever contains a token, code, password or resumable value (FR-045)
- [x] T020 [P] E2E test in `test/session-audit.e2e-spec.ts`: an admin of company A cannot read company B's session events (Principle II); a `SUPER_ADMIN` sign-in writes a row without throwing on the absent `companyId`; and — the reconstruction query FR-044 and SC-009a actually exist for — given a driver's sign-in, sign-out and a subsequent delivery timestamp, a `{userId, occurredAt}` query answers which session was live at that moment

**Checkpoint**: `npm run test && npm run test:e2e` green, `flutter test` still failing exactly
three pre-existing tests. Commit T007–T014 separately from T015–T020.

---

## Phase 3: User Story 1 - Driver sees their own identity (Priority: P1) 🎯 MVP

**Goal**: Every value on a driver's screens belongs to that driver. No hard-coded identity
survives.

**Independent Test**: Sign in as driver A, confirm every profile field matches their record;
sign out, sign in as driver B, confirm no trace of A appears in any frame.

### Backend

- [x] T021 [US1] Add `companyName` to `GET /users/:id` (`UsersController.findOne` in `src/modules/users/users.controller.ts`), populated only when `role === DRIVER`, via one `CompaniesService.findById(user.companyId)` lookup (`CompaniesService` already available — `UsersModule` imports `CompaniesModule`). **Not `/auth/me`** — corrected during implementation: `AuthUser` carries no email/phone/photo at all, so `/auth/me` cannot be FR-001's identity source; `GET /users/:id` is what `ProfileRemoteDataSource.getProfile` already calls (research R6). `truck` needs no backend change — `findOne` already returns the raw user document, so the embedded subdocument already flows through
- [x] T022 [P] [US1] E2E test in `test/users-profile-driver.e2e-spec.ts`: `companyName` appears on `GET /users/:id` for a driver viewing their own profile, is absent for a CLIENT's own profile, and `truck` (already present) round-trips unchanged

### Mobile — data & domain

- [x] T023 [P] [US1] Add `DriverProfile` (companyName, truck) to `../mobile_app/lib/shared/entities/auth_user.dart` and `../mobile_app/lib/features/profile/domain/entities/profile_user.dart` as freezed fields, then run `dart run build_runner build`
- [x] T024 [US1] Map `companyName` and `truck` in `../mobile_app/lib/features/profile/data/models/profile_mapper.dart` — `truck` was already present in the backend response but never read here — treating an absent `truck` as distinct from an absent-but-present-key empty value (depends on T023)

### Mobile — presentation

- [x] T025 [US1] Rewrite `../mobile_app/lib/features/profile/presentation/view/driver_profile_details_screen.dart` to read from `ProfileCubit`, deleting the hard-coded `5X XXX XXXX` and `mohamed.ahmed@example.com` rows (depends on T024)
- [x] T026 [US1] Add the truck row to the same screen — plate and fuel types when assigned, an explicit "no truck assigned" line when not (FR-003); never blank, never invented
- [x] T027 [US1] Render a neutral placeholder avatar when no photo exists (FR-004) and a retryable error state on load failure that **never** falls back to placeholder identity values (FR-007)
- [x] T028 [US1] Wire the real unread count into `../mobile_app/lib/features/delivery/presentation/view/driver_main_scaffold.dart`, replacing line 28's `notificationCount: 3, // mock count from image` (FR-009)
- [x] T029 [US1] Implement the profile edit affordance (name + photo) in place of `// Handle edit`, using the existing `UpdateFullName` and `UploadProfilePicture` use cases (FR-005)

### Mobile — phone number change (FR-006)

`driver_change_phone_screen.dart` documents itself as *"Static UI — the field is a mock-up of
the design's empty state... nothing is wired to a backend yet"*; `driver_verify_phone_screen.dart`
also hard-codes a 4-digit code length against the backend's 6-digit OTP shape
(`OtpPrimitivesService.generateCode`). Both must be wired for real, not merely re-pointed —
the client's `change_phone_screen.dart` / `verify_phone_screen.dart` are the working reference.

- [x] T030 [US1] Update the `driverChangePhone`/`driverVerifyPhone` `GoRoute`s in `../mobile_app/lib/core/router/app_router.dart` to pass and read `extra` exactly like the client equivalents (`state.extra as String`) — today neither route carries the phone number at all
- [x] T031 [US1] Wire `DriverChangePhoneScreen` to `PhoneVerificationCubit.requestCode`, pushing `driverVerifyPhone` with `extra: newPhone` on success, mirroring `change_phone_screen.dart` (depends on T030)
- [x] T032 [US1] Wire `DriverVerifyPhoneScreen` to `PhoneVerificationCubit.confirmCode` using `state.extra` as the phone number, and fix the hard-coded `_kCodeLength = 4` to `6` to match the backend OTP shape — the pre-existing mismatch this wiring would otherwise ship unnoticed (FR-006) (depends on T031)
- [x] T033 [US1] Add `ProfileCubit` and `DeliveryCubit` to the `SessionUnauthenticated` clearing branch in `../mobile_app/lib/core/di/injector.dart` — without this the next driver's first frame renders the previous driver's identity and active delivery (FR-008, SC-002)
- [x] T034 [P] [US1] Add `driver_profile.*` keys (truck rows, no-truck-assigned, load failure) to `../mobile_app/lib/core/localization/translation_keys.dart` and both files under `../mobile_app/assets/translations/`

### Tests

- [x] T035 [P] [US1] Integration test `../mobile_app/test/integration/driver_identity_test.dart`: live identity renders; the no-truck state renders; a driver switch leaks nothing from the previous driver

**Checkpoint**: US1 is independently demoable — a real driver, real truck, real badge.

---

## Phase 4: User Story 2 - A driver's session is locked to their person (Priority: P1)

**Goal**: A mandatory, unconfigurable device lock in front of every driver session, that
cannot lock a driver out of an assigned delivery.

**Independent Test**: Background 2+ minutes, return, confirm the challenge; search every
settings screen and confirm no control disables it.

**Mobile only** — no backend work. FR-011 puts enforcement entirely on the device.

- [x] T036 [US2] Add `bool allowDeviceCredential = false` to `BiometricAuthenticator.authenticate` in `../mobile_app/lib/core/security/biometric_authenticator.dart`, passing `biometricOnly: !allowDeviceCredential`. **Leave the default `false`** so login's biometric sign-in is unchanged — unlocking a stored session with a passcode is a weaker proposition than unlocking a running app, and that call was already made deliberately
- [x] T037 [US2] Add `availableMethod()` handling for the "device supports nothing at all" case so the gate can distinguish *no enrolment* (passcode fallback works) from *no device lock whatsoever* (FR-013a)
- [x] T038 [P] [US2] Create `AppLockState` freezed union (`unlocked` · `locked` · `authenticating` · `unavailable`) in `../mobile_app/lib/features/auth/presentation/cubit/app_lock_state.dart`, then run `dart run build_runner build`
- [x] T039 [US2] Create `AppLockCubit` in `../mobile_app/lib/features/auth/presentation/cubit/app_lock_cubit.dart`: `WidgetsBindingObserver` records `paused` time, evaluates on `resumed`, engages past `AppDurations.appLockThreshold` and on every cold launch into an existing session. Active **only** for an authenticated `DRIVER` — FR-010 scopes the mandate to the driver persona, and the client keeps its existing optional behaviour (depends on T036, T038)
- [x] T040 [US2] Create `LockScreen` in `../mobile_app/lib/features/auth/presentation/view/lock_screen.dart`: challenge, retry on failure, sign-out as the only other exit (FR-014). A failed or dismissed challenge never ends the session (FR-015). The `unavailable` state renders the blocking "set up a device lock" screen (FR-013a) (depends on T038)
- [x] T041 [US2] Create `AppLockGate` in `../mobile_app/lib/features/auth/presentation/view/app_lock_gate.dart` and install it in `../mobile_app/lib/app.dart`'s `MaterialApp.router builder:`, wrapping `NotificationBannerPresenter`. **It must be the `builder:`, not a go_router redirect** — `DriverNavigationScreen` and `DriverScanScreen` are pushed with raw `MaterialPageRoute` (`delivery_detail_screen.dart:213`, `driver_navigation_bottom_sheet.dart:191`) and bypass go_router entirely, so a redirect-based gate would leave both reachable behind a lock that believes it is holding (depends on T039, T040)
- [x] T042 [US2] Register `AppLockCubit` in `../mobile_app/lib/core/di/injector.dart` and clear it on `SessionUnauthenticated` (depends on T039)
- [x] T043 [US2] **Remove** the app-lock controls from `../mobile_app/lib/features/profile/presentation/view/driver_profile_screen.dart` — the `_appLock` field, `_pickAppLock`, and the `AppLockDialog` row. FR-010 forbids any control that disables or weakens the lock, so the existing mock toggle is not merely unpersisted, it is now prohibited on the driver build. Leave the client's `more/` usage of `AppLockDialog` untouched
- [x] T044 [P] [US2] Add `lock.*` keys (challenge reason, retry, sign out, device-lock-required explanation) to `translation_keys.dart` and both translation files
- [x] T045 [P] [US2] Unit test `../mobile_app/test/unit/app_lock_cubit_test.dart`: engages past threshold, does not engage under it, engages on cold launch, stays inert for a CLIENT session, reaches `unavailable` when the device supports nothing
- [x] T046 [P] [US2] Widget test `../mobile_app/test/app_lock_gate_test.dart`: the gate covers a screen pushed via raw `MaterialPageRoute` — the specific hole a redirect-based gate would leave — and, separately, that tapping a delivery notification while locked does not navigate to its destination screen until the challenge resolves (FR-016), guarding against a future reordering of `AppLockGate` and `NotificationBannerPresenter` in `app.dart` silently breaking it

**Checkpoint**: US1 and US2 both work independently. Verify against quickstart US2 step 8 that
a locked driver is still `isOnline` and still appears in dispatch candidates (FR-018a) — a
screen lock is not a break.

---

## Phase 5: User Story 3 - A locked-out driver recovers access (Priority: P2)

**Goal**: A driver who has forgotten their password gets back in from the field, without an
administrator.

**Independent Test**: Run the full recovery flow for a seeded driver, reading codes from the
`NoopSmsSender` log, then sign in with the new password.

**⚠️ Launch-gated**: no SMS provider exists (`SmsModule` wires only `NoopSmsSender`). This is
buildable, testable and reviewable now, and **not launchable** until a provider adapter exists
— the same gate spec 005's Story 7 already sits behind (research R8).

### Backend

- [x] T047 [P] [US3] Create `PasswordReset` schema in `src/modules/auth/schemas/password-reset.schema.ts` per [data-model.md](./data-model.md). **Do NOT call `markTenantScoped`** — recovery is pre-authentication, so no `companyId` exists in context and a scoped query would match nothing (plan Complexity Tracking)
- [x] T048 [P] [US3] Create the three DTOs in `src/modules/auth/dto/`: `request-password-reset.dto.ts`, `verify-reset-code.dto.ts`, `complete-password-reset.dto.ts`
- [x] T049 [US3] Create `PasswordResetService` in `src/modules/auth/services/password-reset.service.ts`, modelled on `PhoneVerificationService`: `OtpPrimitivesService` for issue/verify, `SmsSender` port for delivery, supersede-by-delete on reissue (FR-023), 5 attempts (FR-024), `TenantContextService.runUnscoped` for the phone lookup. Calls `SessionAuditService.recoveryRequested` when — and only when — the phone resolves to an account; an unregistered number gets the identical response with no audit row, since there is no account for FR-021's enumeration guarantee to attach one to (depends on T047, T016)
- [x] T050 [US3] Add the per-account Redis rate limiter (3 per 15 minutes) to the same service, returning `RESET_RATE_LIMITED` with `retryAfterSeconds`. The per-account layer is the one that matters — carrier NAT puts thousands of drivers behind one IP (depends on T049)
- [x] T051 [US3] Add `POST /auth/password-reset/request` to `src/modules/auth/auth.controller.ts` — `@Public()`, `@Throttle({ default: { limit: 10, ttl: 60_000 } })`. **Returns an identical `202` for an unknown number, a successful send, and a failed send.** A send failure is logged server-side and never surfaced to the caller: any variation in status, body or timing tells an anonymous caller which numbers have accounts (FR-021, research R3) (depends on T050)
- [x] T052 [US3] Add `POST /auth/password-reset/verify` returning an opaque single-use `resetToken`, and **no `attemptsRemaining` field** — the app already knows the limit from the request step's `attemptsAllowed` and counts locally, so the server never reports a per-attempt count that would leak existence by its absence on an unknown number. One `RESET_CODE_INVALID` for wrong/expired/superseded/locked-out — distinguishing them tells an attacker which wall they hit. Calls `SessionAuditService.recoveryVerifyFailed` on a mismatch (depends on T049)
- [x] T053 [US3] Add `POST /auth/password-reset/complete`. **One `ClientSession`** covering all four writes: `passwordHash`, `sessionGeneration` increment, `PasswordReset.consumedAt`, and the `REVOKED`/`PASSWORD_RESET` audit row (Principle V, FR-027) (depends on T052, T016)
- [x] T054 [P] [US3] E2E test `test/password-reset.e2e-spec.ts` — **the enumeration parity case first**: assert the registered and unregistered responses are indistinguishable in status and body. Then: wrong code increments attempts, 5 attempts locks out, a reissue invalidates the prior code, an expired code is refused, the 4th request in 15 minutes returns `RESET_RATE_LIMITED` with a wait
- [x] T055 [P] [US3] E2E test in the same file: a session live on another device before the reset can no longer refresh afterwards (FR-027)

### Mobile

- [x] T056 [P] [US3] Create `PasswordResetRemoteDataSource` in `../mobile_app/lib/features/auth/data/datasources/password_reset_remote_data_source.dart` — all three calls set `RequestExtraKeys.skipAuth`
- [x] T057 [P] [US3] Create the repository interface in `../mobile_app/lib/features/auth/domain/repositories/password_reset_repository.dart`
- [x] T058 [US3] Create `PasswordResetRepositoryImpl` in `../mobile_app/lib/features/auth/data/repositories/password_reset_repository_impl.dart` returning `Either<Failure, T>` with structured error parsing (depends on T056, T057)
- [x] T059 [P] [US3] Create the three use cases in `../mobile_app/lib/features/auth/domain/usecases/`: `request_password_reset.dart`, `verify_reset_code.dart`, `complete_password_reset.dart` (depends on T057)
- [x] T060 [US3] Create `PasswordResetCubit` + freezed state in `../mobile_app/lib/features/auth/presentation/cubit/`, then run `dart run build_runner build` (depends on T059)
- [x] T061 [US3] Replace the placeholder `../mobile_app/lib/features/auth/presentation/view/forgot_password_screen.dart` with the phone-entry and code-entry steps, including resend. **The 202 says nothing about existence** — always advance to code entry, never imply the number was found (depends on T060)
- [x] T062 [US3] Create `../mobile_app/lib/features/auth/presentation/view/reset_password_screen.dart` — new password, with the platform's password rules stated **before** submission, not only on rejection (FR-026). Returns to login rather than signing in (depends on T060)
- [x] T063 [US3] Add the reset route to `../mobile_app/lib/core/router/app_routes.dart` and `app_router.dart`, reachable while unauthenticated like `/login` and `/support` (depends on T062)
- [x] T064 [US3] Register the recovery stack in `../mobile_app/lib/core/di/injector.dart` as `_registerPasswordResetFeature()` (depends on T060)
- [x] T065 [P] [US3] Add `reset.*` keys (three steps, resend, generic invalid-code message, rate-limit wait) to `translation_keys.dart` and both translation files
- [x] T066 [P] [US3] Unit test `../mobile_app/test/unit/password_reset_cubit_test.dart`: step progression, one generic message for `RESET_CODE_INVALID` regardless of cause, `RESET_RATE_LIMITED` renders the wait

**Checkpoint**: US1–US3 independently functional.

---

## Phase 6: User Story 4 - Signing out actually ends the session (Priority: P2)

**Goal**: Sign-out becomes a real revocation, and still works with no network.

**Independent Test**: Sign out, then attempt to refresh with the pre-sign-out token; expect
refusal.

**⚠️** T067 changes shared sign-out behaviour for the CLIENT persona too — land it alone with
both suites green.

- [x] T067 [US4] Add `POST /auth/logout` to `src/modules/auth/auth.controller.ts` and `AuthService`: increment `sessionGeneration` and write the `SIGNED_OUT` audit row in **one `ClientSession`**, return `204` (depends on T016, T012)
- [x] T068 [P] [US4] E2E test `test/auth-logout.e2e-spec.ts`: a refresh token captured before logout is refused afterwards. Before this feature that call would have succeeded — this test is the whole point of the story
- [x] T069 [US4] Add `logout()` to `AuthRemoteDataSource` in `../mobile_app/lib/features/auth/data/datasources/auth_remote_data_source.dart` (depends on T067)
- [x] T070 [US4] Call it from `AuthRepositoryImpl.signOut()` in `../mobile_app/lib/features/auth/data/repositories/auth_repository_impl.dart` as **fire-and-forget**: the local `_tokenStore.clear()` must run whether or not the call succeeds. A driver out of coverage must never be trapped in a session they cannot leave (FR-031) (depends on T069)
- [x] T071 [P] [US4] Verify against `driver_profile_screen.dart` that sign-out already confirms before acting (FR-033) and that the existing `SessionUnauthenticated` branch already disposes the socket, stopping location reporting and duty (FR-032). Fix only what is actually missing — do not re-implement what is there
- [x] T072 [P] [US4] Widget test `../mobile_app/test/unit/sign_out_offline_test.dart`: with the logout call failing, the local session still clears and the app reaches the login screen

**Checkpoint**: US1–US4 independently functional.

---

## Phase 7: User Story 5 - A revoked driver loses access promptly (Priority: P3)

**Goal**: Revocation reaches a connected device in seconds, and a disconnected one at its next
reconnect.

**Independent Test**: Deactivate a signed-in driver and confirm they are returned to login
within ~5 seconds without touching the device.

### Backend

- [x] T073 [US5] Make `AuthService.login` increment `sessionGeneration` before issuing the pair, displacing any existing session, and write the `REVOKED`/`SIGNED_IN_ELSEWHERE` audit row alongside `SIGNED_IN` — in one transaction (FR-042) (depends on T012, T016)
- [x] T074 [US5] Emit `session:revoked` via `RealtimeGatewayService.emitToUser` on every revocation. **Increment the generation first, then emit** — the session must be genuinely dead when the notice goes out; Socket.io does not re-validate per frame, so the message still lands on the now-stale socket (research R2) (depends on T073)
- [x] T075 [US5] Extend `PATCH /users/:id/deactivate` in `src/modules/users/users.controller.ts` to bump the generation, emit `session:revoked` with `ACCOUNT_DEACTIVATED`, and write the audit row — all in one transaction with the deactivation (depends on T074)
- [x] T076 [US5] Release the deactivated driver's `activeOrderId` through the **existing** path `orders.service.ts` already uses when a driver is released, so the order returns to a reassignable state (FR-038). Do not invent a new order state (depends on T075)
- [x] T077 [US5] Return `401` with `error: SESSION_REVOKED` and a `cause` field from the generation-mismatch path, so the app can state which of the three applies rather than showing a generic expiry message (FR-036) (depends on T009)
- [x] T078 [P] [US5] E2E test `test/session-revocation.e2e-spec.ts`: displacement by a second sign-in; deactivation mid-session **with an elapsed-time assertion that the `session:revoked` emit follows the deactivation call within 5 seconds** (SC-008 — the bound the story exists to meet, not just that revocation eventually happens); **the handshake refusal** — a socket reconnecting on a revoked session is rejected with `UNAUTHORIZED`, which is FR-035a's fallback and needs no gateway code
- [x] T079 [P] [US5] E2E test: a deactivated driver's sign-in attempt is refused with a message indistinguishable from a wrong password (FR-037)

### Mobile

- [x] T080 [US5] Register the `session:revoked` handler in `../mobile_app/lib/core/di/injector.dart` **inside the `SessionAuthenticated` branch, after `trackingSocket.connect()`**. `mobile_app/CLAUDE.md` debt #6 records that `NotificationsCubit` registers its handler in its constructor, before any socket exists, so it silently never attaches — a revocation handler that repeated that mistake would fail exactly as invisibly (depends on T005)
- [x] T081 [US5] On receipt: clear `TokenStore`, then `SessionCubit.signOut(reason: <localized cause>)`. The router redirect already handles the rest (depends on T080)
- [x] T082 [US5] Extend `AuthInterceptor` in `../mobile_app/lib/core/network/auth_interceptor.dart` to read `error: "SESSION_REVOKED"` and pass its `cause` through `onSessionExpired`, so the HTTP backstop states the reason too (depends on T077)
- [x] T083 [P] [US5] Add `session.*` keys — one message per `SessionRevocationCause`. The app maps the enum to a localized string and **never** matches on message text (Principle I/III)
- [x] T084 [P] [US5] Integration test `../mobile_app/test/integration/driver_session_test.dart`: a `session:revoked` push lands the driver on the login screen with the correct cause message; a `connect_error` does the same

**Checkpoint**: all five stories independently functional.

---

## Phase 8: Polish & Cross-Cutting

- [x] T085 [P] Update `../mobile_app/CLAUDE.md` §2 — it is stale and actively misleading: it claims 3 driver routes, 2 driver screens and "no shell", against an actual 9 routes, 11 screens and a `DriverMainScaffold`. Record the new auth surface while correcting it
- [x] T086 [P] Note in `../mobile_app/CLAUDE.md` §4 that debt #7's mock-state pattern still governs `delivery_detail_screen.dart`'s `_OrderMockState` — untouched by this feature and owned by the driver-operations work
- [x] T087 [P] RTL sweep: every new screen (lock, both reset steps, driver profile) renders correctly in Arabic with no clipped or overflowing text (FR-039, SC-010)
- [x] T088 Run the full [quickstart.md](./quickstart.md) walkthrough, including the Phase 0 deploy-safety check and the audit-trail inspection
- [x] T089 Confirm `flutter test` still fails only its pre-existing non-green tests. **Corrected during implementation**: verified by actually running the suite (repeatedly, throughout this feature) to be **two**, not the originally-planned three — `login_screen_golden_test` (pixel diff) and `auth_session_test` (`skip: true`, router-timing gap). `order_flow_render_test`'s "cancelled" case passes standalone and inside the full run; there was no third pre-existing failure to preserve. Confirmed still exactly two after every phase of this feature, including Phase 8's own new tests (RTL sweep, sign-out-offline, session-revocation/connect_error) — see quickstart.md's Regression gates section

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **US1 (Phase 3)** · **US2 (Phase 4)** · **US3 (Phase 5)** · **US4 (Phase 6)** · **US5 (Phase 7)**: all depend only on Foundational
- **Polish (Phase 8)**: depends on the stories being delivered

### User story dependencies

All five are independent of each other once Phase 2 lands. US2 is the most independent —
mobile-only, no backend at all. US5 shares the generation counter with US4 but tests a
different path (push vs. sign-out) and can be built in either order.

### Commits that must land alone

- **T007–T014** — session validation on the hot path, both personas
- **T067** — shared sign-out behaviour, both personas

### Parallel opportunities

- All of Phase 1 (T001–T006) runs in parallel
- T015 runs parallel to T007–T014 (different files, no shared dependency)
- Within US1: T022, T023, T034, T035 are parallel
- Within US3: backend (T047–T055) and mobile (T056–T066) are parallel tracks
- With three developers after Phase 2: A takes US1+US4, B takes US2 (no backend contention),
  C takes US3

---

## Parallel Example: User Story 3

```bash
# Backend and mobile tracks, concurrently:
Task: "Create PasswordReset schema in src/modules/auth/schemas/password-reset.schema.ts"
Task: "Create the three DTOs in src/modules/auth/dto/"
Task: "Create PasswordResetRemoteDataSource in ../mobile_app/lib/features/auth/data/datasources/"
Task: "Create the repository interface in ../mobile_app/lib/features/auth/domain/repositories/"
Task: "Add reset.* keys to translation_keys.dart and both translation files"
```

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (**commit T007–T014 alone, both suites green**)
→ 3. Phase 3 US1 → 4. **Stop and validate** against quickstart US1 → 5. Demo.

A driver seeing their own name, truck and unread count is a real increment on its own — it
turns the driver build from a demo into an account.

### Incremental delivery

Setup + Foundational → US1 (identity) → US2 (lock) → US4 (real sign-out) → US5 (prompt
revocation) → US3 (recovery, last because it is launch-gated on SMS procurement anyway).

This order differs from strict priority: US3 is P2 but sits behind a commercial dependency,
so shipping US4 and US5 first delivers value that can actually reach drivers.

---

## Notes

- **89 tasks**: Setup 6 · Foundational 14 · US1 15 · US2 11 · US3 20 · US4 6 · US5 12 · Polish 5. US1 grew from 12 to 15 during `/speckit-analyze` remediation — three tasks (driver phone-number change, finding C1) were added because the plan had assumed working screens that turned out to be static mock-ups
- Tests are mandatory here per Constitution v1.0.0's Development Workflow, not optional
- Run `dart run build_runner build` after T023, T038, T060 — never edit `*.freezed.dart` or `*.g.dart`
- Commit after each task or logical group; stop at any checkpoint to validate a story alone
