# Implementation Plan: Driver Authentication & Session

**Branch**: `006-driver-auth-session` | **Date**: 2026-08-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-driver-auth-session/spec.md`

## Summary

Close the driver's session lifecycle end to end: show the driver their own real identity,
put a mandatory device lock in front of the session, give a locked-out driver a way back in
from the field, make sign-out a real revocation, and make revocation land on the device
within seconds instead of at the credential's natural expiry.

The technical spine is one decision — **an account-level session generation counter carried
in the JWT**. A single integer on the user, mirrored into the token and compared inside
`validateActiveSessionWithScoping`, is what delivers single-active-session (FR-042),
sign-out revocation (FR-029), reset-invalidates-sessions (FR-027) and the deactivation
backstop (FR-035b) — all four, in one check, on a document the request already loads. The
push half (FR-035) rides the `user:{userId}` Socket.io room that `TrackingGateway` already
joins every socket to, and the offline fallback (FR-035a) is free because the handshake
runs through that same validation path.

The rest is assembly over parts that already exist: password recovery is a second consumer
of `OtpPrimitivesService` + the `SmsSender` port, built to the shape
`PhoneVerificationService` already established; the driver profile screens get wired to the
`ProfileCubit` the client persona already uses; the mandatory lock wraps `local_auth`, which
is already a dependency and already wrapped by `BiometricAuthenticator`.

## Technical Context

**Language/Version**: TypeScript 5.7 (`strict`) on NestJS 10.4 / Node · Dart 3.11 on Flutter

**Primary Dependencies**: Backend — `@nestjs/jwt` 10.2, `@nestjs/mongoose` 10.1 + Mongoose
8.9, `socket.io` 4.8, `ioredis` 5.4, `@nestjs/throttler` 6.3. Mobile — `flutter_bloc` 9.1,
`go_router` 14.6, `dio` 5.7, `get_it` 8.0, `dartz` 0.10, `socket_io_client` 3.1,
`local_auth` 2.3, `flutter_secure_storage` 9.2, `freezed` 3.2.

**Storage**: MongoDB. Two new collections (`passwordresets`, `sessionevents`) and one new
field on `users` (`sessionGeneration`). Redis holds OTP plaintext and the recovery
rate-limit counter. No device-side storage is added — the mandatory lock has no preference
to persist.

**Testing**: Backend `jest` (unit + `test:e2e` with `--runInBand`). Mobile `flutter test`
— headless, scripted Dio adapters and mocked sockets; feature DI registered through
`test/support/orders_test_di.dart`.

**Target Platform**: iOS and Android handsets (driver persona) against the existing NestJS
API — REST at `/api/v1`, realtime on the `/tracking` Socket.io namespace.

**Project Type**: Mobile app + API. Two roots: `src/` (backend) and `mobile_app/lib/`.

**Performance Goals**: Revocation visible on a connected device within 5 seconds (SC-008).
The session-generation check adds no query — it reads a field on the user document
`validateActiveSessionWithScoping` already fetches on every request and every handshake.

**Constraints**: No SMS provider exists (`SmsModule` wires only `NoopSmsSender`), so US3 is
built and tested against the no-op and is launch-gated on procurement — the same posture
spec 005 took. The mandatory lock must never hard-lock a driver out of an assigned delivery
(SC-004a). Arabic-default, RTL-first. Every change to sign-in, refresh, sign-out or session
validation is shared ground with the CLIENT persona and must leave the client suites green.

**Scale/Scope**: 5 user stories, 50 functional requirements, 12 success criteria. Backend:
~1 schema field, 2 collections, 3 new endpoints, 1 new socket event, 1 changed validation
signature. Mobile: 1 lock gate, 2 recovery screens, 1 rewired profile screen.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Constitution v1.0.0.*

| Principle | Verdict | How this design satisfies it |
|---|---|---|
| **I. Strict Typing & No Magic Values** | **PASS** | Four new named constant sets, no literals: `SessionEventType` and `SessionRevocationCause` enums; three additions to the existing `ErrorCode` enum; `SocketEvents.sessionRevoked` on the Flutter side (that file is already documented as the only place event-name literals appear). The lock threshold and recovery limits become named config/constants, never inline numbers. `sessionGeneration` is a typed number on the schema and a typed `sgen` field on `JwtPayload`. |
| **II. Tenant Isolation & Security-First** | **PASS, with one explicit exemption** | `SessionEvent` is tenant-scoped via the existing `markTenantScoped` plugin — a transport admin reads only their own drivers' events. `PasswordReset` **must not** be tenant-scoped: recovery is pre-authentication, so there is no acting user and no `companyId` in context, exactly like the existing `findByPhoneForAuth` lookup. It is queried through `TenantContextService.runUnscoped`, the mechanism `PhoneVerificationService` already uses for the same reason. Recorded under Complexity Tracking. Enumeration safety (FR-021) is enforced by returning an identical 202 for known and unknown numbers. |
| **III. Centralized Error Handling** | **PASS** | New failures surface as `ErrorCode` members through the existing `HttpExceptionFilter` envelope; the app distinguishes them by code, never by message text. The revocation push is handled in one place on the client (the session lifecycle listener in `injector.dart`), not per-screen. |
| **IV. Clean Architecture & UI/Logic Decoupling** | **PASS** | Password recovery gets a full Data → Domain → Presentation stack (datasource, repository returning `Either<Failure, T>`, three use cases, cubit). `AppLockCubit` injects `BiometricAuthenticator` from `core/security` directly — consistent with the three documented precedents in `mobile_app/CLAUDE.md` §6 for device-local services with no domain abstraction, and not a precedent for anything that touches the API. |
| **V. Transactional Integrity for State Changes** | **PASS** | Every generation bump is a multi-write state change and runs in a `ClientSession`: password reset (update hash + bump generation + consume record + write audit), sign-out (bump + audit), deactivation (deactivate + bump + audit), and login's displacement of a prior session (bump + audit). A bump that landed without its audit row, or a consumed code without its password change, is exactly the partial write Principle V exists to prevent. |

**Gate result: PASS.** One documented exemption, carried in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/006-driver-auth-session/
├── plan.md                        # This file
├── spec.md                        # Feature specification (5 clarifications resolved)
├── research.md                    # Phase 0 — 8 decisions
├── data-model.md                  # Phase 1 — schema field, 2 collections, 3 enums
├── quickstart.md                  # Phase 1 — per-story manual verification
├── checklists/requirements.md     # Spec quality checklist (16/16)
├── contracts/
│   ├── rest-api-delta.md          # 3 new endpoints + GET /users/:id delta
│   ├── realtime-events-delta.md   # session:revoked + handshake refusal
│   └── mobile-integration.md      # lock gate, recovery screens, DI wiring
└── tasks.md                       # Phase 2 output — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
src/                                          # NestJS backend
├── common/
│   ├── enums/
│   │   ├── error-code.enum.ts                # + RESET_CODE_INVALID, RESET_RATE_LIMITED,
│   │   │                                     #   SESSION_REVOKED
│   │   ├── session-event-type.enum.ts        # NEW
│   │   └── session-revocation-cause.enum.ts  # NEW
│   ├── guards/ws-jwt.guard.ts                # authenticateSocket() passes full payload
│   ├── interfaces/jwt-payload.interface.ts   # + sgen
│   ├── otp/otp-primitives.service.ts         # unchanged — reused as-is
│   └── sms/                                  # unchanged — still NoopSmsSender only
├── modules/
│   ├── auth/
│   │   ├── auth.controller.ts                # + 3 recovery endpoints, + POST /auth/logout,
│   │   │                                     #   GET /users/:id gains companyName (truck
│   │   │                                     #   already present) — NOT /auth/me, corrected
│   │   │                                     #   during implementation (research R6)
│   │   ├── auth.service.ts                   # issueTokenPair carries sgen; login displaces;
│   │   │                                     #   logout revokes
│   │   ├── dto/{request-password-reset,verify-reset-code,complete-password-reset}.dto.ts
│   │   ├── schemas/password-reset.schema.ts  # NEW — NOT tenant-scoped
│   │   ├── services/password-reset.service.ts# NEW — models PhoneVerificationService
│   │   └── strategies/jwt.strategy.ts        # passes payload, not just sub
│   ├── sessions/                             # NEW
│   │   ├── schemas/session-event.schema.ts   # tenant-scoped
│   │   └── session-audit.service.ts          # single writer for FR-043
│   ├── tracking/tracking.gateway.ts          # unchanged — user room already exists
│   └── users/
│       ├── users.service.ts                  # validateActiveSessionWithScoping(+sgen)
│       └── users.controller.ts               # deactivate → revoke + audit
└── test/                                     # e2e: recovery, revocation, displacement

mobile_app/lib/                               # Flutter
├── app.dart                                  # AppLockGate wraps the router subtree
├── core/
│   ├── di/injector.dart                      # session:revoked handler; clear ProfileCubit
│   ├── realtime/socket_events.dart           # + sessionRevoked
│   └── security/biometric_authenticator.dart # + allowDeviceCredential flag
└── features/
    ├── auth/
    │   ├── data/datasources/password_reset_remote_data_source.dart   # NEW
    │   ├── data/repositories/password_reset_repository_impl.dart     # NEW
    │   ├── domain/repositories/password_reset_repository.dart        # NEW
    │   ├── domain/usecases/{request_password_reset,verify_reset_code,
    │   │                    complete_password_reset}.dart            # NEW
    │   ├── domain/usecases/sign_out.dart                             # calls /auth/logout
    │   └── presentation/
    │       ├── cubit/{app_lock_cubit,password_reset_cubit}.dart      # NEW
    │       └── view/{lock_screen,forgot_password_screen,
    │                 reset_password_screen}.dart                     # 1 NEW, 1 replaced
    └── profile/presentation/view/driver_profile_details_screen.dart  # wired to ProfileCubit
```

**Structure Decision**: Two existing roots, no new ones. Backend work follows the established
module/service/controller/DTO separation; the one new module (`sessions/`) exists because
session auditing has a single writer that both `auth/` and `users/` call, and putting it in
either would make the other depend on it sideways.

Mobile work obeys `mobile_app/CLAUDE.md` §1: `data/` and `domain/` are never split by
persona, so the password-recovery stack is added flat under `features/auth/` even though the
spec scopes acceptance to drivers — the endpoint is role-agnostic and a second copy for the
client would be the exact duplicate-datasource bug that file warns about. No files move: the
structural migration in `mobile_app/CLAUDE.md` §5 is explicitly Out of Scope for this spec,
so new files land where the *current* structure dictates.

## Phase Breakdown

Ordered so each phase leaves both suites green and is independently shippable. Phases 1 and
2 touch shared client ground and, per `CLAUDE.md`'s standing rule, land alone.

| Design Phase | Scope | Stories | Ships alone? | `tasks.md` phase | Tasks |
|---|---|---|---|---|---|
| **0** | `sessionGeneration` field + `sgen` in `JwtPayload` + the check inside `validateActiveSessionWithScoping`, with every existing session treated as generation 0 | foundation | **yes — alone** | Phase 2 (part) | T007–T014 |
| **1** | Session audit collection + `SessionAuditService`; wire login/refresh | FR-043–046 | yes | Phase 2 (part) | T015–T020 |
| **2** | `POST /auth/logout`, sign-out revocation, login displacement, deactivation revocation | US4, US5 | **yes — alone** | Phase 6 + part of Phase 7 | T067–T070, T073–T076 |
| **3** | `session:revoked` push + client handling + handshake refusal | US5 | yes | Phase 7 (part) | T074, T077–T084 |
| **4** | `GET /users/:id` gains `companyName` (`truck` already present); wire `DriverProfileDetailsScreen`, badge, cubit clearing, plus the driver phone-number change screens (added during `/speckit-analyze` remediation, finding C1) | US1 | yes | Phase 3 | T021–T035 |
| **5** | Mandatory app lock: `AppLockCubit`, `AppLockGate`, `LockScreen`, passcode fallback | US2 | yes | Phase 4 | T036–T046 |
| **6** | Password recovery: collection, service, 3 endpoints, 2 screens | US3 | yes | Phase 5 | T047–T066 |

Task ranges above reflect `tasks.md` as it stands after `/speckit-analyze` remediation, which
added 3 tasks to Phase 3/US1 (T030–T032, wiring the driver phone-number-change screens that
turned out to be static mock-ups — finding C1) and shifted every task from that point onward.

This table's numbering is a design-time narrative — the order in which the *decisions* build on
each other. `tasks.md` numbers phases mechanically (1 Setup, 2 Foundational, 3–7 one per user
story, 8 Polish) because that is the order **work** is staged and checkpointed, including Setup
and Polish wrappers this table has no room for. The two numberings intentionally diverge; the
right-hand columns above are the authoritative cross-reference — follow `tasks.md` when doing
the work, this table when understanding why it is ordered that way.

Design phases 0 and 2 are the ones that land alone: 0 changes a signature called on **every**
authenticated request and every socket handshake, for both personas, and carries no
user-visible behaviour by itself — precisely why it should land by itself. 2 changes shared
sign-out behaviour the same way.

## Constitution Re-Check (post-design)

*Re-evaluated after Phase 1. Verdict unchanged: **PASS**, with the one exemption already
recorded below.*

The design review surfaced one genuine defect in the Phase 1 data model, found and fixed
before this plan was finalized:

> **`SessionEvent.companyId` cannot be required.** The first draft marked it required, on the
> reasoning that tenant scoping needs it. But `SessionEvent{ type: SIGNED_IN }` is written on
> **every** login, and `SUPER_ADMIN` has no `companyId` on `User` at all — that role is exempt
> from tenant isolation platform-wide. A required field would have thrown a validation error on
> every platform-operator sign-in, turning an audit-trail addition into a login outage for the
> one role that could least afford it. The field is now optional; every driver has one, which
> is what FR-043 and FR-044 actually concern.

Two properties were re-confirmed against the finished design rather than assumed:

- **Principle V holds at every generation bump.** Four operations increment
  `sessionGeneration`, and each pairs it with at least one other write (an audit row, a
  password hash, a consumed reset record, a deactivation). All four are specified inside a
  `ClientSession` in `contracts/rest-api-delta.md`. No bump can land without its audit row.
- **Principle II's exemption stayed at one collection.** `SessionEvent` is tenant-scoped
  normally. Only `PasswordReset` is exempt, and only because its caller is anonymous by
  definition. The design did not grow a second exemption.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| `PasswordReset` collection is exempt from the tenant-scope plugin (Principle II) | Password recovery runs before authentication. There is no acting user, so `AsyncLocalStorage` holds no `companyId` for the plugin to inject — a scoped query would silently match nothing and every recovery would fail as "code not found". | Marking it tenant-scoped and passing a company explicitly is impossible: the caller is anonymous and the whole point of the lookup is to *find* which account (and therefore which company) the phone belongs to. The exemption is narrow — one collection, reached only through `runUnscoped`, exactly as `PhoneVerificationService` already reaches `findByPhoneForAuth` for the same structural reason. |
