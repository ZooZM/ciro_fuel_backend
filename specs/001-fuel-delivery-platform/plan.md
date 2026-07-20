# Implementation Plan: Multi-Tenant B2B Fuel Delivery Logistics Platform

**Branch**: `001-fuel-delivery-platform` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-fuel-delivery-platform/spec.md`

## Summary

A multi-tenant SaaS backend for B2B fuel delivery logistics. Fuel stations (CLIENT) order fuel; company admins (COMPANY_ADMIN) price and approve orders; the system auto-dispatches the nearest capable driver (DRIVER) using geospatial queries; payment is confirmed via Sadad/Mada webhooks; delivery closes through a two-step OTP proof-of-delivery flow with live location tracking in between. Tenant isolation is enforced automatically at the data layer (`companyId` scoping via a global Mongoose plugin fed by request-scoped context), RBAC via a `RolesGuard` over four roles, and race-prone operations (driver assignment, payment webhooks) run inside MongoDB multi-document transactions.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20 LTS

**Primary Dependencies**: NestJS 10 (`@nestjs/core`, `@nestjs/mongoose`, `@nestjs/jwt`, `@nestjs/passport`, `@nestjs/websockets`, `@nestjs/platform-socket.io`, `@nestjs/throttler`, `@nestjs/schedule`, `@nestjs/config`, `@nestjs/bullmq`), Mongoose 8, Socket.io 4, BullMQ, Helmet, Multer, class-validator/class-transformer, bcrypt

**Storage**: MongoDB 7 with replica set enabled (required for multi-document ACID transactions); Redis 7 (BullMQ delayed jobs — payment timeouts; future Socket.io adapter); local file uploads on disk under `sys_storge/` (exact name mandated)

**Testing**: Jest + Supertest (e2e), `mongodb-memory-server` in replica-set mode for transaction-capable integration tests

**Target Platform**: Linux server (Docker container); CI/CD via GitHub Actions

**Project Type**: Single backend web service (REST API + WebSocket gateway)

**Performance Goals**: Dispatch decision ≤ 5 s after approval (SC-005); location updates propagated ≤ 10 s (SC-006); 50 tenants / 500 concurrent users without degradation (SC-008)

**Constraints (binding, from user)**:
- Entry file MUST be `src/server.ts` → compiles to `dist/server.js`. NO `index.ts`/`index.js` at root — enforce via `nest-cli.json` `entryFile: "server"` and `package.json` `main`/`start` scripts.
- Upload directory MUST be exactly `sys_storge` (repo root, gitignored, volume-mounted in Docker).
- Clean Architecture: Modules / Services / Controllers / Interfaces / DTOs / Guards / Interceptors separation throughout.
- Tenant isolation MUST be automatic (global mechanism reading `companyId` from JWT), not per-query developer discipline.
- Transactions (`ClientSession`) MANDATORY for driver assignment and payment-webhook confirmation.
- Tracking updates: displacement > 50 m OR heartbeat every 3 min — no per-second polling.
- Security middleware: JWT auth, Helmet, ThrottlerModule rate limiting.

**Scale/Scope**: ~10 modules, 4 roles, order lifecycle of 7 sequential states + 2 terminal states (9 total), ~35 REST endpoints + 1 WebSocket namespace

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unratified template (placeholders only) — no project-specific gates exist. Applying general defaults, all pass:

| Gate | Status | Note |
|------|--------|------|
| Single project, no speculative layers | ✅ PASS | One NestJS service; no microservices split, no CQRS/event-sourcing |
| Every abstraction traces to a requirement | ✅ PASS | Plugin→FR-002, Guard→FR-003, transactions→FR-012/FR-015, state machine→FR-006 |
| Test-first friendly design | ✅ PASS | State machine, dispatch, and OTP logic isolated in injectable services |
| Observability | ✅ PASS | Nest Logger + structured audit trail (status history, OTP attempts, webhook log) |

**Post-Phase-1 re-check**: ✅ PASS — design added no unjustified complexity (see Complexity Tracking: empty).

## Project Structure

### Documentation (this feature)

```text
specs/001-fuel-delivery-platform/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── rest-api.md      # REST endpoint contracts
│   ├── websocket-events.md  # Socket.io namespace/events contract
│   └── payment-webhook.md   # Sadad/Mada inbound webhook contract
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── server.ts                      # Bootstrap (MANDATED name — no index.ts anywhere at root)
├── app.module.ts                  # Root module: config, throttler, mongoose, feature modules
├── config/
│   ├── configuration.ts           # env → typed config (db uri, jwt, otp, payment, storage)
│   └── validation.ts              # env schema validation at boot
├── common/
│   ├── enums/
│   │   ├── user-role.enum.ts      # SUPER_ADMIN | COMPANY_ADMIN | CLIENT | DRIVER
│   │   └── order-status.enum.ts   # 9-value lifecycle enum (7 sequential + REJECTED/CANCELLED)
│   ├── interfaces/
│   │   ├── jwt-payload.interface.ts
│   │   └── tenant-context.interface.ts
│   ├── context/
│   │   └── tenant-context.service.ts   # AsyncLocalStorage store: { userId, role, companyId }
│   ├── plugins/
│   │   └── tenant-scope.plugin.ts      # Global Mongoose plugin: injects companyId filter/field
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   ├── roles.guard.ts              # RolesGuard (FR-003)
│   │   └── ws-jwt.guard.ts             # Socket handshake auth
│   ├── interceptors/
│   │   └── tenant-isolation.interceptor.ts  # Seeds TenantContext from request.user
│   ├── decorators/
│   │   ├── roles.decorator.ts          # @Roles(...)
│   │   ├── public.decorator.ts         # @Public() — skip JWT (login, webhook)
│   │   └── current-user.decorator.ts
│   ├── filters/
│   │   └── http-exception.filter.ts    # Uniform error shape; 404-not-403 for cross-tenant (FR-002)
│   └── pipes/
│       └── object-id.pipe.ts
├── modules/
│   ├── auth/                      # login, refresh, JWT issuing
│   ├── companies/                 # SUPER_ADMIN: tenant CRUD + suspension; fuel base prices
│   ├── users/                     # COMPANY_ADMIN: client/driver accounts, activation
│   ├── trucks/                    # trucks with maxCapacity, driver linkage
│   ├── orders/                    # order CRUD, state machine service, pricing, OTP proof-of-delivery
│   ├── dispatch/                  # geospatial candidate query + transactional assignment
│   ├── payments/                  # webhook controller (idempotent, transactional), payment records
│   │   └── queues/                # BullMQ: payment-timeout delayed jobs + processor
│   ├── tracking/                  # Socket.io gateway: driver location in, watcher rooms out
│   │   └── presence/              # lastSeenAt refresh + 60s offline sweep cron (6-min threshold)
│   ├── notifications/             # in-app notifications (no-driver, final price, timeout…)
│   └── files/                     # Multer upload to sys_storge/, validated, tenant-scoped access
sys_storge/                        # MANDATED upload dir (gitkeep + gitignore contents)
test/                              # e2e specs (jest + supertest + mongodb-memory-server)
Dockerfile
docker-compose.yml                 # app + mongo single-node replica set + redis (BullMQ)
.github/workflows/ci.yml           # lint → test → build → docker image
nest-cli.json                      # entryFile: "server"
```

Each module follows the same internal shape: `*.module.ts`, `controllers/`, `services/`, `dto/`, `schemas/`, `interfaces/`.

**Structure Decision**: Single NestJS project. Multi-tenancy, RBAC, and cross-cutting security live in `src/common/` and are registered globally in `app.module.ts` (`APP_GUARD` for JWT+Roles+Throttler, `APP_INTERCEPTOR` for tenant context, global Mongoose plugin via connection factory). Business capabilities are vertical modules under `src/modules/`, matching the spec's user stories: orders+dispatch+payments+tracking (US1–US4), companies+users+trucks+files (US5).

## Core Design Decisions (summary — full rationale in research.md)

1. **Tenant isolation (FR-001/002)** — `TenantIsolationInterceptor` seeds an `AsyncLocalStorage`-backed `TenantContextService` from the validated JWT; a **global Mongoose plugin** adds `companyId` to every query filter, insert, update, aggregate `$match`, and count for schemas marked tenant-scoped. `SUPER_ADMIN` context skips injection. Cross-tenant fetches surface as 404 (not 403) so existence is never leaked.
2. **RBAC (FR-003)** — `@Roles()` metadata + `RolesGuard` (global, after JWT guard). Route handlers never re-check roles manually.
3. **Order state machine (FR-006)** — `OrderStateService` owns a transition map: `PENDING_APPROVAL → APPROVED → ASSIGNED_TO_DRIVER → PENDING_PAYMENT → IN_TRANSIT → UNLOADING → DELIVERED`, plus sanctioned edges `PENDING_PAYMENT → APPROVED` (30-min timeout), `PENDING_APPROVAL → REJECTED`, and `→ CANCELLED` per FR-009. Every transition appends `{from, to, actorId, actorRole, at}` to `statusHistory`. Illegal transitions throw a domain error → 409.
4. **Smart dispatch (FR-011/012)** — truck capabilities (`maxCapacityLiters`, `fuelTypes`) are **denormalized into the driver's User document** (updated whenever the truck is assigned/edited), so the candidate query is a single `$near`-sorted read with **no `$lookup`** (which cannot combine with `$near`): active + online + available drivers of the company, `truck.maxCapacityLiters ≥ quantity`, `truck.fuelTypes ∋ order.fuelType`, sorted by `$near` on driver `location` (2dsphere). Assignment runs in a **transaction**: `findOneAndUpdate` the driver with `{isAvailable: true} → {isAvailable: false, activeOrderId}` guarded by the same condition; if it returns null (raced), try next candidate. A **partial unique index** on `users.activeOrderId` (when set) is the DB-level backstop against double-booking.
5. **Payment webhook (FR-014/015/015a)** — `@Public()` endpoint verifying gateway HMAC signature; **unique index on `gatewayTransactionId`** + transactional `findOneAndUpdate(order, {status: PENDING_PAYMENT} → IN_TRANSIT)` gives exactly-once semantics; duplicates/out-of-sequence log to `payment_events` and return 200 (ack, no state change). 30-min timeout: **BullMQ delayed job** (Redis) enqueued with exact TTL on entry to `PENDING_PAYMENT`, removed on payment success/cancel; the processor transactionally releases the driver + reverts to `APPROVED` + notifies. Multi-instance safe (single Redis queue, atomic job claim) — no interval sweep.
6. **Two-step OTP PoD (FR-021–023, FR-025)** — 6-digit OTPs generated server-side, stored **hashed** (sha256 + per-order salt) in the order document with `{purpose: ARRIVAL|DELIVERY, expiresAt, usedAt, attempts}`; plaintext exposed only via client-facing endpoint/socket event; driver verify endpoints compare hashes, throttled (5 attempts / 15 min), invalidate on success. Driver responses never echo OTPs. **Emergency override**: `force-complete` endpoint (COMPANY_ADMIN only) transitions `IN_TRANSIT`/`UNLOADING → DELIVERED` in a transaction, releases the driver, and stamps the status-history entry `{manualOverride: true, reason}`.
7. **Tracking & presence (FR-016/017/024)** — Socket.io namespace `/tracking`; driver emits `location:update` (client app applies the 50 m / 3 min policy; server enforces by dropping updates < 50 m from last stored point unless ≥ 3 min elapsed), server updates `users.location` and rebroadcasts to room `order:{orderId}` — join guarded by tenant + role check (`ws-jwt.guard` + room authorization). **Every driver signal** (handshake, any `location:update` — accepted or below-threshold, disconnect ping) refreshes `users.lastSeenAt` and sets `isOnline: true`. A lightweight `@nestjs/schedule` cron (every 60 s) sweeps `{role: DRIVER, isOnline: true, lastSeenAt: {$lt: now − 6 min}}` → `isOnline: false`, excluding them from dispatch; reconnection flips them back automatically. The sweep never touches order state.
8. **Files (FR-020)** — Multer disk storage to `sys_storge/{companyId}/…`, MIME + 10 MB validation, download route re-checks tenant scope.

## Complexity Tracking

> No constitution violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
