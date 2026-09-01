---
description: "Task list for NFC Truck Verification & Warehouse Loading"
---

# Tasks: NFC Truck Verification & Warehouse Loading

**Input**: Design documents from `/specs/008-nfc-truck-loading/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **Included and mandatory.** Constitution v1.0.0's Development Workflow requires that
"guarantees the spec marks as testable … MUST have automated tests before the corresponding
capability is considered done." Vehicle-mismatch refusal, one-truck-one-order concurrency, tenant
isolation of fleet records, the override/verification distinction, and the two **absence**
requirements (no quantity input, no image-derived QR path) are all such guarantees — and the two
absences in particular cannot be verified by reading code alone.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete work)
- **[Story]**: US1–US5, mapping to the spec's user stories

## Path Conventions

Two roots, siblings on disk:

- **Backend** (this repo): `src/…`, `test/…` — NestJS, entry `src/server.ts`
- **Mobile**: `../mobile_app/lib/…`, `../mobile_app/test/…` — Flutter

---

## Phase 1: Setup (Enums, Codes, Dependencies)

**Purpose**: Named values and dependencies only — no logic. Principle I forbids the literals these replace.

- [X] T001 [P] Add `LOADING` to `src/common/enums/order-status.enum.ts`, placed between `ASSIGNED_TO_DRIVER` and `IN_TRANSIT`, with a comment recording that `IN_TRANSIT` now narrows to "loaded and travelling to the customer" (FR-046b)
- [X] T002 [P] Create `src/common/enums/verification-method.enum.ts` with `NFC_CARD` and `QR_CODE` (FR-036c)
- [X] T003 [P] Create `src/common/enums/verification-stage.enum.ts` with `DEPARTURE` and `LOADING` — derived server-side, never client-supplied (research R7)
- [X] T004 [P] Create `src/common/enums/tank-material.enum.ts` with `IRON` and `ALUMINIUM` (FR-048a)
- [X] T005 [P] Add `VEHICLE_MISMATCH`, `VEHICLE_NOT_VERIFIED`, `TRUCK_UNAVAILABLE`, `TANK_UNAVAILABLE`, `TANK_CAPACITY_EXCEEDED`, `TANK_GRADE_UNSUPPORTED`, `CARD_ALREADY_PAIRED`, `TANK_CODE_IN_USE`, `DUPLICATE_PLATE`, `NO_WAREHOUSE_FOR_GRADE`, `ALREADY_DEPARTED` to `src/common/enums/error-code.enum.ts`
- [X] T006 [P] Add `loading` to `../mobile_app/lib/shared/enums/order_status.dart` with its wire value `LOADING`. **This will break every exhaustive switch — that is intended and is how Phase 2B finds them all**
- [X] T007 [P] Create `../mobile_app/lib/shared/enums/tank_material.dart` and `verification_method.dart` mirroring the backend wire values
- [X] T008 [P] Add the matching codes to `../mobile_app/lib/core/network/error_codes.dart` **and** to `_knownCodes` in `../mobile_app/lib/core/network/error_interceptor.dart` — a code absent from `_knownCodes` is discarded and arrives as a generic failure, collapsing FR-037's three distinguishable causes into one
- [X] T009 Add `nfc_manager` to `../mobile_app/pubspec.yaml`; add `android.permission.NFC` and `<uses-feature android:name="android.hardware.nfc" android:required="false"/>` to the Android manifest, and the `com.apple.developer.nfc.readersession.formats` entitlement plus `NFCReaderUsageDescription` to iOS (research R5). `required="false"` is load-bearing — devices without NFC must still install and use the QR path

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The cutover, the lifecycle change, and the warehouse reference data. Every user story depends on this phase.

**⚠️ CRITICAL**: This phase contains **two changes that each land as their own commit, alone** — see the sub-phase warnings.

### 2A — The cutover (research R12)

**⚠️ Lands alone. This is a flag day.** The embedded per-driver truck is deleted, not migrated. Nothing below works until this is green.

- [X] T010 Delete the embedded `Truck` class, `TruckSchema`, and the `truck` property from `src/modules/users/schemas/user.schema.ts` (FR-043). Keep `UserSchema.index({ location: '2dsphere' })` — drivers still report position and are still ranked by proximity
- [X] T011 Delete `PATCH /users/:id/truck` from `src/modules/users/users.controller.ts`, `updateTruck` from `src/modules/users/users.service.ts`, and `src/modules/users/dto/update-truck.dto.ts` (depends on T010)
- [X] T012 Remove the `'truck.maxCapacityLiters'` and `'truck.fuelTypes'` predicates from `DispatchService.findCandidates`'s `$geoNear` query in `src/modules/dispatch/services/dispatch.service.ts`, and from `assignDriver`'s booking `findOneAndUpdate`. **Delete them — do not relocate.** Capability now lives on the tank and is checked at tank selection (research R3) (depends on T010)
- [X] T013 Update the doc comment on `findCandidates` to record that the `$geoNear`/`$lookup` constraint no longer applies, so a future reader does not reintroduce denormalisation to solve a problem that no longer exists (depends on T012)
- [X] T014 Rewrite `seedTwoCompanies` in `test/utils/fixtures.ts` to stop creating drivers with embedded trucks. Leave truck/tank creation out for now — Phase 3 adds it once the collections exist (depends on T010)
- [X] T015 Update `scripts/seed-load-test.ts` for the removed embedded truck (depends on T010)
- [X] T016 Fix every e2e spec under `test/e2e/` that assigns a driver so the suite compiles and passes without embedded trucks. Assignment still takes only `driverId` at this point — Phase 4 changes that signature (depends on T014)

**Checkpoint 2A**: `npm run test && npm run test:e2e` green; `flutter test` at its known baseline. **Commit alone.**

### 2B — The `LOADING` lifecycle (research R8)

**⚠️ Lands alone — widest blast radius in the feature.** Every exhaustive switch over `OrderStatus` in three codebases. Dart's sealed-enum exhaustiveness turns most of the mobile half into compile errors, which is the cheapest way to find them.

- [X] T017 In `src/modules/orders/services/order-state.service.ts`'s `TRANSITIONS` table: **remove** `ASSIGNED_TO_DRIVER → IN_TRANSIT` (FR-046a), and add `ASSIGNED_TO_DRIVER → LOADING`, `LOADING → IN_TRANSIT`, `LOADING → CANCELLED` (FR-046d), and `LOADING → DELIVERED` with `requiresManualOverride: true` mirroring the existing `IN_TRANSIT → DELIVERED` force-complete edge (FR-046e)
- [X] T018 Remove the second `transition(... ASSIGNED_TO_DRIVER → IN_TRANSIT ...)` call from `assignDriver` in `src/modules/dispatch/services/dispatch.service.ts`. Assignment now stops at `ASSIGNED_TO_DRIVER` (FR-046a) (depends on T017)
- [X] T019 Allow force-complete from `LOADING` in `src/modules/orders/orders.controller.ts`'s `forceComplete` status guard, which currently accepts only `IN_TRANSIT` and `UNLOADING` (FR-046e) (depends on T017)
- [X] T020 Ensure `OrdersService.cancel` in `src/modules/orders/orders.service.ts` releases resources and is reachable from `LOADING` (FR-046d) (depends on T017)
- [X] T021 Add every `loading` case to `../mobile_app/lib/features/orders/presentation/constants/order_presentation.dart`: `statusLabel`, `statusColor` (groups with `inTransit`), `flowStep` (`OrderFlowStep.loading`), `statusProgress` (`0.62`, between assigned's `0.5` and in-transit's `0.75`), and `cardKindFor` (`OrderCardKind.inTransit`) (depends on T006)
- [X] T022 In `../mobile_app/lib/features/orders/presentation/constants/order_presentation.dart`, leave `OrderPresentation.isTrackable` returning **false** for `loading`, and add a comment explaining why: during loading the truck is driving to a depot, and the client's tracking map plots the driver against *their own station*, so showing it as progress toward the customer would be actively misleading (depends on T021)
- [X] T023 Add `loading` to `OrderFilter.inDelivery`'s status set in `../mobile_app/lib/features/orders/presentation/constants/order_presentation.dart` (depends on T021)
- [X] T024 Add `loading` to the driver's "In progress" tab in `../mobile_app/lib/features/delivery/presentation/view/driver_orders_screen.dart` (FR-046c) (depends on T021)
- [X] T025 [P] Add `order_status.loading` to `../mobile_app/assets/translations/en.json` and `ar.json`
- [X] T026 [P] Unit test `test/unit/order-state-loading.spec.ts`: `ASSIGNED_TO_DRIVER → IN_TRANSIT` is now **rejected**; the four new edges are accepted; `LOADING → DELIVERED` is rejected without `manualOverride` and accepted with it
- [X] T027 [P] Widget test `../mobile_app/test/unit/order_status_loading_test.dart`: a `loading` order renders a real label, colour and progress on both personas' surfaces — never blank, never falling through to a default
- [X] T028 Run `flutter analyze` in `../mobile_app/` and confirm **zero** unhandled-case errors remain anywhere — the compiler is the checklist for FR-046c (depends on T021, T024)

**Checkpoint 2B**: both suites green; no surface shows a `loading` order as unrecognised (SC-018). **Commit alone.**

### 2C — Warehouse reference data (research R1, R9)

**Purpose**: Platform-level infrastructure US2's assignment resolves against and US4's driver navigates to. Blocking for US2, so it lands here rather than inside US4.

- [X] T029 [P] Create `src/modules/warehouses/schemas/warehouse.schema.ts` per [data-model.md](./data-model.md): `name`, `location` (GeoPoint), `addressText`, `region`, `governorate`, `fuelTypes[]`, `isActive`, optional unique `externalRef`. **Carries neither `markTenantScoped` nor `markMultiParty`** — follow `Company`'s precedent for records with no tenant above them (research R1), and say so in a schema comment
- [X] T030 Add indexes to `warehouse.schema.ts`: `{ location: '2dsphere' }`, `{ fuelTypes: 1, isActive: 1 }`, and `{ externalRef: 1 }` unique-partial. Comment that the "second 2dsphere index" warning in `user.schema.ts` is **collection-scoped** and does not apply across collections (research R9) (depends on T029)
- [X] T031 Create `src/modules/warehouses/warehouses.service.ts` with `findNearestSupplying(location, fuelType)` using `$near` filtered to `isActive` and the grade (FR-035d) (depends on T030)
- [X] T032 Create `src/modules/warehouses/warehouses.controller.ts` and `warehouses.module.ts`: `GET /warehouses` open to every authenticated role; `POST`, `POST /bulk`, `PATCH`, `PATCH /:id/withdraw` restricted with `@Roles(UserRole.SUPER_ADMIN)` (FR-035c) (depends on T031)
- [X] T033 Implement idempotent bulk load in `warehouses.service.ts`, upserting on `externalRef` so re-loading the national dataset updates rather than duplicates (FR-035a) (depends on T032)
- [X] T034 Register `WarehousesModule` in `src/app.module.ts` (depends on T032)
- [X] T035 [P] E2E test `test/e2e/warehouses.e2e-spec.ts`: a `SUPER_ADMIN` creates and bulk-loads warehouses; a `FUEL_COMPANY_ADMIN`, `TRANSPORT_COMPANY_ADMIN`, `CLIENT` and `DRIVER` can each **read** them; none of the four can create, alter or withdraw one (FR-035c); a repeated bulk load with the same `externalRef` updates rather than duplicates
- [X] T036 [P] E2E test in `test/e2e/warehouses.e2e-spec.ts`: `findNearestSupplying` returns the nearest warehouse **supplying the requested grade**, skipping nearer ones that do not (SC-017), and returns nothing when none supplies it

**Checkpoint 2C**: both suites green. Warehouses readable by all, writable by CIRO only.

---

## Phase 3: User Story 1 - A transportation company registers its fleet (Priority: P1) 🎯 MVP

**Goal**: Trucks and tanks exist as individually identifiable, company-owned records, with cards paired and codes mintable.

**Independent Test**: Register three trucks and three tanks for one company, pair a card with each truck, and confirm all are listed and distinguishable, that a card already paired elsewhere is refused, and that a duplicate tank code is refused.

### Trucks

- [X] T037 [P] [US1] Create `src/modules/trucks/schemas/truck.schema.ts` per [data-model.md](./data-model.md): `companyId`, `plateNumber`, optional `model`, optional `nfcCardUid`, optional `qrToken`, `isActive`, optional `activeOrderId`. Carries `markTenantScoped` (research R2)
- [X] T038 [US1] Add indexes to `truck.schema.ts`: `{ companyId: 1, plateNumber: 1 }` unique; `{ nfcCardUid: 1 }` unique-partial (**FR-005's enforcement point**); `{ qrToken: 1 }` unique-partial; `{ activeOrderId: 1 }` unique-partial (**FR-012's enforcement point**, research R13); `{ companyId: 1, isActive: 1, activeOrderId: 1 }`. **`qrToken` carries no TTL or expiry field anywhere in the schema** — it does not expire on its own (FR-036h) (depends on T037)
- [X] T039 [US1] Create `src/modules/trucks/dto/` — `create-truck.dto.ts`, `update-truck.dto.ts`, `pair-card.dto.ts` — with `class-validator` rules (depends on T037)
- [X] T040 [US1] Create `src/modules/trucks/trucks.service.ts` with create, list (with an `available` filter), update, withdraw and restore. Withdrawal clears `isActive` but **never** `activeOrderId`, so a delivery in flight continues (FR-008) (depends on T039)
- [X] T041 [US1] Implement card pairing in `trucks.service.ts`, catching the **duplicate-key violation** on `nfcCardUid` and returning `409 CARD_ALREADY_PAIRED` — never a prior existence check, which two concurrent pairings would both pass (FR-005) (depends on T040)
- [X] T042 [US1] Implement `qrToken` mint/rotate and revoke in `trucks.service.ts` using a cryptographically random high-entropy secret. The token is **never derived from the truck's `_id`** — an id-bearing code would be forgeable and unrevocable (research R6) (depends on T040)
- [X] T043 [US1] In `src/modules/trucks/trucks.service.ts`, make card replacement clear `qrToken`, so a superseded credential cannot keep verifying (FR-036e) (depends on T041, T042)
- [X] T044 [US1] Create `src/modules/trucks/trucks.controller.ts` and `trucks.module.ts` with `@Roles(UserRole.TRANSPORT_COMPANY_ADMIN)`, per [contracts/rest-api-delta.md](./contracts/rest-api-delta.md). Responses expose `hasCard`/`hasCode` **booleans only** — never `nfcCardUid` or `qrToken`, except the mint endpoint's own response (FR-042) (depends on T042)
- [X] T045 [US1] Register `TrucksModule` in `src/app.module.ts` (depends on T044)

### Tanks

- [X] T046 [P] [US1] Create `src/modules/tanks/schemas/tank.schema.ts`: `companyId`, globally-unique `code`, `material`, `maxCapacityLiters`, `fuelTypes[]`, `isActive`, optional `activeOrderId`. Carries `markTenantScoped`
- [X] T047 [US1] Add indexes to `tank.schema.ts`: `{ code: 1 }` unique (FR-048b); `{ activeOrderId: 1 }` unique-partial (SC-024); `{ companyId: 1, isActive: 1, activeOrderId: 1, maxCapacityLiters: 1, fuelTypes: 1 }` serving the pre-filtered offered list (depends on T046)
- [X] T048 [US1] Create `src/modules/tanks/dto/` and `tanks.service.ts` with create, list, update, withdraw and restore. Catch the duplicate-key violation on `code` and return `409 TANK_CODE_IN_USE` **without naming which company holds it** (depends on T047)
- [X] T049 [US1] Implement the `forOrderId` filter in `tanks.service.ts`, pre-excluding tanks below the order's quantity or not permitted its grade — FR-016a requires the offered list and the acceptable set to agree (depends on T048)
- [X] T050 [US1] Create `src/modules/tanks/tanks.controller.ts` and `tanks.module.ts`; register in `src/app.module.ts` (depends on T049)
- [X] T051 [US1] Confirm `material` does **not** constrain `fuelTypes` anywhere in `src/modules/tanks/tanks.service.ts` or `src/modules/tanks/dto/` — it is recorded fact only (FR-048g) (depends on T048)

### Fixtures & tests

- [X] T052 [US1] Extend `seedTwoCompanies` in `test/utils/fixtures.ts` to create trucks and tanks per transportation company, replacing what T014 removed (depends on T044, T050)
- [X] T053 [P] [US1] E2E test `test/e2e/fleet-registration.e2e-spec.ts`: trucks and tanks are created and listed; a truck carries **no** capacity or grade fields; a duplicate plate within a company is refused; a duplicate tank code is refused
- [X] T054 [P] [US1] E2E test in `test/e2e/fleet-registration.e2e-spec.ts`: pairing a card already paired to another truck returns `CARD_ALREADY_PAIRED` and leaves **both** trucks unchanged (FR-005, SC-008); replacing a truck's card invalidates its previously minted code (FR-036e); **minting a code leaves the truck's NFC card still verifying** — the two coexist (FR-036d)
- [X] T055 [P] [US1] E2E test in `test/e2e/fleet-registration.e2e-spec.ts` — **the isolation test**: company B's admin requesting company A's truck or tank by id gets **404**, indistinguishable from non-existence, never 403 (FR-003, FR-048d, SC-011)
- [X] T056 [P] [US1] E2E test in `test/e2e/fleet-registration.e2e-spec.ts` — **the credential-secrecy test**: no list or detail response anywhere returns `nfcCardUid` or `qrToken`; only the mint endpoint returns a token (FR-042)
- [X] T057 [P] [US1] E2E test in `test/e2e/fleet-registration.e2e-spec.ts` — **the tank-has-no-credential test**: no tank endpoint accepts or returns an `nfcCardUid` or `qrToken` field, and the tank schema defines neither (FR-048c)

**Checkpoint US1**: a transportation company has a real fleet inventory with paired cards. Independently demoable.

---

## Phase 4: User Story 2 - An operator assigns a driver, a truck and a tank (Priority: P1)

**Goal**: Assignment records all three, pre-fills the driver's last truck, resolves a warehouse, and books every resource atomically.

**Independent Test**: Assign one order to a driver, truck and tank; confirm all three are recorded, that selecting a driver pre-fills their last truck, and that an unsuitable tank is never offered.

- [X] T058 [US2] Extend `src/modules/dispatch/dto/assign-driver.dto.ts` to require `truckId` and `tankId` alongside `driverId` (FR-009)
- [X] T059 [US2] In `src/modules/trucks/trucks.service.ts`'s list endpoint, distinguish **no trucks registered at all** from **trucks exist but none currently available**, returning a field (e.g. `fleetRegistered: boolean`) an operator-facing surface can use to say a fleet needs registering, rather than showing an unexplained empty picker (FR-043c)
- [X] T060 [P] [US2] E2E test `test/e2e/vehicle-assignment.e2e-spec.ts`: a transportation company with zero registered trucks gets `fleetRegistered: false` from the truck list, distinguishable from a company whose trucks all exist but are withdrawn or busy (FR-043c)
- [X] T061 [US2] Add `truckId`, `tankId`, `tankSummary`, `warehouseId`, `warehouseSummary` and `loadingConfirmedAt` to `src/modules/orders/schemas/order.schema.ts`, all optional and absent-safe (depends on T037, T046, T029)
- [X] T062 [US2] Add the index `{ driverId: 1, truckId: 1, createdAt: -1 }`, partial on `truckId` existing, to `order.schema.ts` — it serves the last-used-truck lookup and excludes pre-cutover orders (research R4) (depends on T061)
- [X] T063 [US2] In `DispatchService.assignDriver`, book the truck and tank inside the **existing** transaction via conditional `findOneAndUpdate` against their unique partial indexes, exactly as the driver is booked today. Return `TRUCK_UNAVAILABLE` / `TANK_UNAVAILABLE` when either is raced away (research R13, FR-012, FR-048f) (depends on T058, T061)
- [X] T064 [US2] Validate the tank against the order in `assignDriver` (`src/modules/dispatch/services/dispatch.service.ts`): capacity ≥ quantity else `TANK_CAPACITY_EXCEEDED` (FR-010); grade permitted else `TANK_GRADE_UNSUPPORTED` (FR-011) (depends on T063)
- [X] T065 [US2] Resolve the warehouse in `assignDriver` (`src/modules/dispatch/services/dispatch.service.ts`) via `WarehousesService.findNearestSupplying`, and refuse the assignment with `NO_WAREHOUSE_FOR_GRADE` when none supplies the grade — the **operator** is told, never the driver sent nowhere (FR-035f) (depends on T031, T063)
- [X] T066 [US2] Snapshot `tankSummary` (code, material) and `warehouseSummary` (name, addressText, location) onto the order inside the same transaction, matching the discipline `driverSummary`/`clientSummary` already follow — a later edit must not rewrite what was assigned (FR-035e) (depends on T065)
- [X] T067 [US2] In `src/modules/dispatch/services/dispatch.service.ts`, re-source `driverSummary.plateNumber` from the assigned `Truck` record rather than the deleted embedded truck. The customer-facing shape does not change (research R12) (depends on T063)
- [X] T068 [US2] Extend `releaseDriverIfAssigned` in `src/modules/orders/orders.service.ts` to release the truck and tank alongside the driver, and confirm it is called from delivery completion, cancellation and force-complete (FR-044) (depends on T063)
- [X] T069 [US2] Implement the last-operated-truck lookup in `DispatchService.getCandidates` (`src/modules/dispatch/services/dispatch.service.ts`), querying the most recent order carrying this `driverId` and a `truckId`. **Derived from order history — no `lastTruckId` field is added to `User`** (research R4) (depends on T062)
- [X] T070 [US2] In `src/modules/dispatch/services/dispatch.service.ts`, suppress the suggestion when that truck is withdrawn or already committed, returning `suggestedTruck: null` rather than an unusable one (FR-009c, FR-009d) (depends on T069)
- [X] T071 [US2] Add `PATCH /orders/:id/reassign-vehicle` to `src/modules/orders/orders.controller.ts`, permitted only before departure, releasing the old resources and booking the new ones in one transaction; `409 ALREADY_DEPARTED` afterwards (FR-015) (depends on T068)
- [X] T072 [P] [US2] Map `truckId`, `tankSummary`, `warehouseSummary` and `loadingConfirmedAt` in `../mobile_app/lib/features/orders/data/models/order_mapper.dart` and add them to the `Order` entity in `../mobile_app/lib/shared/entities/order.dart`, treating absence as normal; run `dart run build_runner build`
- [X] T073 [P] [US2] E2E test `test/e2e/vehicle-assignment.e2e-spec.ts`: assignment records driver, truck, tank and warehouse, and the order lands on **`ASSIGNED_TO_DRIVER`, not `IN_TRANSIT`** (FR-046a) — this is the behaviour change, and the test that proves the departure gate exists at all
- [X] T074 [P] [US2] E2E test in `test/e2e/vehicle-assignment.e2e-spec.ts`: a tank below capacity is refused with `TANK_CAPACITY_EXCEEDED` and one that cannot carry the grade with `TANK_GRADE_UNSUPPORTED`; neither is ever present in the `forOrderId` list (FR-016a, SC-025, SC-026)
- [X] T075 [P] [US2] E2E test in `test/e2e/vehicle-assignment.e2e-spec.ts` — **the concurrency test**: two simultaneous assignments naming the same truck; exactly one succeeds and the other gets `TRUCK_UNAVAILABLE` (SC-007). Repeat for a tank (SC-024)
- [X] T076 [P] [US2] E2E test in `test/e2e/vehicle-assignment.e2e-spec.ts`: `suggestedTruck` is the driver's last operated truck; **null** for a driver who has never driven (FR-009c); **null** when that truck is withdrawn or busy (FR-009d, SC-023)
- [X] T077 [P] [US2] E2E test in `test/e2e/vehicle-assignment.e2e-spec.ts`: assigning an order whose grade no warehouse supplies is refused with `NO_WAREHOUSE_FOR_GRADE` before any resource is booked (FR-035f)

**Checkpoint US2**: the operator's vehicle choice is recorded rather than inferred. Depends on US1 and Phase 2.

---

## Phase 5: User Story 3 - A driver cannot start until they verify the assigned truck (Priority: P1)

**Goal**: The delivery cannot begin without a successful verification of the assigned truck, by card or by code.

**Independent Test**: Assign a delivery, confirm it will not start by any other means, present a wrong vehicle's credential and confirm refusal, then verify the right one and confirm the trip begins.

### Backend

- [X] T078 [US3] Create the `VehicleVerification` subdocument in `src/modules/orders/schemas/order.schema.ts`: `stage`, `method`, `matched`, optional `presentedTruckId`, `at`, optional `driverLocation`, `actorId`; plus a `verifications[]` array defaulting to `[]`. **Store the resolved truck, never the raw credential** — an attempt log holding identifiers would be a harvestable list of valid credentials (data-model.md) (depends on T061)
- [X] T079 [US3] Create `src/modules/orders/dto/verify-vehicle.dto.ts` with `credential` and `method`. **No `stage` field** — the stage is derived from the order's status (research R7)
- [X] T080 [US3] Create `src/modules/orders/services/vehicle-verification.service.ts` that resolves a credential to a truck by `nfcCardUid` or `qrToken`, compares it to the order's `truckId`, appends the attempt, and transitions the order — all in one `ClientSession` transaction, so a recorded verification never exists against an unadvanced order (depends on T078)
- [X] T081 [US3] In `src/modules/orders/services/vehicle-verification.service.ts`, return `403 VEHICLE_MISMATCH` for both "resolved to a different truck" and "resolved to nothing". **Deliberately one code** — telling them apart would let a driver probe which cards exist (FR-018, Principle II) (depends on T080)
- [X] T082 [US3] In `src/modules/orders/services/vehicle-verification.service.ts`, record every attempt, failed included, before returning — a refusal must leave the delivery unchanged but the attempt visible (FR-019, FR-040) (depends on T080)
- [X] T083 [US3] In `src/modules/orders/services/vehicle-verification.service.ts`, refuse an out-of-sequence verification with `409` when the order's status has no verification pending, without re-running or advancing anything (FR-025) (depends on T080)
- [X] T084 [US3] Add `POST /orders/:id/verify-vehicle` to `src/modules/orders/orders.controller.ts` with `@Roles(UserRole.DRIVER)` and `@Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })`, matching the existing OTP verify endpoints (FR-023) (depends on T083)
- [X] T085 [US3] In `src/modules/orders/orders.controller.ts`, return the resolved `warehouseSummary` on a successful `DEPARTURE` verification — it is where the driver goes next (FR-026) (depends on T084)

### Mobile

- [X] T086 [P] [US3] Create the `NfcReader` **port** at `../mobile_app/lib/core/nfc/nfc_reader.dart` — `isAvailable()`, `readTagId()`, `stopSession()`. Domain-safe: no `nfc_manager` import (Constitution IV)
- [X] T087 [US3] Create the adapter `../mobile_app/lib/core/nfc/nfc_manager_reader.dart` — **the only file in the app that imports `nfc_manager`**. Read the tag identifier only; never parse NDEF, never write (depends on T009, T086)
- [X] T088 [US3] Register `NfcReader` as a lazy singleton in `../mobile_app/lib/core/di/injector.dart`, mirroring how `PhoneDialer` isolates `url_launcher` (depends on T087)
- [X] T089 [US3] Add `verifyVehicle` to the delivery datasource, repository and a `VerifyVehicle` use case under `../mobile_app/lib/features/delivery/{data,domain}/` (depends on T072)
- [X] T090 [US3] Create `VehicleVerificationCubit` and its freezed state at `../mobile_app/lib/features/delivery/presentation/cubit/`, with `idle(nfcAvailable)`, `reading`, `submitting`, `verified`, `mismatch`, `throttled`, `failure`; run `dart run build_runner build`. The cubit **never decides whether a credential matches** and **never holds a credential in state** — it exists only as a method parameter, as `OtpVerifyCubit` already handles OTP codes (FR-022, FR-042) (depends on T089)
- [X] T091 [US3] Register `VehicleVerificationCubit` as `registerFactoryParam` keyed by orderId in `injector.dart`, same lifecycle as `OtpVerifyCubit` (depends on T090)
- [X] T092 [US3] Build the verification screen at `../mobile_app/lib/features/delivery/presentation/view/vehicle_verification_screen.dart`: tap-card primary when `nfcAvailable`, scan-code otherwise, using the existing `MobileScanner` live preview. **`nfcAvailable == false` is a normal state on iOS**, not an error — present the code path with a plain explanation, never a broken button (research R5, FR-036a) (depends on T091)
- [X] T093 [US3] Gate the driver's active delivery on verification in `../mobile_app/lib/features/delivery/presentation/view/driver_home_screen.dart` and `delivery_detail_screen.dart`: at `ASSIGNED_TO_DRIVER` the only action is *Verify vehicle*, and every later step is unavailable (FR-017, FR-020) (depends on T092)
- [X] T094 [US3] Distinguish the three refusal causes in `../mobile_app/lib/features/delivery/presentation/view/vehicle_verification_screen.dart` — not-yet-verified, `VEHICLE_MISMATCH`, and unreachable-platform — as three **codes**, never three message strings. The unreachable case must make clear **nothing was recorded**, or a driver who thinks the attempt counted will not retry (FR-037, FR-021) (depends on T092)
- [X] T095 [P] [US3] Add `driver_verification.*` keys to `../mobile_app/lib/core/localization/translation_keys.dart` and both translation files
- [X] T096 [US3] Confirm no offline queue, retry buffer or attempt persistence exists in `../mobile_app/lib/features/delivery/presentation/cubit/vehicle_verification_cubit.dart` or its datasource (FR-021a) (depends on T090)

### Tests

- [X] T097 [P] [US3] E2E test `test/e2e/vehicle-verification.e2e-spec.ts`: a delivery will not start by any means until verified; the wrong truck's card returns `VEHICLE_MISMATCH` and leaves the order unchanged; the right card advances it to `LOADING` (FR-017, FR-018, SC-001, SC-002)
- [X] T098 [P] [US3] E2E test in `test/e2e/vehicle-verification.e2e-spec.ts`: the QR path produces an **identical** outcome to the card path (FR-036a, SC-016); a code presented for a different truck is refused exactly as a mismatched card is (FR-036b); a revoked code stops verifying immediately (FR-036g, SC-027)
- [X] T099 [P] [US3] E2E test in `test/e2e/vehicle-verification.e2e-spec.ts`: an unknown credential and a wrong-truck credential return the **same** `VEHICLE_MISMATCH` code, so existence cannot be probed (Principle II)
- [X] T100 [P] [US3] E2E test in `test/e2e/vehicle-verification.e2e-spec.ts`: a repeated verification at a completed stage is refused as out-of-sequence (FR-025); the 6th attempt inside the window is throttled (FR-023)
- [X] T101 [P] [US3] E2E test in `test/e2e/vehicle-verification.e2e-spec.ts`: every attempt records its `method`, so a scanned code is distinguishable from a tapped card afterwards (FR-036c); no stored attempt contains a raw credential
- [X] T102 [P] [US3] E2E test in `test/e2e/vehicle-verification.e2e-spec.ts` — **the session-continuity test**: verify departure, revoke the driver's session (spec 006 behaviour), sign in again, and confirm the delivery is still at `LOADING` with no re-verification required and no attempt lost (FR-045)
- [X] T103 [P] [US3] Unit test `../mobile_app/test/unit/vehicle_verification_cubit_test.dart`: the cubit submits and reflects without ever comparing; a failed submit leaves state unchanged and persists nothing (FR-021a, FR-022)
- [X] T104 [P] [US3] Integration test `../mobile_app/test/integration/driver_verification_test.dart`: an unverified delivery offers only *Verify vehicle*; a mismatch is retryable and leaves the stage visibly unchanged; the three refusal causes render distinguishably (SC-010)

**Checkpoint US3**: the feature's core assurance works. The MVP is Phase 2 + US1 + US2 + US3.

---

## Phase 6: User Story 4 - A driver loads at the warehouse and confirms (Priority: P2)

**Goal**: The driver is routed to the warehouse, sees the tank they are hauling, and confirms loading with a second verification — recording no quantity.

**Independent Test**: Start a verified delivery, confirm the destination is a warehouse and not the customer, confirm loading with no quantity asked for anywhere, and confirm routing switches to the customer's station.

- [X] T105 [US4] Add `POST /orders/:id/confirm-loading` to `src/modules/orders/orders.controller.ts` with `@Roles(UserRole.DRIVER)`, accepting an **empty body**. FR-028 forbids any quantity, and the DTO must have no numeric field to receive one (depends on T084)
- [X] T106 [US4] In `src/modules/orders/orders.controller.ts`, require the `LOADING`-stage verification to have succeeded before confirm-loading is accepted, returning `409 VEHICLE_NOT_VERIFIED` otherwise (FR-031) (depends on T105)
- [X] T107 [US4] In `src/modules/orders/orders.controller.ts`, transition `LOADING → IN_TRANSIT` and set `loadingConfirmedAt` on success (FR-032) (depends on T106)
- [X] T108 [US4] Audit `src/modules/orders/` and confirm nothing in the loading path records an actual volume; the order holds only the ordered quantity (FR-028a, FR-033) (depends on T107)
- [X] T109 [US4] In `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, show the warehouse as the destination at `LOADING`, from `warehouseSummary`, with navigation — reusing the existing map handoff (FR-026, FR-027) (depends on T093)
- [X] T110 [US4] In `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart`, show the assigned tank's **code and material** **from assignment onward**, not only after loading, reading `tankSummary` off the order with no separate fetch (FR-033a, FR-033b) (depends on T072)
- [X] T111 [US4] Add the *Confirm loading complete* action to `../mobile_app/lib/features/delivery/presentation/view/delivery_detail_screen.dart` — **a button, not a form**. No `TextField`, no numeric entry, anywhere in the flow (FR-028) (depends on T109)
- [X] T112 [P] [US4] Add `driver_loading.*` keys to `translation_keys.dart` and both translation files
- [X] T113 [P] [US4] E2E test `test/e2e/warehouse-loading.e2e-spec.ts`: after departure verification the delivery is at `LOADING` and carries a warehouse **supplying its grade** (SC-017); arrival at the customer is unavailable until loading is confirmed (FR-031); confirming advances to `IN_TRANSIT` (FR-032)
- [X] T114 [P] [US4] E2E test in `test/e2e/warehouse-loading.e2e-spec.ts`: the loading-stage verification refuses a credential that is not the assigned truck's, on the same rule as departure (FR-030)
- [X] T115 [P] [US4] E2E test in `test/e2e/warehouse-loading.e2e-spec.ts`: withdrawing a warehouse mid-delivery leaves that delivery pointed at it unchanged (FR-035e); no actual volume is recorded on any completed delivery (FR-028a)
- [X] T116 [P] [US4] E2E test in `test/e2e/warehouse-loading.e2e-spec.ts` — **the invoice-untouched test**: a delivery's invoice (amount, status, line items) is byte-identical before and after it passes through the loading stage (FR-034, SC-014)
- [X] T117 [P] [US4] Widget test `../mobile_app/test/unit/loading_no_quantity_test.dart` — **the absence test**: no `TextField` or numeric input exists on any screen in the loading flow (FR-028, SC-005a)
- [X] T118 [P] [US4] Integration test `../mobile_app/test/integration/driver_loading_test.dart`: a `LOADING` delivery shows the warehouse as destination and the tank's code and material; confirming loading switches routing to the customer's station

**Checkpoint US4**: the real-world journey is complete end to end.

---

## Phase 6A: US4 amendment — the loading read proves *where*, not just *which* (2026-08-27)

**Goal**: Close the hole FR-030 left open. The loading read presents the same card on the same
tractor that departure already verified, so on its own it could be satisfied without the driver
ever leaving the yard they started in. Geofencing it against the assigned warehouse is what turns
the second tap into the only evidence in the flow that the warehouse leg actually happened. See
research R14 and the 2026-08-27 clarification session.

**Independent Test**: Bring a delivery to `LOADING`, present the correct card from 4 km away and
from inside the depot; only the second confirms loading, and the refusals for wrong-place,
no-position and wrong-truck are three different answers.

- [X] T142 [US4] Add `verification.warehouseGeofenceRadiusMeters` to `src/config/configuration.ts` + `validation.ts` (`WAREHOUSE_GEOFENCE_RADIUS_METERS`, default 500) and document it in `.env.example` (FR-030b)
- [X] T143 [US4] Add `NOT_AT_WAREHOUSE` and `LOCATION_REQUIRED` to `src/common/enums/error-code.enum.ts`, with the reasoning for why neither collapses into `VEHICLE_MISMATCH` (FR-030a, FR-030c)
- [X] T144 [US4] Add optional `driverLocation: GeoPointDto` to `src/modules/orders/dto/verify-vehicle.dto.ts` — optional on the wire because only one stage needs it and the stage is not the client's to declare (FR-030c) (depends on T143)
- [X] T145 [US4] Add `distanceMeters` to `VehicleVerification` in `src/modules/orders/schemas/order.schema.ts`, recorded on refusals as well as successes (FR-030d)
- [X] T146 [US4] In `src/modules/orders/services/vehicle-verification.service.ts`, geofence the `LOADING` stage against `order.warehouseSummary.location` using `haversineDistanceMeters`: `matched` requires the truck **and** the position; the credential is still answered first; a missing fix is refused before anything is recorded; the driver's stored streamed position is never used for the geofence (FR-030a, FR-030c) (depends on T142, T144, T145)
- [X] T147 [US4] Pass `dto.driverLocation` through `OrdersController.verifyVehicle` and return `distanceMeters` on a successful loading verification (depends on T146)
- [X] T148 [P] [US4] Update `test/utils/fixtures.ts` — export `DEFAULT_WAREHOUSE_LOCATION` and send it on `assignAndDepart`'s loading verify; update the two e2e files that run the sequence inline (`order-lifecycle`, `onboarding`) (depends on T146)
- [X] T149 [US4] E2E test `test/e2e/loading-geofence.e2e-spec.ts`: inside the radius confirms and records the distance; the right truck 4 km out is `403 NOT_AT_WAREHOUSE`, is recorded, and leaves `confirm-loading` refusing with `VEHICLE_NOT_VERIFIED`; no fix is `400 LOCATION_REQUIRED` and records nothing; a wrong card at the warehouse is still `VEHICLE_MISMATCH` (FR-018, FR-030a, FR-030c, FR-030d, SC-012) (depends on T148)
- [X] T150 [P] [US4] Add `PositionReader`/`PositionFix` (`../mobile_app/lib/core/location/position_reader.dart`) and its `GeolocatorPositionReader` implementation — the same seam shape as `NfcReader`, distinct from `LocationStreamService`'s throttled stream; register in DI (FR-030c)
- [X] T151 [US4] Thread `driverLocation` through the mobile chain — datasource, repository, `VerifyVehicle` usecase — and have `VehicleVerificationCubit` take a one-shot fix on every submit **without** short-circuiting locally when there isn't one (FR-030c, research R7) (depends on T150)
- [X] T152 [US4] Add `notAtWarehouse({double? distanceMeters})` and `locationUnavailable()` to `VehicleVerificationState`, map `NOT_AT_WAREHOUSE`/`LOCATION_REQUIRED` (and register both in `error_interceptor.dart`'s `_knownCodes`, or they are discarded before the cubit sees them), and render each as its own message in `vehicle_verification_screen.dart` — distance shown in km, dropped below 100 m (FR-037, SC-010) (depends on T151)
- [X] T153 [US4] Add a *Navigate to the depot* action to the `LOADING` destination card via a new `MapNavigator` seam (`../mobile_app/lib/core/utils/map_navigator.dart`, same shape as `PhoneDialer`), navigating by coordinate — T109 showed the address but never made it a destination (FR-027)
- [X] T154 [P] [US4] Bilingual keys for both refusals and the navigate action, in `translation_keys.dart` and both translation files
- [X] T155 [P] [US4] Extend `../mobile_app/test/unit/vehicle_verification_cubit_test.dart`: the fix travels with the attempt; a device with no fix still submits; `NOT_AT_WAREHOUSE` keeps its distance; `LOCATION_REQUIRED` is its own outcome; neither new state leaks a credential (depends on T152)

**Checkpoint 6A**: a delivery cannot record loading unless the driver was measurably at the depot,
and every attempt carries the distance that decided it.

---

## Phase 7: Operator override (US3 + US4 escape hatch)

**Goal**: An operator can advance a stage when a driver cannot reach the platform — recorded honestly as an attestation, never as proof.

**Independent Test**: Override a departure step with a reason; confirm the stage advances, the record shows an override with its author and reason, and the **customer is not told the vehicle was verified**.

- [X] T119 [US3] Create `src/modules/orders/dto/override-verification.dto.ts` requiring a `reason` string with a sensible minimum length (FR-047b)
- [X] T120 [US3] Add `POST /orders/:id/override-verification` to `orders.controller.ts` with `@Roles(UserRole.TRANSPORT_COMPANY_ADMIN)`, advancing exactly the one outstanding verification step — it MUST NOT skip a stage that has not been reached (FR-047a, FR-047g) (depends on T119)
- [X] T121 [US3] In `src/modules/orders/orders.controller.ts`, implement the override via `OrderStateService.transition`'s **existing** `manualOverride: true` + `overrideReason` options, which already write the reason, actor and timestamp into `statusHistory` (research R10) (depends on T120)
- [X] T122 [US3] Confirm the override path in `src/modules/orders/services/vehicle-verification.service.ts` writes **no** `VehicleVerification` record. This is what makes FR-047c structurally true rather than a naming convention: an overridden stage simply has no verification against it (depends on T121)
- [X] T123 [US3] In `src/modules/orders/orders.controller.ts`, restrict the override to an administrator of the transportation company carrying that order, refusing any other (FR-047e) (depends on T120)
- [X] T124 [US4] Add a `vehicleVerified` boolean to the customer-facing order read in `src/modules/orders/orders.controller.ts` that is **false when the stage was overridden** rather than verified (FR-047d) (depends on T122)
- [X] T125 [US4] Ensure `../mobile_app/lib/features/orders/presentation/view/order_detail_screen.dart` never presents `driverSummary.plateNumber` as *verified* for an overridden delivery — it reflects what was assigned, not what was proven (FR-047d) (depends on T124)
- [X] T126 [P] [US3] E2E test `test/e2e/verification-override.e2e-spec.ts`: an override advances the stage and records reason, author and time; it writes no verification record (FR-047c); an administrator of another transportation company is refused (FR-047e); overriding an unreached stage is refused (FR-047g)
- [X] T127 [P] [US4] E2E test in `test/e2e/verification-override.e2e-spec.ts` — **the honesty test, the one most likely to regress**: a client viewing an overridden order is **not** told the vehicle was verified (FR-047d, SC-020)

**Checkpoint Override**: a signal dead zone no longer halts a delivery, and the record says honestly what happened.

---

## Phase 8: User Story 5 - Everyone can see which vehicle is really carrying the order (Priority: P3)

**Goal**: The customer sees the verified vehicle; the operator can review every verification and override with time, place and method.

**Independent Test**: Complete a verified delivery and confirm the customer sees the real vehicle and the operator sees both verification events with their times, locations and methods.

- [X] T128 [US5] Include `verifications[]` on `GET /orders/:id` for the operator and the assigned driver **only** — never the customer (FR-039, FR-041) (depends on T078)
- [X] T129 [US5] In `src/modules/orders/orders.controller.ts`, include failed attempts alongside successful ones in that history (FR-040) (depends on T128)
- [X] T130 [US5] In `src/modules/orders/orders.controller.ts`, scope `tankSummary` to the driver and operator; the customer has no use for a trailer code (depends on T072)
- [X] T131 [US5] Show the verified vehicle to the customer on their order detail in `../mobile_app/lib/features/orders/presentation/view/order_detail_screen.dart`, honouring `vehicleVerified` (FR-038, SC-006) (depends on T124)
- [X] T132 [P] [US5] E2E test `test/e2e/verification-visibility.e2e-spec.ts`: the operator sees both verifications with time, driver location and method (FR-039, SC-009), and failed attempts alongside them (FR-040); a delivery with one verification and one operator override shows **both together**, distinguishably, when reviewed (FR-047f)
- [X] T133 [P] [US5] E2E test in `test/e2e/verification-visibility.e2e-spec.ts` — **the cross-read test**: a driver of another transportation company requesting that verification history gets nothing distinguishable from non-existence (FR-041, SC-011)
- [X] T134 [P] [US5] E2E test in `test/e2e/verification-visibility.e2e-spec.ts`: no customer-facing response ever contains `verifications[]`, `nfcCardUid`, `qrToken` or `tankSummary` (FR-042)

**Checkpoint US5**: the audit surface is complete.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T135 [P] **The image-path absence test**: static assertion in `../mobile_app/test/unit/verification_no_image_path_test.dart` that no file under the verification flow imports `image_picker` (FR-036i, FR-036j, SC-028). `image_picker` **is** already a dependency for profile pictures, so this is a real discipline, not an impossibility
- [X] T136 [P] RTL sweep in `../mobile_app/test/rtl_sweep_verification_test.dart`: the verification screen, the tank-details row and the warehouse destination render correctly in Arabic with a long tank code and a long warehouse address, with no clipped or overflowing text. The equivalent sweep found two real overflow bugs in specs 006 and 007
- [X] T137 [P] Audit every `onPressed: () {}` / `onTap: () {}` added by this feature and wire or remove each
- [X] T138 [P] Update `mobile_app/CLAUDE.md` §2 and §4 for the driver screens this feature added, and record that `OrderStatus` gained `loading`
- [X] T139 [P] Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` with the new endpoints and the changed assignment signature, so the canonical contract stays accurate
- [ ] T140 Run the full [quickstart.md](./quickstart.md) walkthrough against a live backend, starting with the Phase 0 cutover gate
- [ ] T141 From `ciro_fuel/` and `../mobile_app/`, confirm the regression baseline: backend `npm run test && npm run test:e2e` fully green, and `flutter test` still showing **exactly two** pre-existing non-green tests (`login_screen_golden_test` failing, `auth_session_test` skipped). A third is this work, not the pre-existing gap

---

## Dependencies & Execution Order

### Phase dependencies

```
Phase 1 (Setup)
   ↓
Phase 2A (Cutover) ⚠️ alone ──→ Phase 2B (LOADING) ⚠️ alone ──→ Phase 2C (Warehouses)
                                                                      ↓
Phase 3 (US1 Fleet) ──────────────────────────────────────────────────┤
                                                                      ↓
                                                        Phase 4 (US2 Assignment)
                                                                      ↓
                                                        Phase 5 (US3 Verification)  🎯 MVP ends here
                                                                      ↓
                                                        Phase 6 (US4 Loading)
                                                                      ↓
                                                        Phase 7 (Override)
                                                                      ↓
                                                        Phase 8 (US5 Visibility)
                                                                      ↓
                                                        Phase 9 (Polish)
```

### Commits that must land alone

- **Phase 2A** — the cutover is a flag day. Both suites green before anything is built on it.
- **Phase 2B** — the `LOADING` status touches every exhaustive switch in three codebases. Partial application is invisible breakage.

### Story dependencies

- **US1** depends only on Phase 2 — it is the MVP's first demoable increment.
- **US2** depends on US1 (trucks and tanks must exist) and Phase 2C (a warehouse must be resolvable).
- **US3** depends on US2 — there is nothing to verify against until a truck is assigned.
- **US4** depends on US3 — loading follows departure.
- **Override (Phase 7)** depends on US3 and US4 both existing, since it overrides either step.
- **US5** depends on US3 and US4 having written records to display.

### Parallel opportunities

- **Phase 1**: T001–T008 are all parallel; T009 is independent of the enums.
- **Phase 2C**: T029–T036 can proceed in parallel with Phase 3's fleet work — warehouses share no files with trucks or tanks.
- **Within US1**: the truck track (T037–T045) and the tank track (T046–T051) are independent until T052.
- **Within US3**: the backend track (T078–T085) and the mobile NFC port (T086–T088) are independent until T089.
- **All test tasks marked [P]** target distinct files and can run together.

---

## Parallel Example: User Story 1

```
Track A (trucks):  T037 → T038 → T039 → T040 → T041 → T042 → T043 → T044 → T045
Track B (tanks):   T046 → T047 → T048 → T049 → T050 → T051
                                    ↓ both complete ↓
                                        T052 (fixtures)
                                    ↓
Tests in parallel: T053 · T054 · T055 · T056
```

---

## Implementation Strategy

### MVP scope

**Phase 1 + Phase 2 + US1 + US2 + US3.** That delivers the feature's actual purpose: a real fleet,
a recorded vehicle choice, and a delivery that cannot start until the driver proves they are at the
assigned truck. US4's warehouse leg, the override, and US5's audit surface are all valuable
increments on top, but the assurance is complete without them.

### Incremental delivery

1. **Phase 2A alone** — cutover, both suites green. Nothing user-visible changes.
2. **Phase 2B alone** — `LOADING` exists and every surface recognises it. Still nothing user-visible,
   because no order can reach it yet.
3. **Phase 2C + US1** — operators can build a fleet. Demoable.
4. **US2** — assignment records all three. The behaviour change (no auto-advance to `IN_TRANSIT`)
   becomes visible here, and deliveries will *stall* at `ASSIGNED_TO_DRIVER` until US3 lands.
   **Do not deploy US2 without US3.**
5. **US3** — the gate works. MVP complete.
6. **US4 → Override → US5** — each independently demoable.

### The one sequencing trap

Between US2 and US3 the system is briefly incoherent: assignment stops advancing to `IN_TRANSIT`
(T018) but nothing yet exists to advance it. Deploying that pair separately would strand every
delivery at `ASSIGNED_TO_DRIVER`. They are separate *phases* for reviewability, not separate
*releases*.

---

## Notes

- **Tests are mandatory**, per the constitution's Development Workflow gate. The two **absence**
  tests (T117 no-quantity, T135 no-image-path) matter most: both requirements are satisfied by code
  that does not exist, and nothing but a test keeps them that way.
- **`VEHICLE_MISMATCH` is deliberately one code** for "wrong truck" and "unknown credential"
  (T081, T099). Splitting them would turn the endpoint into a credential oracle. `NOT_AT_WAREHOUSE`
  (T143) is not a split of it: it names no credential, and it is only ever reached by a driver
  holding their own assigned truck's card.
- **The override writes no verification record** (T122). That is the mechanism behind FR-047c, not a
  naming convention — code that later wants to show "how was this verified?" finds nothing, which is
  the correct answer for an overridden stage.
- **Dart's exhaustive switches are the checklist for FR-046c.** T028 is a compiler run, not a manual
  audit, and that is why the widest-blast-radius change in this feature is tractable.

**2026-08-27 — the test backlog closed.** T027, T035-T036, T053-T057, T060, T073-T077,
T097-T104, T113-T118, T126-T127, T132-T134, T136 and T139 were all outstanding — implementation
had shipped ahead of its own test layer. Writing them surfaced two real defects, both fixed in the
same pass:

- **`DispatchService.assignDriver` committed partial bookings on contention.** The
  driver/truck/tank booking loop `return`ed early from inside `session.withTransaction` on a
  failure, which resolves the callback normally and **commits** — so a truck-or-tank refusal after
  the driver step had already succeeded left that driver booked (`isAvailable: false`,
  `activeOrderId` set) against an order that was never assigned, with no release path (nothing
  keys off an order that doesn't exist). Fixed by throwing a `ResourceUnavailableError` inside the
  transaction instead, so the abort is real; caught outside and mapped to the same
  `TRUCK_UNAVAILABLE`/`TANK_UNAVAILABLE` responses as before. Caught by the new
  `test/e2e/vehicle-assignment.e2e-spec.ts` ("a refused assignment strands no resource it had
  already booked").
- **`OrdersController.findMine` (the client's order list) leaked the full verification trail.**
  `findOne` (detail) stripped `verifications`/`tankSummary` for a CLIENT; `findMine` spread the raw
  document with no stripping at all — so a customer's own order list returned driver GPS
  coordinates, timestamps, credential resolution methods and truck ids, the exact FR-042 leak the
  detail endpoint was built to prevent. Fixed by extracting the strip into one
  `toRoleScopedShape` helper both endpoints now call — a rule that lives at one endpoint is the
  same leak as no rule, since a customer's list and detail return the same documents. Caught by
  `test/e2e/verification-visibility.e2e-spec.ts` ("no customer-facing response carries the
  verification trail or the tank").

Verified: backend `npm run test` 127/127 unit, `jest --config test/jest-e2e.json --runInBand`
**47 suites / 235 tests** green (7 new backend e2e files: `warehouses`, `fleet-registration`,
`vehicle-assignment`, `vehicle-verification`, `warehouse-loading`, `verification-override`,
`verification-visibility`). Mobile `flutter test` **397 passing** (5 new files: `order_status_
loading_test`, `loading_no_quantity_test`, `driver_verification_test`, `driver_loading_test`,
`rtl_sweep_verification_test`), same two pre-existing non-green tests this repo already
documents. `specs/001-fuel-delivery-platform/contracts/rest-api.md` updated with the fleet/
warehouse/verification endpoints and the corrected assignment signature (T139).

**Still open**: T140 (the live-backend quickstart walkthrough) and T141 (confirming the
regression baseline against a live environment) both need real infrastructure this pass did not
have — same constraint every prior session in this feature recorded.
