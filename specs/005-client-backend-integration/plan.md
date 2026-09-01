# Implementation Plan: Client Mobile App — Backend Integration

**Branch**: `005-client-backend-integration` | **Date**: 2026-08-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-client-backend-integration/spec.md`

## Summary

Connect every client-facing mobile screen to the platform, and add the backend capability the
client journey needs but the platform does not yet expose.

Today only the home dashboard and the login screen read live data; every other client screen
renders values compiled into the app. The data layer for orders, invoices, notifications and
tracking already exists, is registered in dependency injection and is unit-tested — the screens
simply bypass it. Roughly half this feature is therefore **mounting what is already built**; the
other half is genuinely new platform capability, driven by three clarified decisions: itemised
order pricing (a pricing-model change), multi-station clients (a schema change to ground the
driver app also stands on), and SMS phone verification (the one new third-party dependency).

The approach that shapes everything below: **reuse before build**. The credit calculation, the
OTP primitives, the notification delivery path and the payment event record all already exist and
already carry the isolation and transactional guarantees the constitution demands. Extending them
is both cheaper and safer than adding parallel mechanisms, and it is what FR-046c requires.

## Technical Context

**Language/Version**: TypeScript 5.7 (`strict`) on Node 20 / NestJS 10 · Dart (SDK ^3.11.5) on
Flutter

**Primary Dependencies**: Backend — Mongoose 8.9, Passport JWT, BullMQ, ioredis, Socket.io 4.8,
class-validator, Joi. Mobile — flutter_bloc 9.1, dio 5.7, get_it 8, freezed 3.2, go_router 14.6,
easy_localization 3.0, socket_io_client 3.1, dartz.

**New dependency**: an SMS provider SDK — **deferred behind an `SmsSender` port**; a logging no-op
implementation ships as the development default so nothing blocks on procurement (research R4).

**Storage**: MongoDB (replica set — multi-document transactions are mandatory per Principle V) ·
Redis for OTP plaintext cache and BullMQ · local uploads under `sys_storge`.

**Testing**: Backend — Jest unit (`test/unit`, `src/**/*.spec.ts`) + e2e (`test/e2e`,
`--runInBand`) against `mongodb-memory-server`, supertest. Mobile — `flutter_test`, `bloc_test`,
`mocktail`, golden tests under `test/golden`.

**Target Platform**: iOS / Android client app against a Linux-hosted API.

**Project Type**: Mobile client + REST API, in two separate repository roots.

**Performance Goals**: First page of any client list usable within 2s on a normal mobile
connection (SC-004), **independent of how many records the client holds** (SC-004a) — this is an
indexing requirement, not a code-speed one. Tracking reflects driver movement within 10s (SC-006).

**Constraints**: Backend is the sole authority for every state transition. Access token in memory
only. OTPs never rendered on a driver build, never logged, never returned in a response. Arabic
default with full RTL. No magic values. Existing backend suites are a regression gate.

**Scale/Scope**: 15 client screens, 6 new cubits, 9 existing cubits to mount, 3 new collections,
4 modified collections plus 2 that gain only an index, ~21 new or changed endpoints, 1 data
migration.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

### Initial evaluation — PASS

| Principle | Assessment |
|---|---|
| **I. Strict Typing & No Magic Values** | PASS. New enums (`SupportTopic`, `SupportRequestState`, `NotificationType.SUPPORT_REQUEST_RAISED`) and named error codes rather than literals. Page size, throttle limits and rounding precision become named constants. Mobile strings go through `translation_keys.dart`. |
| **II. Tenant Isolation & Security-First** | PASS, with an explicit addition. All three new collections are single-tenant → the existing `companyId` plugin via `markTenantScoped`. **Company scoping alone is insufficient here**: two clients share a fuel company, so every client-facing query adds `clientId = req.user.sub` on top of the plugin. Called out in data-model.md because it is the single likeliest place to introduce a cross-client leak. 404-never-403 preserved. `rawPayload` never projected. |
| **III. Centralized Error Handling** | PASS. New error codes route through the existing global exception filter; mobile through `error_interceptor.dart`. No new error path. |
| **IV. Clean Architecture & UI/Logic Decoupling** | PASS — and this is the principle the feature most directly *restores*. Screens currently hold hardcoded data, which is exactly the coupling Principle IV forbids. New mobile code follows the existing `data/domain/presentation` layout; backend keeps module/service/controller/DTO separation. |
| **V. Transactional Integrity** | PASS. No new race-prone flow. Pricing is computed inside the existing order-creation transaction. The one new DB-level guarantee is the partial unique index enforcing one default station per client — per Principle V, at the data layer rather than assumed from ordering. |

**Platform constraints**: `server.ts` entry unchanged · uploads stay under `sys_storge` · no root
`index.ts` (CI enforces) · Flutter Clean Architecture preserved · no web dashboard code in this
feature.

### Post-design re-evaluation — PASS

Phase 1 introduced no violation. Three points are worth recording because they were live
decisions rather than defaults:

1. **The OTP extraction (research R4) touches security-critical shared code.** Generalising the
   service from order-bound to subject-bound is justified by Principle IV (the domain primitive
   should not know about orders) and by avoiding a second copy of the platform's most
   security-sensitive code. It is mitigated by landing as its own change with the existing suites
   green before anything builds on it (research R11).

2. **The station migration changes `GET /auth/me` for every role.** The response *shape* is
   deliberately unchanged so the driver app is unaffected; only the source of the field moves.
   This is the reason it lands first and alone.

3. **`priceBreakdown` is optional.** A required field would force back-filling fabricated rates
   onto historical orders — which would violate the very thing this feature exists to fix. Optional
   plus a total-only fallback in the app is the honest modelling.

No Complexity Tracking entries are required.

## Project Structure

### Documentation (this feature)

```text
specs/005-client-backend-integration/
├── plan.md                          # This file
├── spec.md                          # Feature specification (5 clarifications resolved)
├── research.md                      # Phase 0 — 11 decisions
├── data-model.md                    # Phase 1 — collections, invariants, migration
├── quickstart.md                    # Phase 1 — setup + per-story verification
├── contracts/
│   ├── rest-api-delta.md            # Phase 1 — API delta vs. feature 001
│   └── mobile-integration.md        # Phase 1 — screen wiring + deletions
├── checklists/
│   └── requirements.md              # Spec quality checklist (16/16)
└── tasks.md                         # Phase 2 — NOT created by /speckit-plan
```

### Source Code

**Backend** (`ciro_fuel/`, this repo):

```text
src/
├── common/
│   ├── enums/                       # + support-topic, support-request-state
│   │                                #   ~ notification-type (+SUPPORT_REQUEST_RAISED)
│   ├── pagination/                  # NEW — cursor encode/decode, page-size constant
│   └── sms/                         # NEW — SmsSender port + no-op dev implementation
├── modules/
│   ├── stations/                    # NEW — schema, service, controller, DTOs
│   ├── support/                     # NEW — schema, service, controller, DTOs
│   ├── orders/
│   │   ├── services/
│   │   │   ├── otp.service.ts       # ~ REFACTOR — extract subject-agnostic primitives
│   │   │   └── pricing.service.ts   # NEW — breakdown derivation + quote token
│   │   ├── schemas/order.schema.ts  # ~ + priceBreakdown, stationId
│   │   └── orders.controller.ts     # ~ + /quote, pagination
│   ├── companies/                   # ~ + pricingConfig endpoints
│   ├── users/
│   │   ├── schemas/                 # ~ + phone-verification.schema.ts
│   │   └── users.controller.ts      # ~ + /me/credit, /me/phone/verification
│   ├── payments/payments.controller.ts   # ~ + GET /payments
│   ├── invoices/                    # ~ pagination only
│   └── notifications/               # ~ pagination + unreadCount
├── config/                          # ~ + SMS config & Joi validation
└── server.ts                        # unchanged (constitution)

scripts/migrate-005-stations.ts      # NEW
test/
├── unit/                            # + pricing, cursor, otp-subject, station invariants
└── e2e/                             # + client-stations, pricing-breakdown, phone-verification,
                                     #   support-routing, pagination; ~ migration
```

**Mobile** (`../mobile_app/`):

```text
lib/
├── core/
│   ├── di/injector.dart             # ~ new registrations; list cubits → lazy singletons
│   └── network/                     # ~ typed failures for new error codes
├── features/
│   ├── stations/{data,domain}/      # NEW (presentation exists)
│   ├── payments/{data,domain}/      # NEW (presentation exists)
│   ├── support/{data,domain}/       # NEW (presentation exists)
│   ├── profile/{data,domain}/       # NEW (presentation exists)
│   ├── orders/                      # ~ quote datasource/usecase; paginated state;
│   │                                #   DELETE order_mock_data.dart, mock_order_state.dart
│   ├── invoices/                    # ~ paginated; + CreditCubit
│   ├── notifications/               # ~ paginated + unread count
│   └── home/                        # ~ real badge, change-station, contact-driver
└── assets/translations/{ar,en}.json # ~ new keys
```

**Structure Decision**: Two existing roots, unchanged. The backend keeps its NestJS module
layout, adding `stations` and `support` as siblings of the existing modules. The mobile app keeps
Feature-Based Clean Architecture, filling in the `data/` and `domain/` layers of four features
that currently have only `presentation/`. No new root, no restructuring — the layouts are correct
already and the constitution binds both.

## Implementation Sequencing

Ordering is a risk decision here, not a preference (research R11).

**Stage 0 — shared-ground changes, each alone, suites green between them.**
Both touch code the driver app depends on. Bundling either into a larger change is how a
driver-side regression gets found late and blamed on the wrong commit.

1. OTP extraction — subject-agnostic primitives, behaviour-preserving.
2. Station collection + migration — `GET /auth/me` shape deliberately unchanged.

**Stage 1 — backend capability**, each with its isolation test (FR-046a): cursor pagination
utility and indexes · pricing config + breakdown + quote · credit endpoint · payment history ·
notification unread count · phone verification · support requests.

**Stage 2 — mobile**, in story-priority order. Backend capability precedes the screen that
consumes it. P1 (orders, ordering) first, then P2 (tracking, money, credit), then P3
(notifications, profile, stations, support).

**Stage 3 — removal.** Delete the mock definitions and add the CI grep that keeps them gone
(FR-002). Deliberately last: deleting the sample data before the screens are wired leaves the app
unrunnable mid-feature.

## Risks

| Risk | Mitigation |
|---|---|
| Station migration regresses the driver app | Response shape held constant; lands alone; full e2e suite before anything follows |
| OTP refactor regresses delivery handover | Behaviour-preserving extraction; existing suites as the gate; lands alone |
| Currency rounding breaks FR-011b intermittently | Rounding rule fixed in research R2 (round components, then sum); asserted in a unit test |
| Pagination indexes forgotten → SC-004a fails silently in dev, loudly for the largest client | Index list enumerated in research R3; verified against a 500-order client in quickstart |
| Singleton cubits leak data across an account switch | Explicit reset on sign-out, with a test |
| SMS provider unavailable at launch | `SmsSender` port + dev no-op; Story 7 fully testable without it; flagged as a launch blocker |
| Support requests accumulate unread pre-dashboard | FR-039b keeps phone/messaging prominent; flagged as a launch blocker |

## Complexity Tracking

> No Constitution Check violations. No entries required.

## Phase Status

- [x] Phase 0 — research complete: [research.md](./research.md) (11 decisions; 1 external item
      deferred with a mitigation that unblocks all development)
- [x] Phase 1 — design complete: [data-model.md](./data-model.md),
      [contracts/rest-api-delta.md](./contracts/rest-api-delta.md),
      [contracts/mobile-integration.md](./contracts/mobile-integration.md),
      [quickstart.md](./quickstart.md)
- [x] Constitution Check — initial: PASS
- [x] Constitution Check — post-design: PASS
- [ ] Phase 2 — task breakdown (`/speckit-tasks`)
