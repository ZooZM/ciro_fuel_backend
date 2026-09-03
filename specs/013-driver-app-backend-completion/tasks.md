---
description: "Task list for feature 013 — Driver App Backend Completion & Cross-Device Delivery Continuity"
---

# Tasks: Driver App Backend Completion & Cross-Device Delivery Continuity

**Input**: Design documents from `/specs/013-driver-app-backend-completion/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **REQUIRED.** Constitution §"Development Workflow & Quality Gates" — guarantees the spec
marks as testable MUST have automated tests before the capability is considered done. Three of this
feature's guarantees (displacement enforcement, the outstanding-stop derivation, detection-not-suppressed)
are invisible when wrong, so their tests are the deliverable, not a follow-up.

**Organization**: Grouped by user story. Three repository roots:
`ciro_fuel/` (backend) · `mobile_app/` (Flutter) · `web_dashboard/` (React).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)

---

## Phase 1: Setup — capture the baselines

**Purpose**: Every one of the three roots has known non-green items. This repo's own history records a
baseline count being trusted and being wrong. Capture, do not assume.

- [X] T001 [P] Record backend baseline in `specs/013-driver-app-backend-completion/tasks.md` Notes: run `npm run lint:check`, `npm run build`, `npm run test`, `npm run test:e2e` from `ciro_fuel/` and write down suite and test counts
- [X] T002 [P] Record mobile baseline: run `flutter test` from `mobile_app/` and confirm **exactly two** non-green tests (`test/golden/login_screen_golden_test.dart` pixel diff, `test/integration/auth_session_test.dart` `skip: true`) — if there is a third, identify it before starting
- [X] T003 [P] Record dashboard baseline: run `tsc -b --force` and `vitest run` from `web_dashboard/`, noting the pre-existing `TS6133`/`TS6192` file set and the two suites that fail to load (`accessibility.test.tsx`, `orders.mutations.test.tsx`)

**Checkpoint**: Three baselines written down. Any later deviation is attributable.

---

## Phase 2: Foundational — the socket handler registry (Slice 0)

**Purpose**: `TrackingSocket`'s every `on*` is `_socket?.on(...)`, so a handler registered before
`connect()` resolves subscribes to nothing, silently. This is why no notification push has ever reached
either persona (research R1).

**⚠️ CRITICAL — this phase lands ALONE, in its own commit, with both personas' suites green.** It touches
the CLIENT persona, which the rest of the feature is scoped away from (FR-042), and Story 3 is built
differently before and after it. Do not begin any user story until it is merged.

- [X] T004 Add a `List<(String, Function)>` handler registry to `mobile_app/lib/core/realtime/tracking_socket.dart`; rewrite every `on*` method (`onLocation`, `onStatus`, `onOtp`, `onNotification`, `onSessionRevoked`, `onConnect`, `onConnectError`) to record into it and attach immediately only when `_socket != null`
- [X] T005 Make `connect()` in `mobile_app/lib/core/realtime/tracking_socket.dart` attach the whole registry to the `io.Socket` it creates, and `dispose()` clear both socket and registry
- [X] T006 [P] Write `mobile_app/test/unit/tracking_socket_registry_test.dart`: a handler registered **before** `connect()` fires after it — this is the exact case that silently no-ops today
- [X] T007 [P] Extend `mobile_app/test/unit/tracking_socket_registry_test.dart` with a `connect()` → `dispose()` → `connect()` cycle proving handlers survive, since `connect()` builds a **new** socket each call while `reauthenticate()` reuses one
- [X] T008 Run `flutter test` from `mobile_app/` and confirm the count matches T002 exactly — still two non-green, no third
- [ ] T009 ⏳ NEEDS LIVE BACKEND + two open apps — deferred to a live-env pass. Walk `quickstart.md` Part 0 against a running backend for **both** personas: an assignment notification reaches an open driver app, and a client notification reaches an open client app, within 5 s and with no refresh (SC-008, SC-014)

> **Do NOT delete `SessionRevocationListener` or `DeliveryListener` in this phase.** They exist because
> of this defect, but they remain correct, their comments are the record of why the pattern existed, and
> removing them mixes a refactor into the one commit that must stay attributable.

**Checkpoint**: Pushes are delivered for both personas. Foundation ready.

---

## Phase 3: User Story 1 — Continue a delivery on a replacement device (Priority: P1) 🎯 MVP

**Goal**: An in-flight delivery, including any unanswered stop question, is fully resumable on a
replacement device.

**Independent Test**: Take a delivery to a mid-journey stage on device A; sign in on device B; the
delivery is present at the same stage, no completed step is repeated, and an outstanding stop question
raised while A held it is visible and answerable on B.

### Tests for User Story 1

- [X] T010 [P] [US1] Write `mobile_app/test/unit/stop_event_parsing_test.dart`: a driver's order payload with `stopEvents` parses every field; **and an order payload with no `stopEvents` key at all parses cleanly** — the CLIENT's response omits it entirely and both personas share one entity
- [X] T011 [P] [US1] Write `mobile_app/test/unit/outstanding_stop_test.dart`: `outstandingStop` is null for a DECLARED stop, null for an answered stop (`reasonGivenAt` set), null for a resolved stop (`resolvedAt` set), and non-null only for one with both absent
- [X] T012 [P] [US1] Write `mobile_app/test/delivery_untracked_indicator_test.dart`: `DeliveryState.active(order, streaming: false)` renders the untracked state; `streaming: true` does not
- [X] T013 [P] [US1] Write `ciro_fuel/test/e2e/driver-stop-visibility.e2e-spec.ts`: `GET /orders/:id` as the assigned DRIVER returns `stopEvents`; as the CLIENT it does not (asserting the existing privacy boundary is not disturbed)
- [X] T014 [P] [US1] Write `ciro_fuel/test/e2e/delivery-continuity.e2e-spec.ts`: after a departure verification and a loading confirmation, a fresh authenticated read of the order returns the same stage and the same `verifications`/`tankSummary`/`warehouseSummary` — nothing is device-held
- [X] T014a [US1] Extend `delivery-continuity.e2e-spec.ts` for **FR-004**: an OTP issued to the customer while the first session held the order still verifies after that session is displaced and a new one signs in — and no second OTP was issued. Was covered only by the manual walkthrough (analysis N4)
- [X] T014b [US1] Extend `delivery-continuity.e2e-spec.ts` for **FR-010**: after displacement, the new session's **first** accepted fix at the truck's existing position does **not** advance `lastMovedAt` — whether the truck moved is a property of the truck, not of the handset. The baseline is `lastMovedLocation`, which is per-driver and survives the switch; a per-session baseline would silently mark a parked truck as moving (analysis N4)
- [X] T014c [US1] Extend `delivery-continuity.e2e-spec.ts` for the rest of **FR-013**: `quantityLiters`, `fuelType`, `clientSummary`, `driverSummary` and `deliveryLocation` are identical across a real device switch (a second sign-in, not a re-read on the same token). T014 asserted only the three *stage-defining* facts; quantity and fuel grade are the two a driver acts on most directly at the depot, where a stale handset cache loads the wrong product (analysis G3)
- [X] T014d [US1] Extend `delivery-continuity.e2e-spec.ts` for **FR-012**: across the device-change gap the client's `GET /orders/:id` still returns `driverLocation` **and** `driverLocationAt`, and the age advances once the replacement device reports. Without the timestamp the customer's map has no input to spec 011 FR-017a's staleness treatment and a frozen dot renders identically to a live one — a response that dropped the field would still draw a truck, which is why this is asserted rather than trusted. FR-012 previously had **zero** coverage outside the deferred manual walkthrough (analysis G1)

### Implementation for User Story 1

- [X] T015 [P] [US1] Create `mobile_app/lib/shared/enums/stop_origin.dart` with `detected`/`declared`/`blocked` and `fromWire`/`toWire` in that one file (no-magic-values rule)
- [X] T016 [US1] Create `mobile_app/lib/shared/entities/stop_event.dart` (freezed + json_serializable) per data-model §4 — keep `reasonGivenAt` and `resolvedAt` nullable, since absence is what "unanswered" and "unresolved" mean
- [X] T017 [US1] Add `@Default(<StopEvent>[]) List<StopEvent> stopEvents` to `mobile_app/lib/shared/entities/order.dart`; the default is what stops every CLIENT order failing to parse
- [X] T018 [US1] Run `dart run build_runner build` in `mobile_app/` and commit the regenerated `*.freezed.dart` / `*.g.dart` (depends on T015–T017)
- [X] T019 [US1] Add the `outstandingStop` derivation (`resolvedAt == null && reasonGivenAt == null`, first match) to `mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart` or the `Order` extension it reads — mirroring the platform's `unblockedStopFilter` rather than approximating it
- [X] T020 [US1] Render the outstanding stop question in `mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, opening the existing `showStopReasonSheet(context, orderId:, stopId:)` — a second entry point to the same sheet, never a second sheet
- [X] T021 [US1] Render `DeliveryActive.streaming == false` in `mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart` as an explicit "this delivery is not being tracked" state with what to do about it (FR-011) — the field has been computed and read by nothing since spec 007
- [X] T022 [P] [US1] Add the translation keys for the outstanding-stop prompt and the untracked state to `mobile_app/lib/core/localization/translation_keys.dart` and both locale files under `mobile_app/assets/translations/`
- [X] T023 [US1] Reload the delivery after a stop reason is submitted so the question clears without a manual refresh, in `mobile_app/lib/features/delivery/presentation/cubit/delivery_cubit.dart`

**Checkpoint**: A stop question is answerable on a device that never received the alert. US1 complete
and independently testable.

---

## Phase 4: User Story 2 — The replaced device stops speaking for the driver (Priority: P2)

**Goal**: A displaced device cannot report a truck's position or act on a delivery, enforced by the
platform rather than by the device's cooperation. **Backend only** — no client change.

**Independent Test**: With a delivery in progress on device A, sign in on device B, then have A report a
position **from a different location** over its existing connection; the truck's recorded position and
`lastMovedAt` are both unchanged.

### Tests for User Story 2

> **The trap (research R12).** A test where the displaced device reports the *same* position proves
> nothing — the displacement threshold rejects that frame regardless, so the test passes whether or not
> the enforcement exists. This is the same shape as spec 012's Redis adapter, silently dead while 53
> suites passed. Every task below that says "different location" means it literally.

- [X] T024 [P] [US2] Write `ciro_fuel/test/e2e/session-displacement.e2e-spec.ts`: driver connects, reports a position, signs in again (displacing), then reports **from a materially different location** over the first connection — assert the ack is `{ ok: false, error: 'SESSION_REVOKED' }`
- [X] T025 [US2] Extend `session-displacement.e2e-spec.ts`: after the refused frame, the driver's `location` and `locationUpdatedAt` are unchanged from before it
- [X] T026 [US2] Extend `session-displacement.e2e-spec.ts`: `lastMovedAt` and `lastMovedLocation` did not advance — a refused frame must not feed spec 011's movement bookkeeping (FR-016)
- [X] T027 [US2] Extend `session-displacement.e2e-spec.ts`: `isOnline`/`lastSeenAt` were not touched by the refused frame — proving the presence-touch reordering actually landed
- [X] T028 [P] [US2] Write `ciro_fuel/test/e2e/session-displacement-rest.e2e-spec.ts`: a delivery action over REST from the displaced token is refused with the structured `SESSION_REVOKED` shape and its `cause`. **This asserts existing behaviour** — `validateActiveSessionWithScoping` already does this; FR-015 needs a test, not an implementation (research R11)
- [X] T029 [P] [US2] Add to `session-displacement.e2e-spec.ts` a handshake-refusal case: a displaced device reconnecting is rejected with `UNAUTHORIZED` (FR-018, spec 006 behaviour — assert it still holds)
- [X] T030 [P] [US2] Add to `ciro_fuel/test/e2e/multi-instance.e2e-spec.ts` a case proving the displacement disconnect reaches a socket connected to a **different instance** — the Redis adapter is the only thing that makes this work, and it is exactly the capability spec 012 found silently dead
- [X] T031 [P] [US2] Write a session-audit assertion in `session-displacement.e2e-spec.ts`: displacement produces a `REVOKED` row with cause `SIGNED_IN_ELSEWHERE` and a `SIGNED_IN` row, in the same transaction (FR-021 — **assert existing behaviour**, add no new audit machinery)
- [X] T031a [P] [US2] Write the **FR-020** order-independence case in `session-displacement.e2e-spec.ts`: with both sessions' sockets open, interleave frames from the displaced and the current session — including the displaced one arriving **last** — and assert the truck's recorded position is always the current session's. Every other US2 test displaces then reports, which cannot distinguish "the older generation is refused" from "the most recent frame wins"; FR-020 had **zero coverage** before this task (analysis N3)

### Implementation for User Story 2

- [X] T032 [P] [US2] Add `sgen?: number` to `AuthenticatedUser` in `ciro_fuel/src/common/interfaces/jwt-payload.interface.ts`, documenting that absent normalises to `0` so pre-spec-006 tokens stay valid
- [X] T033 [US2] Stamp the verified payload's `sgen` onto the returned `AuthenticatedUser` in `authenticateSocket` in `ciro_fuel/src/common/guards/ws-jwt.guard.ts` — from the **handshake token**, never re-read from the account, or the guard compares the account to itself and is silently inert
- [X] T034 [US2] Reorder `locationUpdate` in `ciro_fuel/src/modules/tracking/tracking.gateway.ts` so the `userModel.findById` runs **before** `presenceService.touch()` — a displaced device must not keep a dead handset marked `isOnline`
- [X] T035 [US2] Add the generation comparison in `locationUpdate` immediately after the driver loads: `(client.data.user.sgen ?? 0) !== (driver.sessionGeneration ?? 0)` returns `{ ok: false, error: 'SESSION_REVOKED' }` before presence, gating or any write. **Zero added I/O — the document is already in hand** (research R2); do not introduce a Redis-cached generation
- [X] T036 [US2] Add `disconnectUser(userId)` to `ciro_fuel/src/common/realtime/realtime-gateway.service.ts`, disconnecting every socket in `user:{userId}` — reaching other instances through the Redis adapter, exactly as `emitToUser` already does
- [X] T037 [US2] Call `disconnectUser` from `AuthService.login` in `ciro_fuel/src/modules/auth/auth.service.ts`, **after** the generation bump commits and alongside the existing `session:revoked` emit, matching that emit's existing ordering comment
- [X] T038 [US2] Guard `disconnectUser` so a Redis-adapter failure logs and degrades rather than throwing — spec 012 Clarification Q7 requires these dependencies to degrade, never to break a sign-in, and §1's per-frame check is the guarantee that survives it

**Checkpoint**: A displaced device is refused at the socket, refused at REST, and disconnected. US2
complete.

---

## Phase 5: User Story 3 — A real notification centre for the driver (Priority: P2)

**Goal**: The driver's notifications tab shows what the platform actually sent, with real read state,
live arrival and a working mark-all-read.

**Depends on Phase 2** (pushes must be delivered for FR-028 to be verifiable at all).

**Independent Test**: Send a driver several notifications, open the tab, confirm content, read state,
the All/Unread filter, live arrival, and that mark-all-read empties the badge.

### Tests for User Story 3

- [X] T039 [P] [US3] Write `ciro_fuel/test/e2e/notifications-read-all.e2e-spec.ts`: marks only the caller's unread notifications, returns the count, is idempotent on a second call (`updated: 0`), and cannot be aimed at another user
- [X] T040 [P] [US3] Write `mobile_app/test/driver_notifications_screen_test.dart`: the screen renders from `NotificationsCubit`, shows distinct loading / empty / failure states, and **no fabricated row appears anywhere in the widget tree**. Also assert newest-first ordering (FR-023), that unread rows are visually distinguished from read ones (FR-023), and that the failure state's retry actually re-issues the load (FR-024) — all three were implied rather than asserted (analysis N6)
- [X] T041 [P] [US3] Extend `driver_notifications_screen_test.dart`: a notification of an unrecognised type renders neutrally rather than blank or dropped (FR-031)
- [X] T042 [P] [US3] Extend `driver_notifications_screen_test.dart`: the All/Unread filter partitions correctly, and the screen offers **no** category tabs

### Implementation for User Story 3

- [X] T043 [P] [US3] Add `markAllRead` to `ciro_fuel/src/modules/notifications/notifications.service.ts` as one `updateMany` on `{ recipientUserId, readAt: null }` — idempotent by construction, no transaction needed
- [X] T044 [US3] Add `PATCH /notifications/read-all` to `ciro_fuel/src/modules/notifications/notifications.controller.ts` returning `{ updated }`, with the recipient taken from `@CurrentUser()` and **never** from the request
- [X] T045 [P] [US3] Add `markAllRead()` to `mobile_app/lib/features/notifications/domain/repositories/notifications_repository.dart` and its `data/` implementation and datasource
- [X] T046 [US3] Add a `MarkAllNotificationsRead` use case in `mobile_app/lib/features/notifications/domain/usecases/` and register it in `mobile_app/lib/core/di/injector.dart`
- [X] T047 [US3] Add `markAllRead()` to `mobile_app/lib/features/notifications/presentation/cubit/notifications_cubit.dart`, updating the loaded state's items and `unreadCount` so the list and badge cannot disagree (FR-026)
- [X] T048 [US3] Rewrite `mobile_app/lib/features/delivery/presentation/view/driver_notifications_screen.dart` against the app-wide `NotificationsCubit`, using the client's `notifications_screen.dart` as the structural reference — same cubit, driver styling, **no second notifications stack** (debt #2)
- [X] T049 [US3] Delete the three category tabs and wire the **All / Unread** filter (`?unread=true`) instead, following the client screen's already-shipped precedent (research R7/R7a)
- [X] T050 [US3] Call `loadMore()` on scroll in `driver_notifications_screen.dart` — cursor pagination already exists on the cubit, so FR-032 is a call site, not a capability
- [X] T051 [US3] Wire the "mark all read" control to `markAllRead()`; a press with nothing unread changes nothing and shows no error
- [X] T052 [US3] Open the related delivery on tap, via `AppRoutes.driverOrderDetail(orderId)`, handling a notification whose order the driver no longer holds without an error screen (FR-030)
- [X] T053 [P] [US3] Delete the mock translation keys (`driver_notifications.tab_all`, `tab_orders`, `tab_system`, the sample titles/descriptions/times) from `mobile_app/lib/core/localization/translation_keys.dart` and both locale files, so nothing can re-adopt them

**Checkpoint**: The driver's notification centre is real. US3 complete.

---

## Phase 6: User Story 5a — The blocked-driver report (Priority: P3)

**Goal**: A driver who cannot reach the destination reports it with a reason, the transporter is told
immediately, and stop detection stays armed.

**Depends on Phase 3** (US1 supplies the mobile stop plumbing this renders through).

**Independent Test**: File a report from the driver app; the transport admin sees it distinctly on the
dashboard within a minute; leave the truck parked past the detection window and confirm detection still
fires.

### Tests for User Story 5a

- [X] T054 [P] [US5] Write `ciro_fuel/test/e2e/driver-blocked-report.e2e-spec.ts`: the endpoint appends a `BLOCKED` stop with `reasonGivenAt` and `escalatedAt` set, `resolvedAt` null and **`suppressedUntil` absent** (data-model §1)
- [X] T055 [US5] Extend `driver-blocked-report.e2e-spec.ts`: the transport company's admins receive `ORDER_DRIVER_BLOCKED` immediately — no response window elapses first (FR-039a)
- [X] T056 [US5] Extend `driver-blocked-report.e2e-spec.ts`: **detection is not suppressed** — this is the test that would have caught filing the report as a declaration, which would have told nobody *and* switched detection off (research R5, FR-039b)
- [X] T057 [US5] Extend `driver-blocked-report.e2e-spec.ts`: a second report while a stop is already open returns `409 STOP_ALREADY_OPEN` and does not create a second open stop; a report on a non-`IN_TRANSIT` order is refused; another driver's order is `404`, never `403`
- [X] T058 [US5] Extend `driver-blocked-report.e2e-spec.ts`: the existing `PATCH /orders/:id/stops/:stopId/resolve` closes a `BLOCKED` stop for a `TRANSPORT_COMPANY_ADMIN` and no other role
- [X] T059 [P] [US5] Extend `mobile_app/test/unit/notification_type_test.dart` for the new wire value — the spec 007 parity guard; adding the value backend-side without adding it in Dart must fail this test
- [X] T060 [P] [US5] Write a rendering test for the third origin in `web_dashboard/src/transport_company/orders/components/order-details/` asserting it shows the driver's reason and does **not** show the awaiting-answer treatment

### Implementation for User Story 5a

- [X] T061 [P] [US5] Add `BLOCKED` to `ciro_fuel/src/common/enums/stop-origin.enum.ts` with a comment stating it is unresolved-and-escalated, unlike `DECLARED`
- [X] T062 [P] [US5] Add `ORDER_DRIVER_BLOCKED` to `ciro_fuel/src/common/enums/notification-type.enum.ts`, addressed to the transport company's admins — deliberately not `ORDER_STOP_UNRESOLVED`, which means "asked and said nothing"
- [X] T063 [US5] Add `reportBlocked()` to `ciro_fuel/src/modules/stop-detection/stop-detection.service.ts` as one conditional write, following `declareStop`'s shape so a report racing the sweep cannot leave two open stops (Constitution V)
- [X] T064 [US5] Notify the transport company's admins inside `reportBlocked()`, reusing `StopEscalationProcessor`'s own `companyId: order.transportCompanyId` lookup; enqueue **no** escalation job
- [X] T065 [P] [US5] Add `ReportBlockedDto` to `ciro_fuel/src/modules/orders/dto/` — `reason` required, `reasonText` required only when `reason` is `OTHER`, mirroring the existing reason DTO's rule
- [X] T066 [US5] Add `POST /orders/:id/stops/blocked` to `ciro_fuel/src/modules/orders/orders.controller.ts`, `@Roles(UserRole.DRIVER)`, returning `this.toRoleScopedShape(order, user)` like the sibling stop endpoints
- [X] T067 [P] [US5] Add `blocked` to `mobile_app/lib/shared/enums/stop_origin.dart` and the new type to `mobile_app/lib/shared/enums/notification_type.dart`
- [X] T068 [US5] Add `reportBlocked` to the delivery repository, datasource and a `ReportBlocked` use case under `mobile_app/lib/features/delivery/`, registered in `injector.dart` — never a datasource call from a widget (Constitution IV)
- [X] T069 [US5] Replace `onPressed: () {}` on the "I cannot reach" button in `mobile_app/lib/features/delivery/presentation/widgets/driver_navigation_bottom_sheet.dart` with a reason picker offering the applicable `StopReason` subset (`ROAD_CLOSURE`, `ACCIDENT`, `VEHICLE_PROBLEM`, `OTHER`) followed by the use case
- [X] T070 [US5] Render a `409 STOP_ALREADY_OPEN` as a stated message rather than a failure screen, in the same widget
- [X] T071 [P] [US5] Add the report's translation keys to `mobile_app/lib/core/localization/translation_keys.dart` and both locale files
- [X] T072 [P] [US5] Add `BLOCKED` to `web_dashboard/src/constants/stop-events.ts` — without it the report renders as a missing translation key beside a real stop, which is the failure that file's own header comment warns about (research R10)
- [X] T073 [US5] Add the third presentation branch to `web_dashboard/src/transport_company/orders/components/order-details/StopAlertCard.tsx` per `contracts/dashboard-integration.md` §2
- [X] T074 [P] [US5] Add the new origin's translation key to both dashboard locales, Arabic included — it is the default

**Checkpoint**: A blocked driver reaches the transporter, and detection stays armed. US5a complete.

---

## Phase 7: User Story 4 + User Story 5b — Identity and dead controls (Priority: P3)

**Goal**: Every driver surface shows the signed-in driver, and no control on a driver screen is inert.

**Independent Test**: Sign in as two drivers in turn on one device — neither sees the other's details;
then press every control on every driver screen and confirm each produces an observable effect.

### Tests

- [X] T075 [P] [US4] Write `mobile_app/test/driver_profile_identity_test.dart`: the account screen renders the loaded driver's own name; loading and failure render stated states; **no placeholder identity appears in any state**
- [X] T076 [P] [US4] Extend `driver_profile_identity_test.dart`: after a sign-out and a second driver's sign-in, none of the first driver's details are present (FR-036)
- [X] T077 [P] [US5] Write a sweep test asserting no `onPressed: () {}` / `onTap: () {}` remains under `mobile_app/lib/features/delivery/presentation/` and `mobile_app/lib/features/profile/presentation/view/driver_*.dart`

### Implementation

- [X] T078 [US4] Replace the mock profile card in `mobile_app/lib/features/profile/presentation/view/driver_profile_screen.dart` with `getIt<ProfileCubit>(param1: userId)..load()`, exactly as `driver_profile_details_screen.dart` already does — and remove the station line entirely, a CLIENT concept a driver does not have
- [X] T079 [US4] Render `ProfileCubit`'s loading and failure states on that screen rather than any fallback identity (FR-035)
- [X] T080 [P] [US4] Delete `driver_mock_profile.driver_name_mohamed` and `driver_mock_profile.station_alhamd` from `mobile_app/lib/core/localization/translation_keys.dart` and both locale files
- [X] T081 [P] [US4] Replace the inert about entry (`onTap: () {}`) in `driver_profile_screen.dart` with the real running app version
- [X] T082 [P] [US4] Resolve the `// TODO: Update to driver terms` on the terms entry in `driver_profile_screen.dart` — point it at driver-addressed terms
- [X] T083 [P] [US5] Remove the inert `_MapButton` controls from `mobile_app/lib/features/delivery/presentation/view/driver_navigation_screen.dart` and stop the fixed image presenting as a live map (FR-041); the maps-app handoff stays as the design (FR-041a)
- [X] T084 [P] [US5] Wire `SupportCallButton(onTap: () {})` in `mobile_app/lib/features/support/presentation/view/support_screen.dart` to `PhoneDialer` — **shared screen**, so verify the client's own support screen too

**Checkpoint**: All stories complete.

---

## Phase 8: Polish & Cross-Cutting

- [X] T085 Run `npm run lint:check`, `npm run build`, `npm run test`, `npm run test:e2e` in `ciro_fuel/` and compare against T001 — **re-run 2026-09-03 after T014c/T014d: 67/68 suites, 361/366 tests** (T001's 341/346 + the feature's own additions + these two), with the same 5 reds, all in the pre-existing `request-logging.e2e-spec.ts`
- [X] T086 Run `flutter test` in `mobile_app/` and confirm **exactly two** non-green tests, matching T002 — a third is a regression from this feature. **Re-run 2026-09-03 after the biometric platform fix: 447 passed, 1 skipped, 1 failed** — still exactly the two documented non-green (`login_screen_golden_test` pixel diff, `auth_session_test` `skip: true`), no third
- [X] T087 Run `tsc -b --force` and `vitest run` in `web_dashboard/` and confirm the pre-existing error set has not grown (T003); do **not** fix unrelated `TS6133` files here — that would bury this diff
- [ ] T088 ⏳ NEEDS LIVE BACKEND — deferred. Walk `quickstart.md` Parts 1, 2, 4 and 5 against a running backend on one device
- [ ] T089 ⏳ NEEDS TWO REAL DEVICES + LIVE BACKEND — deferred. Walk `quickstart.md` Part 3 with **two real devices** — 3a resume, 3b the surviving stop question, 3c the displaced device carried to a **different location**, 3d the parked-truck edge case. This is the only way the feature's headline claim can be observed; no suite substitutes for it. **Time 3a** from picking up the replacement to seeing the delivery at its correct stage, and record it against SC-002's 2-minute target — otherwise that number is unmeasured (analysis N5)
- [X] T090 [P] Record the outcome in `quickstart.md`'s Results section, including anything that behaved differently
- [X] T091 [P] Update `mobile_app/CLAUDE.md`: retire debt #6 (the socket now flushes queued handlers), and update debt #7 to note the driver-side notification mock is closed while the client's `OrderDetailScreen(mockState:)` remains
- [X] T092 [P] Update `ciro_fuel/CLAUDE.md`'s active-feature block with the implementation status and any corrections found while building
- [X] T093 [P] Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` with the two new endpoints, keeping the canonical contract true to the platform

---

## Dependencies & Execution Order

### Hard dependencies — only three

1. **Phase 2 (Slice 0) blocks Phase 5 (US3).** Without the registry fix, FR-028's live arrival cannot be
   verified, and the screen would be built against the external-listener workaround and then rewritten.
2. **Phase 3 (US1) blocks Phase 6 (US5a).** The blocked report renders through the mobile stop plumbing
   US1 introduces (`StopEvent`, `StopOrigin`, `Order.stopEvents`).
3. **T018 (`build_runner`) blocks everything downstream of it in US1.**

Everything else is independent. In particular **US1 and US2 have no dependency in either direction** —
US2 is backend-only and US1 is almost entirely mobile.

> **Refinement of plan.md's slice table.** `research.md` R12 lists US2 as Slice 1 and US1 as Slice 2.
> That was a sequencing preference (backend-only work is easy to isolate), **not** a dependency. These
> phases order by spec priority instead, so the P1 story is the MVP. Either order works; what does not
> work is US3 before Phase 2, or US5a before US1.

### Phase order

```
Phase 1 (baselines)
      ↓
Phase 2 (Slice 0 — ALONE, own commit, both suites green)
      ↓
      ├─→ Phase 3 (US1, P1) ──→ Phase 6 (US5a, P3)
      ├─→ Phase 4 (US2, P2)          │
      ├─→ Phase 5 (US3, P2)          │
      └─→ Phase 7 (US4 + US5b, P3) ←─┘
                    ↓
              Phase 8 (Polish)
```

### Parallel opportunities

- **Phase 1**: T001–T003 all parallel (three different roots).
- **Phase 2**: T006 and T007 parallel; T004 → T005 sequential (one file).
- **Phase 3**: T010–T014 all parallel (five different test files). T015 parallel with the tests;
  T016 → T017 → T018 sequential; T022 parallel with T019–T021.
- **Phase 4**: T024, T028, T029, T030, T031 parallel. T032 parallel; T033–T038 sequential-ish, T034 → T035
  strictly ordered (the reorder must land before the check that depends on it).
- **Phase 5**: T039–T042 parallel; T043/T045 parallel (different roots); T053 parallel with everything.
- **Phase 6**: T054, T059, T060 parallel; T061/T062/T065/T067/T071/T072/T074 parallel; the dashboard
  tasks (T072–T074) are a different root and can run alongside the backend ones.
- **Phase 7**: nearly everything parallel — T075–T077, T080–T084 all touch different files.
- **Phase 8**: T090–T093 parallel.

### After each phase

Once Phase 2 is merged, three developers could take Phase 3, Phase 4 and Phase 5 simultaneously —
different roots for the most part, and no shared file between them.

---

## Implementation Strategy

### MVP — Phases 1, 2, 3

Baselines, the socket registry, and US1. That delivers the P1 story: a driver whose phone fails can
resume on a replacement, including an unanswered stop question. It also ships the push fix, which both
personas have been missing since the app was written.

**Stop and validate** with `quickstart.md` Part 3a/3b on two real devices before going further.

### Incremental delivery

| Increment | Adds |
|---|---|
| Phases 1–3 | **MVP**: continuity + working pushes |
| + Phase 4 | The integrity half — a displaced device cannot corrupt a truck's whereabouts |
| + Phase 5 | A real notification centre |
| + Phase 6 | A blocked driver reaches the transporter |
| + Phase 7 | Real identity, no dead controls |

Each increment leaves all three suites green and is independently shippable.

---

## Notes

- **Phase 2 lands alone.** It is the only phase that touches the CLIENT persona, and its failure mode is
  silent. A client regression must be attributable to one commit.
- **Three tests are the deliverable, not paperwork**: T026 (`lastMovedAt` unchanged), T056 (detection not
  suppressed), T011 (the outstanding-stop derivation). Each guards a behaviour that is invisible when
  wrong and that a plausible implementation gets backwards.
- **Four tasks assert existing behaviour rather than adding any**: T013, T014, T028, T031. Resist the
  urge to "implement" them — FR-015 and FR-021 are already satisfied, and adding a second mechanism
  beside a working one is how two records of one event come to disagree.
- **`build_runner` after any entity change** (T018). Never edit `*.freezed.dart` / `*.g.dart`.
- **Baseline discipline**: confirm the mobile count is still exactly two non-green. `mobile_app/CLAUDE.md`
  §7 records an earlier count of three being wrong and trusted.
- Commit after each task or logical group. Stop at any checkpoint to validate a story independently.

### Baselines captured (T001–T003) — 2026-09-03

**T001 · Backend (`ciro_fuel/`)**
- `npm run lint:check` — clean (exit 0)
- `npm run build` — clean (exit 0)
- `npm run test` (unit) — **22 suites, 187/187 passed**
- `npm run test:e2e` — **62 suites, 341 passed / 5 failed / 346 total.** All 5 failures are in
  `test/e2e/request-logging.e2e-spec.ts` (spec 012 US5 structured logging). It fails **identically in
  isolation on an unmodified tree** (`git status` shows only `.specify/feature.json` + `CLAUDE.md`
  touched) — the suite captures pino output and parses 0 records in this environment, so it is a
  **pre-existing, environment-only baseline failure**, not a regression. The other 61 suites are green.
  CLAUDE.md's "346/346" predates whatever changed the local log sink.

**T002 · Mobile (`mobile_app/`)**
- `flutter test` — **418 passed, 1 skipped, 1 failed.** Exactly the two documented non-green:
  `test/golden/login_screen_golden_test.dart` (pixel diff 63.68%) and
  `test/integration/auth_session_test.dart` (`skip: true`). No third.
- Note: the mobile working tree already carried **pre-existing uncommitted edits** unrelated to this
  feature (`lib/features/auth/presentation/widgets/sign_in_button.dart`, `ios/Podfile.lock`,
  regenerated `test/golden/failures/*.png`). Left untouched; not part of any 013 commit.

**T003 · Dashboard (`web_dashboard/`)**
- `tsc -b --force` — **57 errors across 30 files**: 56 × `TS6133`/`TS6192` (unused imports, features
  011/012 fallout) + **1 × `TS2307`** in `src/transport_company/orders/components/OrderEditPage.tsx`
  (missing `./order-details/EditTransportDetailsCard`). All pre-existing.
- `vitest run` — **49 passed**; the same 2 suites fail to *load* (`accessibility.test.tsx`,
  `orders.mutations.test.tsx` — import `@/features/*` paths feature 009 deleted).

### Corrections found while implementing

> Record here, as specs 008–012 did. Each entry: what the artifacts said, what was actually true, and
> what would have shipped if the artifacts had been followed as written.

- **The driver notification READ/WRITE path was tenant-scoped out — not just the push (US3, `notifications.service.ts`).** `Notification` is `markTenantScoped`, and the tenant-scope plugin adds `.where({ companyId })` to `find`/`countDocuments`/`updateMany`/`findOneAndUpdate` for any scoped role. Every `notify` call site addresses a driver notification with the **order's** `fuelCompanyId` — a *different* tenant from the driver's own `companyId` (their transport company). So `GET /notifications`, `PATCH /notifications/:id/read` and the new `read-all` all silently matched **none** of a driver's own notifications: the list would render permanently empty and mark-read would 404. `notify` already sidesteps this with `runUnscoped` + an explicit recipient; `findForUser`, `markRead` and `markAllRead` now do the same, keyed strictly on `recipientUserId` (from the token). For a CLIENT this is equivalent-or-tighter than the `companyId` filter, so no client-persona change (FR-042).

- **`TrackingSocket.dispose()` must NOT clear the handler registry (T005 / mobile-integration.md §1
  said "clears both").** `NotificationsCubit` is an eager app-lifetime singleton that registers its
  `notification:new` handler **once, in its constructor**, at DI setup — and is never recreated
  (`.clear()` only resets its state). If `dispose()` cleared `_handlers`, then after the first
  sign-out/sign-in the registry would be empty on the next `connect()` and that cubit — the badge and
  the whole notification list — would go **permanently deaf**, silently, for the rest of the process.
  So `dispose()` tears down the socket only; `_handlers` lives as long as the `TrackingSocket`
  singleton. This is also exactly what makes T007's "handlers survive a connect→dispose→connect cycle"
  literally true. **Consequence for the re-attaching workaround listeners:** with the registry now
  durable and re-flushed on every `connect()`, `SessionRevocationListener`/`DeliveryListener` must be
  attached **once**, not per sign-in (a one-line guard added in `injector.dart`) — re-attaching would
  stack duplicate handlers (a second device-level stop alert, a double active-delivery reload) that
  would only surface after an in-process sign-out/sign-in. `injector.dart` is therefore part of the
  Slice 0 diff, narrowly.

- **T021 renders the untracked indicator on `driver_home_screen.dart`, not `delivery_detail_screen.dart`.**
  `DeliveryActive.streaming` lives on `DeliveryCubit`, which `driver_home_screen.dart` consumes
  (`_ActiveDeliveryCard`). `delivery_detail_screen.dart` is driven by a *different* cubit —
  `OrderDetailCubit` (a fresh per-order fetch) — and `DeliveryCubit` is not in every tree that pumps it:
  **~10 existing widget/integration tests pump `DeliveryDetailScreen` through `registerOrdersTestDi`,
  which registers no `DeliveryCubit`**, so a `BlocBuilder<DeliveryCubit>` added there would throw
  `ProviderNotFoundException` in all of them. The home screen's active-delivery card keeps it wired to
  the real `streaming` field on a screen where the cubit is already provided app-wide; T012 drives it
  there. The **outstanding-stop banner (T020) does** land on `delivery_detail_screen.dart` as specified
  — it reads `order.stopEvents` off that screen's own `OrderDetailCubit`.

- **`StopEvent` is freezed-only, hand-parsed in `OrderMapper` (T016 / data-model §4 said "+
  json_serializable").** Every other nested `Order` entity (`TankSummary`, `WarehouseSummary`,
  `OrderRating`, `DriverSummary`) is freezed-only and hand-parsed, because `Order` carries a `GeoPoint`
  `json_serializable` cannot round-trip and the whole graph opted out. Forking that for one type — with
  `StopOrigin`/`StopReason` enum fields needing converters — buys nothing. T010 covers the parsing.

- **Biometric sign-in crashed the app on iOS and had silently never worked on Android — found by the
  analysis pass on 2026-09-03, from a user report ("press Face ID on the login page → app crashes").**
  Not a defect in this feature's code: it is spec 006 platform configuration. But it is **this feature's
  blocker**, because US1's whole claim is *sign in on a replacement device*, SC-002 counts "sign-in and
  device unlock" inside its 2-minute budget, and T089 cannot be walked at all while the login screen
  crashes. Two independent causes, in opposite directions:
  · **iOS: `NSFaceIDUsageDescription` was absent from the entire `ios/` tree.** iOS *terminates the
  process* on the first Face ID `evaluatePolicy` call without it — a native abort, so
  `BiometricAuthenticator`'s `catch (PlatformException)` / `catch (MissingPluginException)` never runs
  and the documented "degrades to unavailable, the password form remains the path in" contract does not
  hold. Added, with the purpose string.
  · **Android: `MainActivity` extended `FlutterActivity`, not `FlutterFragmentActivity`.** `local_auth`
  raises the system BiometricPrompt through the AndroidX fragment manager, so a plain `FlutterActivity`
  host fails every `authenticate()` with `no_fragment_activity` — which *is* caught, so the mandatory
  app lock and biometric sign-in have been silently inert on Android with no crash and no error to
  follow. Changed, plus an explicit `USE_BIOMETRIC` declaration rather than relying on the
  `androidx.biometric` manifest merge.
  · Guarded by `mobile_app/test/unit/biometric_platform_config_test.dart`, on
  `background_location_config_test.dart`'s precedent: both settings live in files no Dart test would
  otherwise read, and both fail in ways no widget test can see — one as a process abort, the other as
  silence. **Not changed**: `LaunchTheme`/`NormalTheme` still descend from `@android:style/Theme.*`
  rather than AppCompat, which `androidx.biometric`'s pre-API-28 fallback dialog wants. `minSdk` is 26,
  so API 26–27 devices would still take that path; retheming the whole app's window is a far wider blast
  radius than this fix and is left disclosed rather than done here.

- **`stop_reason_sheet.dart` reloads `DeliveryCubit` on submit, not `delivery_cubit.dart` itself
  (T023 named the cubit file).** The sheet is the single funnel for every stop answer (notification
  tap via `StopAlertRouter`, the new outstanding-stop banner, and the declare button), so reloading
  there covers all three entry points; guarded by `getIt.isRegistered<DeliveryCubit>()` for the widget
  tests that pump the sheet without the full DI graph. The detail screen additionally reloads its own
  `OrderDetailCubit` at the call site (a `registerFactoryParam` instance `getIt` can't re-resolve).
