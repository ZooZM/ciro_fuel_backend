---

description: "Task list for In-Transit Stop Detection & Driver Check-In"
---

# Tasks: In-Transit Stop Detection & Driver Check-In

**Input**: Design documents from `specs/011-transit-stop-detection/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: **Required, not optional.** The constitution's Development Workflow gate requires
automated tests for guarantees the spec marks as testable before the capability is considered done.
This feature's are: the exactly-one-unresolved-stop invariant (FR-016), the stopped-vs-silent
distinction (FR-017), escalation-exactly-once (FR-009/SC-008), declared-stop suppression bounds
(FR-008d/SC-009), and in-transit-only scoping (FR-002).

**Organization**: Tasks are grouped by user story so each can be implemented and tested
independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)

## Path Conventions

Three existing surfaces, no new project (plan.md → Structure Decision):

- **Backend**: `ciro_fuel/src/`, tests in `ciro_fuel/test/`
- **Dashboard**: `web_dashboard/src/`, tests in `web_dashboard/tests/`
- **Mobile**: `mobile_app/lib/`, tests in `mobile_app/test/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Vocabulary and configuration everything else references — no behaviour change alone.

- [X] T001 [P] Create the `StopOrigin` enum (`DETECTED` / `DECLARED`) in `ciro_fuel/src/common/enums/stop-origin.enum.ts` — FR-008c requires these read as visibly different things, so they are two values, not a boolean
- [X] T002 [P] Create the `StopReason` enum (`TRAFFIC`, `VEHICLE_PROBLEM`, `REST_OR_PRAYER`, `REFUELLING`, `ROAD_CLOSURE`, `ACCIDENT`, `OTHER`) in `ciro_fuel/src/common/enums/stop-reason.enum.ts` — fixed list so a roadside driver answers in one tap (SC-003)
- [X] T003 [P] Add `DRIVER_STOP_DETECTED` and `ORDER_STOP_UNRESOLVED` to `ciro_fuel/src/common/enums/notification-type.enum.ts`, each commented with who receives it and what it triggers
- [X] T004 [P] Add the four config keys to `ciro_fuel/src/config/configuration.ts` under a `stopDetection` namespace — `windowMinutes`, `movementMeters`, `responseWindowMinutes`, `sweepSeconds` (FR-019, research R7, `presence.*` precedent)
- [X] T005 [P] Add matching Joi entries to `ciro_fuel/src/config/validation.ts`, each citing the FR it backs; `STOP_DETECTION_MOVEMENT_METERS` defaults to 50 to match the existing tracking threshold (research R2)
- [X] T006 [P] Document the four new variables in `ciro_fuel/.env.example`, noting that the sweep interval is deliberately overridable so tests need not wait a real minute

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The schema every story reads or writes, plus the movement bookkeeping detection
depends on. Touched by all four stories — done once here so no story phase collides.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T007 Add `lastMovedAt?: Date` and `lastMovedLocation?: GeoPoint` to `ciro_fuel/src/modules/users/schemas/user.schema.ts`, with a comment stating explicitly that these are **not** `lastSeenAt` — presence versus movement is what FR-017 rests on (data-model.md §1)
- [X] T008 Create the `StopEvent` sub-schema and add `stopEvents: StopEvent[]` (default `[]`) to `ciro_fuel/src/modules/orders/schemas/order.schema.ts`, following `Order.verifications`' embedded-array shape (research R5) — **but with one deliberate departure: `StopEvent` MUST NOT use `@Schema({ _id: false })`.** Every other embedded sub-schema on `Order` (all 8, `VehicleVerification` included) disables `_id` because none of them is ever addressed individually. `StopEvent` is the first that is: `POST /orders/:id/stops/:stopId/reason`, `PATCH /orders/:id/stops/:stopId/resolve`, the escalation's `jobId = stopId`, and the `DRIVER_STOP_DETECTED` payload all need a stable per-stop identifier. Copying the precedent literally here would leave nothing able to address a stop. **Not parallel with T007**
- [X] T009 Add the `{ status: 1, driverId: 1 }` compound index to `order.schema.ts` for the sweep's only query — the existing `{ driverId: 1, status: 1 }` leads with the wrong field for this access pattern (data-model.md §Indexes) — **corrected during implementation**: the sweep turned out to be better as a DRIVER-first query (the selective predicate, a stale `lastMovedAt`, lives on `User`; nearly every driver on a delivery is moving at any moment), which makes an Order index dead weight. Added `{ role: 1, lastMovedAt: 1 }` on `User` instead and removed the Order one.
- [X] T010 Extend `toRoleScopedShape` in `ciro_fuel/src/modules/orders/orders.controller.ts` so `stopEvents` is present for operator/driver roles and **stripped for `CLIENT`** — a customer has no business reading why their driver stopped (contracts/rest-api-delta.md §4)
- [X] T011 In `ciro_fuel/src/modules/tracking/tracking.gateway.ts`'s accepted-fix branch, also write `lastMovedAt`/`lastMovedLocation` when the fix is farther than the configured movement threshold from `lastMovedLocation` — measured against **`lastMovedLocation`, never `location`**, or a parked truck drifts past the threshold in sub-threshold steps and reads as moving (contracts/realtime-contract.md)
- [X] T012 [P] Add a unit test in `ciro_fuel/test/unit/movement-bookkeeping.spec.ts` asserting a heartbeat from a stationary driver advances `lastSeenAt` but **never** `lastMovedAt`, and that repeated sub-threshold drift never accumulates into a movement — the two properties FR-017/FR-003/SC-007 depend on — **the test caught a conceptual error in its own first draft**: 20 sub-threshold steps *in one direction* is 400 m of slow travel, not drift, and the implementation was right to call it movement. Rewritten to model real jitter (scattered around a fixed point, no consistent direction), plus a deliberate counterpart test pinning that slow steady travel IS movement — the boundary the drift rule must not over-suppress

**Checkpoint**: Schema, vocabulary and movement bookkeeping in place — stories can now proceed.

---

## Phase 3: User Story 1 - The platform notices a stalled delivery and asks the driver why (Priority: P1) 🎯 MVP

**Goal**: A truck stopped past the window during the in-transit leg is detected, and the driver is
asked why through an alert that reaches them mid-drive.

**Independent Test**: With a delivery in transit, hold the driver's device in one place past the
configured window; the driver receives a device-level prompt asking why they stopped.

### Tests for User Story 1 ⚠️

> Write these first and confirm they fail before implementing.

- [X] T013 [P] [US1] Add an e2e test in `ciro_fuel/test/e2e/stop-detection.e2e-spec.ts` asserting the sweep raises a `DETECTED` stop event for an in-transit order whose driver's `lastMovedAt` is older than the window, and notifies that driver (FR-001, FR-004)
- [X] T014 [US1] Add to the same spec: **no** stop is raised for a driver still moving, nor for a stationary driver whose order is in any stage other than `IN_TRANSIT` (FR-002, SC-002) — **not parallel with T013**, same file
- [X] T015 [US1] Add to the same `ciro_fuel/test/e2e/stop-detection.e2e-spec.ts`: a driver whose device has gone **silent** (no fixes arriving at all — stale `lastSeenAt` as well as stale `lastMovedAt`) raises no stop event, distinguishing silence from stillness (FR-017) — **not parallel with T013**, same file
- [X] T016 [P] [US1] Add a unit test in `ciro_fuel/test/unit/stop-detection.service.spec.ts` asserting the sweep raises **at most one** unresolved stop per order even when run repeatedly against the same stalled delivery (FR-016, SC-008), and that a driver who resolves a stop, moves again, then stops again gets a **new** stop event (FR-015) — the latter works by construction from T019's query, so it needs a test precisely because nothing else would notice if a refactor broke it
- [X] T016a [P] [US1] Add a unit test in `ciro_fuel/test/unit/stop-detection-null-movement.spec.ts` asserting a driver whose `lastMovedAt` is **`null`** — never granted location permission, so no fix has ever arrived — produces no stop event (FR-020). The correct query (`{ lastMovedAt: { $lt: cutoff } }`) skips null naturally, but a well-meant `$or: [{ lastMovedAt: null }, ...]` "for safety" would raise a stop for every permission-denied driver; this test is what stops that
- [X] T017 [P] [US1] Add a mobile test in `mobile_app/test/unit/stop_notification_test.dart` asserting a `DRIVER_STOP_DETECTED` notification triggers `NotificationPresenter.present`, and that other notification types do **not** — the seam makes this assertable without a device — **landed in the existing `mobile_app/test/unit/delivery_listener_test.dart` instead of a new `stop_notification_test.dart`**: the handler under test is `DeliveryListener`'s, and that file already owns every assertion about which `notification:new` types it acts on. A second file would have had to rebuild the same mocked socket/cubit fixture to test one more branch of one handler

- [X] T017a [P] [US1] Add a mobile test in `mobile_app/test/unit/background_location_config_test.dart` asserting `LocationStreamService`'s Android settings carry a `foregroundNotificationConfig` and its Apple settings set `allowBackgroundLocationUpdates` (FR-018, SC-006) — this config is already correct today, and the only thing standing between it and a silent regression is that nothing asserts it

### Implementation for User Story 1

- [X] T018 [US1] Create `ciro_fuel/src/modules/stop-detection/stop-detection.service.ts` with the `@Cron` sweep, interval from `stopDetection.sweepSeconds`, mirroring `PresenceService.sweepOfflineDrivers`' shape — including its documented no-ambient-tenant-context comment, since this cron has the same property (plan.md Constitution Check)
- [X] T019 [US1] Implement the sweep query: in-transit orders whose driver's `lastMovedAt` is older than the window and which have no unresolved stop event, raising each via a **conditional update** guarded on no-unresolved-stop rather than a read-then-write (research R6, FR-016)
- [X] T020 [US1] Notify the driver on each raised stop via the existing `NotificationsService.notify` path with `DRIVER_STOP_DETECTED`, carrying `orderId` and `stopId` so the app can open the right prompt (contracts/realtime-contract.md)
- [X] T021 [US1] Create `ciro_fuel/src/modules/stop-detection/stop-detection.module.ts` and register it in `ciro_fuel/src/app.module.ts`
- [X] T022 [P] [US1] Add `flutter_local_notifications` to `mobile_app/pubspec.yaml`
- [X] T023 [US1] Create the `NotificationPresenter` seam (FR-004a) in `mobile_app/lib/core/notifications/notification_presenter.dart` — abstract interface only, no plugin import anywhere near it, mirroring `lib/core/nfc/nfc_reader.dart`'s shape exactly
- [X] T024 [US1] Implement it in `mobile_app/lib/core/notifications/local_notification_presenter.dart` — **including the Android high-importance channel created at init** (a notification posted without one is silently dropped on modern Android) and the iOS `UNUserNotificationCenter` authorization request
- [X] T025 [US1] Add the Android 13+ runtime `POST_NOTIFICATIONS` permission request — the manifest already declares it, but nothing requests it at runtime today (contracts/mobile-integration.md §1)
- [X] T026 [US1] Register `NotificationPresenter` in `mobile_app/lib/core/di/injector.dart` and initialize it at app start alongside the other core seams
- [X] T027 [US1] Raise a device-level alert on `DRIVER_STOP_DETECTED` in the existing `notification:new` handler — attached **after** `trackingSocket.connect()` resolves, never in a constructor (`mobile_app/CLAUDE.md` debt #6's silent-no-op failure)
- [X] T028 [US1] Handle an alert tap: route to the reason prompt for the specific `stopId` in the payload (`mobile_app/lib/core/notifications/` tap stream → delivery feature routing) — landed with US2, once T039 gave the tap somewhere to go. `core/notifications/stop_alert_router.dart` consumes the `taps` stream, splits the `orderId:stopId` payload and opens the sheet for that specific stop. Kept out of `DeliveryListener` on purpose: that class is unit-tested against a mocked socket with no navigator, and navigation would drag a live `GoRouter` into every one of those tests

**Checkpoint**: A stalled delivery announces itself and the driver is genuinely reachable — the MVP.

---

## Phase 4: User Story 2 - The driver explains, and the transporter sees it (Priority: P1)

**Goal**: The driver answers the prompt (or declares a stop before being asked), and the reason
reaches the transportation company.

**Independent Test**: With a stop raised, the driver submits a reason; the transport administrator
viewing that order sees the reason and when it was given.

### Tests for User Story 2 ⚠️

- [X] T029 [P] [US2] Add an e2e test in `ciro_fuel/test/e2e/stop-reason.e2e-spec.ts` asserting a driver can submit a reason for a raised stop, that it resolves the stop, and that submitting for an order not assigned to them is refused with 404 indistinguishably from absent (FR-007)
- [X] T030 [US2] Add to the same spec: a driver declaring a stop creates an already-answered `DECLARED` event that never prompts, and that declaring while one is already unresolved is refused (FR-008a-c, FR-016) — **not parallel with T029**, same file
- [X] T031 [US2] Add to the same spec: declaring outside `IN_TRANSIT` is refused (FR-002) — **not parallel with T029**, same file
- [X] T032 [P] [US2] Add a unit test in `ciro_fuel/test/unit/stop-suppression.spec.ts` asserting a declared stop suppresses detection only until its stated duration expires, after which the sweep raises a **new** `DETECTED` event rather than reopening the declared one (FR-008d, SC-009)
- [X] T033 [P] [US2] Add a mobile test in `mobile_app/test/unit/stop_reason_flow_test.dart` asserting a common reason submits without any text entry, and that `OTHER` requires text (FR-005, FR-006, SC-003)

### Implementation for User Story 2

- [X] T034 [P] [US2] Create `DeclareStopDto` and `SubmitStopReasonDto` in `ciro_fuel/src/modules/orders/dto/`, with `reasonText` required only when `reason` is `OTHER`
- [X] T035 [US2] Add `POST /orders/:id/stops/declare` to `ciro_fuel/src/modules/orders/orders.controller.ts` — `@Roles(DRIVER)`, ownership-checked, `IN_TRANSIT`-only, creating an already-answered `DECLARED` event with `suppressedUntil` (contracts/rest-api-delta.md §1)
- [X] T036 [US2] Add `POST /orders/:id/stops/:stopId/reason` — records the reason, cancels the pending escalation, resolves the stop. **A submission after escalation is a normal resolution, never an error** (FR-010) — the case most likely to be coded as a rejection by reflex
- [X] T037 [US2] Teach the sweep to skip orders whose unresolved stop is a declared one still inside its `suppressedUntil`, and to raise a fresh `DETECTED` event once that lapses (FR-008b, FR-008d)
- [X] T038 [P] [US2] Add `DeclareStop` and `SubmitStopReason` use cases in `mobile_app/lib/features/delivery/domain/usecases/`, plus their repository and remote-data-source methods, following `mark_arrived.dart`'s exact shape
- [X] T039 [US2] Build the reason prompt in `mobile_app/lib/features/delivery/presentation/` — the fixed reason list as one-tap primary controls (not a dropdown), free text revealed only for `OTHER` (SC-003)
- [X] T040 [US2] Build the declare-stop action on the active-delivery screen, offered only while `IN_TRANSIT`, with the reason list plus a duration picker
- [X] T041 [P] [US2] Register both use cases in `mobile_app/lib/core/di/injector.dart`
- [X] T042 [P] [US2] Add both-language strings for every `StopReason` label and the two driver flows to `mobile_app/assets/translations/`

**Checkpoint**: The driver's own answer reaches the transporter, and predictable stops can be declared ahead of time.

---

## Phase 5: User Story 3 - Silence itself becomes the alert (Priority: P1)

**Goal**: A driver who never answers escalates to the transportation company automatically.

**Independent Test**: With a stop raised and the driver never responding, wait past the response
window; the transport administrator is notified that the delivery has an unexplained stop.

### Tests for User Story 3 ⚠️

- [X] T043 [P] [US3] Add a unit test in `ciro_fuel/test/unit/stop-escalation.processor.spec.ts` asserting the processor notifies the transport admin exactly once for an unanswered stop, and **not at all** for one already answered (FR-009, SC-008); also assert the notification is produced within SC-004's one-minute bound of the job becoming due under normal (non-rate-capped) conditions
- [X] T044 [US3] Add to the same spec: a reason submitted after escalation is recorded normally, leaves `escalatedAt` in place as a truthful record, and raises no error (FR-010) — **not parallel with T043**, same file
- [X] T045 [P] [US3] Add an e2e test in `ciro_fuel/test/e2e/stop-escalation.e2e-spec.ts` asserting the pending escalation is cancelled when the driver answers, and when the delivery reaches a final state (FR-014)

### Implementation for User Story 3

- [X] T046 [US3] Create `ciro_fuel/src/modules/stop-detection/queues/stop-escalation-queue.service.ts` with `schedule(stopId, delayMinutes)` / `cancel(stopId)`, `jobId = stopId`, mirroring feature 010's `AssignmentEscalationQueueService` exactly (research R3)
- [X] T047 [US3] Create `ciro_fuel/src/modules/stop-detection/queues/stop-escalation.processor.ts` — re-read the order fresh, no-op if the stop is answered/resolved or the delivery is finished, otherwise notify the transport admin(s) with `ORDER_STOP_UNRESOLVED` and stamp `escalatedAt`
- [X] T048 [US3] Register the queue in `stop-detection.module.ts` via `BullModule.registerQueue` and schedule the escalation when a stop is raised (T019), after the raising write commits — feature 010's stated reasoning about jobs referencing uncommitted state applies identically
- [X] T049 [US3] Cancel the pending escalation wherever a stop resolves — in `ciro_fuel/src/modules/orders/orders.controller.ts` for the driver answering (T036) and the administrator resolving (T053), and in `ciro_fuel/src/modules/orders/orders.service.ts` where the delivery reaches a final state (FR-014), following feature 010's `assignmentEscalationQueue.cancel` placement

**Checkpoint**: An unresponsive driver reaches a human automatically — the safety net is closed.

---

## Phase 6: User Story 4 - The administrator sees and handles the alert (Priority: P2)

**Goal**: The transport dashboard's order detail shows the stop plainly and lets the administrator
mark it handled.

**Independent Test**: Open an order with an active stop alert; it shows the driver's reason or their
non-response, and can be marked handled.

### Tests for User Story 4 ⚠️

- [X] T050 [P] [US4] Add a dashboard unit test in `web_dashboard/tests/unit/stop-alert-card.test.tsx` asserting the four states (unanswered / escalated / answered / declared) render distinctly, that an answered stop shows the driver's **own words** rather than a generic message (US4.2), and that an order with no stop events renders **no card at all** (FR-013)

### Implementation for User Story 4

- [X] T051 [P] [US4] Add `stopEvents` and the `StopReason`/`StopOrigin` const maps to `web_dashboard/src/transport_company/orders/types.ts` and `web_dashboard/src/constants/` — never bare string literals (Constitution Principle I)
- [X] T052 [US4] Build `web_dashboard/src/transport_company/orders/components/order-details/StopAlertCard.tsx`, reinstating the deleted mock's real elements only — **omitting "remaining distance" and the street-name location, which have no data source** (contracts/dashboard-integration.md §1); render the stop's point on the existing map instead
- [X] T053 [US4] Add `PATCH /orders/:id/stops/:stopId/resolve` to `orders.controller.ts` (`@Roles(TRANSPORT_COMPANY_ADMIN)`) plus its dashboard API/hook, wired to the card's "handled" action (FR-011, FR-012)
- [X] T054 [US4] Compose `StopAlertCard` into `web_dashboard/src/transport_company/orders/components/OrderDetailPage.tsx`, above the existing cards — an active alert is the first thing an administrator should see
- [X] T055 [US4] Apply the stale-position treatment to `web_dashboard/src/transport_company/orders/components/order-details/MapCard.tsx`, reusing `TrackingMapCard.tsx`'s existing approach and the `tracking.stalePosition` key — a silent device currently reads there as a live position frozen in place (FR-017a)
- [X] T056 [P] [US4] Add both-language strings for the four card states, every `StopReason` label, and the handled action to `web_dashboard/src/lib/i18n/en.json` and `ar.json` — the reason labels must read consistently with the driver app's, since the transporter is reading what the driver picked

**Checkpoint**: All four stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T057 [P] (verified: the card reads the shared `OrderDetailContext` and adds no fourth state — it renders its content or nothing at all, so the page's existing loading/not-found/loaded branches are untouched) Verify loading, empty and failed remain three visibly distinct states on the order detail with the new card present — inherited discipline from features 009/010, not a requirement of this spec
- [X] T058 [P] (verified: `StopAlertCard` uses `stop._id` only as a React `key`, never rendered; `resolvedBy` is typed but never displayed) Confirm no isolation key (`companyId`, `driverId`, …) is rendered anywhere in the new dashboard UI — inherited discipline from feature 009's T120, not a requirement of this spec
- [X] T059 [P] Confirm the driver's raw coordinates are never shown to a `CLIENT` on any surface, and that `stopEvents` is absent from the client-scoped order shape — the privacy boundary data-model.md's closing note names. **Done as a test, not an inspection** (`stop-reason.e2e-spec.ts`, "never shows a CLIENT the stop trail, on detail or on their own list"): asserted on the detail endpoint *and* the client's own list, because spec 008's leak was precisely a strip applied at one endpoint and silently missing at the other — and asserted in the positive direction too, that the transporter does see it
- [X] T060 Run the full backend suites — `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand`. **Result**: unit **152/152 across 19 suites**, green. E2e **267/267 tests passing across 53 suites — every test green**, but 3 suites are *reported* as failed because their `afterAll` `ctx.close()` exceeded its 30 s budget. No test failed; the failure is entirely in teardown. All 3 pass in isolation (verified), a different set fails on each run, and a timing probe measured `ctx.close()` at **538 ms** on a clean boot — so this is accumulated resource pressure across 53 sequential `MongoMemoryReplSet` + Redis-backed apps in one `--runInBand` process, not a defect in any suite. Disclosed rather than papered over by raising the timeouts: the real fix is a shared teardown budget in `test-app.factory.ts`, which is a test-infrastructure change outside this feature
- [X] T061 Run `npx tsc -b --force` and `npx vitest run` in `web_dashboard/`, and `flutter test` in `mobile_app/`. **Result**: `vitest run` 49 passing with the same 2 pre-existing suites that fail to *load*; `flutter test` 418 passing with the two documented pre-existing non-green tests. `tsc -b --force` reports 30 files with unused-import errors — **all pre-existing and none touched by this feature** (see the US4 corrections above); not fixed here
- [ ] T062 Run the `quickstart.md` walkthrough end to end on **a real device or simulator with mock location** — steps 2-6 cannot be verified any other way, since the whole point is that the alert reaches a backgrounded, locked app (SC-006, SC-010)
- [X] T063 Update `ciro_fuel/CLAUDE.md` to record feature 011 as implemented, with its binding decisions and any corrections found during implementation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — T001-T006 all parallel
- **Foundational (Phase 2)**: needs Phase 1's enums and config; **blocks all user stories**
- **US1 (Phase 3)**: depends only on Phase 2 — the MVP
- **US2 (Phase 4)**: depends on Phase 2; its declare-stop half is independent of US1, but the
  answer-a-prompt half needs US1's detection to have something to answer
- **US3 (Phase 5)**: depends on US1 raising stops — there is nothing to escalate otherwise
- **US4 (Phase 6)**: depends on Phase 2 for the fields; independently testable against seeded stop
  events without US1-US3 running
- **Polish (Phase 7)**: after the stories it verifies

### Critical constraints

- **T011 measures against `lastMovedLocation`, never `location`** — getting this wrong makes a parked
  truck read as moving, silently disabling the whole feature while every test that checks a *moving*
  driver still passes
- **T019 must use a conditional update**, not read-then-write — the same class of concurrency bug
  feature 009 found the hard way (research R6)
- **T024's Android notification channel is not optional** — a notification posted without one is
  silently dropped on modern Android, which reviews clean and fails in the field
- **T036 must treat a post-escalation answer as success**, not an error (FR-010)
- **T048 schedules after the raising write commits**, never inside it

### Parallel Opportunities

- All of Phase 1 (T001-T006)
- US1 tests: T013, T016 and T017 are three different files and run in parallel; **T014 and T015
  share T013's file** and follow it
- US2 tests: T029, T032 and T033 are parallel; **T030 and T031 follow T029**, same file
- US3 tests: T043 and T045 are parallel; **T044 follows T043**, same file
- The mobile seam (T022-T026) and the backend sweep (T018-T021) are different codebases entirely and
  can proceed simultaneously once Phase 2 lands
- US4 is a different surface again and can run alongside US1-US3 by a different person

---

## Implementation Strategy

### MVP (User Story 1 only)

Phase 1 → Phase 2 → Phase 3, then stop and validate: a stalled delivery is detected and the driver
is genuinely asked about it on a backgrounded phone. This alone is the capability feature 009 had to
delete its alert card for, and it is the half most likely to reveal platform surprises (the
notification channel, the iOS authorization, the background socket) — worth landing and testing
before building the answer flows on top of it.

### Incremental delivery

1. Setup + Foundational → vocabulary, schema, movement bookkeeping
2. + US1 → stalls detected, driver reachable (**MVP**)
3. + US2 → the driver's answer reaches the transporter; predictable stops declarable in advance
4. + US3 → silence escalates automatically — the safety net
5. + US4 → the administrator's view of it all

### Notes

- US1, US2 and US3 are all P1 but are **not** independent of each other in the way features 009/010's
  stories were: US3 escalates stops US1 raises, and US2's prompt-answering needs a prompt to answer.
  US2's declare-stop half and US4 are the genuinely independent pieces. Sequencing US1 → US2 → US3
  is the honest order; parallelism here is across *surfaces*, not across stories.
- Tests are mandatory (constitution), not the template's optional case — write them first within
  each story phase.

### Test-infrastructure findings (not spec 011 defects)

- **`warehouse-loading.e2e-spec.ts` had a ~14%-flaky assertion, fixed.** `expect(JSON.stringify(order))
  .not.toContain('950')` matched any ISO timestamp whose milliseconds contained `950` — with a dozen
  timestamps in the serialised order, that fires often. Replaced with `numericValuesIn(order)` so the
  assertion is about the rejected *quantity*, which is what FR-028a is actually about, rather than
  about its digits appearing somewhere in a date.
- **The e2e suite's teardown budget is too tight in aggregate** — see T060. Left as-is and disclosed.

### Corrections found while implementing US4

- **T055's premise was wrong, and the real gap was worse.** The task said to apply the stale
  treatment to `MapCard.tsx` because "a silent device currently reads there as a live position
  frozen in place". `MapCard` renders the *destination*, not the driver — it never shows a position
  at all. The frozen-position bug is in `TrackingMapCard.tsx`, whose `isStale` check was gated on
  `position.status === 'live'`: it covered a socket that had been delivering and went quiet, and
  missed the case that matters most — a socket that never delivered anything, where the map falls
  back to the order's own seeded `driverLocation` and drew it **completely unmarked**. A truck whose
  driver's phone died and a truck parked at that spot rendered identically. Fixed there instead.
- **That fix needed a platform addition the plan had not identified**: `driverLocationAt` on
  `GET /orders/:id` (from `EtaService.driverTelemetry`, reading the driver's existing
  `locationUpdatedAt`). FR-017a requires stating *how old* a position is, and the seeded fix
  previously travelled with no timestamp at all — so the requirement was unimplementable as
  specified, not merely unimplemented.
- **`StopAlertCard` deliberately omits two elements of the deleted mock** — "remaining distance" and
  a street-name location — because neither has a data source, following the `MapTrackingCard`
  legend precedent from feature 009. The stop's coordinates are on the event and go to the map.
- **The four states are derived from three nullable timestamps, and the check order is the
  behaviour.** `declared` must be tested before `resolved`, because a declaration is created
  already-resolved — the naive `resolvedAt`-first ordering renders a driver's volunteered stop as
  "handled" and loses FR-008c's required distinction. Pinned by T050.
- **Dashboard `tsc -b --force` is not clean, and was not clean before this feature.** 30 files carry
  `TS6133`/`TS6192` unused-import errors, none of them touched by spec 011 (they are fallout from
  feature 009's deletions in `admin/`, `petrol_company/`, `components/ui/` and `app/router.tsx`).
  CLAUDE.md's claim that feature 009 left it clean no longer holds. Not fixed here — 30 unrelated
  files is a separate cleanup, and doing it inside this feature would bury the diff.
- **Dashboard test baseline**: `vitest run` is 49 passed, with the same 2 pre-existing suites failing
  to *load* (`accessibility.test.tsx`, `orders.mutations.test.tsx` — both import `@/features/*`
  paths feature 009 deleted). Unchanged by this feature.

### Corrections found while implementing US3

- **The processor escalated twice for one stop (SC-008 violation), found by T043.** It guarded only
  on `reasonGivenAt`/`resolvedAt`, so a redelivered job — BullMQ is at-least-once, so this happens
  eventually — alerted the transport admin a second time about the same silence. Fixed by folding
  `escalatedAt: null` into the *same conditional write* that stamps it, so `modifiedCount` decides
  which delivery of the job gets to notify. Guarding it with a prior read would have left the same
  race between two concurrent deliveries.
- **T049's cancel-on-cancellation is unreachable, and kept anyway.** `ADMIN_CANCELLABLE` stops at
  `LOADING`, so an `IN_TRANSIT` delivery cannot be cancelled — and `IN_TRANSIT` is the only status a
  stop can exist in. The e2e test therefore covers the two paths that *are* reachable from in-transit
  (normal completion via the OTP chain, and force-complete); the call in `cancel()` stays as a
  one-line no-op backstop with a comment saying so, since a future widening of that list would
  otherwise leave a cancelled delivery still alerting its transporter.

### Corrections found while implementing US2

- **A declared stop is created already *resolved*, not merely already answered.** The artifacts said
  "already-answered" and left `resolvedAt` to the answering/administrator paths, which reads fine
  until its suppression window lapses: the sweep is then required to raise a *new* `DETECTED` event
  (data-model.md's state diagram), and the delivery would carry two events with `resolvedAt == null`
  — breaking FR-016's stated invariant. Suppression is therefore carried by `suppressedUntil` alone,
  and the sweep's guard has two clauses rather than one. Both live in a single shared
  `unblockedStopFilter` used by the sweep and the declare path, since a disagreement between the two
  is precisely how two open stops would appear. data-model.md and rest-api-delta.md updated.
- **Three new error codes**, not in the contract as written: `STOP_ALREADY_OPEN`,
  `STOP_ALREADY_ANSWERED`, `STOP_NOT_IN_TRANSIT`. The contract specified the statuses (409/409/409)
  but not how the app tells them apart, and three same-status refusals distinguishable only by
  message text is what this platform's `ErrorCode` envelope exists to prevent.
- **`NotificationType`'s parity test caught a real omission.** `test/unit/notification_type_test.dart`
  pins the Flutter enum against a hand-maintained copy of the backend's wire values; adding
  `DRIVER_STOP_DETECTED` to both enums without adding it there failed the inverse check ("this app
  enum has no backend counterpart"). Working exactly as spec 007 intended.
- **T017 landed in `delivery_listener_test.dart`**, not the new `stop_notification_test.dart` the
  task named — see that task's own note.
- **T028 was deferred within US1 and completed here**, since the alert tap had no destination until
  T039 existed.
