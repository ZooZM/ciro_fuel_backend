# Implementation Plan: Web Dashboard Authentication & Taqnyat SMS Provider

**Branch**: `015-dashboard-auth-taqnyat-sms` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/015-dashboard-auth-taqnyat-sms/spec.md`

## Summary

Administrators sign in to the web dashboard with their mobile number and a code sent by SMS. Behind
that sentence sit three separate gaps, and they are not the same kind of work:

- **Sending an SMS is a configuration change, not a build.** `TaqnyatSmsSender` already exists and
  already handles the provider's genuinely surprising behaviour — a `201` that lists the recipient as
  *rejected*. The platform is simply pointed at the development no-op. Turning it on means setting
  `SMS_PROVIDER=taqnyat` and closing two Joi holes that would otherwise let a production deployment
  start "configured for Taqnyat" with a blank token (R6).
- **Code sign-in is a genuinely new, unauthenticated credential endpoint**, and the clarification
  session asked for it to be hardened well past the platform's existing recovery flow — a per-number
  block across codes and a proof-of-work challenge on top of the rate limit and per-code lockout.
- **Concurrent administrator sessions break the platform's session model.** This is the real work.
  `sessionGeneration` is a single integer per account, and it is currently the sole mechanism behind
  driver displacement, sign-out revocation, password-reset invalidation, deactivation and company
  suspension. It cannot express "three sessions, close this one, evict the oldest."

The design risk is concentrated entirely in that third item, and its correctness condition is a
**negative** one: DRIVER and CLIENT behaviour must be bit-for-bit unchanged, with both Flutter
suites green and unmodified. A negative condition is only credible when nothing else moved in the
same change — so **Slice 0 lands the session model alone**, before any endpoint or screen (R12).

Two findings decided more of this plan than the spec did. **Administrator phone numbers are neither
unique nor real** — the partial unique index deliberately excludes admin roles, `seed-super-admin.ts`
writes the literal string `'N/A'`, and `findByPhoneForAuth` is scoped away from admin roles *on
purpose*, with comments explaining that this is what stops the placeholder resolving to a login
(R5). The platform has an explicit, commented design that admin phones are not login identifiers,
and this feature reverses it. And **the dashboard persists the wrong token**: the access token goes
to `localStorage` while the refresh token is memory-only, which is exactly backwards and means a
browser reload after the access token expires throws the administrator back to sign-in — now at the
cost of an SMS (R9).

## Technical Context

**Language/Version**: TypeScript 5.x with `strict` (backend NestJS; dashboard React 18 + Vite)

**Primary Dependencies**: Backend — NestJS, Mongoose, Passport-JWT, Joi, ioredis, BullMQ, Socket.io.
Dashboard — React 18, TanStack Query, Zustand, React Router v6, Axios, react-i18next, Tailwind +
shadcn/ui. **No new runtime dependency in either repository** — the proof-of-work uses
`crypto.subtle` in the browser and `node:crypto` on the server (R7).

**Storage**: MongoDB (replica set; transactions available) for `User.activeSessions`, `LoginCode`
and `SessionEvent`. Redis for the four abuse-counter key families and the proof-of-work seeds.

**Testing**: Backend — Jest unit + e2e (`test/jest-e2e.json`, `--runInBand`, `MongoMemoryReplSet`,
`test/utils/test-app.factory.ts`, which already overrides `SMS_SENDER`). Dashboard — Vitest +
Testing Library + MSW; Playwright for journeys.

**Target Platform**: Linux server (Docker Compose on GCE behind nginx); dashboard is a browser SPA.

**Project Type**: Web application — NestJS backend in this repository, dashboard in a separate
repository at `E:\zeyad\web_dashboard_ciro_fuel`.

**Performance Goals**: No new latency budget. The session check adds **zero queries** — it reads an
array on a document `_loadActiveUser` already fetches on every authenticated request and every
socket handshake (R1). Proof-of-work is client-side and never gates a first request.

**Constraints**: No change to either Flutter client (FR-033, SC-020). Backend entry stays
`server.ts`; local uploads stay under `sys_storge`. `TrackingGateway`'s per-frame `sgen` check is
deliberately left alone (R4).

**Scale/Scope**: 7 user stories, 74 functional requirements, 20 success criteria. Two repositories.
2 new endpoints, 1 new collection, 1 new embedded sub-document, 1 new JWT claim, 6 enum values, 10
new settings, 2 changed settings. Dashboard: 2 screens rewired, 3 screens new, 1 store inverted, 4
files' copy corrected.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes: **PASS**.*

### I. Strict Typing & No Magic Values — PASS

Every new literal is named: `SessionRevocationCause.SESSION_LIMIT_EXCEEDED`, two `SessionEventType`
values, three `ErrorCode` values, ten configuration settings, and two `apiRoutes.auth.*` entries in
the dashboard (literal paths at the point of use are prohibited — feature 013 FR-097). The new `sid`
claim is typed on `JwtPayload`. The `ActiveSession` sub-document is a typed schema class.

**Watch item carried into review**: the role split in `validateActiveSessionWithScoping` must key on
a named constant (`DASHBOARD_LOGIN_ROLES`-equivalent on the backend), never on an inline role array —
a role added later must fail loudly at that site, not silently skip the session check.

### II. Tenant Isolation & Security-First — PASS

`LoginCode` is deliberately **not** `markTenantScoped`, for the reason `PasswordReset`'s own schema
comment gives: the caller is anonymous, there is no `companyId` in `AsyncLocalStorage`, and a scoped
query would match nothing and fail every sign-in as "code not found". Reached only through
`TenantContextService.runUnscoped`, the same mechanism `PhoneVerificationService` and
`PasswordResetService` already use. This is a *continuation* of an existing, reviewed pattern rather
than a new exemption, so it does not require Complexity Tracking.

Security defaults to the safe option throughout: codes hashed with salt at rest and never returned,
logged or exposed; one refusal for four failure states; a neutral response for every lookup outcome;
counters keyed on the submitted phone *before* any account lookup so the limit cannot become the
oracle; and the counters fail **closed** (FR-030). The last point contradicts spec 012's Q7 decision
for the throttler and does so knowingly — see R8 for why the blast-radius argument does not transfer.

### III. Centralized Error Handling — PASS

All new refusals use the platform's existing structured envelope and the `ErrorCode` enum. The
`SESSION_REVOKED` + `cause` shape is reused unchanged for the new eviction case, which is why the
dashboard's interceptor needs no structural change — only a new message for a new `cause` value.

### IV. Clean Architecture & UI/Logic Decoupling — PASS

Backend keeps module/service/controller/DTO separation: a `LoginCodeService` alongside the existing
`PasswordResetService`, both consuming the shared `OtpPrimitivesService`; a `ChallengeService` behind
an interface so the proof-of-work can be swapped for a third-party CAPTCHA without touching a
controller (R7). Dashboard keeps fetching and state out of components — the two sign-in screens call
hooks over `auth.api.ts`, and `useLogin`'s existing success handling is **extracted and shared**
between the password and code paths rather than duplicated. Functional components only.

### V. Transactional Integrity for State Changes — PASS

Opening a session, evicting the oldest, consuming the `LoginCode` and writing both audit rows commit
in one `session.withTransaction` — the same shape `AuthService.login` already uses. A consumed code
without a session, or an eviction without its audit row, are exactly the partial writes this
principle exists to prevent. Password reset already runs in a transaction and gains the
`activeSessions` clear inside it.

### Post-design re-check

Nothing in Phase 1 introduced a new violation. Two things were checked specifically and are clean:
the `LoginCode` non-scoping is the documented continuation described above, and the new Redis
dependency does not weaken Principle II because it fails closed rather than open.

**Complexity Tracking: empty.**

## Project Structure

### Documentation (this feature)

```text
specs/015-dashboard-auth-taqnyat-sms/
├── plan.md                              # This file
├── spec.md                              # 7 stories, 74 FRs, 20 SCs, 5 clarifications
├── research.md                          # 12 decisions (R1, R3, R5, R6, R9 overturn assumptions)
├── data-model.md                        # User delta, LoginCode, Redis keys, enums, config
├── quickstart.md                        # 5-part walkthrough; Part 4 needs a real handset
├── contracts/
│   ├── rest-api-delta.md                # 2 new endpoints; 3 existing change behaviour only
│   ├── dashboard-integration.md         # What to build, and what NOT to rebuild
│   └── config-contract.md               # Every setting + the exact Joi shapes
└── tasks.md                             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code

**Backend** (`e:\zeyad\ciro_fuel_backend`) — changed and new:

```text
src/
├── common/
│   ├── enums/
│   │   ├── session-revocation-cause.enum.ts   # + SESSION_LIMIT_EXCEEDED
│   │   ├── session-event-type.enum.ts         # + LOGIN_CODE_REQUESTED, LOGIN_CODE_VERIFY_FAILED
│   │   └── error-code.enum.ts                 # + LOGIN_CODE_INVALID, LOGIN_RATE_LIMITED, CHALLENGE_REQUIRED
│   ├── interfaces/jwt-payload.interface.ts    # + sid
│   └── sms/                                   # UNCHANGED — TaqnyatSmsSender already correct (R6)
├── config/
│   ├── validation.ts                          # SMS_API_KEY/SMS_SENDER_ID conditionals + 10 new settings
│   └── configuration.ts                       # auth.*, loginOtp.*
├── modules/
│   ├── auth/
│   │   ├── auth.controller.ts                 # + 2 routes
│   │   ├── auth.service.ts                    # role-split login/logout/refresh; no push on admin login
│   │   ├── dto/{request-login-code,verify-login-code}.dto.ts   # new
│   │   ├── schemas/login-code.schema.ts       # new
│   │   └── services/
│   │       ├── login-code.service.ts          # new
│   │       ├── login-abuse.service.ts         # new — Redis counters, fail closed
│   │       └── challenge.service.ts           # new — proof-of-work behind an interface
│   ├── users/
│   │   ├── schemas/user.schema.ts             # + activeSessions; phone index extended
│   │   └── users.service.ts                   # revokeAllSessions / openSession / closeSession
│   └── sessions/schemas/session-event.schema.ts  # + sid
└── scripts/seed-super-admin.ts                # SUPER_ADMIN_PHONE required, E.164
```

**Dashboard** (`E:\zeyad\web_dashboard_ciro_fuel`):

```text
src/
├── auth/
│   ├── api/auth.api.ts                        # + requestLoginCode, verifyLoginCode, 3 recovery calls
│   ├── components/
│   │   ├── LoginPage.tsx                      # rewired (design kept)
│   │   ├── VerifyPage.tsx                     # rewired; 4 boxes → 6
│   │   └── recovery/{Request,Verify,NewPassword}Page.tsx   # new
│   ├── hooks/{useLogin,useRequestLoginCode,useVerifyLoginCode}.ts
│   └── bootstrap-session.ts                   # + SESSION_LIMIT_EXCEEDED message
├── constants/{api-routes,session}.ts          # + routes, + cause value
├── lib/auth/{token-store.ts, proof-of-work.ts}  # storage inverted; PoW new
└── {admin,petrol_company}/…                   # 4 files' copy corrected (R11)
```

**Structure Decision**: two existing repositories, unchanged in shape. No new top-level directory in
either. The backend's `auth` module absorbs all three new services rather than growing a new module,
because they share `OtpPrimitivesService`, the `SessionAuditService`, and the `SMS_SENDER` port with
`PasswordResetService`, which already lives there.

## Slice Order

Each slice is independently shippable and independently verifiable. **The order is not negotiable
for Slices 0–3**; 4–7 may be resequenced.

| Slice | Content | Why here | Gate |
|---|---|---|---|
| **0** | Per-session identity: `sid`, `activeSessions`, the three revocation primitives, role-split login/logout/refresh, no push on admin login | Touches every authenticated request and every handshake; its correctness condition is a negative one (R12) | Backend suites at Part 0 baseline; **`flutter test` unchanged**; quickstart Part 1 |
| **1** | Taqnyat activation + the two Joi holes | Independent of everything; delivers escalation SMS and recovery codes on its own | Quickstart Part 2 — including the start-up failure matrix |
| **2** | Admin phone integrity: E.164 validation, seed fix, data normalisation, **then** the index extension | Prerequisite for Slice 3 and nothing else. Index creation fails while placeholders collide (R5) | Quickstart 3.1 returns empty |
| **3** | `LoginCode`, the two endpoints, abuse controls, proof-of-work | The feature's core | Quickstart 3.2–3.6 — especially 3.2 (neutral) and 3.6 (fail closed) |
| **4** | Dashboard sign-in screens rewired; 6-digit entry; challenge worker | Needs Slice 3's endpoints | Quickstart Part 4 steps 1–7, 11 |
| **5** | `token-store` inversion + remember-me + `SESSION_LIMIT_EXCEEDED` message | Fixes FR-060, which Slice 4 makes expensive to get wrong | Part 4 steps 4, 8, 9 |
| **6** | Password-recovery screens | Independent; existing endpoints | Part 4 step 10 |
| **7** | Copy corrections on 4 files (R11) | Documentation-shaped; last | Review |

## Risks

| Risk | Mitigation |
|---|---|
| **Slice 0 silently changes mobile session behaviour.** The failure is invisible until a driver is affected in production. | The role split is *structural* — mobile tokens carry no `sid` and the check is skipped when it is absent, so there is no branch that can accidentally apply. Slice 0 ships alone with `flutter test` and all 62 e2e suites green (quickstart 1.5/1.6). |
| **The extended phone index fails at boot**, taking the service down on deploy. | Slice 2 sequences normalisation before the index, and quickstart 3.1 is a hard gate that must return empty first. |
| **The neutral response leaks by timing.** A registered number does more work (issue a code, send an SMS) than an unknown one. | The SMS send is already fire-and-forget-shaped in `PasswordResetService` (its failure is caught and logged without changing the response). Quickstart 3.2 diffs status and body; a constant-time guarantee is **not** claimed, matching the platform's existing posture for recovery. SC-006 states this limit explicitly rather than promising indistinguishable latency the implementation does not deliver. |
| **`refresh` mints a NEW `sid` instead of reusing the presented one.** Every renewed admin token would then carry a session id absent from `activeSessions`, so every admin session dies one access-token lifetime after sign-in — and the symptom (periodic forced re-login) looks nothing like the cause. | `sid` is an explicit **input** to `issueTokenPair`, never generated inside it. Asserted by T028a and by SC-014's 20-consecutive-renewal criterion, which a naive implementation fails on the first renewal. |
| **The extended phone index builds at boot, before the placeholder normalisation can run.** Mongoose `autoIndex` is not disabled in this repository, so deploying T044's schema change builds the index immediately — and it fails while two admins share `'N/A'`, taking the service down on deploy. | T041a makes normalisation a per-environment deployment step that must run **against each target environment before** the schema change is deployed there, not merely before the local test passes. T045 remains the local gate. |
| **Proof-of-work blocks a legitimate administrator** on an old or locked-down browser. | It gates only a resubmission after the rate limit already fired, never a first request. `LOGIN_POW_DIFFICULTY_BITS=0` is a valid production value and is the documented escape hatch. |
| **`.invalid('')` is omitted** and the Taqnyat validation ships open for the third time. | Called out in R6, in the config contract, and as an explicit quickstart step (2.1) that asserts the *failure*, not the success. |
| **The dashboard's two failing-to-load test suites** mask a new regression. | Baseline recorded in quickstart Part 0; the gate is "no worse", and the two suites are named. |

## Deferred

- **httpOnly refresh cookie** (spec 003's original design). Would change both Flutter clients' refresh
  path, which this feature cannot test. Explicitly out of scope in the spec's Assumptions; R9's
  storage inversion is the best available answer without it.
- **A "your devices" screen** letting an administrator see and end their own other sessions. The data
  now exists to build it (`activeSessions` + `SessionEvent.sid`); the surface does not.
- **Removing passwords from administrator accounts.** Q2 chose coexistence, so `CreateUserDto` still
  requires one.
- **Turnstile or another third-party challenge.** Kept behind `ChallengeService`'s interface so it is
  an adapter swap if abuse is observed.
- **Taqnyat delivery-receipt webhooks.** "Sent" means a clean acceptance with no recipient rejection.

## Complexity Tracking

> No Constitution violations. This section is intentionally empty.
