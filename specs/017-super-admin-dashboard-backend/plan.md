# Implementation Plan: Platform Operator (Super Admin) Dashboard — Backend Integration

**Branch**: `017-super-admin-dashboard-backend` | **Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/017-super-admin-dashboard-backend/spec.md`

## Summary

Finish the platform operator's dashboard surface. Features 013 and 016 wired two of its sub-modules;
every other operator screen is a static mock-up. This feature connects each remaining screen to real
platform data and builds the missing backend capability where a screen asks for something the
platform cannot answer.

**The research changes the size and shape of the work substantially.** Verification against the
codebase found that much of what the spec describes as missing is already built and already correct
for this role, while three things the spec treats as simple are not:

- **Stories 3, 6 and 7 are mostly already done.** The operator already receives every order on the
  platform, already gets the full restricted record, already gets the supplier-invoice section
  correctly omitted when there is none, and already has a complete, role-agnostic notification and
  phone-change API. What remains is a bucket filter, a summary shape, one role on one decorator, and
  one widened lookup.
- **Story 8 has a trap.** `getConfirmedBalance` is **per-kind**, so recording a payout under a new
  kind would leave the cashback balance unchanged while every existing method kept returning a
  correct-looking number. The owed figure must be a new two-kind derivation (research R11).
- **Story 5 has the opposite trap.** The last-operated-truck derivation already exists in
  `DispatchService.getSuggestedTruck` — but it suppresses the answer when the truck is unavailable,
  because it is a pick-list suggestion. Calling it from a roster would make a driver whose truck is
  on a job right now show "no truck", collapsing the distinction FR-039b requires (research R8).
- **Story 1's three period figures do not share one basis**, and an early draft of this plan got it
  wrong in a way that would have shipped. Counting the order total over delivered orders only —
  which the spec's Assumptions say for value and volume — would make it equal the `COMPLETED` bucket
  and force the other five to zero, so the six-segment chart FR-006 requires could never sum. The
  order count is bounded by `createdAt` across every state; value and volume stay delivered-only.
  The response now states both bases rather than leaving them to be inferred (FR-001a).

The work is therefore weighted towards Stories 1, 4, 5, 6 and 8, with Stories 2, 3 and 7 being
small, high-value corrections — Story 2 most of all: a live defect on the operator's most-used
screen, fixed by one query parameter, which also gates Story 1's company chart.

**Technical approach**: rely entirely on the existing `SUPER_ADMIN` bypass in both scoping plugins
(verified to cover queries, `save`, `insertMany` **and** `aggregate`) rather than adding any new
unscoped mechanism. Add two collections for announcements with a BullMQ fan-out whose idempotency is
a unique index, not an application check. Add no migration — nothing existing is rewritten.

## Technical Context

**Language/Version**: TypeScript 5.7 (`strict`), Node.js · Dashboard: TypeScript + React 18 + Vite

**Primary Dependencies**: NestJS 10.4 · Mongoose 8.9 · `@nestjs/bullmq` 10.2 (BullMQ over Redis) ·
Passport/JWT · Joi config validation · Dashboard: TanStack Query, Zustand, Tailwind, react-i18next

**Storage**: MongoDB (replica set — transactions are mandatory for the payout, Constitution V) ·
Redis (BullMQ, throttler counters, socket adapter) · GCS/local object storage for payout evidence

**Testing**: Jest (unit + e2e via `MongoMemoryReplSet`) · Vitest + Playwright (dashboard) ·
`flutter test` (mobile — non-regression gate only)

**Target Platform**: Linux server (GCE VMs behind nginx, per feature 012) · modern browsers

**Project Type**: Multi-tier web platform — NestJS REST API + React dashboard. **Spans two
repositories**: this backend and `E:\zeyad\web_dashboard_ciro_fuel`.

**Performance Goals**: no new per-request cost on any existing path. The platform overview is the
first cross-company aggregate on this platform and must be bounded — count/`$sum` aggregations over
indexed fields, never a full scan with application-side reduction. The driver roster derives the
last truck in **one** aggregate per page, never one query per row.

**Constraints**:
- No change to any non-operator role's visible behaviour (FR-075, SC-013) — a **negative**
  correctness condition, so it is asserted by baselines rather than by a feature test.
- No change to the transport administrator's tenant isolation key or the transporter-resolution
  query used by routing (FR-032).
- No driver location, trip history or per-driver aggregate on any operator surface, verified against
  **what the platform sends**, not what the screen renders (FR-043/FR-044, SC-014).
- No migration. This feature adds nothing to an existing document and rewrites nothing.

**Scale/Scope**: 8 user stories · 89 functional requirements · 14 success criteria · 3 clarifications
· ~14 operator screens across 8 dashboard sub-modules · 7 new backend routes, 4 changed, 2 new
collections, 1 new BullMQ queue. FR counts include the five added by the post-task consistency pass
(FR-001a, FR-016a, FR-026a, FR-026b, and the corrected FR-026).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

### Initial check — PASS

| Principle | Assessment |
|---|---|
| **I. Strict Typing & No Magic Values** | PASS. Every added set is a named value: `OrderStatusBucket` + `ORDER_STATUS_BUCKETS`, `FORCE_COMPLETABLE_STATUSES`, `AccountMovementKind.CASHBACK_PAID_OUT`, `AccountMovementDirection`, `AnnouncementDeliveryFailureReason`, `NotificationType.PLATFORM_ANNOUNCEMENT`. The feature also **removes** three existing magic-value violations: `forceComplete`'s inline stage list (repeated four times, once in prose), and the dashboard's hardcoded Arabic bucket labels and six invented stat figures. |
| **II. Tenant Isolation & Security-First** | PASS, and deliberately additive-free. The operator's platform-wide reach is the **existing** plugin bypass; this feature adds no `runUnscoped`, no second connection, no raw collection access, and changes neither plugin. Every new route is `@Roles(SUPER_ADMIN)` server-side, verified per capability (SC-012). |
| **III. Centralized Error Handling** | PASS. All refusals are Nest exceptions through the existing global filter with the existing `ErrorCode` enum. New codes for the payout refusals follow that shape; no ad-hoc `try/catch` swallowing, save the one deliberate duplicate-key catch in the fan-out processor, which is a documented idempotency mechanism. |
| **IV. Clean Architecture & UI/Logic Decoupling** | PASS. Backend keeps controller/service/DTO/guard separation; the announcement fan-out is a `@Processor`, not controller logic. Dashboard uses typed functional components with fetching in custom hooks (`usePlatformOverview`, `useDriverRoster`, `useTransportCompanies`). |
| **V. Transactional Integrity for State Changes** | PASS, and load-bearing twice. Transporter onboarding reuses the existing two-write `session.withTransaction` (FR-028). The cashback payout re-reads the owed balance **inside** its session (FR-069) and rests on a **partial unique index** for reference idempotency (FR-070) — "concurrency safety at the data layer, not assumed from application ordering". |

**Backend binding constraints**: `server.ts` untouched · no root `index.ts` · payout evidence goes
through the existing `FilesService`/object storage, so `sys_storge` behaviour is unchanged · tenant
scoping stays automatic via the global plugins.

### Post-design re-check — PASS

Re-evaluated after `data-model.md` and the three contracts. No violation found; **Complexity
Tracking is empty**. Three points the re-check surfaced, each resolved in the design rather than
carried as a deviation:

1. **`Announcement`/`AnnouncementDelivery` carry no scoping marker.** This looks like a Principle II
   departure and is not. Both are platform-level records whose author has no tenant — marking them
   `markTenantScoped` would make an announcement **unreadable by the operator who sent it**, since a
   `SUPER_ADMIN` has no `companyId` to match. This follows `Company`'s and `Warehouse`'s established
   precedent (spec 008 made the same call for `Warehouse` with the same reasoning). Access is
   enforced by `@Roles(SUPER_ADMIN)`, which is the correct enforcement point for a collection with
   exactly one legitimate reader.

2. **The fan-out processor must stamp `companyId` by hand.** A BullMQ worker has no request context,
   so `pre('save')` takes the anonymous bypass and stamps nothing. This is not a weakening of
   Principle II — it is the documented behaviour of a non-request actor — but it means the
   *recipient's* notification must be stamped explicitly or it becomes invisible to the
   tenant-scoped list query it was written for. Captured as a binding implementation constraint and
   as a test that authenticates **as the recipient**, not as the operator.

3. **`AccountMovementDirection` is response-only.** Adding a `direction` column to the schema would
   satisfy FR-064 more literally but would require migrating every existing row and would change a
   payload feature 013's dashboard already reads. Deriving it at serialisation satisfies the
   requirement (the direction is explicit on the wire) at no migration cost. Recorded as a design
   decision, not a deviation — Principle I is satisfied because the derived value is a named enum,
   not a string literal.

## Project Structure

### Documentation (this feature)

```text
specs/017-super-admin-dashboard-backend/
├── plan.md                              # This file
├── spec.md                              # 8 stories, 89 FRs, 14 SCs, 3 clarifications
├── research.md                          # Phase 0 — R1–R14
├── data-model.md                        # Phase 1
├── quickstart.md                        # Phase 1 — Parts 0–9
├── contracts/
│   ├── rest-api-delta.md                # routes: new, changed, and already-sufficient
│   ├── dashboard-integration.md         # screen-by-screen wiring and removals
│   └── isolation-contract.md            # the negative guarantees and how each is tested
├── checklists/
│   └── requirements.md                  # 16/16 passing
└── tasks.md                             # Phase 2 — created by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

```text
E:\zeyad\ciro_fuel_backend\
├── src/
│   ├── common/
│   │   ├── constants/
│   │   │   ├── order-status-buckets.ts          # NEW — OrderStatusBucket + the mapping (R3)
│   │   │   └── force-completable-statuses.ts    # NEW — lifted from the inline guard (R7)
│   │   ├── enums/
│   │   │   ├── period-figure-basis.enum.ts      # NEW — RAISED_IN_PERIOD / DELIVERED_IN_PERIOD
│   │   │   ├── account-movement-kind.enum.ts    # CHANGED — + CASHBACK_PAID_OUT
│   │   │   ├── account-movement-direction.enum.ts  # NEW — response-only
│   │   │   ├── announcement-state.enum.ts       # NEW
│   │   │   ├── announcement-delivery-failure-reason.enum.ts  # NEW
│   │   │   └── notification-type.enum.ts        # CHANGED — + PLATFORM_ANNOUNCEMENT
│   │   └── plugins/                             # UNTOUCHED — deliberately (isolation contract §1)
│   └── modules/
│       ├── platform/                            # NEW module — Stories 1 & 4
│       │   ├── platform.controller.ts           #   GET /platform/overview
│       │   │                                    #   GET /platform/transport-company-volumes
│       │   ├── platform-overview.service.ts
│       │   └── dto/platform-overview.dto.ts
│       ├── announcements/                       # NEW module — Story 6
│       │   ├── announcements.controller.ts
│       │   ├── announcements.service.ts
│       │   ├── announcement-fanout.queue.ts
│       │   ├── announcement-fanout.processor.ts # stamps companyId explicitly
│       │   ├── schemas/announcement.schema.ts
│       │   └── schemas/announcement-delivery.schema.ts
│       ├── companies/                           # CHANGED — Stories 2 & 4
│       │   ├── companies.controller.ts          #   + type/status query; + POST /transporters
│       │   ├── companies.service.ts             #   findAll takes a filter object
│       │   └── dto/onboard-transport-company.dto.ts   # NEW — parent REQUIRED
│       ├── orders/                              # CHANGED — Story 3
│       │   ├── orders.controller.ts             #   + bucket filter; + SUPER_ADMIN force-complete
│       │   ├── orders.service.ts                #   + getPlatformSummary
│       │   └── dto/platform-summary.dto.ts      # NEW
│       ├── drivers/                             # CHANGED — Story 5
│       │   ├── drivers.controller.ts            #   + GET /drivers/roster
│       │   └── driver-roster.service.ts         # NEW — one aggregate, projects truckId ONLY
│       ├── platform-account/                    # CHANGED — Story 8
│       │   ├── platform-account.controller.ts   #   + cashback owed/payout
│       │   ├── platform-account.service.ts      #   + getCashbackOwed, recordCashbackPayout
│       │   └── schemas/account-movement.schema.ts  # + partial unique index
│       ├── users/                               # CHANGED — Story 7
│       │   ├── users.service.ts                 #   + findAnyByPhone (role/active-agnostic)
│       │   └── services/phone-verification.service.ts  # uses it (FR-061)
│       └── auth/
│           └── auth.controller.ts               # CHANGED — + GET /auth/me/account
└── test/
    ├── unit/    order-status-buckets · driver-roster · cashback-payout · announcement-fanout
    └── e2e/     platform-overview · company-type-filter · order-buckets · transport-onboarding
                 driver-roster-privacy · announcements · operator-profile · cashback-payout

E:\zeyad\web_dashboard_ciro_fuel\        # branch 017-… must be CREATED
└── src/admin/
    ├── dashboard/      # Story 1 — remove 6 invented figures + all trend captions
    ├── petrol_companies/  # Story 2 — correct the false comment; count from filtered result
    ├── orders/         # Story 3 — 5 summary cards, bucket filter, absent-not-zero cards
    ├── transport_companies/  # Story 4 — list, detail, onboarding with REQUIRED parent select
    ├── drivers/        # Story 5 — remove tripsMonth/lastShipment/capacity; shared-table hazard
    ├── notifications/  # Story 6 — wiring only + announcement composer
    ├── profile/        # Story 7 — remove AdminProfilePermissions entirely
    └── payment/        # Story 8 — replace TOTAL_AMOUNT; make submit real
```

**Structure Decision**: The backend keeps its existing `src/modules/<domain>/` layout; two new
modules (`platform/`, `announcements/`) are added and six existing ones extended. The dashboard keeps
its `src/admin/<sub-module>/` layout with fetching in `hooks/` and clients in `api/`, matching the
convention feature 013 established in `petrol_companies/`. No structural change to either
repository.

### Implementation sequencing

Two ordering constraints follow from the research rather than from story priority:

**Story 2 lands first, alone.** It is a live defect, it is one query parameter, and Story 1's
company-type chart cannot be right until the platform can filter companies by type. It is also the
cheapest possible demonstration that the operator's screens are being made trustworthy.

**Story 5's roster and Story 8's payout each need their guard test written before the happy path.**
Both have a failure mode that produces a plausible, wrong, non-erroring result — a suppressed truck
that reads as "never driven", and a payout that appears to succeed while the owed balance does not
move. In both cases the passing happy-path test is exactly what a wrong implementation also
produces. The negative test is the one that decides correctness, which is why it is written first.

Stories 3, 6 and 7 are independent of one another and of the above. US4 additionally extends the
`platform` module US1 creates, so it follows US1 — which costs nothing, since US1 is P1 and US4 is
P2.

**Dashboard named constants land before any dashboard client.** Routes, statuses and query keys are
addressed through `apiRoutes.*`, `OrderStatusBucket` and `queryKeys.*` on this platform, and
Constitution I forbids literals for them in the web repository exactly as in the backend. Written
afterwards, every client would carry a string a later task has to find and undo.

**Where a screen is both wired and stripped, wire first.** Removing the mocked cards before
connecting the real ones leaves a blank screen and no signal that the wiring step is still
outstanding — the driver detail page is the one place both happen.

## Complexity Tracking

> No Constitution Check violations. This section is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | —          | —                                    |
