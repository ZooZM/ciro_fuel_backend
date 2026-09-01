# Implementation Plan: In-Transit Stop Detection & Driver Check-In

**Branch**: `009-transport-dashboard-order-lifecycle` (spec directory numbered independently — see `.specify/feature.json`) | **Date**: 2026-08-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/011-transit-stop-detection/spec.md`

## Summary

A truck that stalls between the warehouse and the customer is invisible today: the tracking map
shows a position that simply stops changing, and nothing distinguishes that from a driver who is
fine, or from a phone that lost signal. Feature 009 built a mock for exactly this
(`UrgentNotificationCard.tsx` — "driver stopped moving for more than 10 minutes") and deleted it
because the platform had no movement-timeout detection behind it.

This feature adds that detection and the conversation around it: a periodic sweep notices a
delivery whose driver has not meaningfully moved for a configurable window, asks the driver why
through a **device-level** alert (new capability — the app currently has no way to surface anything
while backgrounded), records their answer against the delivery, and escalates to the transportation
company only when the driver says nothing. Drivers who know a stop is coming can declare it in
advance and skip the prompt for a duration they state themselves.

## Technical Context

**Language/Version**: TypeScript (NestJS 10, backend); TypeScript/React 18 (web_dashboard);
Dart/Flutter (mobile_app) — all three already in place.

**Primary Dependencies**: `@nestjs/schedule` (already wired — `ScheduleModule.forRoot()` in
`app.module.ts`, used by `PresenceService`'s sweep) for detection; `@nestjs/bullmq`+`bullmq`
(already required) for the response-window escalation; **one genuinely new mobile dependency,
`flutter_local_notifications`**, which is the only way to satisfy FR-004a — the app today has no
package capable of raising a device-level alert.

**Storage**: MongoDB — new embedded array on `Order` (mirroring `Order.verifications`) plus two new
movement-tracking fields on `User`; Redis (existing) for the escalation job only.

**Testing**: Jest unit + `test/e2e` (backend); Vitest (dashboard); `flutter test` (mobile) — all
existing harnesses.

**Target Platform**: Existing three surfaces. FR-018/SC-006/SC-010 make Android and iOS explicit
first-class targets for this feature rather than incidental.

**Performance Goals**: SC-004's one-minute escalation bound; detection latency bounded by the sweep
interval (a driver stopped for the window is noticed within one sweep of it elapsing).

**Constraints**: Detection MUST NOT thrash Redis on a moving truck (see research R1 — this is what
rules out the obvious per-order-job design); a stop MUST be distinguishable from a silent device
(FR-017); the feature MUST NOT accumulate per-driver stop histories or infer anything about a
driver beyond the single delivery in front of it (spec Assumptions — safety framing, not
surveillance).

**Scale/Scope**: Concurrent in-transit deliveries per sweep is bounded by real dispatch throughput
(tens, not thousands); the sweep is a single indexed query regardless.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Strict Typing & No Magic Values** — stop reasons, stop-event states and notification types are
  named enums; the stop window, movement threshold, response window and sweep interval are named
  config keys following the `presence.offlineThresholdMinutes` precedent. **PASS**.
- **II. Tenant Isolation & Security-First** — stop events live on the already multi-party-scoped
  `Order`; no new collection needing its own scoping plugin. **The sweep is the one deliberate
  exception**, and it is the *same* exception `PresenceService.sweepOfflineDrivers` already
  documents: a background cron has no acting user, so it queries across companies explicitly rather
  than relying on ambient scoping — every read it performs is a platform-level status query, and
  every *write* it triggers is scoped to the specific order it found. Recorded here rather than
  discovered later. **PASS (with the documented cron exception, precedent-matched)**.
- **III. Centralized Error Handling** — a driver submitting a reason for a stop that has already
  been resolved is a normal outcome (FR-010), recorded as data, not thrown; genuine refusals
  (submitting for someone else's delivery) reuse the platform's existing 404-indistinguishable-from-
  absent discipline. **PASS**.
- **IV. Clean Architecture & UI/Logic Decoupling** — detection is its own service, the escalation its
  own queue module; the mobile local-notification capability goes behind a seam (`NotificationPresenter`)
  in the same shape as the existing `NfcReader`/`PositionReader`/`MapNavigator` seams, so the cubit
  layer never touches the plugin directly. **PASS**.
- **V. Transactional Integrity for State Changes** — raising a stop, recording a reason and resolving
  one each mutate a single `Order` document; the concurrency risk (a sweep raising a stop at the same
  instant the driver declares one) is handled by a conditional update, not a read-then-write.
  **PASS**.

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/011-transit-stop-detection/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── rest-api-delta.md
│   ├── realtime-contract.md
│   ├── dashboard-integration.md
│   └── mobile-integration.md
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
ciro_fuel/                                          # backend (NestJS)
├── src/
│   ├── common/enums/                               # stop-reason, stop-status, notification types
│   ├── config/                                     # + 4 config keys
│   ├── modules/
│   │   ├── orders/schemas/order.schema.ts          # + stopEvents embedded array
│   │   ├── orders/orders.controller.ts             # + driver declare/answer, admin resolve
│   │   ├── users/schemas/user.schema.ts            # + lastMovedAt / lastMovedLocation
│   │   ├── tracking/tracking.gateway.ts            # movement bookkeeping on accepted fixes
│   │   └── stop-detection/                         # NEW module
│   │       ├── stop-detection.module.ts
│   │       ├── stop-detection.service.ts           # the sweep (@Cron)
│   │       └── queues/                             # response-window escalation (BullMQ)
│   └── ...
└── test/                                           # unit + e2e

web_dashboard/                                      # frontend (React)
└── src/transport_company/orders/components/order-details/
    ├── StopAlertCard.tsx                           # the rebuilt UrgentNotificationCard
    └── MapCard.tsx                                 # + stale-position treatment (FR-017a)

mobile_app/                                         # Flutter driver app
├── lib/core/notifications/                         # NEW seam: NotificationPresenter
└── lib/features/delivery/                          # declare-stop + answer-prompt flows
```

**Structure Decision**: Extends the existing three-surface layout — no new project. The one new
backend module (`stop-detection/`) is separated from `tracking/` deliberately: `tracking` owns
*where the driver is*, this owns *what it means that they haven't moved*, and mixing them would put
alerting policy inside the socket hot path.

## Complexity Tracking

*No entries — Constitution Check passed. The cron's tenant-scoping exception is precedent-matched
(`PresenceService`) and documented inline above rather than treated as new complexity.*
