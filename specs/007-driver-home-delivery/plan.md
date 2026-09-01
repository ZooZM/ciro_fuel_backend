# Implementation Plan: Driver Home & Active Delivery

**Branch**: `007-driver-home-delivery` | **Date**: 2026-08-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-driver-home-delivery/spec.md`

## Summary

Spec 006 gave the driver a real session. This gives them real *work*: the delivery they were
assigned, the ability to complete it, an honest list and detail, and a header that states only
what is true.

The framing that matters for sequencing: **US1–US4 are mostly repair, US5–US6 are mostly new
capability.** The delivery machinery already exists, is registered, and is unit-tested — it is
simply never invoked, and three independent defects sit between it and working. The rating and
daily-count figures, by contrast, have no platform representation at all.

Four defects were found by reading the code, and **any one of them left unfixed keeps a delivery
uncompletable**:

1. `DeliveryCubit.load()` is never called from anywhere. The app permanently believes the driver
   has no work.
2. `getActiveOrder()` parses `response.data!['data']` against a `{ items, nextCursor }`
   response — it would throw even if called.
3. Nothing ever calls `/arrive` or `/request-delivery-otp`, the two steps that **issue the
   customer their code**. The handover is broken in the middle: the customer never receives
   anything to show.
4. **A driver cannot receive `order:status` at all.** `TrackingGateway.watch` refuses drivers
   with `FORBIDDEN_ROLE`, and the event is emitted only to the order room — so
   `DeliveryCubit._handleStatus` has never fired and would have stayed dead.

The technical spine is small: emit `order:status` to the driver's **user room** (the channel
spec 006 already uses for `session:revoked`), attach socket handlers **after** connect rather
than in a constructor, and fix one JSON key. The new capability — a rating domain, a daily
count, and a customer-contact mirror of the existing `driverSummary` — is additive and follows
patterns the platform already has.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`) on Node.js — backend; Dart 3.x / Flutter — mobile

**Primary Dependencies**: NestJS · Mongoose · Socket.io · BullMQ · ioredis (backend) ·
flutter_bloc · get_it · dartz · freezed · go_router · socket_io_client · easy_localization (mobile)

**Storage**: MongoDB (replica set — transactions are mandatory per Principle V) · Redis

**Testing**: Jest unit + e2e against `mongodb-memory-server` replica set and real Redis (backend) ·
`flutter_test` with `bloc_test` + `mocktail`, scripted Dio adapters and mocked sockets (mobile)

**Target Platform**: iOS / Android (driver and client personas) against a Linux-hosted API

**Project Type**: Mobile + API — two sibling repositories, `ciro_fuel/` and `mobile_app/`

**Performance Goals**: active delivery visible within 3s of app open (SC-001) · terminal delivery
disappears within 5s of the platform change, pushed not polled (SC-007)

**Constraints**: The platform is the sole authority on every delivery stage — no local or
optimistic advancement (FR-015) · the driver's app never receives, stores or displays a handover
code (FR-014) · absence of a rating is a distinct state from a score of zero, all the way from
schema to screen (FR-031)

**Scale/Scope**: ~11 driver screens · 6 user stories · 45 functional requirements · 2 new
endpoints · 1 new collection · 3 changed documents · 1 realtime routing change

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Justification |
|---|---|---|
| **I. Strict Typing & No Magic Values** | **PASS** | The delivery-list tabs stop being `InvoicesKeys` literals and become named `driver_orders.*` keys. Stage mapping goes through the existing `OrderStatus` enum — the local `_OrderMockState` is deleted, not mirrored. `NotificationType` is corrected to the backend's real wire values, ending a silent `unknown` fallback (debt #5). No new literal is introduced anywhere. |
| **II. Tenant Isolation & Security-First** | **PASS** | `GET /orders` is already role-scoped (`query.driverId = user.userId`) with no client input. `GET /drivers/me/summary` is `me`-scoped, so FR-034 holds structurally — there is no identifier to authorise. `DeliveryRating` is multi-party (client of a fuel company rating a driver of a transport company) and carries `markMultiParty`, matching `Order`. Rating another client's order returns `404`, indistinguishable from non-existent. `clientSummary` reaches a driver only through `findOneForUser`'s existing ownership check. |
| **III. Centralized Error Handling** | **PASS** | New failures (`ORDER_NOT_DELIVERED`, `ALREADY_RATED`) are `ErrorCode` members surfaced through the existing `HttpExceptionFilter` envelope and branched on by code, never message text. The app's throttle-exhaustion guidance (FR-017) reads the existing 429, not a string. |
| **IV. Clean Architecture & UI/Logic Decoupling** | **PASS** | The driver's list reuses `orders/`'s existing datasource → repository → use case chain rather than growing a second one (research R4, retiring part of debt #2). New reads get a full stack. The socket wiring is extracted as a testable `DeliveryListener` class rather than an inline closure in `injector.dart` — the precedent spec 006 set with `SessionRevocationListener`. |
| **V. Transactional Integrity for State Changes** | **PASS** | Rating insert + driver aggregate bump run in one `ClientSession`; a rating without its aggregate, or an aggregate without its rating, is exactly the partial write this forbids. "Rate once" is enforced by a **unique index on `orderId`**, not a check-then-insert that races. `clientSummary` is written inside `assignDriver`'s existing transaction alongside `driverSummary`. |

**Gate result: PASS.** No violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/007-driver-home-delivery/
├── plan.md                        # This file
├── spec.md                        # 6 stories · 45 FRs · 12 SCs · 5 clarifications
├── research.md                    # 11 decisions (R1–R11)
├── data-model.md                  # 1 new collection · 3 changed documents
├── quickstart.md                  # Manual walkthrough, incl. the Phase 0 invisible-break checks
├── checklists/requirements.md
└── contracts/
    ├── rest-api-delta.md          # 2 new endpoints · 2 changed shapes
    ├── realtime-events-delta.md   # order:status routing change
    └── mobile-integration.md      # binding client-side constraints
```

### Source Code

```text
ciro_fuel/                                     # NestJS — entry src/server.ts
├── src/
│   ├── common/
│   │   └── enums/error-code.enum.ts           # + ORDER_NOT_DELIVERED, ALREADY_RATED
│   └── modules/
│       ├── drivers/                           # NEW — GET /drivers/me/summary
│       │   ├── drivers.controller.ts
│       │   ├── drivers.service.ts
│       │   └── drivers.module.ts
│       ├── ratings/                            # NEW
│       │   ├── schemas/delivery-rating.schema.ts   # multi-party, unique on orderId
│       │   ├── ratings.service.ts                  # insert + aggregate, one transaction
│       │   └── ratings.module.ts
│       ├── orders/
│       │   ├── orders.controller.ts           # + POST /orders/:id/rating
│       │   ├── schemas/order.schema.ts        # + clientSummary, deliveredAt
│       │   └── services/order-state.service.ts# + emit to user:{driverId}; set deliveredAt
│       ├── dispatch/services/dispatch.service.ts   # + snapshot clientSummary at assignment
│       └── users/schemas/user.schema.ts       # + ratingAverage (NO default), ratingCount
└── test/                                      # e2e: rating, driver summary, driver realtime

mobile_app/lib/                                # Flutter
├── core/
│   ├── di/injector.dart                       # DeliveryListener attached AFTER connect
│   └── realtime/delivery_listener.dart        # NEW — testable, mirrors SessionRevocationListener
├── shared/enums/notification_type.dart        # corrected to real wire values (debt #5, SHARED)
└── features/
    ├── delivery/
    │   ├── data/datasources/delivery_remote_data_source.dart  # envelope fix; arrive/request-otp
    │   ├── presentation/cubit/delivery_cubit.dart             # no socket wiring in constructor
    │   └── presentation/view/
    │       ├── driver_home_screen.dart        # wired to DeliveryCubit + summary
    │       ├── driver_orders_screen.dart      # real list, 4 delivery tabs
    │       └── delivery_detail_screen.dart    # _OrderMockState DELETED; real status
    └── orders/                                # client: rating control on delivered order detail
```

**Structure Decision**: Two sibling repositories, unchanged from specs 004–006. The driver's
delivery **list** deliberately reuses the existing `features/orders/` data and domain layers
rather than growing a parallel stack in `features/delivery/` (research R4) — `GET /orders` is one
endpoint, and a second paginated datasource for it would deepen `mobile_app/CLAUDE.md` debt #2 at
exactly the moment this feature touches both.

## Implementation Phasing

| # | Slice | Delivers | Lands alone? | Stories |
|---|---|---|---|---|
| **0** | `order:status` → `user:{driverId}`; socket handlers attach after connect; `DeliveryListener` | The driver can receive realtime at all | **yes — alone** | prerequisite |
| **1** | Envelope fix; `DeliveryCubit.load()` actually called; home wired | 🎯 **MVP** — a driver sees real work | yes | US1 |
| **2** | `/arrive` + `/request-delivery-otp` wired; handover reachable; inert controls resolved | A delivery can be completed | yes | US2 |
| **3** | Driver list on `orders/` stack; four delivery tabs | Honest list | yes | US3 |
| **4** | `_OrderMockState` deleted; detail driven by real status; call action | Detail matches reality | yes | US4 |
| **5** | `clientSummary` snapshot at assignment | The call action has a number | with slice 4 | US4 |
| **6** | `deliveredAt`; `GET /drivers/me/summary`; header wired | Honest header | yes | US5 |
| **7** | `DeliveryRating` collection; `POST /orders/:id/rating`; client rating control | Ratings exist | yes | US6, US5 |
| **8** | `NotificationType` corrected | Live assignment without restart | **yes — alone** | US1 |

**Slice 0 must land first and alone.** Everything realtime in this feature is unverifiable
without it, and it is the one change that is invisible when wrong — the app looks wired and
silently never updates.

**Slice 8 touches the CLIENT persona.** The enum is shared; today every client notification
degrades to `unknown`, and correcting it changes client-facing rendering. It lands alone with
both suites green, per `CLAUDE.md`'s standing rule for shared-surface changes.

**The cheapest large win is slices 0–1.** A driver seeing their real assignment turns the driver
build from a demo into a working tool, and is a legitimate stopping point.

## Complexity Tracking

> No Constitution Check violations. This section is intentionally empty.

## Notes carried into planning

- **Effort inverts priority.** US5/US6 are correctly P3 — neither blocks a driver from working —
  yet they carry nearly all the *new* platform capability (a rating domain, a summary endpoint,
  two schema changes). US1–US4 are largely repair. Sequence by slice, not by story priority.
- **Two stale documents must be corrected as part of this work**: `mobile_app/CLAUDE.md` debt #1
  describes `GET /orders` as returning a bare array (untrue since spec 005's pagination), and
  debt #5's `NotificationType` mismatch is fixed by slice 8 rather than merely re-recorded.
- **Recorded, not done**: `TrackingSocket` handler-queueing (would retire debt #6 wholesale for
  both personas), folding `delivery/` into `orders/` (CLAUDE.md §3's end state), rating takedown
  or moderation (a knowingly accepted risk in the spec), and admin visibility of driver ratings
  (no surface exists until spec 003's dashboard).
