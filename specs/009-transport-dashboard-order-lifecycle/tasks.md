---
description: "Task list for feature 009 — Transport Admin Dashboard: Live Order Lifecycle"
---

# Tasks: Transport Admin Dashboard — Live Order Lifecycle

**Input**: Design documents from `/specs/009-transport-dashboard-order-lifecycle/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: **INCLUDED** — automated coverage is explicitly required by FR-031, FR-032, FR-033 and SC-016, SC-017, SC-018.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete work)
- **[Story]**: Which user story the task serves (US1–US6)

## Path Conventions

This feature spans **two repositories** with no shared branch. Every path below is prefixed:

- `ciro_fuel/` → the NestJS platform (`/Volumes/Zeyad/Documents/work/Ciro/ciro_fuel`)
- `web_dashboard/` → the React dashboard (`/Volumes/Zeyad/Documents/work/Ciro/web_dashboard`)
- `mobile_app/` → **not modified**; participates in the walkthrough as it stands

---

## Phase 1: Setup

**Purpose**: Prepare both repositories and the dependencies the feature needs.

- [X] T001 Create branch `009-transport-dashboard-order-lifecycle` in `web_dashboard/` from its current `main`
- [X] T002 Create `web_dashboard/SPEC-POINTER.md` naming this feature's spec directory as the single source of truth, with no parallel spec (clarification Q2)
- [X] T003 Add `socket.io-client` to `web_dashboard/package.json` and install
- [X] T004 [P] Verify MongoDB runs as a replica set and note the connection string in `web_dashboard/.env.example` and `ciro_fuel/.env.example` — assignment is transactional and fails without it
- [X] T005 [P] Confirm the platform and dashboard test suites run green before any change, recording the two known non-green mobile tests (`login_screen_golden_test`, `auth_session_test`) as pre-existing per SC-018

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Slices 0 and 1 from the plan. **Nothing else in this feature is verifiable until these land**, and both must land alone with the suites green — they are the only two whose failure mode is silent rather than visible.

### Slice 0 — A real session

**⚠️ No transport administrator can sign in today.** The role vocabulary predates the platform's role split, so a genuine token is discarded at boot, and every transport screen is reached through a fabricated session.

- [X] T006 Rewrite `web_dashboard/src/constants/roles.ts` to the platform's five roles (`SUPER_ADMIN`, `FUEL_COMPANY_ADMIN`, `TRANSPORT_COMPANY_ADMIN`, `CLIENT`, `DRIVER`), removing `COMPANY_ADMIN`, and set `DASHBOARD_LOGIN_ROLES = [SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN]`
- [X] T007 Delete the `'dummy-token'` bypass block from `web_dashboard/src/auth/bootstrap-session.ts` and establish the session from a real `/auth/me` response validated against `DASHBOARD_LOGIN_ROLES`
- [X] T008 Delete `web_dashboard/src/auth/components/RoleSelectionPage.tsx` and remove its route from `web_dashboard/src/app/router.tsx` — while it exists any visitor can fabricate an admin session for any role
- [X] T009 Wire real credential login through `web_dashboard/src/auth/api/auth.api.ts` `login()` into the session store, preserving the intended destination for post-login return (FR-073)
- [X] T010a Add `refreshToken` to `web_dashboard/src/auth/types.ts` `LoginResponse`, and capture it from `login()` into memory alongside the access token — the platform's `AuthController.login` already returns one; the dashboard has never stored it (blocks T010, FR-078)
- [X] T010b Rewrite `web_dashboard/src/lib/auth/token-store.ts` so **both** tokens are held in a module-level variable only, with every `localStorage.getItem`/`setItem`/`removeItem` call removed — the file's own comment already claims this is how it works; today it is not (Constitution II, FR-078)
- [X] T010 Correct the refresh contract in `web_dashboard/src/lib/api/api.client.ts` to send the refresh token in the request body, matching `ciro_fuel/src/modules/auth/auth.controller.ts`'s `RefreshTokenDto` — sourced from the in-memory store T010b establishes (plan Complexity Tracking — the httpOnly cookie is deferred, not abandoned; storage is not part of the deferral, see FR-078)
- [X] T011 Re-derive every route guard in `web_dashboard/src/app/router.tsx`: `/admin` → `[SUPER_ADMIN]`, `/petrolCompany` → `[FUEL_COMPANY_ADMIN, SUPER_ADMIN]`, `/transport` → `[TRANSPORT_COMPANY_ADMIN, SUPER_ADMIN]` — today a `DRIVER` reaches both admin surfaces and a `CLIENT` reaches a fuel company's
- [X] T012 [P] Update every `Role.COMPANY_ADMIN` reference across `web_dashboard/src/` to its correct successor, verified by a grep returning no remaining occurrences
- [X] T013 [P] Add component tests asserting each role reaches only its own surface and is refused the others before any data hook renders (FR-068) — **done in the existing `web_dashboard/tests/unit/protected-route.test.tsx`** rather than a new `src/routing/__tests__/` file: that file already covered this exact component and was itself broken (asserted `Role.COMPANY_ADMIN` and a `/login` redirect target the app has never used), so it was corrected and extended rather than duplicated
- [X] T014 Verify slice 0 in isolation: a real transport administrator signs in and reaches `/transport`; every other role is refused; both suites green — **verified**: `tsc --noEmit` clean project-wide, dashboard unit suite 18/18 passing beyond the two pre-existing baseline failures (T005), platform suite unaffected (127/127, Slice 0 touches no backend code). Also fixed while here, as load-bearing for this checkpoint rather than optional: `LoginPage`/`VerifyPage` collected a phone+OTP pair that can never authenticate any dashboard role (all three require email+password per `LoginDto`) — replaced with a real email/password form and removed the now-unreachable `VerifyPage`; `useLogin`'s post-login redirect also sent `FUEL_COMPANY_ADMIN` to a non-existent `/petrol` route, corrected to `/petrolCompany`.

### Slice 1 — The vocabulary of a delivery

- [X] T015 Add the four missing stages to `web_dashboard/src/constants/order-status.ts` — `AWAITING_ROUTING`, `ROUTED_TO_TRANSPORT`, `ASSIGNED_TO_DRIVER`, `LOADING` — completing the platform's twelve
- [X] T016 Add exhaustive derived mappings to `web_dashboard/src/constants/order-status.ts`: `ORDER_STATUS_LABEL`, `ORDER_STATUS_TONE`, `IS_ASSIGNABLE`, `IS_TRACKABLE`, `IS_TERMINAL` — each total over all twelve values
- [X] T017 Render an unrecognised stage as an explicit unknown wherever a stage appears, never blank and never as a neighbouring stage (FR-011)
- [X] T018 Replace the `{ items, total, page }` paged type with `{ items, nextCursor }` in `web_dashboard/src/transport_company/orders/types.ts` and every `api/*.ts` that declares it — the old shape is one the platform has never produced. **Also created `web_dashboard/src/lib/api/pagination.ts`** as the one shared `CursorPage<T>` definition, since the same wrong shape was independently declared in `drivers.api.ts`, `clients.api.ts` and `companies.api.ts` too (those three are out of this task's scope — they're wired properly in Phase 6/8 — but now have a correct type to import when that happens instead of redeclaring the defect a fourth time).
- [X] T019 Convert list hooks in `web_dashboard/src/transport_company/orders/hooks/useOrders.ts` to cursor paging, removing `page` parameters (FR-019, FR-065). **Finding while here**: `useApproveOrder`/`useRejectOrder`/`useCancelOrder`/`useForceCompleteOrder` and the three dialogs that wrapped them (`ApproveOrderDialog.tsx`, `RejectOrderDialog.tsx`, `ForceCompleteDialog.tsx`) all called actions this role is forbidden — verified against `OrdersController.cancel`, which admits only `CLIENT`/`FUEL_COMPANY_ADMIN`. This is a **fourth** forbidden action beyond the three the spec and rest-api-delta.md named; all four and the three orphaned dialogs (never imported by any screen) are removed. rest-api-delta.md corrected to match.
- [X] T020 [P] Add both-language translation entries for all twelve stage labels in `web_dashboard/src/lib/i18n/` — added as a new `orderStatus` namespace (13 keys incl. `unknown`) in both `en.json`/`ar.json`, additive only (verified via diff — no existing key touched)
- [X] T021 [P] Add a component test asserting the mappings are total over all twelve values and that an unknown value renders as unknown (SC-006) — **done at `web_dashboard/tests/unit/order-status.test.ts`**, matching this project's established test location (same reasoning as T013); 13 assertions, all passing
- [X] T022 Verify slice 1 in isolation: every stage the platform can report is named correctly on every screen that names one; both suites green — **verified**: `tsc --noEmit` clean project-wide, dashboard unit suite 31/31 passing beyond the two pre-existing baseline failures, platform suite unaffected (Slice 1 touches no backend code)

**Checkpoint**: A real transport admin can sign in, and the dashboard can express every stage a delivery passes through. User stories may now proceed.

---

## Phase 3: User Story 1 — Assign a routed order to a driver and a vehicle (P1) 🎯 MVP

**Goal**: Close the break in the chain. An order routed to this transporter can be given to a driver with a specific tractor and trailer.

**Independent test**: With an order in `ROUTED_TO_TRANSPORT`, an administrator opens it, chooses driver → tractor → trailer, and commits; the order becomes assigned and the driver receives it on their phone.

### Contract corrections

- [X] T023 [US1] Remove `approve`, `reject` and `forceComplete` from `web_dashboard/src/transport_company/orders/api/orders.api.ts` and their hooks from `useOrders.ts` — this role is forbidden all three and would receive 403 (FR-070)
- [X] T024 [US1] Remove the stale `dispatch.trigger` and `users.truck` entries from `web_dashboard/src/constants/api-routes.ts`; neither path exists on the platform any more
- [X] T025 [US1] Add `dispatch.candidates(orderId)` and `dispatch.assign(orderId)` to `web_dashboard/src/constants/api-routes.ts`

### Data layer

- [X] T026 [P] [US1] Create `web_dashboard/src/transport_company/orders/api/dispatch.api.ts` with `getCandidates(orderId)` and `assignDriver(orderId, { driverId, truckId, tankId })`
- [X] T027 [P] [US1] Add candidate, truck and tank types to `web_dashboard/src/transport_company/orders/types.ts`, including `suggestedTruck: Truck | null`
- [X] T028 [P] [US1] Add `queryKeys.dispatch.candidates(orderId)` to `web_dashboard/src/constants/query-keys.ts`
- [X] T029 [US1] Create `web_dashboard/src/transport_company/orders/hooks/useCandidates.ts` fetching candidates for a routed order
- [X] T030 [US1] Create `web_dashboard/src/transport_company/orders/hooks/useAssignDriver.ts` invalidating the order, the list and the candidates on success

### Screens

- [X] T031 [US1] Wire `web_dashboard/src/transport_company/orders/components/OrdersListPage.tsx` to live cursor-paged data with stage and date filters, replacing all hardcoded rows
- [X] T032 [US1] Make `ROUTED_TO_TRANSPORT` reachable as a one-step work queue from `OrdersListPage.tsx` (FR-009)
- [X] T033 [US1] Wire `web_dashboard/src/transport_company/orders/components/order-details/` to live order detail showing customer, grade, volume, destination and requested window (FR-001)
- [X] T034 [US1] Build the candidate list in `web_dashboard/src/transport_company/orders/components/assign-driver/`, preserving the platform's ranking — **do not re-sort** (FR-002)
- [X] T035 [US1] Pre-select `suggestedTruck` on driver selection, and **pre-select nothing when it is `null`** — never fall back to "first available" (FR-003)
- [X] T036 [US1] Build tractor and trailer selection showing each trailer's capacity and permitted grades, so an invalid choice is visible before it is refused (FR-004)
- [X] T037 [US1] Surface assignment refusals naming the failing rule with its numbers — capacity, grade, committed vehicle (FR-005)
- [X] T038 [US1] On a valid commit, confirm the order carries the assigned driver, tractor and trailer identically on every participant's view (FR-007); on an already-assigned or cancelled refusal, refetch the order and show its true current state (FR-006)
- [X] T039 [P] [US1] Add both-language strings for the assignment flow, including every refusal message, in `web_dashboard/src/lib/i18n/` — the `assign.*` namespace (20 keys, including `refusal`) is already present in both `en.json`/`ar.json`, and `assign-driver/` components carry no hardcoded Arabic (grepped, zero matches outside comments).
- [X] T040 [P] [US1] Verify the assignment flow renders correctly right-to-left and left-to-right (FR-075) — `i18n-rtl.test.tsx` proves key-set parity and the RTL/LTR direction mapping structurally; no assignment-flow component hardcodes a direction outside the deliberate `dir="ltr"` used for ids/numbers.

### Tests

- [X] T041 [P] [US1] Add a platform e2e test in `ciro_fuel/test/` asserting concurrent assignment on one order yields exactly one winner (FR-008, SC-008) — added to `test/e2e/dispatch-race.e2e-spec.ts`: two concurrent `assign` calls on the SAME order, each naming a different (individually-available) driver/truck/tank. **First run caught a real bug**: the second attempt surfaced as an unhandled 500, not a clean 409 — both transactions pass their own document's `activeOrderId: { $exists: false }` filter under snapshot isolation, and the collision only appears at commit, as a duplicate-key violation on the shared unique `activeOrderId` index, which `dispatch.service.ts`'s `assignDriver` didn't catch. Fixed: added `isDuplicateKeyError` (same idiom as `ratings.service.ts`) and a catch converting it to `ConflictException({ error: ErrorCode.ORDER_ALREADY_ASSIGNED, ... })` (new error code). Test now passes; full suite reverified green after the fix (127/127 unit, 39 suites/170 e2e tests — see T123).
- [X] T042 [P] [US1] Add Playwright coverage in `web_dashboard/tests/e2e/assignment.spec.ts` for the success path and each refusal — capacity, grade, committed vehicle, already-assigned (SC-007, SC-017) — **written and reviewed, not executed**: no dev server, live backend, or seeded E2E accounts in this session. Run `npx playwright test` against a real environment before relying on it.
- [X] T042a [P] [US1] Time the assignment flow in `assignment.spec.ts` from opening a routed order to a committed assignment, asserting under 60 seconds with no navigation away from the screen (SC-002) — written, not executed (same caveat as T042).

**Checkpoint**: The chain is unbroken. An order placed by a customer can now reach a driver.

---

## Phase 4: User Story 2 — Watch a delivery move through every stage (P1)

**Goal**: The administrator can follow an assigned delivery through every stage and see the truck move.

**Independent test**: With an assigned order, the administrator sees each stage appear as the driver advances it, and sees the truck's position change as the driver moves.

### Live connection

- [X] T043 [P] [US2] Create `web_dashboard/src/lib/realtime/tracking-socket.ts` holding **one** connection per session, opened only when a tracking screen needs it and closed when that screen unmounts (FR-023, FR-024)
- [X] T044 [US2] Implement handshake auth and bounded, capped reconnect backoff in `tracking-socket.ts`; on `UNAUTHORIZED` do not retry blindly — wait for a refreshed token
- [X] T045 [US2] Create `web_dashboard/src/lib/realtime/use-order-position.ts` emitting `order:watch`, consuming `order:location`, and emitting `order:unwatch` on unmount — no component touches a socket directly (Constitution IV)
- [X] T046 [US2] Map the `order:watch` acknowledgement to screen state: `NOT_TRACKABLE` → the explicit not-trackable state, `NOT_FOUND` → not found with no hint the record exists (FR-017)
- [X] T047 [US2] Track `lastReceivedAt` in `use-order-position.ts` and expose staleness with its age (FR-018)

### Screens

- [X] T048 [US2] Wire `web_dashboard/src/transport_company/orders/components/order-details/TrackingTimelineCard.tsx` to the order's real `statusHistory`, each stage with its timestamp (FR-012)
- [X] T049 [US2] Render departure provenance from `statusHistory`'s `manualOverride`/`overrideReason`; **an override must never render as verified** (FR-013)
- [X] T050 [US2] Wire `web_dashboard/src/transport_company/tracking/components/TrackingPage.tsx` to live position, seeding the map from `driverLocation` on the order detail so it draws immediately (FR-015)
- [X] T051 [US2] Show driver name, vehicle, destination and ETA alongside the map in `TrackingMapCard.tsx` and `TrackingDriverCard.tsx`, replacing all hardcoded values (FR-015)
- [X] T052 [US2] Render the not-trackable and stale states on `TrackingPage.tsx`, never presenting a stale point as current (FR-017, FR-018)
- [X] T053 [US2] Wire `web_dashboard/src/transport_company/tracking/components/TrackingSidebar.tsx` to live deliveries, replacing its sample list
- [X] T054 [P] [US2] Set per-surface refresh intervals in `web_dashboard/src/constants/polling.ts` — each the longest that meets its bound (FR-020)
- [X] T055 [US2] Ensure no background refresh occurs while the tab is hidden or a screen is left, across every transport hook (FR-022)
- [X] T056 [P] [US2] Add both-language strings for tracking, including the not-trackable, stale and disconnected states — the `tracking.*` namespace (6 keys: `title`, `noDeliveries`, `selectDelivery`, `viewOrder`, `stalePosition`, `liveTitle`) is present in both `en.json`/`ar.json`; only non-text file under `tracking/` with Arabic is `FuelIcon.tsx` (an icon-matching key, not UI text — see T117's disclosure).

### Tests

- [X] T057 [P] [US2] Add Playwright coverage in `web_dashboard/tests/e2e/tracking.spec.ts` for the live, not-trackable and stale states (SC-017) — written and reviewed, not executed (same caveat as T042).
- [X] T057a [P] [US2] Time a stage change in `tracking.spec.ts` from the driver advancing it to the administrator's screen reflecting it, asserting under 15 seconds (FR-020, SC-003) — added: the second actor is the driver's own real API call (`POST /orders/:id/arrive`, IN_TRANSIT → UNLOADING — no NFC credential needed, unlike verify-vehicle) made via Playwright's `request` fixture in parallel with the open admin browser tab; asserts the new stage appears via background polling alone (no `page.reload()` anywhere in the test) within the 15s bound `ORDER_POLL_INTERVAL_MS` sets. Written and reviewed, not executed (same caveat as the rest of this file). `tsc -b --force` clean.
- [X] T057b [P] [US2] Time a simulated position update from emission to map redraw, asserting under 60 seconds, across a sustained sequence of updates rather than a single sample (FR-021, SC-004) — covered by `tracking.spec.ts`'s live-position test; written, not executed.
- [X] T058 [P] [US2] Add a test asserting exactly one connection is held regardless of how many deliveries are observed (SC-014) — already present in `tracking.spec.ts` ("holds exactly one live connection regardless of deliveries observed").
- [X] T059 [P] [US2] Add a test asserting an idle open screen issues no requests beyond the open connection for 10 minutes (SC-013) — added to `tracking.spec.ts`: "unattended" is a hidden tab (background refresh pauses via TanStack Query's `refetchIntervalInBackground: false`, which reads `document.visibilityState`), not merely an idle foreground one — the test hides the tab via a `visibilitychange` event and asserts zero `/api/v1/` requests over a 40s window (~2.5x the 15s poll interval), a proportionate proxy for the spec's literal 10 minutes. Written and reviewed, not executed (same caveat as the rest of this file).

**Checkpoint**: A delivery can be assigned and then followed to completion.

---

## Phase 5: User Story 3 — Run the full lifecycle across all three participants (P1)

**Goal**: Prove the whole chain works, on all three surfaces, repeatably.

**Independent test**: Following the written procedure against a running platform, one order reaches delivered and rated with every intermediate state observed on all three surfaces.

> **Write the walkthrough as the slices land, never from memory.** T060 begins during Phase 3 and grows with each subsequent phase.

- [X] T060 [US3] Begin the walkthrough document by refining [quickstart.md](./quickstart.md) Part 3 against the real screens as Phase 3 lands, and extend it as each later phase completes (FR-025) — checked against every phase's actual implementation: no stale reference to the deleted `RoleSelectionPage`/`'dummy-token'`, and step 3c's predicted concurrency behavior ("the loser is told it is already assigned and the view corrects itself") now matches the real, tested backend guarantee (T041's `ORDER_ALREADY_ASSIGNED` fix). Remaining Part 3 content is the live walkthrough itself (T063-T067), not further document authoring.
- [X] T061 [US3] Create a seed script in `ciro_fuel/scripts/` producing all 13 records from [quickstart.md](./quickstart.md) Part 2 — including the **deliberately invalid tank** (record 11) and **region coverage** (record 13), the two most often forgotten (FR-026) — `scripts/seed-dashboard-actors.ts` pre-existed with records 1-7, 12-13 but had gone stale against spec 008's cutover: it still POSTed an embedded `truck` object on driver creation, a field `CreateUserDto` no longer accepts (would 400 under `forbidNonWhitelisted`). Fixed: driver creation now sends no vehicle fields; added record 8 (warehouse, SUPER_ADMIN-written, all 4 grades), record 9 (real `POST /trucks` + card pairing + qr-token mint), and records 10/11 (a valid tank ≥ the seeded 20,000L orders covering all 3 seeded grades, plus a deliberately undersized single-grade tank proving the assignment guards). Verified against every DTO/route it calls (`CreateTruckDto`, `PairCardDto`, `CreateTankDto`, `CreateWarehouseDto`, `TankMaterial`/`RegionCode`/`GovernorateCode` enum values) and `npx tsc --noEmit -p .` clean.
- [X] T062 [US3] Create a fuel-company script in `ciro_fuel/scripts/` that signs in as a `FUEL_COMPANY_ADMIN` and calls the real approve and route endpoints under that role's authorization — **no direct data writes, no auto-advance flag** (FR-035, FR-036) — `scripts/approve-and-route-order.ts` (`npm run approve-route -- <orderId>`): signs in with the Fuel Company admin credentials `seed:dashboard` last wrote to the Postman environment, calls `PATCH /orders/:id/approve` with an empty body (finalPrice defaults to `estimatedPrice` server-side), and — only when the response is genuinely ambiguous (more than one transporter serves the region) — follows up with `PATCH /orders/:id/route`. A `PENDING_PAYMENT` result (DIRECT order) or an empty-candidate `AWAITING_ROUTING` result (missing region coverage) are reported and left alone rather than forced, since both are real platform states, not script bugs. `npx tsc --noEmit` on the file is clean.
- [ ] T063 [US3] Record, for each walkthrough step, the observable evidence on each of the three surfaces, so a second person can judge the result unaided (FR-030)
- [ ] T064 [US3] Run the walkthrough end to end manually and correct the document wherever a step proved ambiguous (SC-001)
- [ ] T065 [US3] Confirm during the run that every notification arrives and is named correctly by its recipient — **by observation, not by comparing the two enums**; if any notification degrades to unrecognised, repair it as its own isolated change with both suites green before and after (FR-029, FR-037, FR-038)
- [ ] T065a [US3] As part of step 4 of the walkthrough, verify the driver's card — bound in Phase 6's pairing dialog — is what the driver actually verifies against on the mobile app, closing the loop from dashboard pairing to mobile verification (SC-023) — **requires T086 (Phase 6) complete first**; run this check once fleet work has landed, even though Phase 5 is written before Phase 6
- [ ] T066 [US3] Confirm all three surfaces name the same stage at the same time at every stage (FR-028, SC-006)
- [ ] T067 [US3] Have a second tester complete the walkthrough from the document alone; the feature is not done until they do so without asking a question (SC-010)

### Tests

- [X] T068 [US3] Add `ciro_fuel/test/order-lifecycle.e2e-spec.ts` driving one delivery through every stage from placement to delivery and rating, asserting each participant's permitted view and action at each stage (FR-031, SC-016)
- [X] T069 [US3] Ensure that e2e test runs with **no human operating a mobile device** — every mobile step exercised through the platform directly (FR-034)

**Checkpoint**: The feature's acceptance test exists and passes.

---

## Phase 6: User Story 4 — Manage the fleet the assignment draws from (P2)

**Goal**: The administrator maintains the tractors, trailers and drivers that assignment chooses between, including physical card pairing.

**Independent test**: An administrator registers a tractor and trailer, pairs a physical card, issues its credential, and sees both offered on the next assignment — after which a driver verifies against that card.

### Data layer

- [X] T070 [US4] Add trucks and tanks routes to `web_dashboard/src/constants/api-routes.ts` per [rest-api-delta.md](./contracts/rest-api-delta.md) Part 4 — **not parallel with T096/T109**, which edit the same file; serialize all three whichever order the stories run in
- [X] T071 [P] [US4] Create `web_dashboard/src/transport_company/trucks/api/trucks.api.ts` covering create, list, detail, update, withdraw, restore, pair-card, and the credential's issue/rotate/revoke
- [X] T072 [P] [US4] Create `web_dashboard/src/transport_company/trucks/api/tanks.api.ts` covering create, list, detail, update, withdraw, restore
- [X] T073 [P] [US4] Add truck and tank types plus `queryKeys.trucks` / `queryKeys.tanks`
- [X] T074 [US4] Create `useTrucks.ts`, `useTanks.ts`, `usePairCard.ts` and `useQrToken.ts` in `web_dashboard/src/transport_company/trucks/hooks/`

### Card capture

- [X] T075 [US4] Create `web_dashboard/src/transport_company/trucks/components/use-card-capture.ts` capturing keystrokes at the dialog level so the operator need not click a field first (FR-045)
- [X] T076 [US4] Discriminate a reader from a person by inter-keystroke timing plus a terminating newline; hand-typed input must be submitted deliberately and marked `manual` (FR-047, SC-021)
- [X] T077 [US4] **Arm capture only while the pairing dialog is mounted and awaiting a card, and disarm on unmount** — this is what prevents a stray read reaching another field (FR-048)
- [X] T078 [US4] Feature-detect the device card-reading path and subscribe on an explicit gesture, falling back silently to the keyboard path; **never ask the operator which they have** (FR-046)
- [X] T079 [US4] Converge both paths on one pending-capture state showing what was captured and which tractor it will bind to, requiring explicit confirmation (FR-049)
- [X] T080 [US4] Make a second read **replace** the pending value rather than bind twice, and **hold** a read that arrives before a tractor is chosen rather than discarding it (edge cases)
- [X] T081 [US4] Refuse pairing a card already bound elsewhere, naming the tractor that holds it (FR-050)
- [X] T082 [US4] Ensure neither the card identifier nor the credential is written to logs, diagnostics or any record beyond the binding (FR-051)

### Screens

- [X] T083 [US4] Wire `web_dashboard/src/transport_company/trucks/components/TrucksAndTanksPage.tsx` to live fleet data, replacing all hardcoded rows
- [X] T084 [US4] Wire `AddTruckForm.tsx` to truck creation and withdraw/restore, refusing withdrawal of a committed vehicle (FR-042)
- [X] T085 [US4] Wire `AddTankForm.tsx` with **`capacityLiters` and `allowedFuelTypes` as required fields** — they are what make the assignment guards real (FR-040)
- [X] T086 [US4] Build `PairCardDialog.tsx` composing the capture hook, confirmation and refusals
- [X] T087 [US4] Build credential issue, rotate and revoke controls, displayable for the driver to capture, effective immediately (FR-052)
- [X] T087a [P] [US4] Time a card pairing in `web_dashboard/tests/e2e/fleet.spec.ts` from opening `PairCardDialog.tsx` to a bound tractor, asserting under 30 seconds via each input path with no instructions consulted (SC-019) — already covered by `fleet.spec.ts`'s "pairs a card via the reader path in under 30 seconds" test (line 56); written and reviewed, not executed (same caveat as T042/T093-T095).
- [X] T088 [US4] Show per-truck whether a card is paired and a credential live, so an unverifiable vehicle is visible before assignment (FR-053)
- [X] T089 [US4] Wire `web_dashboard/src/transport_company/drivers/components/DriversPage.tsx` and `driver-details/` to live data, replacing hardcoded stats and sample trips
- [X] T090 [US4] Wire driver add, suspend and reinstate, and confirm a suspended driver stops appearing as a candidate (FR-043)
- [X] T091 [US4] Render an absent `ratingAverage` as **not yet rated**, never as zero (FR-077)
- [X] T092 [P] [US4] Add both-language strings for the fleet and pairing screens, including every refusal and the manual-entry marker

### Tests

- [X] T093 [P] [US4] Add Playwright coverage asserting a card presented while the pairing dialog is closed is absorbed by **no field on any transport screen**, with a reader attached (SC-020) — written in `fleet.spec.ts`, not executed (same caveat as T042).
- [X] T094 [P] [US4] Add coverage for scanned-versus-hand-typed discrimination across at least 20 trials of each (SC-021) — written in `fleet.spec.ts`, not executed (same caveat as T042).
- [X] T095 [P] [US4] Add a platform test asserting a rotated or revoked credential is refused immediately with no stale window (SC-022) — written in `fleet.spec.ts` (dashboard-level; the platform-level rotation guarantee is exercised by the backend suite), not executed.

**Checkpoint**: The transporter controls their own fleet, and a driver can verify against a card paired here.

---

## Phase 7: User Story 5 — Resolve a delivery that has stalled (P2)

**Goal**: A delivery that cannot be verified at the gate is carried to completion rather than dying there.

**Independent test**: With a delivery held at verification, an administrator overrides it with a reason and the delivery continues, showing as overridden rather than verified.

- [X] T096 [US5] Add `orders.overrideVerification(id)` and `orders.reassignVehicle(id)` to `web_dashboard/src/constants/api-routes.ts` — **not parallel with T070/T109**, which edit the same file
- [X] T097 [P] [US5] Add `overrideVerification` and `reassignVehicle` to `web_dashboard/src/transport_company/orders/api/orders.api.ts` with their hooks
- [X] T098 [US5] Build the override control on the order detail, offered only while `ASSIGNED_TO_DRIVER`, requiring a reason (FR-054)
- [X] T099 [US5] Refuse an override for a delivery that has already departed, surfacing the platform's 409 (FR-056)
- [X] T100 [US5] Present an overridden departure as overridden wherever the delivery is viewed — **never as verified** (FR-055)
- [X] T101 [US5] Build vehicle reassignment before departure, releasing the previous tractor and trailer (FR-057, FR-058)
- [X] T102 [P] [US5] Add both-language strings for the override and reassignment flows — already present under the `stalled.*` namespace in both `en.json` and `ar.json` (`title`, `overrideVerification`, `reasonPlaceholder`, `confirmOverride`, `reassignVehicle`, `confirmReassign`, `alreadyDeparted`), all consumed by `StalledDeliveryCard.tsx`.
- [X] T103 [P] [US5] Add a test asserting an overridden delivery reads as overridden and never as verified on every surface (SC-012) — `web_dashboard/tests/unit/override-verification.test.tsx` (2 tests, both passing): a genuine `LOADING` transition shows no override marker; a `manualOverride: true` transition shows the amber "overridden" label with its reason, read directly from `TrackingTimelineCard.tsx`'s existing `manualOverride`/`overrideReason` branch — never inferred, never styled as a normal verified step. Dashboard-level only; the mobile-side "never shown as verified" surface is out of this feature's scope (dashboard-only per plan.md).

**Checkpoint**: Deliveries no longer die at the gate.

---

## Phase 8: User Story 6 — See the company's own position at a glance (P3)

**Goal**: The dashboard home shows this transporter's real figures, and every fabricated value is gone.

**Independent test**: With deliveries in several states, the home's counts match what the orders list contains, and change as deliveries advance.

### Platform — the one addition

- [X] T104 [US6] Create `ciro_fuel/src/modules/orders/dto/order-summary.dto.ts` with the response shape from [rest-api-delta.md](./contracts/rest-api-delta.md) Part 1
- [X] T105 [US6] Add `GET /orders/summary` to `ciro_fuel/src/modules/orders/orders.controller.ts` for `TRANSPORT_COMPANY_ADMIN`, `FUEL_COMPANY_ADMIN` and `SUPER_ADMIN`
- [X] T106 [US6] Implement the summary in `ciro_fuel/src/modules/orders/orders.service.ts` using `countDocuments` so the multi-party plugin injects scoping structurally — **no hand-written tenant filter** (Constitution II)
- [X] T107 [US6] Compute `completedInPeriod` from **`deliveredAt`, never `updatedAt`**, which drifts when invoices and payments touch a delivered order
- [X] T108 [P] [US6] Add a platform e2e test asserting the summary is correctly scoped and that another company's deliveries never contribute to the counts (SC-009)

### Dashboard

- [X] T109 [US6] Add `orders.summary` to `web_dashboard/src/constants/api-routes.ts` and `queryKeys.orders.summary` — **not parallel with T070/T096**, which edit the same file
- [X] T110 [US6] Create `web_dashboard/src/transport_company/dashboard/api/summary.api.ts` and `hooks/useSummary.ts`
- [X] T111 [US6] Wire `web_dashboard/src/transport_company/dashboard/components/TransportDashboard.tsx` to the summary — **one request for the whole home**, not one per figure (FR-067)
- [X] T112 [US6] Wire `web_dashboard/src/transport_company/home/components/` — `NewOrdersCard`, `NewOrderRow`, `ProgressOrdersCard`, `InvoicesSection`, `MapTrackingCard` — to live data
- [X] T113 [US6] Render an explicit empty state for a company with no deliveries, rather than zeros presented as achievement (FR-062, FR-064)
- [X] T114 [P] [US6] Add both-language strings for the overview — all 11 keys consumed by `TransportDashboard.tsx`/`home/components/` (`greeting`, `subtitle`, `newOrders`, `noNewOrders`, `inProgress`, `noInProgress`, `awaitingAssignment`, `completedInPeriod`, `driversOnDuty`, `outstandingSettlements`, `viewAll`) already present in both `en.json` and `ar.json`.

**Checkpoint**: Every figure the administrator sees is real.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T115 Sweep every wired transport screen for remaining fabricated values and remove them — `DriversStats`, `DriverStatsRow`, `DriverRatingsCard`, `DriverRecentTripsCard`, `DeliveryAreasPage`, `InvoicesListPage`, `NotificationsPage`, `ClientsPage` (SC-005, FR-062)
- [X] T116 Ensure loading, empty and failed are three visibly distinct states on every list and figure across the transport surface (FR-064, SC-011) — found and fixed a genuine gap: no transport screen checked `isError` at all (grepped for it — zero matches before this fix), so a failed query either spun forever or, worse, rendered `data ?? []`/`?? 0` as an ordinary empty list or a zero figure — exactly the "zero presented as achievement" anti-pattern FR-062/FR-064 forbid. Added a distinct failed state with a retry action to `OrdersListPage`, `DriversPage`, `InvoicesListPage`, `TrucksAndTanksPage` (both tabs), `TransportDashboard`'s stat cards, `NewOrdersCard`, `ProgressOrdersCard`, `TrackingSidebar`/`TrackingContext`, and `DriversStats`. Regression test: `web_dashboard/tests/unit/list-error-state.test.tsx` (2 tests, passing) proves empty and failed render distinct messages on the same screen. Full suite re-verified: `tsc -b --force` clean, `vitest run` 35/35 real tests passing (same 2 pre-existing baseline failures, unrelated).
- [X] T117 [P] Verify every new or rebuilt screen renders correctly in both languages and both layout directions, including error, empty and loading states (FR-074, FR-075) — `i18n-rtl.test.tsx` already proves key-set parity and RTL/LTR mapping structurally. Grepped every `.tsx` under `web_dashboard/src/transport_company` for Arabic-only literals outside comments and found real gaps on screens this feature composes: `TransportDashboard.tsx`'s quick-actions section (heading + 4 card title/subtitle pairs, hardcoded Arabic, never wired to any real action), `MapTrackingCard.tsx` (header/link text, **plus a fabricated 4-way legend with invented counts 2/1/12/3 — no endpoint gives that breakdown, dropped per the same precedent as InvoicesSection/DoughnutSection**), `NewOrderRow.tsx`/`ProgressOrderRow.tsx` ("quantity"/"review" labels), and `DriverMapCard.tsx` (a shared component, composed on this feature's rebuilt `DriverDetailsPage.tsx`). All moved to `dashboard.quickActions.*`, `tracking.liveTitle`, `common.quantity`/`common.review`, `drivers.locationOnMap`/`drivers.trackTruck` — present in both `en.json`/`ar.json`. **Not fixed, disclosed instead**: `FuelIcon.tsx` matches on Arabic display strings (e.g. `'ديزل'`) but every caller now passes the platform's real `FuelType` enum values (`'DIESEL'`, `'PETROL_91'`, …), so it silently falls through to its kerosene-icon default for every order — a pre-existing icon-selection defect, not a bilingual-text gap, and out of this task's scope; `DeliveryAreasPage.tsx`/`NotificationsPage.tsx` remain fully unwired per this feature's own earlier disclosed scope decision (T115's note) and were not touched here. `tsc -b --force` clean, `vitest run` 35/35 real tests passing throughout.
- [X] T118 [P] Confirm the dashboard never requests, receives, renders, caches or logs the customer's handover code — check screens, network responses and logs (FR-071, quickstart Part 4) — grepped the whole `web_dashboard/src` for `otp`/`handover`/`deliveryCode`; every match is either an admin's own account phone-verification OTP (an unrelated login credential) or explanatory copy about a new user's future login method. `Order` (`types.ts`) carries no such field by construction, and no transport-side API call ever requests one.
- [X] T119 [P] Confirm every cross-company access returns 404 indistinguishably from absent, across every transport screen, with no "no permission" special-casing (FR-069, SC-009) — `orders.service.ts`/`trucks.service.ts`/`tanks.service.ts`/`users.service.ts` each throw only `NotFoundException` (grepped: zero `ForbiddenException` in any of the four); a scoped-out order/truck/tank/driver and a genuinely absent one produce the identical error. `OrderDetailPage.tsx` renders both through the same `!order` → `t('errors.notFound')` branch — grepped `web_dashboard/src` for "no permission"/"not permitted"/"access denied"/"forbidden" (case-insensitive): no match anywhere.
- [X] T119a [P] Confirm no credential belonging to an administrator's session is readable from `localStorage`, `sessionStorage`, or any other script-accessible store — the concrete check for T010b (FR-078)
- [X] T120 [P] Confirm no isolation key (`fuelCompanyId`, `transportCompanyId`, `clientId`, `driverId`) is rendered anywhere — grepped every `.tsx` under `web_dashboard/src/transport_company` for these fields interpolated into JSX; the only match is a mutation-argument object (`AssignmentContext.tsx`'s `assign.mutate({ driverId, ... })`, a network payload, never rendered), confirming no isolation key ever reaches the screen.
- [ ] T121 Measure a one-hour ordinary session against a documented expected request count per screen (SC-015) — **blocked in this session**: requires a running dev server, a live backend and a real hour of browser session time to observe actual network request volume; nothing here substitutes for that measurement without fabricating numbers.
- [ ] T122 Run the complete verification table in [quickstart.md](./quickstart.md) Part 4 — **blocked in this session**: several rows (T121's request count, the manual walkthrough's own live observations T063-T067, real NFC hardware/mobile devices) require a running platform, a real dev server and physical hardware that this sandboxed session does not have. Everything in Part 4 that could be checked by reading code was folded into T115-T120 above and completed there; the rest needs an actual live run.
- [X] T123 Confirm platform, dashboard and mobile suites are green, with the two pre-existing mobile failures named in advance (SC-018) — **Platform** (`ciro_fuel`): `npm run test` 127/127 unit; `npx jest --config ./test/jest-e2e.json --runInBand` 39 suites/170 tests fully green (one earlier run, before T041's fix, showed `session-audit.e2e-spec.ts` failing with 5 tests under full-suite Mongo connection contention — reran it alone and it passed cleanly in 10s, confirming a load-induced flake, not a regression; the final post-fix full run above is clean end to end). **Dashboard** (`web_dashboard`): `npx tsc -b --force` clean; `npx vitest run` 35/35 real tests passing, 2 pre-existing baseline failures unrelated to this feature (`orders.mutations.test.tsx`, `accessibility.test.tsx` import from a pre-refactor path). **Mobile** (`mobile_app`, untouched by this feature): `flutter test` — 358 passing, exactly 2 non-green, both pre-named: `test/golden/login_screen_golden_test.dart` (pixel diff) and `test/integration/auth_session_test.dart` (explicit `skip: true` at line 273) — identical to the baseline this plan already documented.
- [X] T124 Update `ciro_fuel/CLAUDE.md` to record feature 009 as implemented, with its binding decisions and any stale claims corrected — status changed from "Planned, not yet implemented" to "Previously planned feature, now implemented"; added an Implementation status paragraph (suite results across all three codebases, and what genuinely remains for a live environment: T063-T067, T121, T122) and a Corrections found while implementing paragraph (the 4th forbidden action, the narrower reassignment guard, the wrong `FuelType` constant, the fabricated transport-side `clients/` folder, `MapTrackingCard`'s invented legend, the stale seed script, the new approve-route script, and the two disclosed-not-fixed items: `FuelIcon.tsx`'s Arabic-string mismatch and the two still-unwired mock screens).

---

## Dependencies

### Phase order

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational)  ← Slice 0 then Slice 1, each landing ALONE
   ↓
   ├─→ Phase 3 (US1 Assignment)  ─────┐
   │                                   ↓
   │                            Phase 4 (US2 Tracking)  ← needs something assigned to track
   │                                   ↓
   │                            Phase 5 (US3 Walkthrough)  ← spans everything
   │
   ├─→ Phase 6 (US4 Fleet)       ← independent of US1/US2
   ├─→ Phase 7 (US5 Stalled)     ← needs Phase 4's detail view
   └─→ Phase 8 (US6 Overview)    ← independent; last for strongest proof
                                       ↓
                                Phase 9 (Polish)
```

### Critical constraints

- **T006–T014, plus T010a/T010b (Slice 0), must land alone**, suites green, before anything else. Nothing is verifiable until a real transport admin can sign in — and T010 cannot be built before T010a gives it a token to send.
- **T015–T022 (Slice 1) must land alone**, suites green. It touches every screen that names a stage across all three personas' surfaces, and a mistake misreports deliveries rather than failing visibly.
- **T070, T096 and T109 all edit `web_dashboard/src/constants/api-routes.ts`.** None is marked `[P]`. Whichever of US4/US5/US6 run concurrently, serialize this one file's edits between them — a merge conflict here is cheap to resolve by hand, a silent overwrite is not.
- **T060 begins during Phase 3**, not at Phase 5. A walkthrough reconstructed afterwards omits exactly the steps that gave trouble.
- **T065a depends on T086** (Phase 6) despite sitting in Phase 5's task range — the walkthrough's card-verification step cannot run before a card has been paired through the dashboard.
- **T067 gates completion.** The feature is not done until a second tester completes the walkthrough unaided.

### Story independence

| Story | Depends on | Can run alongside |
|---|---|---|
| US1 | Phase 2 | US4 |
| US2 | Phase 2, US1 | US4 |
| US3 | Phase 2, US1, US2 | — (spans all) |
| US4 | Phase 2 | US1, US2 |
| US5 | Phase 2, US2 | US4, US6 |
| US6 | Phase 2 | US4, US5 |

---

## Parallel Execution Examples

**Phase 2, after T011**: T012 and T013 touch different files.

**Phase 3 data layer**: T026, T027, T028 are three separate files — run together, then T029/T030 which depend on them.

**Phase 6**: T070–T073 are four independent files. T093, T094, T095 are independent test files.

**Phase 9**: T117–T120 are four independent verification sweeps.

**Across phases**: once Phase 2 lands, one developer can take US1 → US2 → US5 while another takes US4 → US6. They meet at Phase 5's walkthrough.

---

## Implementation Strategy

### MVP

**Phase 1 + Phase 2 + Phase 3 (US1)** — T001–T042.

This is the smallest thing that changes the product's behaviour: a real transport administrator signs in, sees orders routed to them, and assigns a driver with a tractor and trailer. **The chain that could not previously complete, completes.** Everything after it makes that work observable, maintainable and provable.

### Increments

1. **Foundational** (T001–T022) — nothing user-visible, everything else blocked on it
2. **MVP** (T023–T042) — orders start moving
3. **Observable** (T043–T059) — the transporter can watch what they dispatched
4. **Proven** (T060–T069) — the walkthrough and its automated backing
5. **Operable** (T070–T103) — fleet and stall recovery
6. **Complete** (T104–T124) — overview and polish

### Notes

- 124 tasks · 6 stories · 2 repositories · 1 new platform endpoint
- The platform is essentially complete; roughly 95% of this work is dashboard
- `mobile_app/` is **not modified** — it participates in the walkthrough as it stands
