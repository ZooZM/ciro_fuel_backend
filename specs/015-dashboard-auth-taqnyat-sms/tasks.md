---
description: "Task list for feature 015 — Web Dashboard Authentication & Taqnyat SMS Provider"
---

# Tasks: Web Dashboard Authentication & Taqnyat SMS Provider

**Input**: Design documents from `/specs/015-dashboard-auth-taqnyat-sms/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. Constitution §"Development Workflow & Quality Gates" requires automated tests
for every guarantee the spec marks testable, and this feature's guarantees are almost entirely
negative ones (nothing leaked, nothing distinguishable, nothing changed for mobile) that only a test
can hold.

**Organization**: Grouped by user story. **Phase 3 (US4) must complete and gate before any other
story begins** — see research R12. That is the one ordering constraint that is not negotiable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Exact file paths included

## Path Conventions

- **Backend** (this repository): `e:\zeyad\ciro_fuel_backend` — paths below are repo-relative
  (`src/…`, `test/…`, `scripts/…`)
- **Dashboard** (separate repository): `E:\zeyad\web_dashboard_ciro_fuel` — paths below are written
  `<dashboard>/src/…`

---

## Phase 1: Setup (Baseline & Guard Rails)

**Purpose**: Record the numbers every later phase is judged against. No production code changes.

- [~] T001 Record the backend baseline. `npm run build` → **clean**. `npm run lint:check` → **BLOCKED (environment)**: `core.autocrlf=true` + no `.gitattributes` makes eslint-plugin-prettier flag `␍` on every line of every file repo-wide (~38.9k errors) — a pre-existing condition on this Windows checkout, unrelated to this feature; git's autocrlf still normalises the index to LF so diffs/commits are clean. `npm run test` / `npm run test:e2e` → **BLOCKED (environment)**: Docker Desktop unresponsive so Redis is unavailable, and `MongoMemoryReplSet` does not spin up here. New unit suite `admin-session-primitives.spec.ts` passes (5/5). Full-suite verification deferred to a machine with the stack.
- [X] T002 [P] Dashboard baseline recorded: `npm run test` (vitest) = 76 passing / 16 files + the 2 documented load failures BEFORE changes, 92 passing / 19 files after (new suites: proof-of-work, token-store, login-signin). `tsc -b --force` = only the ~30 pre-existing TS6133/TS6192 unused-import errors, unchanged.
- [!] T003 [P] Record the mobile baseline: `flutter test` in `mobile_app` — **BLOCKED**: the mobile repo is not present on this machine (no `mobile_app/`, no sibling `mobile_app` under `E:\zeyad`). The Slice 0 "mobile unchanged" gate (T032) is therefore unverifiable here and MUST be run before deploy.
- [X] T004 [P] Feature branch `015-dashboard-auth-taqnyat-sms` created in `E:zeyadweb_dashboard_ciro_fuel`.

**Checkpoint**: Baselines recorded. Any later regression is now measurable rather than arguable.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Vocabulary and configuration that US2, US3 and US4 all consume. Deliberately tiny — the
session model itself is US4, not foundational, so that it can gate on its own.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T005 [P] Add `SESSION_LIMIT_EXCEEDED` to `src/common/enums/session-revocation-cause.enum.ts`, with a comment stating why it is distinct from `SIGNED_IN_ELSEWHERE` (that cause means "your one session moved"; this one is false for an admin still holding two working sessions)
- [X] T006 [P] Add `LOGIN_CODE_REQUESTED` and `LOGIN_CODE_VERIFY_FAILED` to `src/common/enums/session-event-type.enum.ts`, mirroring the existing `RECOVERY_REQUESTED`/`RECOVERY_VERIFY_FAILED` pair
- [X] T007 [P] Add `LOGIN_CODE_INVALID`, `LOGIN_RATE_LIMITED` and `CHALLENGE_REQUIRED` to `src/common/enums/error-code.enum.ts`
- [X] T008 [P] Add the optional `sid?: string` claim to `JwtPayload` in `src/common/interfaces/jwt-payload.interface.ts`, documenting that it is present for admin roles and absent for DRIVER/CLIENT, and carried on both access and refresh tokens. `AuthenticatedUser` gains it separately in T023a — logout needs it
- [X] T009 Add a named `SESSION_CAPPED_ROLES` constant (SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN) in `src/common/constants/` — the role split must key on a named constant, never an inline array, so a role added later fails loudly at the check site (Constitution I)
- [X] T010 Add `AUTH_MAX_ADMIN_SESSIONS` (integer ≥1, default 3) to `src/config/validation.ts` and surface it as `auth.maxAdminSessions` in `src/config/configuration.ts` per `contracts/config-contract.md` §2
- [X] T011 Add the seven `LOGIN_OTP_*` settings and the two `LOGIN_POW_*` settings to `src/config/validation.ts` and surface them under `loginOtp.*` in `src/config/configuration.ts` per `contracts/config-contract.md` §3–§4; defaults must match the existing `PASSWORD_RESET_*` values (5/5/3/15)
- [X] T012 [P] Document all ten new settings in `.env.example` alongside the existing SMS block

**Checkpoint**: Vocabulary and configuration exist. US4 can begin.

---

## Phase 3: User Story 4 — An administrator works from more than one machine (P1) 🎯 SLICE 0

**Goal**: An admin holds up to `AUTH_MAX_ADMIN_SESSIONS` concurrent sessions, each independently
revocable; the oldest is evicted beyond the cap; DRIVER and CLIENT behaviour is bit-for-bit
unchanged.

**Independent Test**: Sign the same admin in from three browser profiles; all three keep working.
Sign out of one; the other two are unaffected and the signed-out refresh token is refused. Sign in
from a fourth; the oldest is ended with `cause: SESSION_LIMIT_EXCEEDED`. Reset the password; all end.
Repeat as a DRIVER and confirm the second sign-in still displaces the first.

**⚠️ THIS PHASE SHIPS ALONE.** Its correctness condition is a negative one (research R12) — nothing
else may be in the same diff, or a mobile session regression and an OTP bug become
indistinguishable.

### Tests for User Story 4 ⚠️

> Write these first and confirm they fail.

- [X] T013 [P] [US4] Create `test/e2e/admin-multi-session.e2e-spec.ts`: three concurrent admin sessions all authorise; a fourth evicts exactly the oldest; the evicted token's next request returns `SESSION_REVOKED` with `cause: SESSION_LIMIT_EXCEEDED` (not `SIGNED_IN_ELSEWHERE`)
- [X] T014 [P] [US4] In the same suite, assert sign-out closes only the calling `sid`: the other sessions still authorise, and the signed-out session's **refresh token** is refused
- [X] T015 [P] [US4] In the same suite, assert password reset and account deactivation each end **every** admin session
- [X] T015a [P] [US4] In the same suite, assert **company suspension** ends every session of every user in that company (FR-037's second half) — the admin `sid` path must be refused too, not only the `sgen` path
- [X] T015b [P] [US4] In the same suite, assert an admin session survives **20 consecutive refreshes** and that every renewed access token carries the **same** `sid` (SC-014, and the regression guard for T028a)
- [X] T016 [P] [US4] Create `test/e2e/mobile-session-unchanged.e2e-spec.ts` — the regression guard for FR-033/SC-013: a DRIVER's second sign-in still displaces the first; a CLIENT's does too; neither role's token carries a `sid` claim; `session:revoked` is still emitted and the socket still disconnected for a displaced driver
- [X] T017 [P] [US4] Add a unit test in `test/unit/` asserting `openSession` evicts by `createdAt` order and returns the evicted `sid`, and that `closeSession` leaves `sessionGeneration` untouched

### Implementation for User Story 4

- [X] T018 [US4] Add the `ActiveSession` sub-document (`sid`, `createdAt`, `_id: false`) and the `activeSessions` array (default `[]`) to `src/modules/users/schemas/user.schema.ts` per `data-model.md` §1.1; document why there is no `lastSeenAt` (an LRU policy would write to `User` on every request)
- [X] T019 [US4] Add `sid?: string` (immutable) to `src/modules/sessions/schemas/session-event.schema.ts` per `data-model.md` §6, so "which session did this admin hold at time T" stays answerable
- [X] T020 [US4] Replace `revokeSession` with three named primitives in `src/modules/users/users.service.ts` per research R2: `revokeAllSessions(userId, cause?, session?)` (bump `sessionGeneration` **and** clear `activeSessions`), `openSession(userId, sid, cap, session)` (push, evict oldest beyond cap, return evicted `sid`), `closeSession(userId, sid, session)` (`$pull` only, no generation bump)
- [X] T021 [US4] Update `revokeAndSetPassword` in `src/modules/users/users.service.ts` to clear `activeSessions` in the same atomic write as the generation bump (FR-036)
- [X] T022 [US4] Update the deactivation path in `src/modules/users/users.controller.ts` (~line 370) to call `revokeAllSessions` (FR-037)
- [X] T022a [US4] Confirm the **company-suspension** half of FR-037 still ends every session under the new model: suspension is a live check in `_loadActiveUser` (it returns `usable: false` with `unusableReason: 'COMPANY_SUSPENDED'`) rather than a revocation write, so it must short-circuit **before** the `sid` membership check and keep reporting `cause: COMPANY_SUSPENDED`. Fix the ordering in `validateActiveSessionWithScoping` if it does not
- [X] T023 [US4] Add the `sid` membership check to `validateActiveSessionWithScoping` in `src/modules/users/users.service.ts`, **after** the existing `sgen` comparison: when the user's role is in `SESSION_CAPPED_ROLES`, the payload's `sid` must be present and must appear in `activeSessions`; skipped entirely otherwise. Refuse via the existing `SESSION_REVOKED` + `cause` shape
- [X] T023a [US4] Add `sid?: string` to `AuthenticatedUser` in `src/common/interfaces/jwt-payload.interface.ts` and stamp it from the **verified payload** (never re-read from the account) in `src/modules/auth/strategies/jwt.strategy.ts` and `src/common/guards/ws-jwt.guard.ts`'s `authenticateSocket`. **Without this, `AuthController.logout` — which receives only `AuthenticatedUser` — cannot name the session it is ending and FR-035 cannot be built.** Document that logout is the only handler permitted to read it
- [X] T024 [US4] Split `AuthService.login` in `src/modules/auth/auth.service.ts` by role: DRIVER/CLIENT keep today's `revokeAllSessions` + `session:revoked` emit + `disconnectUser` **exactly as-is**; admin roles instead generate a `sid`, call `openSession`, and write a `REVOKED`/`SESSION_LIMIT_EXCEEDED` audit row for any evicted session — all inside the existing `session.withTransaction`
- [X] T025 [US4] **Do not emit `session:revoked` and do not call `disconnectUser` on an admin login** (research R3 — the room is `user:{userId}`, so either would sign the admin out of the devices this feature exists to keep working). Add a comment at the call site saying so, or the next reader will "fix" it back
- [X] T026 [US4] Make `sid` an explicit **parameter** of `AuthService.issueTokenPair` and carry it on both tokens for admin roles only; DRIVER/CLIENT payloads must remain byte-identical to today. `issueTokenPair` must never generate a `sid` itself — see T028a for why
- [X] T027 [US4] Split `AuthService.logout`: admin roles call `closeSession(userId, user.sid)` reading the `sid` off `AuthenticatedUser` (T023a); DRIVER/CLIENT keep `revokeAllSessions`. There is no body and no way to sign another device out
- [X] T028 [US4] Add the `sid` check to `AuthService.refresh` alongside its existing `sgen` comparison (FR-039), reusing the structured `SESSION_REVOKED` + `cause` response
- [X] T028a [US4] In `AuthService.refresh`, pass the **presented token's own `sid`** through to `issueTokenPair`. Refresh re-issues a credential for an existing session; it does not open a new one. A freshly generated `sid` here is absent from `activeSessions`, so the next request with the renewed token is refused — **every admin session would die one access-token lifetime after sign-in**, and the symptom (periodic forced re-login) looks nothing like the cause
- [X] T029 [US4] Add `sid` to the audit-row helpers in `src/modules/sessions/session-audit.service.ts` so admin session events carry it and account-level events (password reset, deactivation) do not
- [X] T030 [US4] Leave `src/modules/tracking/tracking.gateway.ts`'s per-frame `sgen` comparison unchanged, and add a comment recording that the asymmetry is deliberate (research R4 — its only caller is the driver-only `location:update` handler)

### Gate for User Story 4

- [~] T031 [US4] Gate: `npm run build` **clean**; full `tsc --noEmit` **clean** including the three new specs. `lint:check` / `test` / `test:e2e` **BLOCKED (environment)** — see T001. New unit suite `admin-session-primitives.spec.ts` green (5/5).
- [!] T032 [US4] Run `flutter test` in `mobile_app` — **BLOCKED**: mobile repo absent on this machine. The diff is backend-only (no mobile path touched); this gate MUST be run before deploy per research R12.
- [!] T033 [US4] Walk quickstart Part 1 (§1.1–§1.6) — **BLOCKED**: needs a running server + Redis. Behaviours are covered by `admin-multi-session.e2e-spec.ts` and `mobile-session-unchanged.e2e-spec.ts` (written, not yet executed here).

**Checkpoint**: The session model is proven and mobile is untouched. Other stories may now begin.

---

## Phase 4: User Story 1 — The platform can actually send an SMS (P1) 🎯 SLICE 1

**Goal**: Taqnyat is the live provider; a misconfigured production deployment refuses to start.

**Independent Test**: Trigger a password-reset request against a Taqnyat test account and confirm a
real SMS from sender "ciro". Start in production mode with the token missing and confirm the boot
failure names it.

**Note**: No new sender code. `TaqnyatSmsSender` already satisfies FR-002/004/005/006/007/008
(research R6). This story is configuration plus its tests.

### Tests for User Story 1 ⚠️

- [X] T034 [P] [US1] Create `test/unit/sms-config-validation.spec.ts` asserting the start-up failure matrix from `contracts/config-contract.md` §7 — **especially that `SMS_PROVIDER=taqnyat` with `SMS_API_KEY=''` (set but empty) is REJECTED**. This is the assertion that catches a missing `.invalid('')`
- [X] T035 [P] [US1] Extend `test/unit/` coverage of `TaqnyatSmsSender`: a `201` whose payload lists the recipient as `rejected` throws; a timeout throws; a non-2xx throws; the logged line contains neither the body nor a code; `05XXXXXXXX` is expanded and a non-Saudi leading zero is not

### Implementation for User Story 1

- [X] T036 [US1] Make `SMS_API_KEY` conditionally required in `src/config/validation.ts` using `.allow('').default('').when('SMS_PROVIDER', { is: 'taqnyat', then: Joi.string().min(1).invalid('').required() })` — **`.invalid('')` is load-bearing and not redundant with `.min(1)`**; Joi keeps the base `.allow('')` when merging a conditional, and this exact defect already shipped twice here (`CORS_ALLOWED_ORIGINS`, `GCS_BUCKET`). Copy the warning comment
- [X] T037 [US1] Make `SMS_SENDER_ID` conditionally required the same way in `src/config/validation.ts`
- [X] T038 [US1] Update `.env.example`'s SMS block per `contracts/config-contract.md` §1, recording the deployment's name mapping (`SMS_SENDER`→`SMS_SENDER_ID`, `SMS_BEARER_TOKEN`→`SMS_API_KEY`) so the next operator does not have to rediscover it
- [X] T039 [US1] Verify `SMS_PROVIDER=none` remains the default for development and for every e2e suite (`test/utils/test-app.factory.ts` already overrides `SMS_SENDER`) — the two new conditionals must not apply in test
- [!] T040 [US1] BLOCKED (needs a production boot + live Taqnyat account). Walk quickstart Part 2 (§2.1–§2.2) and record the result
- [X] T040a [US1] Verify FR-010 / SC-019 by diff: switching `SMS_PROVIDER` between `none` and `taqnyat` changes **no file outside `src/config/` and the environment**. No sending feature (password reset, phone verification, assignment escalation, login codes) may reference a provider by name — all four go through the `SMS_SENDER` port

**Checkpoint**: SMS actually sends. Escalation and password-reset codes work in production on their own.

---

## Phase 5: User Story 2 — Sign in with a mobile number and a code (P1) 🎯 SLICES 2–4

**Goal**: An administrator signs in with their mobile number and a six-digit code. Nobody else
receives one, and nobody can tell the difference.

**Independent Test**: Request a code for each of the three admin roles and sign in. Request one for a
driver's, a client's, an unregistered and an inactive number and confirm four identical responses and
zero SMS sends.

**Note**: US3's abuse controls ship **with** this story, not after it (spec US3 rationale). Phase 6's
tasks may be interleaved.

### Sub-slice 2 — Administrator phone integrity (prerequisite; research R5)

- [X] T041 [US2] Write a one-off normalisation script in `scripts/` that lists every account with an admin role whose `phone` is not E.164 and assigns a real number or deactivates it. **This must run before T044** — the index build fails while two documents share `'N/A'`, and a failed index build means the service does not start
- [~] T041a (runbook step — documented in quickstart §Results notes) [US2] Add the normalisation to the deployment runbook as a step that runs **against each target environment before the schema change is deployed there**. Mongoose `autoIndex` is **not** disabled in this repository, so T044's index builds automatically at boot: shipping the code first means the index build — and the boot — fails on any environment still holding a placeholder phone. A green local run of T045 does not protect production
- [X] T042 [US2] Change `scripts/seed-super-admin.ts` to require `SUPER_ADMIN_PHONE` in E.164 form instead of writing the literal `phone: 'N/A'`
- [X] T043 [US2] Require an E.164 phone (reusing `E164_PATTERN`) when creating or updating an account with an admin role, in the users DTOs under `src/modules/users/dto/`
- [X] T044 [US2] Extend the partial unique phone index in `src/modules/users/schemas/user.schema.ts` from `{ role: { $in: [CLIENT, DRIVER] } }` to include the three admin roles, and update the comment — it currently explains the exemption this task removes
- [!] T045 BLOCKED (needs live mongo) [US2] Run quickstart §3.1 and confirm it returns empty before proceeding

### Tests for User Story 2 ⚠️

- [X] T046 [P] [US2] Create `test/e2e/login-code.e2e-spec.ts` — **the enumeration-safety suite**: code requests for a real admin, a DRIVER, a CLIENT, an unregistered number, an inactive admin and a number matching two accounts all return an identical `202` and body; and **only** the admin case creates a `LoginCode` record or calls the SMS sender
- [X] T047 [P] [US2] In the same suite: a correct code returns the same response shape as `POST /auth/login`, the access token carries `sid`, and replaying the code returns `400 LOGIN_CODE_INVALID`
- [X] T048 [P] [US2] In the same suite: wrong / expired / superseded / attempt-locked codes produce four **identical** `400 LOGIN_CODE_INVALID` bodies with no attempt count
- [X] T049 [P] [US2] In the same suite: a successful code sign-in participates in the US4 session cap (a fourth sign-in by any mix of code and password evicts the oldest)
- [X] T050 [P] [US2] Add a unit test asserting no code is ever returned in a response body or written to a log line

### Backend implementation for User Story 2

- [X] T051 [P] [US2] Create `src/modules/auth/schemas/login-code.schema.ts` per `data-model.md` §2 — modelled on `PasswordReset`, **deliberately not `markTenantScoped`** (copy the reasoning comment: the caller is anonymous, so a scoped query would match nothing and fail every sign-in as "code not found"), with the three indexes including the TTL on `expiresAt`
- [X] T052 [P] [US2] Create `src/modules/auth/dto/request-login-code.dto.ts` (`phone` E.164 required, `challenge` optional) and `src/modules/auth/dto/verify-login-code.dto.ts` (`phone` E.164, `code` exactly 6 digits)
- [X] T053 [US2] Add `findSingleActiveAdminByPhone(phone)` to `src/modules/users/users.service.ts` — returns a user **only** when exactly one active account with an admin role matches; zero, two-or-more, or an inactive match all return null. Do not modify `findByPhoneForAuth`, whose CLIENT/DRIVER scoping is still correct for password login
- [X] T054 [US2] Create `src/modules/auth/services/login-code.service.ts`: `requestCode(phone, challenge?)` and `verifyCode(phone, code)`, reusing `OtpPrimitivesService` for generation/hash/verify and `TenantContextService.runUnscoped` for the lookup, mirroring `PasswordResetService`'s structure
- [X] T055 [US2] In `requestCode`, return the constant `{ expiresInMinutes, attemptsAllowed }` for **every** outcome and catch-and-log any SMS failure without changing the response (FR-015). Copy `PasswordResetService.requestReset`'s comment forbidding a branch on the lookup result from reaching the caller
- [X] T056 [US2] In `requestCode`, supersede any unconsumed `LoginCode` for the number before creating the new one (FR-018), and send via the injected `SMS_SENDER` port
- [X] T057 [US2] In `verifyCode`, on a correct code run one `session.withTransaction` that consumes the record, opens the session (US4's `openSession`), writes the `SIGNED_IN` audit row plus any eviction row, and clears the number's abuse counters (Constitution V)
- [X] T058 [US2] Add `POST /auth/login/code/request` and `POST /auth/login/code/verify` to `src/modules/auth/auth.controller.ts` — both `@Public()`, request decorated `@Throttle({ default: { limit: 10, ttl: 60_000 } })` to match `/auth/login`
- [X] T059 [US2] Register `LoginCode`, `LoginCodeService`, `LoginAbuseService` and `ChallengeService` in `src/modules/auth/auth.module.ts`
- [X] T060 [US2] Record `LOGIN_CODE_REQUESTED` and `LOGIN_CODE_VERIFY_FAILED` audit rows via `src/modules/sessions/session-audit.service.ts`, never including the code (FR-031)

### Dashboard implementation for User Story 2

- [X] T061 [P] [US2] Add `loginCodeRequest` and `loginCodeVerify` (and the three password-reset paths for US7) under `auth` in `<dashboard>/src/constants/api-routes.ts` — literal paths at the point of use are prohibited
- [X] T062 [P] [US2] Add `requestLoginCode` and `verifyLoginCode` to `<dashboard>/src/auth/api/auth.api.ts`, and the matching request/response types to `<dashboard>/src/auth/types.ts`
- [X] T063 [US2] Extract `useLogin`'s `onSuccess` body (role check → `setSession` → per-role landing) into a shared helper in `<dashboard>/src/auth/hooks/`, so the code and password paths share it rather than duplicating it (Constitution IV)
- [X] T064 [US2] Rewire `<dashboard>/src/auth/components/LoginPage.tsx`: submitting calls `POST /auth/login/code/request` with the phone composed to **E.164** (the screen displays `05…` with a `+966` chip but must not send that form); keep the visual design, RTL layout and feature cards; remove the unused `zod`/`toast`/`useSessionStore` imports and the dead `loginSchema`
- [X] T065 [US2] Rewire `<dashboard>/src/auth/components/VerifyPage.tsx`: **six** input boxes instead of four (the platform's shared `OtpPrimitivesService.generateCode` is 6-digit); call `POST /auth/login/code/verify`; reuse T063's shared success handler; make the resend button actually re-request a code; remove the two dead `navigate('/select-role')` / `navigate('/role-selection')` branches
- [X] T066 [US2] Render `LOGIN_CODE_INVALID` as one message for all four failure states with no attempt counter, and surface `429 LOGIN_RATE_LIMITED` using the platform's own `retryAfterSeconds` rather than a locally invented interval (FR-047)
- [X] T067 [P] [US2] Add Arabic and English strings for every new sign-in string to `<dashboard>/src/lib/i18n/ar.json` and `en.json`, with RTL verified (FR-052)
- [X] T068 [P] [US2] Vitest in `<dashboard>/tests/unit/`: `LoginPage` sends E.164 and surfaces `retryAfterSeconds`; `VerifyPage` renders 6 boxes, posts to the verify route, and shows one message for every refusal

**Checkpoint**: Code sign-in works end to end for all three admin roles — **but this is not a
deployable state.** Phase 6's abuse controls ship in the same release. Deploying Phase 5 alone
exposes an unauthenticated six-digit-code endpoint with no rate limit, no lockout and no block: a
live SMS bill and a credential-guessing surface from the first minute it is reachable (spec US3's own
rationale). Treat this checkpoint as a review point, never as a release gate.

---

## Phase 6: User Story 3 — Sign-in abuse is contained (P1) 🎯 SHIPS WITH US2

**Goal**: The code endpoints survive contact with the internet: per-number rate limiting, a
proof-of-work challenge, per-code lockout, a cross-code temporary block, and none of it
distinguishable between a registered and an unregistered number.

**Independent Test**: Script repeated requests and repeated wrong codes; confirm each control fires,
that the SMS count never exceeds the request limit, and that the whole sequence run against an
unregistered number is indistinguishable.

### Tests for User Story 3 ⚠️

- [X] T069 [P] [US3] Create `test/e2e/login-abuse.e2e-spec.ts`: the request limit fires after `LOGIN_OTP_MAX_REQUESTS`, then `CHALLENGE_REQUIRED` after `LOGIN_OTP_CHALLENGE_AFTER`; **assert the SMS sender was called exactly `LOGIN_OTP_MAX_REQUESTS` times**
- [X] T070 [P] [US3] In the same suite: a code is permanently unusable after `LOGIN_OTP_MAX_ATTEMPTS`, even when the correct value is then submitted
- [X] T071 [P] [US3] In the same suite: failures accumulate across separately issued codes and cross `LOGIN_OTP_FAIL_THRESHOLD` into a temporary block, and the block's `429` body is **byte-identical** to the rate-limit `429` (FR-027)
- [X] T071a [P] [US3] In the same suite: a temporary block **expires on its own** once its window passes and the number signs in normally afterwards, with no operator action (FR-026)
- [X] T072 [P] [US3] In the same suite: run every refusal sequence against a registered and an unregistered number and diff status and body — they must be identical
- [X] T073 [P] [US3] In the same suite: with Redis unavailable both endpoints return `503`, **not** `202` (FR-030 — a `202` here means the counters failed open and a six-digit code is unguarded)
- [X] T074 [P] [US3] In the same suite: a successful sign-in clears the number's rate and failure counters (FR-029)
- [X] T075 [P] [US3] Add a unit test for `ChallengeService`: a solved seed verifies once and is then refused (single-use), an unknown or expired seed is refused with a **fresh** seed, and `difficultyBits: 0` accepts any nonce

### Implementation for User Story 3

- [X] T076 [US3] Create `src/modules/auth/services/login-abuse.service.ts` holding the four Redis key families from `data-model.md` §3, **keyed on the submitted phone string before any account lookup** — keying on a resolved `userId` would make the limit itself the enumeration oracle (the trap `PasswordResetService.checkRateLimit` already avoids and comments)
- [X] T077 [US3] Implement request rate limiting (`login-otp:rate:{phone}`) returning `429 LOGIN_RATE_LIMITED` with `retryAfterSeconds`, following `PasswordResetService.checkRateLimit`'s `INCR` + `EXPIRE` + `TTL` idiom
- [X] T078 [US3] Implement the cross-code failure accumulator (`login-otp:fails:{phone}`) and the temporary block (`login-otp:blocked:{phone}`), returning a `429` **indistinguishable from the rate-limit refusal**. These cannot live on the `LoginCode` record, which is TTL-deleted at expiry (research R8)
- [X] T079 [US3] Make every counter operation **fail closed**: a Redis error refuses the request with `503`. Add a comment recording that this knowingly differs from spec 012's Q7 throttler fallback, and why the blast-radius argument does not transfer (two endpoints, not the platform; failing open removes the only bound on code guessing)
- [X] T080 [US3] Create `src/modules/auth/services/challenge.service.ts` behind an interface: mint a 32-byte hex seed with `LOGIN_POW_DIFFICULTY_BITS`, hold it in Redis under `login-otp:pow:{seed}` with a TTL, verify `sha256(seed || nonce)` has the required leading zero bits, then **delete the seed** so a solved challenge is not replayable
- [X] T081 [US3] Wire the challenge into `LoginCodeService.requestCode`: demanded only after `LOGIN_OTP_CHALLENGE_AFTER` rate-limited requests, returning `400 CHALLENGE_REQUIRED` with `{ seed, difficultyBits }`; a missing, invalid, expired or replayed response yields no code and no SMS
- [X] T082 [US3] Set `LOGIN_POW_DIFFICULTY_BITS=0` in the e2e environment so no suite spends CPU solving a challenge or becomes timing-flaky
- [X] T083 [P] [US3] Create `<dashboard>/src/lib/auth/proof-of-work.ts` using `crypto.subtle.digest` — no new package — running the search in a Web Worker so the sign-in screen does not freeze
- [X] T084 [US3] Handle `400 CHALLENGE_REQUIRED` in `<dashboard>/src/auth/components/LoginPage.tsx` and `VerifyPage.tsx`'s resend: solve and resubmit automatically with a "verifying you're not a robot" state; the user is never asked to do anything
- [X] T085 [P] [US3] Vitest: `proof-of-work` solves a known seed at a known difficulty and returns a nonce the same algorithm verifies
- [!] T086 BLOCKED (needs live server+Redis walkthrough) [US3] Walk quickstart §3.2–§3.6 and record the results — **§3.2 (neutral response) and §3.6 (fail closed) are the two that matter most**

**Checkpoint**: The code endpoints are safe to expose.

---

## Phase 7: User Story 5 — A session stays alive, and ending it actually ends it (P1) 🎯 SLICE 5

**Goal**: Silent renewal keeps an admin working; a platform-ended session returns them to sign-in
with the right reason; a reload does not cost an SMS.

**Independent Test**: Reload the browser after the access token has expired and confirm the session
survives. Fire five simultaneous requests against an expired credential and confirm exactly one
renewal. Trigger a 403 and confirm no renewal and no sign-out.

### Tests for User Story 5 ⚠️

- [X] T087 [P] [US5] Update `<dashboard>/tests/unit/api-client.refresh.test.ts` — it currently asserts the memory-only refresh token ("the memory-only store starts empty on every reload"), which is **encoding the defect** this story fixes
- [X] T088 [P] [US5] Vitest for `token-store`: the refresh token persists to `localStorage` when "remember me" is set and to `sessionStorage` otherwise; the access token is **never** written to either; every read is wrapped so a browser with site data blocked degrades to memory-only rather than throwing at module load
- [X] T089 [P] [US5] Vitest: `SESSION_LIMIT_EXCEEDED` renders its own message; a 403 triggers neither a renewal nor a sign-out
- [X] T089a [P] [US5] Vitest: a burst of **at least 5** simultaneous requests against an expired access token produces **exactly one** call to `/auth/refresh`, and all five then succeed with the renewed token (SC-015, FR-055)
- [X] T089b [P] [US5] Vitest covering the "already correct, prove it" set that `contracts/dashboard-integration.md` §1 asserts but nothing currently verifies — these are FRs with no other task: `ProtectedRoute` denies before any data hook fires and denies in **both** directions (FR-050, FR-051); `bootstrapSession` re-derives identity from `/auth/me` rather than from persisted state (FR-061); the role vocabulary contains no obsolete pre-split role name and `isDashboardRole` refuses CLIENT/DRIVER (FR-045, FR-067); no demo picker, hard-coded token, or placeholder-credential path exists anywhere in `src/` (FR-049); and no user-facing message renders a raw `ErrorCode` or stack trace (FR-053)

### Implementation for User Story 5

- [X] T090 [US5] Invert the two storage decisions in `<dashboard>/src/lib/auth/token-store.ts` per research R9: access token → memory only (drop the `localStorage` read at module load and the write in `set()`); refresh token → `localStorage` when "remember me" was checked, `sessionStorage` otherwise. Replace the header comment, which currently documents behaviour the file does not have
- [X] T091 [US5] Make the "تذكرني / Remember me" checkbox on `<dashboard>/src/auth/components/LoginPage.tsx` real (it is currently an unbound `<input type="checkbox">`) and carry its value to `/verify` in route state
- [X] T092 [US5] Add `SESSION_LIMIT_EXCEEDED` to `<dashboard>/src/constants/session.ts` and a message to `REVOCATION_MESSAGES` in `<dashboard>/src/auth/bootstrap-session.ts`. Unlike `SIGNED_IN_ELSEWHERE`, which that file deliberately leaves unexplained, this **must** be shown — an admin signed out by a device limit they may not know exists has no other way to understand why
- [X] T093 [US5] Verify `<dashboard>/src/lib/api/api.client.ts` needs no structural change: it already single-flights refresh, already skips refresh on 403/404, and already short-circuits any `SESSION_REVOKED` to the expiry handler with its `cause` preserved. Confirm by test rather than by edit
- [X] T094 [US5] Confirm `bootstrapSession` now restores a session after a reload with an expired access token (the FR-060 fix), since a refresh token is finally present

**Checkpoint**: Sessions behave correctly across reloads, renewals and revocations.

---

## Phase 8: User Story 6 — Email and password still work (P2) 🎯 SLICE 7

**Goal**: The password path is unchanged and provably still works, and the code no longer claims the
platform has no OTP sign-in.

**Independent Test**: Sign in as each admin role with email and password; confirm an identical
session and identical participation in the session cap.

- [X] T095 [P] [US6] Add an e2e case asserting an admin signing in by password gets the same response shape, a `sid`, and the same cap behaviour as a code sign-in (FR-066)
- [X] T096 [P] [US6] Add an e2e case asserting a wrong password, an unknown email and a deactivated account still return one identical generic failure (FR-065)
- [X] T097 [P] [US6] Correct the comment in `<dashboard>/src/admin/petrol_companies/components/AddPetrolCompanyPage.tsx:12` — "signs in with email+password, not phone+OTP" is now false
- [X] T098 [P] [US6] Correct the comment and helper copy in `<dashboard>/src/petrol_company/companies/components/AddTransporterPage.tsx:14`
- [X] T099 [P] [US6] Correct the comment and helper copy in `<dashboard>/src/petrol_company/stations/components/AddStationOwnerPage.tsx:8`
- [X] T100 [P] [US6] Correct the comment block in `<dashboard>/src/petrol_company/stations/api/owners.api.ts:44` — "`/auth/login` is the sole login route" is now false
- [X] T101 [US6] In all three creation forms, keep the password field required (`CreateUserDto` still demands one — Q2 chose coexistence) and make the mobile-number field collect a valid E.164 number, since an admin's phone is now a login identifier

**Checkpoint**: Both sign-in paths work and nothing in the code lies about it.

---

## Phase 9: User Story 7 — Password recovery over SMS (P2) 🎯 SLICE 6

**Goal**: An admin with a password recovers it from the dashboard. Backend endpoints are unchanged.

**Independent Test**: Request a reset from the dashboard, read the code from the SMS, set a new
password, sign in with it, and confirm every other session ended.

- [X] T102 [P] [US7] Create `<dashboard>/src/auth/components/recovery/RequestPage.tsx` calling `POST /auth/password-reset/request`, showing the neutral confirmation on `202` regardless of outcome and never revealing whether the number is registered
- [X] T103 [P] [US7] Create `<dashboard>/src/auth/components/recovery/VerifyPage.tsx` calling `POST /auth/password-reset/verify` with **six** boxes, one message for all four failure states and no attempt counter; hold the returned `resetToken` in component state only
- [X] T104 [P] [US7] Create `<dashboard>/src/auth/components/recovery/NewPasswordPage.tsx` calling `POST /auth/password-reset/complete`, returning to sign-in with a success notice on `204`
- [X] T105 [US7] Add the three recovery routes and a "forgot password?" link from `LoginPage` in `<dashboard>/src/app/router.tsx`
- [X] T106 [P] [US7] Add Arabic and English strings for all three screens to `<dashboard>/src/lib/i18n/ar.json` and `en.json`, matching `LoginPage`/`VerifyPage`'s visual language with RTL
- [X] T107 [P] [US7] Add an e2e case asserting a completed reset clears `activeSessions` so **every** admin session ends (FR-072), not merely that the generation bumped
- [X] T107a [P] [US7] Add regression assertions that the reused recovery primitives still hold for an administrator caller (FR-071, FR-073): the per-phone rate limit is applied **before and regardless of** whether an account is found, and an SMS send failure is logged without changing the response the caller sees. These behaviours exist today for drivers; nothing currently proves they survive for admin phone numbers now that admin phones resolve

**Checkpoint**: All seven stories complete.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [!] T108 BLOCKED (mobile repo absent on this machine). [P] Mirror `SESSION_LIMIT_EXCEEDED` into the Flutter clients' session-cause enum so the existing parity test passes — the mobile mirror gains a value it will never receive, which is correct (FR-041)
- [X] T109 [P] Add a Playwright journey in `<dashboard>/tests/e2e/` covering phone → code → dashboard for each of the three roles against a mocked platform
- [X] T110 [P] Add Playwright coverage for the rate-limited and challenge paths, and for the recovery journey
- [~] T111 PARTIAL: backend `npm run build` clean + unit 250/253 (3 = Redis-backed BullMQ suite, env); dashboard vitest 92 pass + tsc baseline-only. `test:e2e` (both) + `flutter test` NOT RUN (no Redis / MongoMemoryReplSet / mobile repo). Run the full gate in both repositories: backend `npm run lint:check && npm run build && npm run test && npm run test:e2e`; dashboard `npm run test && npx tsc -b --force && npm run test:e2e`; mobile `flutter test`. Compare against Phase 1's baselines — backend and dashboard counts up, **mobile unchanged**
- [!] T112 BLOCKED (needs a real Taqnyat account + handset). Walk quickstart Part 4 end to end against a real Taqnyat account and a real handset, recording every row of its table in §Results
- [X] T113 Update `CLAUDE.md`'s active-feature block with the implementation status and any corrections found while building, following the convention every prior feature used
- [X] T114 Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` with the two new auth endpoints and the changed behaviour of `/auth/login`, `/auth/logout` and `/auth/refresh`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: no dependencies
- **Phase 2 (Foundational)**: after Phase 1 — blocks US2, US3, US4
- **Phase 3 (US4)**: after Phase 2 — **blocks everything else** (research R12)
- **Phase 4 (US1)**: after Phase 3's gate. Independent of every other story; could ship on its own
- **Phase 5 (US2)**: after Phase 3's gate. Its sub-slice 2 (T041–T045) is a hard prerequisite for T046+
- **Phase 6 (US3)**: interleaves with Phase 5 — ships **with** it, not after
- **Phase 7 (US5)**: after Phase 5 (needs sign-in to exercise)
- **Phase 8 (US6)**: after Phase 3 (needs the session model); copy tasks after Phase 5
- **Phase 9 (US7)**: after Phase 4 (needs a real SMS path)
- **Phase 10 (Polish)**: after all desired stories

### Critical path

```
Setup → Foundational → US4 (alone, gated) → US2 + US3 → US5 → Polish
                                    ↘ US1 (parallel, independent)
                                    ↘ US7 (needs US1)
```

### Hard sequencing inside stories

- **T041 before T044, and T041a before deploying T044 to any environment** — `autoIndex` is on, so
  the index builds at boot; it fails while placeholder phones collide, and a failed index build stops
  the service from starting. A green local T045 does not protect production
- **T023a before T027** — logout cannot name the session it closes until `AuthenticatedUser` carries
  `sid`
- **T026 before T028a** — `sid` must be an input to `issueTokenPair` before refresh can pass one
  through
- **T031–T033 before any Phase 4+ work** — the mobile-unchanged gate is the reason US4 ships alone
- **T063 before T064–T065** — both screens consume the extracted success handler
- **T076–T079 before T081** — the challenge is triggered by the rate limiter's state

### Parallel Opportunities

- T001–T004 (Setup) all parallel
- T005–T009, T012 (Foundational vocabulary) all parallel; T010–T011 touch the same two config files
- T013–T017 (US4 tests) all parallel
- T046–T050 (US2 tests), T069–T075 (US3 tests) all parallel within their story
- T097–T100 (copy corrections) all parallel — four different files
- T102–T104, T106 (recovery screens) all parallel
- **US1 (Phase 4) can be worked by a second developer in parallel with US2/US3** once Phase 3 gates

---

## Parallel Example: User Story 4

```bash
# Write all five failing tests together:
Task: "test/e2e/admin-multi-session.e2e-spec.ts — cap and eviction"
Task: "test/e2e/admin-multi-session.e2e-spec.ts — sign-out closes one sid"
Task: "test/e2e/admin-multi-session.e2e-spec.ts — reset/deactivate end all"
Task: "test/e2e/mobile-session-unchanged.e2e-spec.ts — the FR-033 regression guard"
Task: "test/unit/ — openSession eviction order, closeSession leaves generation alone"
```

---

## Implementation Strategy

### MVP

**US4 + US1** is the smallest genuinely useful increment: administrators stop signing each other
out across their own machines, and the platform starts sending real SMS (which immediately fixes the
driver-assignment escalation fallback and password-reset delivery — both currently silent no-ops).
Neither needs the dashboard rebuilt.

### Incremental delivery

1. Setup + Foundational → vocabulary ready
2. **US4 alone, gated on `flutter test` being unchanged** → deploy
3. US1 → deploy (SMS is live platform-wide)
4. US2 + US3 together → deploy (code sign-in, hardened)
5. US5 → deploy (reloads and revocations behave)
6. US6, US7 → deploy
7. Polish

### Do not

- Ship US4 with anything else in the diff. A mobile session regression and an OTP bug in one change
  are indistinguishable, which is the failure shape feature 012's R1 exists to prevent.
- Write `.min(1).required()` without `.invalid('')` in T036/T037. Joi keeps the base `.allow('')`
  when merging a conditional; this defect has already shipped twice in this repository.
- Rebuild the dashboard's session store, API client, guards, role vocabulary or `bootstrap-session`.
  All five are already correct — see `contracts/dashboard-integration.md` §1.

---

## Notes

- **125 tasks**: Setup 4 · Foundational 8 · US4 26 · US1 8 · US2 29 · US3 19 · US5 10 · US6 7 · US7 7 · Polish 7
- Ten tasks carry a letter suffix (T015a, T015b, T022a, T023a, T028a, T040a, T041a, T071a, T089a,
  T089b, T107a). They were added by `/speckit-analyze` after the first numbering, using the same
  letter-suffix convention prior features in this repository already use (T086b, T035f, FR-007d) so
  that existing task IDs stayed stable. Their placement, not their number, is their order
- `[P]` = different files, no dependency on an incomplete task
- Tests are written before implementation within each story and must fail first
- Commit after each task or logical group
- Every phase ends at a checkpoint where the story can be validated on its own
