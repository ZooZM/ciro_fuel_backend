# Phase 0 Research: Multi-Tenant B2B Fuel Delivery Logistics Platform

**Date**: 2026-07-19 | **Plan**: [plan.md](./plan.md)

The Technical Context contained no `NEEDS CLARIFICATION` markers — the stack was fully mandated by the feature request. Research therefore focused on *how* to realize each mandated mechanism idiomatically in NestJS + Mongoose. Each item records Decision / Rationale / Alternatives.

## R1. Automatic tenant isolation mechanism

- **Decision**: Request-scoped tenant context in `AsyncLocalStorage` (seeded by a global `TenantIsolationInterceptor` after JWT validation) + a **global Mongoose plugin** that injects `companyId` into `find*`, `count*`, `update*`, `delete*`, `aggregate` (prepends `$match`) and sets `companyId` on `save`/`insertMany` for schemas opted in via `schema.set('tenantScoped', true)`. `SUPER_ADMIN` role in context ⇒ plugin no-ops.
- **Rationale**: The spec (FR-002) demands isolation "without relying on per-feature developer discipline". A query-layer plugin is the only single choke point all Mongoose operations pass through; the interceptor alone cannot see DB calls, and per-service filters are exactly the discipline-dependent approach being forbidden. `AsyncLocalStorage` (Node ≥ 16, stable) avoids NestJS request-scoped provider bubbling, which would force every service in the injection chain to be request-scoped (large perf + complexity cost).
- **Alternatives considered**: (a) NestJS `REQUEST`-scoped repositories — rejected: scope bubbling makes every dependent provider per-request, measurable overhead and breaks gateway/cron contexts. (b) Separate DB per tenant — rejected: spec mandates shared-DB/isolated-data model. (c) `mongoose-tenant` community packages — rejected: unmaintained against Mongoose 8; the plugin is ~100 LOC and must be auditable (security-critical).

## R2. RBAC enforcement

- **Decision**: `@Roles(...roles)` decorator writing `Reflector` metadata + global `RolesGuard` registered via `APP_GUARD` after `JwtAuthGuard`; `@Public()` decorator exempts login + payment webhook. WebSocket handshake authenticated by `WsJwtGuard` reusing the same JWT service.
- **Rationale**: Canonical NestJS pattern; global registration means forgetting a decorator fails closed (no `@Roles` ⇒ any authenticated user, and sensitive routes always declare roles; mutation routes will all carry explicit `@Roles`).
- **Alternatives**: CASL/ability-based authorization — rejected: 4 fixed roles with simple ownership rules don't justify an ability DSL; tenant scoping is already handled at the data layer.

## R3. Order state machine

- **Decision**: Plain TypeScript transition map inside `OrderStateService` (`Record<OrderStatus, OrderStatus[]>`), with a single `transition(orderId, to, actor, session?)` method that validates, appends to `statusHistory`, and saves — optionally inside a caller-provided `ClientSession`.
- **Rationale**: 8 states, ~10 edges; a hand-rolled map is fully testable and keeps the sanctioned-exception edges (payment-timeout reversion, terminal exits) explicit and reviewable against FR-006.
- **Alternatives**: XState — rejected: heavy for a linear-with-exceptions flow, awkward to bind into Mongo transactions. DB-level `$switch` update pipelines — rejected: business rules (who may transition) live in code, not storage.

## R4. Double-booking prevention (driver assignment)

- **Decision**: Inside `session.withTransaction()`: (1) `findOneAndUpdate({_id: driverId, isAvailable: true, companyId}, {$set: {isAvailable: false, activeOrderId}}, {session})` — null result ⇒ candidate raced away, try next; (2) order transition `APPROVED → ASSIGNED_TO_DRIVER` via state service in same session. Backstop: partial unique index `{activeOrderId: 1}` with `partialFilterExpression: {activeOrderId: {$exists: true}}`.
- **Rationale**: The conditional atomic update makes the availability check-and-set race-free even without the transaction; the transaction ties driver mutation + order mutation together (FR-012, mandated `ClientSession`); the partial index makes double-booking a hard DB error if any future code path bypasses the service.
- **Alternatives**: Optimistic versioning (`__v` checks) — rejected: more retry code for the same guarantee. Redis distributed lock — rejected: new infrastructure for a problem Mongo solves natively.

## R5. Payment webhook idempotency (Sadad/Mada)

- **Decision**: Verify HMAC signature header against per-gateway secret → upsert `payment_events` record keyed by **unique** `gatewayTransactionId` (duplicate key ⇒ already processed ⇒ ack 200, no-op) → `session.withTransaction()`: conditional order transition `PENDING_PAYMENT → IN_TRANSIT` + create `PaymentConfirmation`. Out-of-state confirmations (e.g., after timeout reversion) are recorded with `outcome: OUT_OF_SEQUENCE` and flagged for reconciliation (edge case in spec).
- **Rationale**: Unique index gives exactly-once across concurrent replays (FR-015); conditional transition gives correctness even if the same txn id never repeats but order state moved (FR-015a). Always ack 200 on duplicates so the gateway stops retrying.
- **Alternatives**: In-memory dedupe cache — rejected: not crash-safe, not multi-instance-safe.

## R6. Payment deadline (30 min) enforcement

- **Decision** *(revised in operational review)*: **BullMQ delayed job on Redis.** On entry to `PENDING_PAYMENT`, enqueue `payment-timeout` with `delay = 30 min` and `jobId = orderId` (idempotent enqueue); on payment success or cancellation, remove the job. The processor re-checks order state and runs the transactional release (driver freed, order → `APPROVED`, notifications emitted). `paymentDeadline` remains stored on the order for display and as a reconciliation cross-check.
- **Rationale**: Exact-TTL firing (no sweep granularity) and, critically, **multi-instance safety**: BullMQ's atomic job claim guarantees exactly one worker processes a timeout even with N app instances, whereas an `@nestjs/schedule` sweep runs on every instance and races itself when scaled horizontally. Redis is also the natural substrate for the future Socket.io adapter, so the dependency pays twice.
- **Alternatives**: `@nestjs/schedule` interval sweep — rejected: duplicate concurrent execution across instances requires leader election to fix, which is more machinery than BullMQ; minute-level granularity. Mongo TTL indexes — rejected: TTL deletes documents, cannot run business logic. The webhook still races the processor safely either way: both paths use conditional state transitions, so exactly one wins.

## R6a. Driver offline detection (presence sweep)

- **Decision**: Every driver signal (socket handshake, any `location:update` — including below-threshold rejections — and heartbeats) sets `lastSeenAt = now` and `isOnline = true` on the driver document. A lightweight `@nestjs/schedule` cron (60 s) performs one bulk `updateMany({role: DRIVER, isOnline: true, lastSeenAt: {$lt: now − 6 min}}, {$set: {isOnline: false}})`. Dispatch filters on `isOnline: true`. Reconnection restores eligibility automatically. The sweep never mutates orders (an in-progress delivery continues; staleness stays visible to watchers via `receivedAt`).
- **Rationale**: 6 minutes = two missed 3-minute heartbeats — a dead phone is distinguishable from one slow packet. This closes the dispatch blind spot where a driver with a dead device stays "available" forever. Unlike the payment timeout, this sweep is a single idempotent `updateMany` — running it on every instance concurrently is harmless (same result), so cron is appropriate here and BullMQ would be overkill.
- **Alternatives**: Socket.io `disconnect` event alone — rejected: transport disconnects are unreliable (dead radios don't FIN); the timestamp sweep catches all cases. Per-driver BullMQ delayed jobs — rejected: thousands of churning jobs for what one bulk update achieves.

## R7. Two-step OTP proof of delivery

- **Decision**: 6-digit numeric OTP from `crypto.randomInt`; stored in the order as `{purpose, hash: sha256(salt+otp), salt, createdAt, expiresAt: +30min, usedAt, attempts}`; plaintext returned ONLY on client-role endpoints/events (`GET /orders/:id/otp/current` + socket push). Driver submits via `POST /orders/:id/arrive` → generates ARRIVAL OTP; `POST /orders/:id/verify-arrival {otp}` → transition to `UNLOADING`; `POST /orders/:id/request-delivery-otp` / `POST /orders/:id/verify-delivery {otp}` → `DELIVERED` + driver released. Per-order attempt counter + Throttler on verify routes (5/15 min); re-arrival while an unused unexpired OTP exists returns the same record (no regeneration spam); once an OTP has expired, a repeat `arrive`/`request-delivery-otp` issues a fresh record with the attempt counter reset.
- **Rationale**: Hashing keeps OTPs unreadable even with DB read access; single-use + attempts counter satisfies FR-023; response DTOs for driver routes are explicit allowlists so OTP material can never serialize out.
- **Alternatives**: TOTP (time-based) — rejected: requires shared clock/secret UX that station staff don't have; random single-use codes are the standard delivery-verification pattern.
- **Emergency override (FR-025)**: `PATCH /orders/:id/force-complete` — COMPANY_ADMIN only, requires a `reason` string; transactionally transitions `IN_TRANSIT` or `UNLOADING → DELIVERED`, releases the driver, invalidates any active OTPs, and stamps the status-history entry `{manualOverride: true, reason, actorId}`. Rationale: B2B hardware failure at the station must not permanently strand a driver; restricting to the admin role with a mandatory audited reason keeps the OTP guarantee meaningful (SC-009 amended to count flagged overrides). Alternative rejected: SUPER_ADMIN-only override — too slow operationally; the tenant's admin owns the commercial risk.

## R8. Geospatial dispatch query (denormalized truck capabilities)

- **Decision**: GeoJSON `Point` fields (`users.location` for drivers, order `deliveryLocation`) with `2dsphere` indexes. Truck capabilities (`maxCapacityLiters`, `fuelTypes[]`, `plateNumber`) are **denormalized into the driver's User document** — written whenever a truck is assigned to or edited for a driver — making the candidate search one single-collection `$near` query: `{role: DRIVER, isActive: true, isOnline: true, isAvailable: true, 'truck.maxCapacityLiters': {$gte: quantity}, 'truck.fuelTypes': order.fuelType, location: {$near: …}}`.
- **Rationale**: MongoDB `$near` **cannot be combined with `$lookup`** (geo operators must run against the queried collection's index, and `$geoNear` must be the first aggregation stage — no join beforehand). Denormalization is therefore a correctness/performance requirement, not just an optimization: one index-served query returns distance-sorted, fully-filtered candidates. Write amplification is negligible (truck reassignment is rare, one driver = one truck in v1).
- **Alternatives**: Separate `trucks` collection + `$lookup` after `$geoNear` — rejected: post-join filtering discards nearest candidates already fetched, breaks index-only pagination, and is measurably slower. `$geoWithin` + app-side sort — rejected: loses native distance ordering. Fetch-then-filter in application code — rejected: unbounded candidate sets.

## R9. Real-time tracking transport & policy

- **Decision**: Socket.io namespace `/tracking`. Driver connection authenticated via JWT in handshake auth; server persists last point + timestamp on the driver doc and broadcasts `order:location` to room `order:{id}`. Server-side enforcement: incoming update dropped (acked `ignored`) if haversine distance from last stored point ≤ 50 m AND elapsed < 3 min — the displacement/heartbeat contract is enforced server-side, not trusted to clients. Every inbound driver frame (accepted or dropped) refreshes `lastSeenAt`/`isOnline` for presence (R6a).
- **Rationale**: Mandated stack; room-per-order maps 1:1 to the authorization unit (order visibility); server-side enforcement satisfies FR-016 even against misbehaving clients.
- **Alternatives**: Per-second ingestion with server sampling — explicitly forbidden by spec. Redis adapter for multi-instance fan-out — deferred until >1 app instance (documented as scaling note in quickstart).

## R10. File storage under `sys_storge`

- **Decision**: Multer `diskStorage` to `sys_storge/{companyId}/{uuid}{ext}`; allowlist MIME (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`), 10 MB cap; metadata persisted in a `files` collection (tenant-scoped) with owner/purpose; downloads streamed through an authorized controller route (never static-served), path always reconstructed from DB record — user input never touches the filesystem path.
- **Rationale**: Mandated directory name; routing downloads through the API keeps FR-020's tenant check enforceable and prevents path traversal.
- **Alternatives**: S3-compatible object storage — rejected: constraint mandates the local `sys_storge` directory; the `FilesService` interface isolates a future swap.

## R11. Entry point & build constraints

- **Decision**: `src/server.ts` bootstraps `AppModule` (Helmet, global pipes/filters, Swagger in non-prod). `nest-cli.json` sets `"entryFile": "server"`; `package.json`: `"main": "dist/server.js"`, `start:prod: node dist/server.js`. ESLint rule (`no-restricted-imports` + CI grep gate) ensures no root `index.ts`/`index.js` is introduced.
- **Rationale**: Hard constraint from the request; `entryFile` is the supported Nest mechanism.
- **Alternatives**: none applicable.

## R12. Testing strategy

- **Decision**: Unit tests (Jest) for state machine, tenant plugin, guards, OTP service, dispatch selection; integration/e2e (Supertest) against `mongodb-memory-server` configured as a single-node replica set so real transactions execute; dedicated cross-tenant isolation suite (two seeded companies, exhaustive 404 assertions) and concurrency suite (parallel dispatch of 2 orders / 1 driver; duplicate webhook replay; payment-timeout job racing a late webhook). Presence suite verifies the 6-min offline sweep (SC-010) and force-complete override auditing (SC-009). BullMQ tested against a real Redis service container in CI (ioredis-mock diverges on delayed-job semantics).
- **Rationale**: SC-002/003/004/007 are directly test-verifiable; memory-server replica-set mode is the standard way to test Mongoose transactions in CI without services.
- **Alternatives**: Testcontainers Mongo — heavier in GitHub Actions; memory-server is sufficient and faster.

## R13. Docker & CI/CD

- **Decision**: Multi-stage Dockerfile (deps → build → slim runtime on `node:20-alpine`, non-root user, `sys_storge` volume). `docker-compose.yml`: app + `mongo:7` with `--replSet rs0` + one-shot init container running `rs.initiate()` + `redis:7-alpine` (BullMQ). GitHub Actions workflow: entry-point guard → lint/unit/e2e (parallel) → build → docker build (image build verification only; no registry push configured yet — add one alongside a real deployment target).
- **Rationale**: Replica set is required even locally for transactions; single-node replica set is the accepted dev/CI pattern.
- **Alternatives**: MongoDB Atlas for dev — rejected: keep local dev offline-capable.

## R14. Realtime event delivery from non-gateway services (implementation addendum)

- **Decision**: `OrderStateService`, `OtpService`, and `NotificationsService` all need to push Socket.io events (`order:status`, `order:otp`, `notification:new`), but none of them live in `TrackingModule` (which owns the gateway and needs `Order`/`User` models — importing it back from `OrderCoreModule`/`NotificationsModule` would cycle). A tiny `@Global()` `RealtimeGatewayService` (`src/common/realtime/`) holds an optional reference to the Socket.io `Server` — `TrackingGateway.afterInit()` sets it once; every other service just injects the global service and calls `emitToOrderRoom()`/`emitToUser()`, which are silent no-ops before the gateway initializes (e.g. app bootstrap order, or in tests never touching sockets).
- **Rationale**: Keeps the leaf-module dependency graph acyclic (same shape as `OrderCoreModule` from R1-era planning) without a pub/sub broker for a single-process deployment. Every socket also joins a `user:{userId}` room on connect, so direct-to-user pushes don't need the gateway to track per-user socket ids itself.
- **Alternatives**: Inject the gateway class directly into those services — rejected, same circular-import problem, and couples business logic to the Socket.io gateway's full surface instead of two narrow emit methods. An event emitter / message bus — deferred: real overkill for one process; revisit only if the app goes multi-instance (see quickstart.md's Socket.io Redis adapter note, which this design slots into cleanly since `RealtimeGatewayService` only wraps `server.to(room).emit(...)`).
