# Implementation Plan: Driver Availability & Assignment Escalation

**Branch**: `009-transport-dashboard-order-lifecycle` (spec directory numbered independently — see `.specify/feature.json`) | **Date**: 2026-08-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/010-driver-availability-escalation/spec.md`

## Summary

The transport dashboard's assignment candidate list currently shows only online-and-available
drivers, via `DispatchService.findCandidates`'s `$geoNear` query, which hard-filters on
`isOnline: true, isAvailable: true, activeOrderId: { $exists: false }`. An administrator whose
whole fleet happens to be briefly offline sees a false "no drivers available" empty state even
though the company has drivers on file. Separately, `assignDriver` already sends an `ORDER_ASSIGNED`
notification (a Mongo `Notification` document + a Socket.io emit — there is no real push
provider), but nothing tracks whether the driver ever saw it, and nothing happens if they didn't.

This feature: (1) changes the candidate query to return every one of the transporter's active
drivers, annotated with an eligibility classification (`ELIGIBLE` / `BUSY` / `OFFLINE`) computed
in the service layer rather than filtered at the database, with offline/never-connected drivers no
longer silently dropped by `$geoNear`'s location requirement; (2) adds an explicit driver-side
acknowledgment signal for an assignment, distinct from the existing generic
`Notification.readAt`; (3) reuses the platform's existing BullMQ job queue (the exact same shape as
`PaymentTimeoutQueueService`/`PaymentTimeoutProcessor`) to schedule a durable, cancellable
escalation job per assignment, whose processor sends a minimal SMS via the existing `SmsSender`
port if the job fires before acknowledgment; (4) surfaces acknowledgment/escalation state on the
order for the administrator.

## Technical Context

**Language/Version**: TypeScript (NestJS 10, backend); TypeScript/React 18 (web_dashboard);
Dart/Flutter (mobile_app) — all three already in place, no new language/runtime introduced.

**Primary Dependencies**: `@nestjs/bullmq` + `bullmq` + `ioredis` (already installed and wired in
`app.module.ts` — reused, not added) for the durable escalation job; the existing `SmsSender` port
(`src/common/sms/`) for the SMS send; the existing `@nestjs/throttler`/config idiom for tunables.
No new package is required for this feature.

**Storage**: MongoDB (existing `Order`/`User` collections — new fields only, no new collection)
for assignment/acknowledgment/escalation state; Redis (existing, already required for BullMQ) for
the durable job itself.

**Testing**: Jest unit + `test/e2e` (backend, existing harness); Vitest + Playwright (dashboard,
existing harness); `flutter test` (mobile, existing harness) — all three already established by
prior features, reused as-is.

**Target Platform**: Existing three surfaces (Node/NestJS backend, React web dashboard, Flutter
mobile driver app) — no new platform.

**Project Type**: Web + mobile application (existing multi-surface platform) — Option 2/3 hybrid
per the structure this repo already uses.

**Performance Goals**: SC-003's one-minute escalation-firing bound (subject to the rate cap,
FR-013a); candidate-list response time unaffected in practice — dropping the `isOnline`/
`isAvailable` filter from `$geoNear`'s query trades a smaller matched set for one the same order of
magnitude as a company's total driver count (tens, not thousands — see Scale/Scope).

**Constraints**: The escalation SMS body MUST NOT include customer name, address, or delivery
detail (FR-011a — SMS is unencrypted/carrier-visible); acknowledgment MUST come from an explicit
driver action, never inferred from presence/connectivity (FR-017); a pending escalation MUST
survive a platform restart (FR-012a) and MUST be cancelled outright — not fired late — if the
underlying assignment changes first (FR-014a).

**Scale/Scope**: A transportation company's driver roster is assumed to be tens, not thousands, of
accounts (matching every existing fleet-facing screen in `specs/009-*`, which already renders an
unpaginated list) — the candidate list showing the *entire* roster (per SC-001) does not need
pagination for this scale. Escalation job volume scales with assignment volume, which is already
bounded by real-world dispatch throughput, not a mass-notification broadcast.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Strict Typing & No Magic Values** — Eligibility (`ELIGIBLE`/`BUSY`/`OFFLINE`) is a named
  enum, not a string literal scattered across the codebase; the escalation window and SMS
  send-rate cap are named config keys (`config/configuration.ts` + `validation.ts`), never
  hardcoded numbers. **PASS**.
- **II. Tenant Isolation & Security-First** — All new fields live on the existing tenant/multi-party
  -scoped `Order` and single-tenant-scoped `User` documents; no new collection is introduced that
  would need its own scoping plugin. The escalation queue processor re-reads the order via the
  same scoped services, never bypassing the tenant-isolation plugins. **PASS**.
- **III. Centralized Error Handling** — New failure paths (no phone on file, SMS provider failure)
  are recorded as data (a field on `Order`), not thrown as ad-hoc errors that would leak into the
  uniform error envelope inappropriately; genuine caller-facing refusals (e.g., missing reason for
  an ineligible-driver assignment) use the existing `ConflictException`/`ErrorCode` idiom. **PASS**.
- **IV. Clean Architecture & UI/Logic Decoupling** — The escalation queue/processor is its own
  module boundary (mirroring `payments/queues/`), injected where needed via `exports`, not reached
  into directly; the dashboard's eligibility rendering is presentation over a typed API response,
  no business logic duplicated client-side. **PASS**.
- **V. Transactional Integrity for State Changes** — Escalation scheduling happens *after* the
  `assignDriver` transaction commits (identical to the payment-timeout precedent's own stated
  reasoning: "a job referencing a rolled-back transaction would be worse than one scheduled a
  moment late"); cancellation on reassignment/cancellation happens inside the same transaction that
  changes the order's assignment, so the two can never disagree. Concurrency safety for "is this
  driver still assigned" is re-checked inside the processor before sending, mirroring
  `PaymentTimeoutProcessor`'s own re-check pattern. **PASS**.

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/010-driver-availability-escalation/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── rest-api-delta.md
│   ├── dashboard-integration.md
│   └── mobile-integration.md
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
ciro_fuel/                                    # backend (NestJS)
├── src/
│   ├── modules/
│   │   ├── dispatch/services/dispatch.service.ts     # findCandidates/getCandidates rewrite
│   │   ├── dispatch/dto/assign-driver.dto.ts          # + optional `reason` field
│   │   ├── orders/schemas/order.schema.ts             # + ack/escalation/reason fields
│   │   ├── orders/orders.controller.ts                # + POST :id/acknowledge-assignment
│   │   ├── notifications/                             # unchanged (existing ORDER_ASSIGNED path)
│   │   └── assignment-escalation/                     # NEW module, mirrors payments/queues/
│   │       ├── assignment-escalation.module.ts
│   │       ├── queues/
│   │       │   ├── assignment-escalation-queue.service.ts
│   │       │   └── assignment-escalation.processor.ts
│   │       └── dto/ (if any)
│   └── config/
│       ├── configuration.ts                           # + escalation window/rate-cap keys
│       └── validation.ts                              # + Joi entries
└── test/e2e/                                           # new e2e specs for the above

web_dashboard/                                # frontend (React)
└── src/transport_company/
    ├── orders/
    │   ├── api/dispatch.api.ts                         # candidate response shape change
    │   ├── components/assign-driver/                   # eligibility rendering + reason dialog
    │   └── components/order-details/                  # ack/escalation state display (US3)
    └── constants/ (eligibility enum, i18n keys)

mobile_app/                                   # Flutter driver app
└── lib/features/delivery/                              # wire one new API call into the existing
                                                          # active-delivery load path (feature 007)
```

**Structure Decision**: Extends the existing three-surface layout (`ciro_fuel/` backend,
`web_dashboard/` React dashboard, `mobile_app/` Flutter driver app) established by every prior
feature in this repo — no new top-level project, no new deployment unit. The one new backend
module (`assignment-escalation/`) follows the existing `payments/queues/` shape exactly rather than
inventing a different pattern for "a durable, cancellable delayed job."

## Complexity Tracking

*No entries — Constitution Check passed without violations.*
