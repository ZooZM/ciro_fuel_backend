# Implementation Plan: Driver App Backend Completion & Cross-Device Delivery Continuity

**Branch**: `013-driver-app-backend-completion` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-driver-app-backend-completion/spec.md`

## Summary

Close the driver app's remaining fabricated surfaces against the real platform, and make an in-flight
delivery belong to the driver rather than to the handset in their pocket.

The technical approach is dominated by four findings from Phase 0:

1. **`TrackingSocket` silently discards handlers registered before its connection exists** — every `on*`
   is `_socket?.on(...)` against a null socket. This is why no notification push has ever been delivered
   to either persona. It is fixed first, **alone**, because Story 3 is built differently before and
   after it and because its failure mode is invisible (research R1).
2. **Server-side session enforcement is free.** `TrackingGateway.locationUpdate` already loads the
   driver's document on every frame, and that document carries `sessionGeneration`. Comparing it to the
   handshake's stamped `sgen` costs zero extra I/O — which removes the only real objection to closing
   the hole where a displaced device keeps writing a truck's authoritative position (research R2).
3. **The driver's notification tabs describe a platform that does not exist.** Auditing every
   `notify` call site, a driver can receive exactly two notification types, both order-related — so
   "System" can never match and "Orders" equals "All". The tabs are removed, not wired (research R7).
4. **The blocked-driver report cannot be filed as a declaration.** A declared stop is written already
   resolved, suppresses detection, and notifies nobody — so the obvious reuse would make a driver who
   asks for help *less* visible than one who says nothing. It is a third origin, written unresolved and
   escalated immediately (research R5).

Everything else is connection work against capabilities that already exist: the platform already
returns `stopEvents` to drivers, `ProfileCubit` already serves driver identity, and
`DeliveryState.streaming` is already computed and thrown away.

## Technical Context

**Language/Version**: TypeScript 5.x (NestJS 10, `strict`) · Dart 3.x / Flutter 3.x · TypeScript 5.x
(React 18 + Vite, `strict`)

**Primary Dependencies**: NestJS, Mongoose, Socket.io + `@socket.io/redis-adapter`, BullMQ, ioredis ·
`flutter_bloc`, `freezed`, `dartz`, `get_it`, `dio`, `socket_io_client`, `geolocator`,
`flutter_local_notifications` · TanStack Query, react-i18next

**Storage**: MongoDB (replica set; transactions for state changes) · Redis (queues, cache, throttler,
scheduler leases, socket fan-out)

**Testing**: Jest unit + e2e (`--runInBand`, `MongoMemoryReplSet`) · `flutter test` (headless, scripted
Dio adapters, mocked sockets) · Vitest + Playwright

**Target Platform**: Linux server (GCE VMs, Docker Compose behind nginx — spec 012) · Android/iOS ·
evergreen browsers

**Project Type**: Multi-root — NestJS backend, Flutter mobile (two personas, one binary), React
dashboard

**Performance Goals**: No added per-frame I/O on the location path (research R2 requires the session
check to be free) · notification list loads progressively · push visible within 5 s (SC-008)

**Constraints**: No behaviour change to the client persona except regained notification pushes
(FR-042) · no new platform dependency · Redis-dependent paths must degrade, never crash (spec 012 Q7) ·
the mobile `NotificationType` enum is pinned to the backend's wire values by a parity test

**Scale/Scope**: 6 slices · ~5 driver screens touched · 3 codebases · 1 new REST endpoint, 1 new
notification type, 1 new stop origin, 0 new services

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Initial evaluation — PASS.**

| Principle | Assessment |
|---|---|
| **I. Strict Typing & No Magic Values** | `StopOrigin.BLOCKED` and the new notification type are enum members on all three sides, mirrored into the dashboard's const map (R10) and the mobile enum guarded by its existing parity test. The removed mock translation keys are deleted with their call sites. No literal introduced. |
| **II. Tenant Isolation & Security-First** | The feature *strengthens* this: R2 closes a path by which a revoked session keeps writing. The blocked report is written through the existing multi-party-scoped `Order`; the transporter lookup reuses `ORDER_STOP_UNRESOLVED`'s own `companyId: order.transportCompanyId` query. Mark-all-read is scoped by `recipientUserId` from the token, never a body parameter. No new endpoint widens a role. |
| **III. Centralized Error Handling** | Refusals from a displaced device go through the existing structured `SESSION_REVOKED` shape (REST) and the gateway's existing ack-with-`error` shape (socket) — no new error channel. Mobile keeps `Either<Failure, T>`. |
| **IV. Clean Architecture & UI/Logic Decoupling** | Stop events enter through the existing `Order` entity and `OrdersRepository`; the notification screen consumes the existing `NotificationsCubit`/use-case stack rather than fetching. Slice 0 is a change to a `core/realtime/` infrastructure class, which is where socket lifecycle already lives. No widget gains business logic. |
| **V. Transactional Integrity for State Changes** | The blocked report is a single conditional write on the order, following `declareStop`'s existing pattern, so a report racing the detection sweep cannot produce two open stops. Mark-all-read is one `updateMany` idempotent by construction. No operation added that could double-book or double-charge. |

**Backend binding constraints**: `server.ts` untouched as the entry point; no root `index.ts`; no new
local upload path (`sys_storge` unaffected); tenant scoping remains automatic. **Mobile**: layering
preserved — the new stop entity is `shared/entities/`, its parsing is `data/`, the screens stay
presentation-only. **Dashboard**: the change is a const map member, a translation key and a card
branch; functional components only.

**Post-design re-evaluation — PASS.** Complexity Tracking is empty; no deviation to record.

## Project Structure

### Documentation (this feature)

```text
specs/013-driver-app-backend-completion/
├── plan.md              # This file
├── spec.md              # 5 stories, 50 FRs, 14 SCs, 3 clarifications resolved
├── research.md          # 12 decisions (R1/R2/R7/R10 overturn an assumption)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # 16/16 pass
├── contracts/
│   ├── rest-api-delta.md
│   ├── realtime-contract.md
│   ├── mobile-integration.md
│   └── dashboard-integration.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (three repository roots)

```text
ciro_fuel/                                     # NestJS backend
├── src/common/
│   ├── enums/stop-origin.enum.ts              # + BLOCKED
│   ├── enums/notification-type.enum.ts        # + the blocked-report type
│   ├── guards/ws-jwt.guard.ts                 # authenticateSocket stamps sgen (R3)
│   └── interfaces/jwt-payload.interface.ts    # AuthenticatedUser gains sgen
├── src/modules/
│   ├── tracking/tracking.gateway.ts           # per-frame sgen check; touch reordered (R2)
│   ├── auth/auth.service.ts                   # force-disconnect displaced sockets (R2)
│   ├── common/realtime/realtime-gateway.service.ts  # disconnectUser()
│   ├── stop-detection/stop-detection.service.ts     # reportBlocked()
│   ├── orders/orders.controller.ts            # POST :id/stops/blocked
│   └── notifications/                         # PATCH /notifications/read-all
└── test/e2e/
    ├── session-displacement.e2e-spec.ts       # NEW — the Slice 1 trap (R12)
    ├── driver-blocked-report.e2e-spec.ts      # NEW
    └── notifications-read-all.e2e-spec.ts     # NEW

mobile_app/                                    # Flutter, both personas
├── lib/core/realtime/tracking_socket.dart     # Slice 0: handler registry (R1)
├── lib/shared/entities/order.dart             # + stopEvents
├── lib/shared/entities/stop_event.dart         # NEW
├── lib/shared/enums/stop_origin.dart           # NEW
├── lib/features/delivery/presentation/
│   ├── cubit/delivery_cubit.dart              # outstanding-stop derivation
│   ├── view/delivery_detail_screen.dart       # outstanding-stop banner (T020)
│   ├── view/driver_home_screen.dart           # untracked indicator (T021 — see
│   │                                          #   tasks.md Corrections: `streaming`
│   │                                          #   lives on DeliveryCubit, which the
│   │                                          #   detail screen's tree does not have)
│   ├── view/driver_notifications_screen.dart  # REWRITTEN against NotificationsCubit
│   ├── view/driver_navigation_screen.dart     # dead map controls removed
│   └── widgets/driver_navigation_bottom_sheet.dart  # "I cannot reach" → real report
├── lib/features/profile/presentation/view/driver_profile_screen.dart  # ProfileCubit
└── test/

web_dashboard/                                 # React
├── src/constants/stop-events.ts               # + BLOCKED (R10)
└── src/transport_company/orders/components/order-details/StopAlertCard.tsx
```

**Structure Decision**: Three existing roots, unchanged. This feature adds no directory and no module —
every change lands in a file that already exists, except four new mobile files (a stop entity, its enum,
and their tests) and three new backend e2e suites.

## Implementation Slices

Ordered by dependency and by failure visibility, not by spec priority (research R12).

### Slice 0 — The socket handler registry (lands alone)

`TrackingSocket` keeps a registry of `(event, handler)` pairs; `on*` records and attaches if a socket
exists; `connect()` attaches the registry to the socket it creates. Retires mobile debt #6 for both
personas.

**Exit**: both personas' suites green at their documented counts; a test proves a handler registered
*before* `connect()` fires after it. The client regains notification pushes — the one intended
client-visible change in the feature (SC-014).

### Slice 1 — Server-side displacement enforcement (backend only)

`authenticateSocket` stamps `sgen`; `locationUpdate` loads the driver *before* touching presence and
refuses on a generation mismatch; `AuthService.login` disconnects the displaced user's sockets after
bumping the generation.

**Exit**: `session-displacement.e2e-spec.ts` proves a displaced device reporting **from a different
location** changes neither the truck's position nor `lastMovedAt`. Without the different location the
test proves nothing — the displacement threshold would have rejected the frame anyway (R12).

### Slice 2 — Delivery continuity (US1)

`StopEvent` on the mobile `Order`; the outstanding-stop derivation mirroring the platform's own filter;
the stop-reason sheet reachable from the delivery screen; `DeliveryActive.streaming` rendered.

**Exit**: an outstanding stop is answerable on a device that never received the alert.

### Slice 3 — The driver's notification centre (US3)

`DriverNotificationsScreen` rewritten against `NotificationsCubit`; the three tabs removed (R7);
`PATCH /notifications/read-all` added and wired.

### Slice 4 — The blocked-driver report (US5a)

`StopOrigin.BLOCKED` + `reportBlocked()` + the endpoint + the notification type; the mobile control
wired to it; the dashboard's const map, translation key and card branch.

### Slice 5 — Identity and dead controls (US4 + US5b)

`DriverProfileScreen`'s card on `ProfileCubit`; mock translation keys deleted; the navigation view's
inert map controls and live-map pretence removed; the support call button wired; driver terms and app
version.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)* | | |
