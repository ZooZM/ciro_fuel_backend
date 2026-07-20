# Tasks: Multi-Tenant B2B Fuel Delivery Logistics Platform

**Input**: Design documents from `/specs/001-fuel-delivery-platform/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: INCLUDED — spec success criteria SC-002/003/004/007/009/010 mandate test-verified guarantees; strategy per research.md R12 (Jest unit + Supertest e2e on mongodb-memory-server replica set + real Redis for BullMQ).

**Organization**: Tasks grouped by user story (US1–US5 from spec.md) after Setup and Foundational phases.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 (user story phases only)

## Path Conventions

Single NestJS project at repo root: `src/`, `test/`, per plan.md structure. Entry file is `src/server.ts` — never `index.ts`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization honoring the binding constraints (server.ts entry, sys_storge, Docker, CI)

- [X] T001 Initialize NestJS 10 + TypeScript project at repo root: `package.json` (`"main": "dist/server.js"`, scripts `start:dev`/`start:prod` targeting server.ts/js), `tsconfig.json`, `nest-cli.json` with `"entryFile": "server"`, bootstrap in `src/server.ts` (Helmet, global ValidationPipe `{whitelist: true, forbidNonWhitelisted: true}`, versioned prefix `/api/v1`, rawBody enabled) and empty `src/app.module.ts`; delete any generated `src/main.ts`
- [X] T002 Install dependencies per plan.md Technical Context: `@nestjs/{mongoose,jwt,passport,websockets,platform-socket.io,throttler,schedule,config,bullmq}`, `mongoose`, `socket.io`, `bullmq`, `helmet`, `multer`, `class-validator`, `class-transformer`, `bcrypt`, `passport-jwt` + dev deps `jest`, `supertest`, `mongodb-memory-server`, `@types/*`
- [X] T003 [P] Configure ESLint + Prettier in `.eslintrc.js` / `.prettierrc`, including a lint guard that fails on any root-level `index.ts`/`index.js`
- [X] T004 [P] Create `docker-compose.yml`: app + `mongo:7 --replSet rs0` + one-shot `rs.initiate()` init service + `redis:7-alpine`; volume mount for `sys_storge`
- [X] T005 [P] Create multi-stage `Dockerfile` (deps → build → `node:20-alpine` runtime, non-root user, `CMD ["node", "dist/server.js"]`)
- [X] T006 [P] Create `.github/workflows/ci.yml`: lint → unit tests → e2e (mongo memory server + redis service container) → build → docker build; include grep gate failing the build if root `index.ts`/`index.js` exists
- [X] T007 [P] Create `sys_storge/.gitkeep` and gitignore its contents (directory name exact — binding constraint)
- [X] T008 [P] Create `src/config/configuration.ts` + `src/config/validation.ts` (env schema: PORT, MONGODB_URI, REDIS_URL, JWT_*, PAYMENT_*_SECRET, PAYMENT_DEADLINE_MINUTES=30, OTP_EXPIRY_MINUTES=30, STORAGE_DIR=sys_storge, THROTTLE_*) and `.env.example` per quickstart.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Multi-tenancy, auth, RBAC, base schemas, queues — nothing story-specific works without these

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T009 [P] Create shared enums and interfaces: `src/common/enums/user-role.enum.ts` (SUPER_ADMIN/COMPANY_ADMIN/CLIENT/DRIVER), `src/common/enums/order-status.enum.ts` (7 sequential states + REJECTED/CANCELLED = 9 values), `src/common/enums/fuel-type.enum.ts`, `src/common/interfaces/jwt-payload.interface.ts`, `src/common/interfaces/tenant-context.interface.ts`
- [X] T010 Implement `TenantContextService` (AsyncLocalStorage store `{userId, role, companyId}`) in `src/common/context/tenant-context.service.ts` (research R1)
- [X] T011 Implement global tenant-scoping Mongoose plugin in `src/common/plugins/tenant-scope.plugin.ts`: inject `companyId` into find/count/update/delete/aggregate ($match after $geoNear when present) and on save/insertMany for schemas with `tenantScoped` option; SUPER_ADMIN context bypasses (R1, FR-002)
- [X] T012 Register MongooseModule in `src/app.module.ts` via `connectionFactory` applying the tenant plugin globally; wire ConfigModule, ThrottlerModule (global guard), ScheduleModule, BullModule (Redis connection from config)
- [X] T013 [P] Create Company schema in `src/modules/companies/schemas/company.schema.ts` (name unique, commercialRegisterFileId, status ACTIVE/SUSPENDED, fuelPrices[], contacts — NOT tenant-scoped) per data-model.md
- [X] T014 [P] Create User schema in `src/modules/users/schemas/user.schema.ts`: role discriminators, driver fields (`isAvailable`, `isOnline`, `lastSeenAt`, `activeOrderId`, `location` 2dsphere, embedded `truck{plateNumber, maxCapacityLiters, fuelTypes[]}`), client `stationLocation`, all indexes incl. partial unique `{activeOrderId: 1}` and dispatch compound `{companyId, role, isActive, isOnline, isAvailable}` per data-model.md
- [X] T015 Implement auth module in `src/modules/auth/`: `POST /auth/login` (bcrypt compare, suspended-company/deactivated block with identical 401 message), `POST /auth/refresh`, `GET /auth/me`; JWT payload `{sub, role, companyId?}`
- [X] T016 Implement `JwtAuthGuard` + `@Public()` decorator in `src/common/guards/jwt-auth.guard.ts` / `src/common/decorators/public.decorator.ts`; register as global `APP_GUARD`
- [X] T017 Implement `@Roles()` decorator + `RolesGuard` in `src/common/decorators/roles.decorator.ts` / `src/common/guards/roles.guard.ts`; register globally after JWT guard (FR-003)
- [X] T018 Implement `TenantIsolationInterceptor` in `src/common/interceptors/tenant-isolation.interceptor.ts` seeding TenantContext from `request.user`; register as global `APP_INTERCEPTOR` (R1)
- [X] T019 [P] Implement `HttpExceptionFilter` (uniform `{statusCode, message, error}`, cross-tenant miss → 404 semantics) in `src/common/filters/http-exception.filter.ts` and `ObjectIdPipe` in `src/common/pipes/object-id.pipe.ts`
- [X] T020 [P] Implement notifications module in `src/modules/notifications/`: schema (tenant-scoped, types per data-model.md), `NotificationsService.notify()`, `GET /notifications?unread=`, `PATCH /notifications/:id/read`
- [X] T021 [P] Create super-admin seed script `scripts/seed-super-admin.ts` + `npm run seed:super-admin` (idempotent, reads env)
- [X] T022 [P] Unit tests for tenant plugin (scoped/bypass/aggregate/$geoNear ordering) in `test/unit/tenant-scope.plugin.spec.ts` and for RolesGuard in `test/unit/roles.guard.spec.ts`
- [X] T023 [P] Create e2e test harness in `test/utils/`: app factory booting full AppModule against `mongodb-memory-server` (replica-set mode) + test Redis, two-company seed fixtures (admins, clients, drivers with trucks/locations)

**Checkpoint**: Foundation ready — login works, tenant plugin + guards active, schemas registered

---

## Phase 3: User Story 1 — Client Orders Fuel Through the Full Delivery Lifecycle (Priority: P1) 🎯 MVP

**Goal**: Complete order lifecycle: create (estimated price) → approve (final price) → assign → pay (webhook) → transit → two-step OTP delivery, incl. payment timeout and admin force-complete

**Independent Test**: Seed one company with admin/client/driver; drive an order through every state via API; verify invalid transitions rejected, duplicate webhooks ignored, OTP gates enforced

### Implementation for User Story 1

- [X] T024 [P] [US1] Create Order schema in `src/modules/orders/schemas/order.schema.ts`: all fields, `statusHistory[]` (with `manualOverride?/overrideReason?`), embedded `otps[]` (hash/salt/purpose/expiresAt/usedAt/attempts), indexes per data-model.md
- [X] T025 [P] [US1] Create PaymentEvent schema in `src/modules/payments/schemas/payment-event.schema.ts` (unique `gatewayTransactionId`, outcome enum, rawPayload; tenant-read-scoped, write-exempt)
- [X] T026 [US1] Implement `OrderStateService` in `src/modules/orders/services/order-state.service.ts`: transition map exactly per data-model.md state machine (incl. PENDING_PAYMENT→APPROVED reversion and force-complete edges), appends statusHistory, accepts optional ClientSession, throws 409 domain error on illegal edges (FR-006/010)
- [X] T027 [P] [US1] Unit tests for OrderStateService (every legal edge + exhaustive illegal-edge rejection) in `test/unit/order-state.service.spec.ts`
- [X] T028 [US1] Implement order creation in `src/modules/orders/`: `POST /orders` (CLIENT) with estimated price from company fuelPrices × quantity, default deliveryLocation from stationLocation; reject with clear 400 when the fuel type has no configured base price (FR-007/008a); DTOs forbid `companyId`
- [X] T029 [US1] Implement approval flow: `PATCH /orders/:id/approve` (finalPrice optional → defaults to estimate; notifies client via NotificationsService, triggers dispatch), `PATCH /orders/:id/reject` (FR-008/008b)
- [X] T030 [US1] Implement cancellation: `PATCH /orders/:id/cancel` — CLIENT in PENDING_APPROVAL/APPROVED (pre-assignment) and in PENDING_PAYMENT (declining Final Price), COMPANY_ADMIN until IN_TRANSIT; transactional driver release + timeout-job removal when assigned (FR-009)
- [X] T031 [US1] Implement `DispatchService.assignDriver(orderId)` transactional core in `src/modules/dispatch/services/dispatch.service.ts`: `withTransaction` → conditional `findOneAndUpdate` driver `{isAvailable: true}` → set `{isAvailable: false, activeOrderId}` → order APPROVED→ASSIGNED_TO_DRIVER→PENDING_PAYMENT (+`paymentDeadline`, notify driver) — candidate selection minimal here (any eligible driver); smart selection lands in US3 (FR-012, R4)
- [X] T032 [US1] Register BullMQ `payment-timeout` queue + processor in `src/modules/payments/queues/`: enqueue on PENDING_PAYMENT entry (`jobId = orderId`, delay from config), processor transactionally releases driver + reverts to APPROVED + increments `paymentTimeoutCount` + notifies client & admin; removed on payment/cancel (FR-015a, R6)
- [X] T033 [US1] Implement payment webhook `POST /payments/webhook/:gateway` in `src/modules/payments/`: `@Public()`, raw-body HMAC-SHA256 verify, normalize payload, unique-insert payment_event, amount/currency check, transactional PENDING_PAYMENT→IN_TRANSIT + link confirmation + remove timeout job; outcomes DUPLICATE/OUT_OF_SEQUENCE/AMOUNT_MISMATCH/INVALID_SIGNATURE always ack per contracts/payment-webhook.md (FR-014/015)
- [X] T034 [US1] Implement `OtpService` in `src/modules/orders/services/otp.service.ts`: `crypto.randomInt` 6-digit, sha256+salt hashing, single active record per purpose, expiry, attempt counter, invalidate-on-use (FR-023, R7)
- [X] T035 [US1] Implement PoD endpoints in orders controller: `POST /orders/:id/arrive` (driver, idempotent OTP issue), `GET /orders/:id/otp/current` (client only — sole plaintext surface), `POST /orders/:id/verify-arrival` (throttled 5/15min → UNLOADING), `POST /orders/:id/request-delivery-otp`, `POST /orders/:id/verify-delivery` (txn → DELIVERED + driver release); driver response DTOs exclude `otps` entirely (FR-021/022/023)
- [X] T036 [US1] Implement `PATCH /orders/:id/force-complete` (COMPANY_ADMIN, required reason 5–500 chars): txn IN_TRANSIT/UNLOADING→DELIVERED, release driver, invalidate active OTPs, statusHistory `{manualOverride: true, overrideReason}` (FR-025)
- [X] T037 [US1] Implement `GET /orders` / `GET /orders/:id` with role-based scoping (CLIENT→own, DRIVER→assigned, ADMIN→company via plugin) + `POST /orders/:id/redispatch` (from APPROVED after timeout; CLIENT blocked once `paymentTimeoutCount ≥ 2`, FR-015a)

### Tests for User Story 1

- [X] T038 [P] [US1] E2E happy-path lifecycle test in `test/e2e/order-lifecycle.e2e-spec.ts`: create→approve(finalPrice)→assign→webhook→arrive/OTP→unload/OTP→delivered; assert statusHistory actors + driver released + invalid-transition 409 matrix (SC-001/003)
- [X] T039 [P] [US1] E2E payment tests in `test/e2e/payment-idempotency.e2e-spec.ts`: duplicate webhook no-op, bad signature 401, amount mismatch flag, timeout job fires → driver released + order APPROVED, late webhook after timeout → OUT_OF_SEQUENCE, timeout-vs-webhook race (SC-007)
- [X] T040 [P] [US1] E2E proof-of-delivery tests in `test/e2e/force-complete.e2e-spec.ts`: wrong-OTP throttling, OTP absent from every driver response, force-complete override flag + role denial for DRIVER/CLIENT (SC-009)

**Checkpoint**: MVP — full lifecycle functional for a single company

---

## Phase 4: User Story 2 — Tenant Data Isolation and Role-Based Access (Priority: P1)

**Goal**: Prove and harden the automatic isolation + RBAC built in Phase 2 across every surface

**Independent Test**: Two seeded companies; exhaustively verify no cross-company read/write/inference via REST or sockets

### Implementation for User Story 2

- [X] T041 [US2] Audit + enforce 404-not-403 semantics for cross-tenant object fetches across orders/users/files controllers (service `findOwned()` helpers), per contracts/rest-api.md status table (FR-002)
- [X] T042 [US2] Verify every mutating DTO strips/forbids `companyId`/`role` escalation fields; add `test/unit/dto-whitelist.spec.ts` asserting forbidNonWhitelisted on representative DTOs

### Tests for User Story 2

- [X] T043 [P] [US2] E2E isolation matrix in `test/e2e/tenant-isolation.e2e-spec.ts`: company-A admin/client/driver vs company-B resources — list leakage, direct-id fetch (404), mutation attempts, file access, aggregate endpoints (SC-002)
- [X] T044 [P] [US2] E2E RBAC matrix in `test/e2e/rbac.e2e-spec.ts`: role × endpoint denial table (client approving, driver listing users, admin cross-company, SUPER_ADMIN global read), suspended-company login block, deactivated-user block

**Checkpoint**: Both P1 stories verified — platform is safe to onboard a second tenant

---

## Phase 5: User Story 3 — Smart Driver Dispatch (Priority: P2)

**Goal**: Upgrade the US1 assignment core to proximity + capability matching with race-proof selection

**Independent Test**: Seed drivers at varying distances/capacities/fuel types/availability; approve orders; verify nearest-eligible selection and zero double-booking under concurrency

### Implementation for User Story 3

- [X] T045 [US3] Implement smart candidate query in `src/modules/dispatch/services/dispatch.service.ts`: single `$near`-sorted query on users — `{role: DRIVER, isActive: true, isOnline: true, isAvailable: true, 'truck.maxCapacityLiters': {$gte: qty}, 'truck.fuelTypes': fuelType}` — no `$lookup` (denormalized truck, R8, FR-011)
- [X] T046 [US3] Implement race-fallback iteration (next-nearest on lost conditional update) and no-eligible-driver path: order stays APPROVED + COMPANY_ADMIN notification (FR-013); re-validate qty/fuelType against denormalized truck at assignment time
- [X] T047 [US3] Expose `POST /dispatch/orders/:id` (COMPANY_ADMIN manual retry) in `src/modules/dispatch/controllers/dispatch.controller.ts`; wire auto-trigger from approval (T029) through this service

### Tests for User Story 3

- [X] T048 [P] [US3] E2E selection tests in `test/e2e/dispatch-selection.e2e-spec.ts`: nearest wins; capacity-insufficient skipped; wrong fuel type skipped; inactive/busy/offline excluded; no-driver → APPROVED + notification (SC-005)
- [X] T049 [P] [US3] E2E race test in `test/e2e/dispatch-race.e2e-spec.ts`: two simultaneous approvals, one eligible driver → exactly one assignment, second order notified; partial unique index violation impossible (SC-004)

**Checkpoint**: Dispatch is smart, capability-aware, and concurrency-safe

---

## Phase 6: User Story 4 — Real-Time Delivery Tracking (Priority: P2)

**Goal**: Live location feed with displacement/heartbeat policy, watcher authorization, and driver presence detection

**Independent Test**: Simulated driver socket moving along a route; watchers receive only policy-compliant updates; silent driver goes Offline in ≤ 6 min

### Implementation for User Story 4

- [X] T050 [US4] Implement `WsJwtGuard` (handshake auth → socket context) in `src/common/guards/ws-jwt.guard.ts`
- [X] T051 [US4] Implement `/tracking` gateway in `src/modules/tracking/tracking.gateway.ts`: `order:watch`/`order:unwatch` with room authorization (owner client, company admin, SUPER_ADMIN; NOT_FOUND for cross-tenant; NOT_TRACKABLE outside IN_TRANSIT/UNLOADING) per contracts/websocket-events.md (FR-017)
- [X] T052 [US4] Implement `location:update` handler: server-side 50 m haversine / 3 min policy enforcement + 5 s abuse ceiling, persist `users.location`+`locationUpdatedAt`, broadcast `order:location` with `receivedAt` (FR-016)
- [X] T053 [US4] Implement presence in `src/modules/tracking/presence/`: every driver frame (handshake, accepted AND below-threshold updates) refreshes `lastSeenAt`+`isOnline: true`; 60 s cron bulk-marks `isOnline: false` past 6 min silence; never touches orders (FR-024, R6a)
- [X] T054 [US4] Wire lifecycle emits: `order:status` on every transition (from OrderStateService hook), `order:otp` direct to client sockets only, `notification:new` from NotificationsService

### Tests for User Story 4

- [X] T055 [P] [US4] E2E tracking policy tests in `test/e2e/tracking.e2e-spec.ts`: >50 m accepted+broadcast, <50 m within 3 min dropped, heartbeat accepted, cross-tenant watch NOT_FOUND, OTP event never reaches driver/room sockets (SC-006)
- [X] T056 [P] [US4] E2E presence tests in `test/e2e/presence.e2e-spec.ts`: silent 6 min → isOnline false + excluded from dispatch; reconnect → eligible again; in-progress order untouched (SC-010)

**Checkpoint**: Watchers see live, policy-compliant movement; dead devices leave the dispatch pool automatically

---

## Phase 7: User Story 5 — Platform & Company Onboarding (Priority: P3)

**Goal**: SUPER_ADMIN registers companies (with commercial register upload); admins manage clients, drivers, trucks, prices, and files

**Independent Test**: Register a company end-to-end, create client+driver with uploads, verify new users operate with correct role/company binding

### Implementation for User Story 5

- [X] T057 [P] [US5] Implement files module in `src/modules/files/`: Multer diskStorage to `sys_storge/{companyId}/{uuid}{ext}` (server-generated paths only), MIME allowlist + 10 MB cap, tenant-scoped metadata collection, authorized streaming `GET /files/:id` (FR-020, R10)
- [X] T058 [US5] Implement companies module endpoints in `src/modules/companies/`: `POST /companies` (SUPER_ADMIN, multipart commercial register + initial admin creation), `GET /companies(/:id)`, `PATCH /companies/:id/status` (suspension blocks login via auth check from T015) (FR-018)
- [X] T059 [US5] Implement fuel price endpoints: `GET/PUT /companies/:id/fuel-prices` (admin write, client read — feeds US1 estimates) (FR-008a)
- [X] T060 [US5] Implement users module endpoints in `src/modules/users/`: `POST /users` (CLIENT requires stationLocation; DRIVER requires truck{plate, capacity, fuelTypes[]}), `GET /users`, `PATCH /users/:id`, activate/deactivate (active-delivery rule), `PATCH /users/:id/truck` atomically rewriting the denormalized subdoc (FR-019)
- [X] T061 [US5] Wire profile-picture upload (purpose PROFILE_PICTURE) into user create/update flows

### Tests for User Story 5

- [X] T062 [P] [US5] E2E onboarding flow in `test/e2e/onboarding.e2e-spec.ts`: company registration → admin login → prices → client/driver creation → driver dispatch-eligible; file type/size rejections atomic
- [X] T063 [P] [US5] E2E file isolation in `test/e2e/file-access.e2e-spec.ts`: cross-tenant file fetch 404, path traversal attempts rejected, SUPER_ADMIN read allowed

**Checkpoint**: All five stories functional — full platform operable end-to-end

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T064 [P] Swagger/OpenAPI setup (non-prod only) in `src/server.ts` matching contracts/rest-api.md
- [X] T065 [P] Create `scripts/smoke.http` covering quickstart.md steps 1–7
- [X] T066 [P] Structured logging pass: request logging middleware, audit logs for webhook outcomes, OTP attempts, force-complete overrides
- [X] T067 Rate-limit buckets per contract (login 10/min, OTP verify 5/15min) via named Throttler configs
- [X] T068 Load-sanity check against SC-008 (50 tenants / 500 users seed script + basic autocannon run) documented in `test/perf/README.md`
- [X] T069 Run quickstart.md end-to-end validation (docker compose up, seed, smoke.http) and fix drift
- [X] T070 Final CI green: lint + unit + e2e + docker build + index.ts grep gate all passing on the feature branch

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** → no dependencies
- **Phase 2 (Foundational)** → requires Phase 1 — **BLOCKS all stories**
- **Phase 3 (US1)** → requires Phase 2
- **Phase 4 (US2)** → requires Phase 2; its e2e matrices exercise US1 endpoints, so run after T037
- **Phase 5 (US3)** → requires US1's T031 (dispatch core)
- **Phase 6 (US4)** → requires Phase 2; T054 hooks into US1's OrderStateService (T026); presence (T053) feeds US3's isOnline filter but is independently testable
- **Phase 7 (US5)** → requires Phase 2; T057 (files) is a prerequisite for T058 (commercial register upload)
- **Phase 8 (Polish)** → after desired stories complete

### Key task-level dependencies

- T026 (state machine) blocks T028–T037
- T031 (assignment core) blocks T032, T045–T047
- T034 (OtpService) blocks T035, T036
- T057 (files) blocks T058, T061
- T050 (WsJwtGuard) blocks T051–T053

### Parallel Opportunities

- Phase 1: T003–T008 all [P] after T001–T002
- Phase 2: T009, T013, T014, T019–T023 parallelize around the T010→T011→T012 spine
- US1: T024/T025/T027 in parallel; T038–T040 test files in parallel
- After Phase 2, US4 (T050–T053) and US5 (T057) can proceed in parallel with US1 by separate developers
- All e2e test tasks within a story are [P] (separate spec files)

## Parallel Example: User Story 1

```bash
# Parallel model/schema tasks after Phase 2:
Task: "T024 Create Order schema in src/modules/orders/schemas/order.schema.ts"
Task: "T025 Create PaymentEvent schema in src/modules/payments/schemas/payment-event.schema.ts"

# Parallel test authoring after T037:
Task: "T038 E2E lifecycle in test/e2e/order-lifecycle.e2e-spec.ts"
Task: "T039 E2E payments in test/e2e/payment-idempotency.e2e-spec.ts"
Task: "T040 E2E PoD in test/e2e/force-complete.e2e-spec.ts"
```

## Implementation Strategy

### MVP First (US1 + US2)

1. Phases 1–2 (setup + foundation)
2. Phase 3 (US1) → **STOP & VALIDATE**: full lifecycle green (T038–T040)
3. Phase 4 (US2) → isolation matrices green — this pair is the true multi-tenant MVP (both are P1: a lifecycle without isolation is not shippable for this domain)
4. Demo/deploy

### Incremental Delivery

- +US3 → smart dispatch replaces naive assignment (drop-in service upgrade)
- +US4 → live tracking + presence
- +US5 → self-serve onboarding (until then, seed scripts suffice)
- Polish phase closes with quickstart validation + CI gate

---

## Notes

- Total: **70 tasks** (Setup 8, Foundational 15, US1 17, US2 4, US3 5, US4 7, US5 7, Polish 7)
- Binding constraints enforced in T001 (server.ts), T003/T006 (no index.ts gates), T007/T057 (sys_storge), T031/T033 (mandated transactions)
- Commit after each task or logical group; every checkpoint is independently demoable
