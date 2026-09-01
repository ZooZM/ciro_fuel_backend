# Implementation Plan: NFC Truck Verification & Warehouse Loading

**Branch**: `007-driver-home-delivery` (spec 008 authored on the 007 branch by explicit request) | **Date**: 2026-08-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-nfc-truck-loading/spec.md`

## Summary

Make the vehicle a verifiable participant in a delivery. A transportation company registers its
fleet as two separate things — **trucks** (tractors, each carrying an NFC card) and **tanks**
(trailers, each with a code, material, capacity and permitted grades) — and picks a driver, a truck
and a tank per order. A delivery cannot start until the driver physically verifies the assigned
truck, and it routes via a platform-registered fuel warehouse before the customer's station.

The technical shape follows from two clarification answers that removed more than they added.
Capacity and grade moved to the **tank**, and selection became **sequential** (driver → truck →
tank) — so the driver candidate query stops filtering on vehicle capability entirely, and the
`$geoNear`-cannot-follow-`$lookup` constraint that forced vehicles onto the driver record simply
stops applying (research R3). Separately, the driver records **no volume at all**; the authoritative
figure is an Aramco invoice reconciled asynchronously in a later feature, so nothing here touches
invoicing.

Two credentials resolve to a truck server-side: the card's identifier, and a rotatable random
`qrToken` that makes revocation a token rotation (R6). One new order status, `LOADING`, sits between
assignment and transit — the widest-blast-radius change in the feature (R8).

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`) on Node.js — NestJS backend, entry `src/server.ts`. Dart ≥3.11.5 / Flutter — mobile app.

**Primary Dependencies**: Backend — NestJS, Mongoose, Socket.io (`/tracking`), `@nestjs/throttler`. Mobile — `flutter_bloc`, `get_it`, `dio`, `freezed`, `dartz`, `go_router`, `easy_localization`, `mobile_scanner` (already present, live QR preview), **`nfc_manager` (new)**.

**Storage**: MongoDB with two global Mongoose scoping plugins plus AsyncLocalStorage tenant context. Transactions via `ClientSession`.

**Testing**: Backend — Jest unit (`npm run test`) + e2e against a real app instance (`npm run test:e2e`). Mobile — `flutter test` with `bloc_test`, `mocktail`, scripted `HttpClientAdapter`, mocked sockets.

**Target Platform**: Linux server; Android and iOS. **NFC availability is materially asymmetric** — Android reads 13.56 MHz identifiers freely; iOS requires a paid-account entitlement, cannot reliably read MIFARE Classic, and shows a system sheet per scan. The QR path is what keeps iOS viable (R5).

**Project Type**: Multi-tier platform — NestJS backend + Flutter mobile app. The React web dashboard (spec 003) has no code; operator-facing surfaces are API-only here.

**Performance Goals**: Verification round-trip within the spec's 10 s budget (SC-004) on a normal connection. Warehouse resolution is one indexed `$near` inside the existing assignment transaction. Candidate listing is unchanged — one `$geoNear` pass, now with fewer predicates.

**Constraints**: Verification is strictly online and server-decided — never queued, never device-judged (FR-021a, FR-022). No numeric volume input anywhere in the driver app (FR-028). No image-derived QR path (FR-036i/j). Pre-production cutover: the embedded per-driver truck is deleted, not migrated (FR-043).

**Scale/Scope**: 5 user stories · 97 functional requirements · 27 success criteria. Backend — 3 new collections (`Truck`, `Tank`, `Warehouse`), 1 new subdocument (`VehicleVerification`), 1 new `OrderStatus` value, ~5 new endpoint groups. Mobile — 1 new capability (NFC), 2 driver screens touched, plus every exhaustive `OrderStatus` switch in both personas.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design.*

### I. Strict Typing & No Magic Values — **PASS**

`LOADING` joins the `OrderStatus` enum; verification method becomes a `VerificationMethod` enum
(`NFC_CARD` | `QR_CODE`); tank material becomes a `TankMaterial` enum. New failure codes
(`VEHICLE_MISMATCH`, `VEHICLE_NOT_VERIFIED`, `TRUCK_UNAVAILABLE`, `TANK_UNAVAILABLE`,
`CARD_ALREADY_PAIRED`, `TANK_CODE_IN_USE`, `NO_WAREHOUSE_FOR_GRADE`) join `ErrorCode`. Mobile
mirrors each. No literal status, method, material or code is written inline.

### II. Tenant Isolation & Security-First — **PASS**

`Truck` and `Tank` carry `markTenantScoped`, so isolation is automatic and a cross-company read is
indistinguishable from non-existence (R2, FR-003/FR-048d). `Warehouse` is deliberately **unmarked**
— it holds no tenant data and every company loads from the same physical depots — following the
precedent `Company` already sets, with `@Roles(SUPER_ADMIN)` guarding writes (R1). Credentials
resolve server-side, so presenting another company's card is refused identically to presenting
nothing (R6), revealing no existence. Card identifiers and QR tokens are never returned to a driver
or a customer (FR-042).

### III. Centralized Error Handling — **PASS**

Every new failure is a typed `ErrorCode` thrown as a Nest exception and shaped by the existing
global filter. Mobile adds the codes to `error_codes.dart` and `_knownCodes` so they arrive as
branchable `ValidationFailure.code`, never string-matched. FR-037's three distinguishable refusal
causes are three distinct codes, not three message strings.

### IV. Clean Architecture & UI/Logic Decoupling — **PASS**

Backend gains `trucks/`, `tanks/`, `warehouses/` modules with the established
controller/service/DTO/schema separation. Mobile follows Presentation/Domain/Data: an
`NfcReader` **port** in the domain layer keeps `nfc_manager` out of it entirely, with the concrete
adapter in `data/` and injected via `get_it` — the same shape `PhoneDialer` and `SmsSender` already
use. Verification decisions live in a cubit, never in a widget.

### V. Transactional Integrity for State Changes — **PASS**

Booking a driver, truck and tank happens inside `assignDriver`'s **existing** `ClientSession`
transaction, each via conditional `findOneAndUpdate` against a unique partial index on
`activeOrderId` — the pattern already proven for drivers (R13). Two simultaneous assignments race at
the index; exactly one wins (SC-007, SC-024). Verification writes its record and transitions the
order in one transaction, so a recorded verification never exists against an unadvanced order.

### Platform-Specific Binding Constraints — **PASS**

Entry stays `src/server.ts`. No new upload paths (`sys_storge` untouched — QR codes are rendered
from a token, not stored as files). Tenant injection is via the global plugin for `Truck`/`Tank`.
Dispatch remains transactional.

**Gate result: PASS on all five principles and the platform constraints. Complexity Tracking is
empty — no violations to justify.**

*Post-Phase-1 re-evaluation: still PASS. The design added no unmarked tenant-scoped collection, no
hand-written `companyId` filter, no client-decided transition, and no new framework dependency in a
domain layer.*

## Project Structure

### Documentation (this feature)

```text
specs/008-nfc-truck-loading/
├── plan.md              # This file
├── research.md          # Phase 0 — 13 decisions
├── data-model.md        # Phase 1 — entities, indexes, state machine
├── quickstart.md        # Phase 1 — manual verification walkthrough
├── contracts/
│   ├── rest-api-delta.md        # New and changed endpoints
│   └── mobile-integration.md    # Driver-app contract, NFC/QR ports
├── checklists/
│   └── requirements.md  # Spec quality gate (PASS)
└── tasks.md             # Phase 2 — created by /speckit-tasks, NOT here
```

### Source Code (repository root)

```text
src/                                     # NestJS backend
├── common/
│   ├── enums/
│   │   ├── order-status.enum.ts         # + LOADING
│   │   ├── error-code.enum.ts           # + 7 codes
│   │   ├── verification-method.enum.ts  # NEW
│   │   └── tank-material.enum.ts        # NEW
│   └── plugins/                         # unchanged — Warehouse is deliberately unmarked
├── modules/
│   ├── trucks/                          # NEW — schema, service, controller, DTOs
│   ├── tanks/                           # NEW
│   ├── warehouses/                      # NEW — SUPER_ADMIN writes, all roles read
│   ├── orders/
│   │   ├── schemas/order.schema.ts      # + truckId, tankId, warehouse snapshot,
│   │   │                                #   verifications[], tankSummary
│   │   ├── services/order-state.service.ts   # + LOADING edges
│   │   └── orders.controller.ts         # + verify-vehicle, confirm-loading, override
│   ├── dispatch/services/dispatch.service.ts # driver+truck+tank booking; candidate
│   │                                          #   query drops capability filters
│   └── users/schemas/user.schema.ts     # − embedded Truck (deleted, R12)
└── server.ts                            # unchanged entry point

../mobile_app/lib/                       # Flutter
├── core/
│   ├── nfc/                             # NEW — NfcReader port + nfc_manager adapter
│   └── network/error_codes.dart         # + 7 codes
├── shared/enums/order_status.dart        # + loading
└── features/delivery/
    ├── domain/                          # verify-vehicle + confirm-loading use cases
    ├── data/                            # datasource, repository
    └── presentation/
        ├── cubit/vehicle_verification_cubit.dart   # NEW
        └── view/                        # verification screen; delivery detail shows tank

test/e2e/                                # backend e2e — new specs per story
../mobile_app/test/                      # unit + integration
```

**Structure Decision**: Extends the existing multi-tier layout rather than introducing anything new.
Three new backend modules follow the established
`schemas/ · dto/ · *.service.ts · *.controller.ts · *.module.ts` shape (`stations/` is the closest
model — a geo-bearing collection with its own module). On mobile, the driver-facing work stays in
`features/delivery/`, and NFC enters through `core/nfc/` as a port-and-adapter so the domain layer
never imports `nfc_manager` — mirroring how `core/utils/phone_dialer.dart` isolates `url_launcher`.

## Implementation Phasing

Ordered by dependency, not by story priority. **Two changes must land alone** — flagged below.

| Slice | Contents | Why here |
|---|---|---|
| **0 — Cutover** ⚠️ *lands alone* | Delete embedded `User.truck`, `PATCH /users/:id/truck`, `UpdateTruckDto`; update every fixture, seed and e2e that creates a driver | A flag day (FR-043a). Everything downstream assumes it. Both suites must be green after it and before anything is built on it. |
| **1 — Fleet** | `Truck`, `Tank` collections, modules, CRUD, card pairing, QR token mint/rotate | US1. Nothing can reference a truck by identity until this exists. |
| **2 — Warehouses** | `Warehouse` collection (unmarked), SUPER_ADMIN writes, bulk load, `$near` resolution | US4's destination. Independent of slices 1 and 3, so parallelisable. |
| **3 — Lifecycle** ⚠️ *lands alone* | `LOADING` status, transition-table edges, every exhaustive switch in backend + both apps | FR-046c. The widest blast radius; invisible breakage if partial. Dart's exhaustive switches make most of it a compile error. |
| **4 — Assignment** | `assignDriver` takes truck + tank; candidate query drops capability filters; last-truck suggestion; warehouse resolution; booking + release of all three | US2. Depends on 1, 2, 3. |
| **5 — Verification** | `verify-vehicle` endpoint, `VehicleVerification` records, rate limiting, mobile NFC port + QR path, driver verification screen | US3. The feature's core assurance. |
| **6 — Loading** | Confirm-loading (no volume), warehouse routing on the driver's active delivery, tank details display | US4. Depends on 5. |
| **7 — Override** | Operator override via existing `manualOverride`/`overrideReason`; honesty rule for customer-facing vehicle display | FR-047. Depends on 5 and 6 existing to override. |
| **8 — Visibility** | Verification history for the operator; customer sees verified vehicle | US5. Reporting over records slices 5–7 already write. |
| **9 — Polish** | RTL sweep, `image_picker`-absence audit, CLAUDE.md updates, regression baseline | — |

**Ordering note**: the slice numbers above are a dependency reading, not the execution order.
`tasks.md` sequences **Lifecycle before Fleet** — Phase 2B before Phase 3 — and that is the
authoritative order. The reason: `LOADING` is a prerequisite for slice 4 (Assignment), which Fleet
alone does not unblock, so placing it in the Foundational phase means both "lands alone" commits
clear before any user story begins. The original argument for the reverse — that `LOADING` should
arrive when there is something to load *with* — is a readability preference, not a dependency, and
it loses to keeping the two high-risk commits adjacent and early. Both still land alone, so the
risk-separation concern that motivated it is satisfied either way.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

The one design choice that *looks* like a deviation is `Warehouse` carrying neither scoping marker.
It is not a violation: `Company` already establishes the unmarked-global category for records that
sit outside the tenant hierarchy, and a warehouse holds no tenant data to isolate. Recorded in
research R1 with the alternatives considered.
