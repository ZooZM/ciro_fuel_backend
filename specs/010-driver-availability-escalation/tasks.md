---

description: "Task list for Driver Availability & Assignment Escalation"
---

# Tasks: Driver Availability & Assignment Escalation

**Input**: Design documents from `specs/010-driver-availability-escalation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: **Required, not optional.** The constitution's Development Workflow gate states that
guarantees the spec marks as testable (tenant isolation, no double-booking, presence, …) MUST have
automated tests before the capability is considered done. This feature's escalation-exactly-once
(FR-013), cancellation correctness (FR-014a), durability (FR-012a) and roster-scoping (FR-001) are
all such guarantees.

**Organization**: Tasks are grouped by user story so each can be implemented and tested
independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Path Conventions

Three existing surfaces, no new project (plan.md → Structure Decision):

- **Backend**: `ciro_fuel/src/`, tests in `ciro_fuel/test/`
- **Dashboard**: `web_dashboard/src/`, tests in `web_dashboard/tests/`
- **Mobile**: `mobile_app/lib/`, tests in `mobile_app/test/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Named constants and configuration the rest of the feature references — no behavior
change on its own. All four are separate files and fully parallel.

- [X] T001 [P] Add `assignment.ackWindowMinutes`, `assignment.escalationRateLimitMax` and `assignment.escalationRateLimitDurationMs` to the `AppConfig` interface and factory in `ciro_fuel/src/config/configuration.ts`, following the `payment.deadlineMinutes` precedent (research R6)
- [X] T002 [P] Add `ASSIGNMENT_ACK_WINDOW_MINUTES`, `ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_MAX` and `ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_DURATION_MS` Joi entries to `ciro_fuel/src/config/validation.ts`, each with a one-line comment citing the FR it backs (FR-012, FR-013a)
- [X] T003 [P] Document the three new environment variables in `ciro_fuel/.env.example`
- [X] T004 [P] Create the `DriverEligibility` enum (`ELIGIBLE` / `BUSY` / `OFFLINE`) in `ciro_fuel/src/common/enums/driver-eligibility.enum.ts` — Constitution Principle I: never a bare string literal (data-model.md §1)
- [X] T005 [P] Add `ASSIGNMENT_REASON_REQUIRED` to `ciro_fuel/src/common/enums/error-code.enum.ts` for FR-008's refusal, with a comment explaining it is a validation-shaped 400 (a malformed request), not a 409 state conflict

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The `Order` schema fields every story reads or writes. One file, touched by all three
stories — done once here so no story phase collides with another on it.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 Add the five new fields to `ciro_fuel/src/modules/orders/schemas/order.schema.ts` per data-model.md §2 — `assignmentAcknowledgedAt?: Date`, `assignmentEscalationSmsAt?: Date`, `assignmentEscalationSkippedReason?: EscalationSkipReason`, `assignedWhileIneligible?: boolean`, `assignedWhileIneligibleReason?: string` — modelling the last two on the existing `manualOverride`/`overrideReason` pair in the same file (research R5)
- [X] T007 Create the `EscalationSkipReason` enum (`NO_PHONE` today, typed as an enum so a second reason needs no shape change) in `ciro_fuel/src/common/enums/escalation-skip-reason.enum.ts` — **not parallel with T006**, which imports it
- [X] T008 Extend `toRoleScopedShape` in `ciro_fuel/src/modules/orders/orders.controller.ts` so all five new fields are present in the operator/driver shapes and **stripped from the `CLIENT` shape** (contracts/rest-api-delta.md §4) — the same leak spec 008 already had to fix once

**Checkpoint**: Schema and vocabulary in place — US1 and US2 can now proceed in parallel.

---

## Phase 3: User Story 1 - See every driver, not just the ones online (Priority: P1) 🎯 MVP

**Goal**: The assignment screen shows the transporter's whole roster with each driver's
eligibility clear, and assigning an ineligible one records a reason.

**Independent Test**: With one online+available driver and one never-connected driver on file,
open a routed order's assignment screen — both appear, the offline one marked; assigning the
offline one without a reason is refused, with a reason it succeeds and the reason is stored.

### Tests for User Story 1 ⚠️

> Write these first and confirm they fail before implementing.

- [X] T009 [P] [US1] Add a platform e2e test in `ciro_fuel/test/e2e/dispatch-candidates.e2e-spec.ts` asserting the candidate list includes an offline driver, a busy driver, a never-connected driver (no `location` at all) and a deactivated (`isActive: false`) driver, each with the correct `eligibility` (the last as `INACTIVE`), and that another company's drivers never appear (FR-001, FR-002, tenant isolation)
- [X] T010 [US1] Add an e2e test to the same `ciro_fuel/test/e2e/dispatch-candidates.e2e-spec.ts` asserting an empty candidate array is returned **only** for a company with zero driver accounts, never merely because none are online (FR-006, SC-001) — **not parallel with T009**, same file
- [X] T011 [P] [US1] Add an e2e test in `ciro_fuel/test/e2e/assignment-reason.e2e-spec.ts` asserting assignment of an `OFFLINE` driver without a reason is refused with `ASSIGNMENT_REASON_REQUIRED`, and with a reason succeeds and persists `assignedWhileIneligible`/`assignedWhileIneligibleReason`; and asserting a `BUSY` driver's assignment is refused **regardless of any reason supplied** (FR-007 correction, FR-008)
- [X] T012 [P] [US1] Add a dashboard unit test in `web_dashboard/tests/unit/candidate-eligibility.test.tsx` asserting `ELIGIBLE`/`BUSY`/`OFFLINE`/`INACTIVE` rows render distinctly, that the reason field appears **only** for an `OFFLINE` selection, and that a `BUSY`/`INACTIVE` row offers no assignable action at all (FR-004, FR-007, FR-008)

### Implementation for User Story 1

- [X] T013 [US1] Rewrite `findCandidates` in `ciro_fuel/src/modules/dispatch/services/dispatch.service.ts` as the two-query split from research R1 — a `$geoNear` matching only `{ role: DRIVER }` (dropping `isActive` too — a suspended driver is still shown, per spec Edge Cases, corrected during implementation from an earlier draft that wrongly excluded them) plus a separate `find` for drivers with no `location` at all, since `$geoNear` silently omits any document missing its sort field
- [X] T014 [US1] Annotate each candidate with `eligibility` (T004's enum) and `lastSeenAt` in `getCandidates`, ordering `ELIGIBLE` first (nearest-first preserved within it) then the rest (FR-003, FR-005, data-model.md §1)
- [X] T015 [US1] Add the optional `reason` field to `ciro_fuel/src/modules/dispatch/dto/assign-driver.dto.ts` (contracts/rest-api-delta.md §2)
- [X] T016 [US1] In `assignDriver`, resolve the chosen driver's eligibility before booking: refuse a `BUSY` driver outright (the existing `activeOrderId: { $exists: false }` filter already does this — no new logic needed there, just confirm it stays); refuse `ASSIGNMENT_REASON_REQUIRED` for `OFFLINE` with no reason; otherwise persist `assignedWhileIneligible`/`assignedWhileIneligibleReason` **inside the existing assignment transaction**, alongside `driverSummary` (Constitution Principle V, FR-007 correction) — implemented: one-line filter change (dropped `isOnline: true`, kept `isActive`/`isAvailable`/`activeOrderId` exactly as before) plus a pre-transaction eligibility read gating the reason requirement; `assignment-reason.e2e-spec.ts` proves OFFLINE succeeds-with-reason, BUSY and INACTIVE both refuse unconditionally regardless of reason.
- [X] T017 [US1] Update the candidate response type in `web_dashboard/src/transport_company/orders/api/dispatch.api.ts` and add a matching `DriverEligibility` const map in `web_dashboard/src/constants/` — never a bare string literal (Constitution Principle I)
- [X] T018 [US1] Render every returned driver in `web_dashboard/src/transport_company/orders/components/assign-driver/AssignLists.tsx`, with `OFFLINE` rows visually muted+badged and assignable-with-reason, `BUSY` rows visually muted+badged but **not** assignable (no reason override — FR-007 correction), and `INACTIVE` rows non-interactive with no click target at all (offline shows relative `lastSeenAt`, or "never online") — **no client-side filtering** (contracts/dashboard-integration.md)
- [X] T019 [US1] Update the empty state in `web_dashboard/src/transport_company/orders/components/assign-driver/AssignLists.tsx` to fire only on a genuinely empty array, rewording it from "no drivers available" to "no drivers registered" — the old copy now describes something the response no longer means (FR-006)
- [X] T020 [US1] Add the conditional required-reason field to `web_dashboard/src/transport_company/orders/components/assign-driver/AssignSelectionCard.tsx` and thread it through `AssignmentContext.tsx`, shown only when the selected driver is not `ELIGIBLE` (FR-007, FR-008)
- [X] T021 [US1] Surface the `ASSIGNMENT_REASON_REQUIRED` refusal inline on the reason field in `web_dashboard/src/transport_company/orders/components/assign-driver/assignmentRefusal.ts`, matching how capacity/grade refusals are already handled there
- [X] T022 [P] [US1] Add both-language strings for eligibility badges, "last seen"/"never online", and the reason field's label/placeholder/validation message to `web_dashboard/src/lib/i18n/en.json` and `ar.json`

**Checkpoint**: US1 fully functional — an administrator always sees their real fleet and can assign anyone on it, with an audit trail when they override.

---

## Phase 4: User Story 2 - Get the assignment to the driver even if the first notification doesn't land (Priority: P1)

**Goal**: An unacknowledged assignment escalates to SMS after a configurable window; an
acknowledged one never does.

**Independent Test**: Assign an order and never acknowledge it — after the window elapses an SMS
is sent (visible in `NoopSmsSender`'s log locally). Acknowledge a second one in time — no SMS.

### Tests for User Story 2 ⚠️

- [X] T023 [P] [US2] Add an e2e test in `ciro_fuel/test/e2e/assignment-escalation.e2e-spec.ts` asserting the acknowledge endpoint sets `assignmentAcknowledgedAt`, is idempotent on a second call, and is refused with 404 for a driver the order isn't assigned to — indistinguishably from absent (FR-010, FR-017). Also assert, in the same spec, that `assignDriver` still creates/emits the existing `ORDER_ASSIGNED` notification unchanged — a regression guard for the code this feature edits immediately alongside it (FR-009)
- [X] T024 [P] [US2] Add a unit test in `ciro_fuel/test/unit/assignment-escalation.processor.spec.ts` asserting the processor sends exactly one SMS for an unacknowledged assignment, sends **none** when already acknowledged, and records `NO_PHONE` without sending when the driver has no phone (FR-013, FR-015). Also assert the SMS is sent within one minute of the job becoming due under normal (non-rate-capped) conditions (SC-003)
- [X] T025 [US2] Add a unit test to the same `ciro_fuel/test/unit/assignment-escalation.processor.spec.ts` asserting the escalation SMS body contains an order reference only — **no** customer name, address, or delivery detail (FR-011a, the security-scoping clarification) — **not parallel with T024**, same file
- [X] T026 [US2] Add an e2e test to the same `ciro_fuel/test/e2e/assignment-escalation.e2e-spec.ts` asserting a pending escalation is cancelled when the order is cancelled (`OrdersService.cancel`, the only real "no longer applies" path — FR-014a narrowed during implementation, no driver-reassignment capability exists on this platform), and is **not** cancelled by a vehicle-only `reassignVehicle` — **not parallel with T023**, same file
- [X] T026a [P] [US2] Add a unit test in `ciro_fuel/test/unit/assignment-escalation-queue.service.spec.ts` asserting a job scheduled via `AssignmentEscalationQueueService.schedule` is still present (re-fetchable via `queue.getJob`) after the underlying `Worker`/processor is torn down and a fresh one constructed against the same Redis connection — the closest a test can get to "survives a restart" without actually restarting the process (FR-012a, SC-006)
- [X] T026b [P] [US2] Add a unit test asserting that scheduling more escalations than the configured `limiter.max` within one `limiter.duration` window still processes every one of them (none dropped), with the excess visibly delayed rather than sent immediately (FR-013a) — the burst scenario `quickstart.md` defers to an automated test rather than a manual step

### Implementation for User Story 2

- [X] T027 [US2] Create `ciro_fuel/src/modules/assignment-escalation/queues/assignment-escalation-queue.service.ts` with `schedule(orderId, delayMinutes)` / `cancel(orderId)`, using `jobId = orderId` as the idempotency key — mirroring `payments/queues/payment-timeout-queue.service.ts` exactly (research R3)
- [X] T028 [US2] Create `ciro_fuel/src/modules/assignment-escalation/queues/assignment-escalation.processor.ts` — re-read the order fresh, no-op if already acknowledged or no longer assigned to that driver, otherwise send via the injected `SmsSender` and stamp `assignmentEscalationSmsAt` (or `assignmentEscalationSkippedReason: NO_PHONE`)
- [X] T029 [US2] Create `ciro_fuel/src/modules/assignment-escalation/assignment-escalation.module.ts` with `BullModule.registerQueue`, the worker `limiter` wired from T001's rate-cap config (research R4, FR-013a), and `exports: [AssignmentEscalationQueueService]`
- [X] T030 [US2] Schedule the escalation from `assignDriver` in `ciro_fuel/src/modules/dispatch/services/dispatch.service.ts` — **after** the transaction commits, matching the payment-timeout precedent's stated reasoning (Constitution Principle V)
- [X] T031 [US2] Cancel the pending escalation from `OrdersService.cancel` (same spot `paymentTimeoutQueue.cancel` already is, same `from === ASSIGNED_TO_DRIVER` guard) — the only place a driver assignment ever ends; confirm `reassignVehicle` deliberately does **not** trigger it (FR-014a, narrowed)
- [X] T032 [US2] Add `POST /orders/:id/acknowledge-assignment` to `ciro_fuel/src/modules/orders/orders.controller.ts`, `@Roles(DRIVER)`, ownership-checked like `verify-vehicle`, idempotent, cancelling the pending escalation on success (contracts/rest-api-delta.md §3)
- [X] T033 [US2] Register `AssignmentEscalationModule` in `ciro_fuel/src/modules/dispatch/dispatch.module.ts` and `orders.module.ts` as needed
- [X] T034 [P] [US2] Add an `AcknowledgeAssignment` use case in `mobile_app/lib/features/delivery/domain/usecases/acknowledge_assignment.dart` plus its repository/data-source methods, following `mark_arrived.dart`'s exact shape (contracts/mobile-integration.md)
- [X] T035 [US2] Call it from `DeliveryCubit.load()` in `mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart` after emitting `DeliveryState.active(...)` for an order whose `assignmentAcknowledgedAt` is unset — **fire-and-forget**: a failed acknowledgment must never turn into a `DeliveryState.failure` for the whole screen
- [X] T036 [P] [US2] Register the new use case in `mobile_app/lib/core/di/` alongside the other delivery use cases

**Checkpoint**: US1 and US2 both work independently — the roster is honest and an assignment can no longer go silently unnoticed.

---

## Phase 5: User Story 3 - See whether the driver actually got the message (Priority: P2)

**Goal**: The administrator can tell, from the order itself, whether the driver acknowledged and
whether an SMS went out.

**Independent Test**: Open an assigned-but-unacknowledged order — it says so; after escalation it
names the SMS and its time; after acknowledgment it says acknowledged and never reverts.

### Tests for User Story 3 ⚠️

- [X] T037 [P] [US3] Add a dashboard unit test in `web_dashboard/tests/unit/assignment-ack-state.test.tsx` asserting the three states (waiting / SMS sent / acknowledged) render distinctly and that an acknowledged order never shows a stale "waiting" state (spec US3.3)

### Implementation for User Story 3

- [X] T038 [US3] Add the acknowledgment/escalation fields to the dashboard's `Order` type in `web_dashboard/src/transport_company/orders/types.ts`
- [X] T039 [US3] Build the acknowledgment-state display into `web_dashboard/src/transport_company/orders/components/order-details/AssignedDriverCard.tsx` — waiting / SMS sent at `<time>` / acknowledged at `<time>`, plus the recorded `assignedWhileIneligibleReason` when present (FR-016, contracts/dashboard-integration.md)
- [X] T040 [P] [US3] Add both-language strings for the three acknowledgment states and the ineligible-assignment reason label to `web_dashboard/src/lib/i18n/en.json` and `ar.json`

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T041 [P] Verify loading, empty and failed remain three visibly distinct states on the rewritten candidate list (the `isError` discipline feature 009 established) — found a genuine gap: `AssignmentContext`/`AssignLists.tsx` never checked `isError` at all (a failed candidates fetch silently rendered as the empty state). Added `candidatesError`/`refetchCandidates` to the context and a distinct failed+retry state to `AssignLists.tsx`, matching feature 009's own established pattern exactly. `tsc -b --force` clean, `vitest run` 42/42 real tests.
- [X] T042 [P] Confirm no isolation key (`companyId`, `driverId`, …) is rendered anywhere in the new dashboard UI — inherited discipline from feature 009 (its own T120), not a requirement of this spec, applied to the screens this feature adds — grepped `assign-driver/` and `order-details/` for any isolation key interpolated into JSX: zero matches.
- [X] T043 [P] Grep `ciro_fuel/src/modules/assignment-escalation/` and `ciro_fuel/src/common/sms/` to confirm the escalation SMS body is never written to application logs in full, and that no customer detail reaches the SMS path at all (FR-011a) — the processor's own log lines carry only `orderId`, never the message/phone; the one place that DOES log the full message is `NoopSmsSender` (`SMS_PROVIDER=none`), a pre-existing, disclosed dev-only stand-in that `validation.ts` refuses outside development — unreachable in production, where a real provider is mandatory. Even there, the message itself carries no customer/delivery detail (T024/T025 already proved this), so the dev-only exposure is minimal regardless.
- [X] T044 Run the full backend suites — `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` — and confirm green — 136/136 unit, 50 suites/247 e2e tests, both fully green.
- [X] T045 Run `npx tsc -b --force` and `npx vitest run` in `web_dashboard/`, and `flutter test` in `mobile_app/`, confirming green with only the two documented pre-existing mobile failures — `tsc -b --force` clean, `vitest run` 42/42 real tests; `flutter test` 404 passing, `login_screen_golden_test` (pixel diff) and `auth_session_test` (`skip: true`) unchanged from the documented baseline.
- [ ] T046 Run the `quickstart.md` walkthrough end to end against a live environment (needs Redis and a running backend)
- [X] T047 Update `ciro_fuel/CLAUDE.md` to record feature 010 as implemented, with its binding decisions and any corrections found during implementation — status changed from "Planned, not yet implemented" to "Previously planned feature, now implemented"; added an Implementation status paragraph and a Corrections found while implementing paragraph (the 4th DriverEligibility value, the BUSY-never-assignable finding and its one-line fix, the driver-reassignment-doesn't-exist narrowing, the live-phone-lookup fix, and the SEND_FAILED addition).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — T001–T005 all parallel
- **Foundational (Phase 2)**: needs T004/T005 from Setup; **blocks all user stories**
- **US1 (Phase 3)** and **US2 (Phase 4)**: both depend only on Phase 2 — genuinely parallel, they share no file
- **US3 (Phase 5)**: depends on Phase 2 for the fields; its *display* is only meaningful once US2 populates them, but it is independently testable with seeded field values
- **Polish (Phase 6)**: after the stories it verifies

### Critical constraints

- **T006 before T007's consumers** — the schema imports the enum, so T007 lands first in practice
- **T013 before T014** — same file, and the annotation needs the merged result
- **T030 must be after the transaction commits**, never inside it (Constitution Principle V; the payment-timeout precedent documents exactly why)
- **T031's `reassignVehicle` check is a negative assertion** — the task is partly to confirm it does *not* cancel, which is easy to get wrong in the direction of over-cancelling

### Parallel Opportunities

- All of Phase 1 (T001–T005)
- US1 tests: T009, T011 and T012 are three different files and run in parallel; **T010 shares T009's file** and follows it
- US2 tests: T023 and T024 are two different files and run in parallel; **T025 follows T024** and **T026 follows T023**, each sharing its file; **T026a and T026b** are each their own new file and run in parallel with everything else in this block
- US1 and US2 implementation streams, by different people, after Phase 2
- Both i18n tasks (T022, T040) against the other work in their phases

---

## Implementation Strategy

### MVP (User Story 1 only)

Phase 1 → Phase 2 → Phase 3, then stop and validate: the administrator sees their whole fleet and
can assign anyone on it with an audit trail. This alone fixes the false "no drivers available"
screen that prompted the feature, and ships without any escalation machinery at all.

### Incremental delivery

1. Setup + Foundational → vocabulary and schema ready
2. + US1 → honest roster, reasoned overrides (**MVP**)
3. + US2 → no assignment goes silently unnoticed
4. + US3 → the administrator can see which is which

### Notes

- US1 and US2 are both P1 but genuinely independent — US2's escalation protects *any* assignment,
  including one made to an already-eligible driver, so it delivers value even if US1 never ships.
- Tests are mandatory here (constitution), not the template's optional case — write them first
  within each story phase.
