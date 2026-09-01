# Implementation Plan: Production Hardening & Horizontal Readiness

**Branch**: `012-production-hardening` | **Date**: 2026-08-31 | **Spec**: [spec.md](./spec.md)

**Revised 2026-08-31** after a post-`/speckit-tasks` cross-artifact analysis and a second
clarification round (spec Session 2026-08-31, Q10–Q12). Three findings changed the design rather than
merely documenting it, and each is recorded below: the shared cache is now load-bearing for five
subsystems and needed a defined degradation for each (R11); open-source nginx cannot poll the
readiness endpoint it was assumed to consume (R10); and the download path had to be unified across
storage drivers or the redirect would have run first in production (R12).

**Input**: Feature specification from `specs/012-production-hardening/spec.md`

## Summary

Close ten operational gaps that decide whether a production incident is a five-minute fix or a
silent failure, **without changing one byte of platform behaviour**. Four are launch blockers
(liveness signal, graceful shutdown, production CORS, proxy-aware rate limiting), four are
diagnosability and durability (structured logs, object storage, managed secrets, database
resilience), and two remove the constraints that make redundancy impossible (in-process schedulers,
in-memory realtime fan-out) — plus a third the spec's own verification found: in-memory rate-limit
counters.

**The technical approach is dominated by one finding that inverts the obvious order.**
`test/utils/test-app.factory.ts` re-implements a subset of `src/server.ts`'s bootstrap by hand and
omits `helmet` and `enableCors` entirely. All 53 e2e suites therefore run against an application
that was never configured the way production configures it. Every property this feature adds at
bootstrap would be added to `server.ts` and asserted by nothing. So **Slice 0 extracts
`configureApp()` and points both entry points at it**, before any behaviour is added. Without it
this feature would reintroduce, four times over, the exact class of production-only defect it exists
to remove.

Beyond that, the work is unusually well-seamed: every realtime emission already funnels through
`RealtimeGatewayService`, so cross-instance delivery is a one-file change; file storage has three
write paths and one read path; and secrets load into `process.env` before Nest boots, leaving
`configuration.ts` and `validation.ts` untouched.

**One consequence deserves stating up front, because it is easy to under-read.** Making Redis carry
throttler counters, scheduler leases and realtime fan-out — on top of the queues and cache it already
holds — means five subsystems now depend on it, while the health design deliberately keeps a
cache-less instance in rotation. That is only defensible if each of the five degrades gracefully; the
throttler in particular fails closed by default, which would have made a cache outage error **every
request on the platform** and turned the very decision meant to prevent a total outage into the cause
of one. Each of the five now has a stated degradation (R11).

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`), Node.js 20 (Alpine runtime image)

**Primary Dependencies**: NestJS 10 · Mongoose 8 · Socket.io 4 · BullMQ 5 · ioredis 5 · Joi 17 ·
Passport-JWT · helmet 8
**New**: `@nestjs/terminus` · `nestjs-pino` + `pino-http` · `@socket.io/redis-adapter` +
`@socket.io/redis-emitter` · `@nest-lab/throttler-storage-redis` · `@google-cloud/storage` ·
`@google-cloud/secret-manager`

**Storage**: MongoDB (replica set — required for existing transactions) · Redis (BullMQ, cache, and
now throttler counters + scheduler leases + socket adapter) · Google Cloud Storage regional bucket
(new, documents) · Google Secret Manager (new, secrets)

**Testing**: Jest — 19 unit suites (152 tests), 53 e2e suites (267 tests) via
`jest --config test/jest-e2e.json --runInBand` against `mongodb-memory-server` + real Redis.
**New**: a multi-instance e2e harness (two `INestApplication`s, one shared replica set and Redis).

**Target Platform**: Google Compute Engine VMs running the existing Docker Compose stack behind
nginx, with a process manager (Clarification Q1). Managed GCS, Secret Manager and Cloud Logging from
the same project and region (Q3, Q5, Q6). **One topology fact is not yet established and gates
several tasks**: whether a managed load balancer or instance group already fronts nginx (FR-007d). If
it does, its health check supplies active readiness-based routing, the external monitor reduces to
alerting, and the trusted-hop count is **two** rather than one. This must be checked before any proxy
configuration is written (research R10).

**Project Type**: Multi-tenant B2B web service (NestJS backend) with two existing clients — Flutter
mobile app and React web dashboard — **both of which must require no change** (FR-067), with exactly
one permitted exception (FR-038e, the document-redirect header).

**Performance Goals**: No regression against current behaviour. Health probe resolves within its
configured timeout (default 1 s) without consuming a request-pool connection. Log volume must not
grow with the tracking stream (FR-035).

**Constraints**: Zero change to endpoint paths, payloads, tenant scoping, role restrictions,
transaction boundaries or order-lifecycle transitions (FR-065–FR-067). One deliberate exception:
`GET /files/:id` becomes a 302 rather than a byte stream, **under every storage driver** so tests and
production exercise one path (FR-038/FR-038a/FR-042a). Existing suites must stay green (FR-068).

**Scale/Scope**: ~12 new/changed source areas in `src/`, one new `bootstrap/` directory, one new
`health/` module, one new `storage/` port with two adapters, one new `secrets/` loader, one new
scheduler-lease service, one throttler-storage fallback wrapper, and one local-driver-only byte
route. No new business endpoints. 2+ application instances behind nginx.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes recorded.*

| Principle | Assessment |
|---|---|
| **I. Strict Typing & No Magic Values** | **PASS.** Every new value is config-backed (`CORS_ALLOWED_ORIGINS`, `TRUSTED_PROXY_HOPS`, `SHUTDOWN_DRAIN_MS`, `SIGNED_URL_TTL_SECONDS`, `STORAGE_DRIVER`, `SECRETS_DRIVER`, `HEALTH_TIMEOUT_MS`, `SCHEDULER_LEASE_TTL_MS`, `LOG_LEVEL`, plus `READINESS_POLL_INTERVAL_SECONDS`/`READINESS_FAILURE_THRESHOLD`/`READINESS_RECOVERY_THRESHOLD` and `LOCAL_STORAGE_TOKEN_TTL_SECONDS`/`LOCAL_STORAGE_TOKEN_SECRET`) added to `configuration.ts` + `validation.ts`. New enums for `StorageDriver` and `SecretsDriver`; sweep names as a const map. The `FileStorage` port and both adapters are fully typed; no `any` at module boundaries. **`TRUSTED_PROXY_HOPS` deliberately has no default** — see the Backend constraints below. |
| **II. Tenant Isolation & Security-First** | **PASS, with the feature's two sharpest risks.** `FileRecord` stays `markTenantScoped`, so `findForDownload`'s `findById` remains plugin-scoped — `files.controller.ts` has no explicit tenant check and correctly needs none. The storage rewrite must not disturb this. The signed URL is issued **only after** that scoped read succeeds (FR-039), is read-only, single-object and 5-minute (FR-038b/FR-040). The object key prefix carries `companyId` for organisation but enforces **nothing** (FR-040a) — recorded in the schema so no future reader mistakes it for a boundary. R5's throttler tracker verifies the JWT signature before keying on `sub`, so no attacker can consume another user's budget. R4 closes a **pre-existing production wildcard** on the WebSocket namespace. **New with R12**: the local byte route is `@Public()` and streams tenant documents, authorised solely by a scoped expiring token. That is acceptable only because scoped, expiring and **absent from production builds** all hold together — so all three are asserted by test (T064b), not assumed. R11's throttler fallback keeps limiting bounded during a cache outage rather than failing open, which would have removed brute-force protection from login, refresh and one-time-code routes precisely when the platform is already degraded. |
| **III. Centralized Error Handling** | **PASS.** `HttpExceptionFilter` is untouched and remains the single exit point; it moves into `configureApp` so tests exercise the same instance production does. Storage and secret failures surface as standard Nest exceptions through it (FR-041). Pino records the failure with its correlation id while the filter's response shape is unchanged (FR-034). |
| **IV. Clean Architecture & UI/Logic Decoupling** | **PASS.** `FileStorage` is an abstract port with two injected adapters — `FilesService` gains no cloud-vendor import. `SecretsLoader` sits outside the Nest graph by necessity (it must run before `ConfigModule` validates) and is a pure function with no framework coupling. Module/service/controller/DTO/guard separation preserved throughout. No client-side work. |
| **V. Transactional Integrity for State Changes** | **PASS, and materially strengthened.** No transaction boundary changes. Shutdown must not truncate a transaction (FR-013): `Worker.close()` waits for in-flight handlers, and an unfinished job is redelivered rather than abandoned. The scheduler lease is explicitly **not** presented as a correctness boundary — FR-056a requires every sweep to be idempotent via the conditional-write/`modifiedCount` discipline the constitution's "concurrency safety at the data layer, not assumed from application ordering" already demands. Explicit database pool bounds and timeouts (Story 8) make a transaction fail fast rather than hold resources indefinitely. |

**Backend binding constraints**

- **`server.ts` remains the root entry file.** `configureApp` lives at `src/bootstrap/configure-app.ts`
  — a subdirectory, not a root `index.ts`. `npm run lint:no-index` still passes.
- **`sys_storge` — resolved, and recorded here as the Constitution Check requires.** The constraint
  binds *local file uploads* to a directory of that exact name. After Story 6 uploads are not local,
  so the constraint no longer binds them. The name is nonetheless retained as the GCS object key
  prefix (`sys_storge/{companyId}/{uuid}{ext}`), and `LocalFileStorage` — still used by development
  and every test — continues to write to a real `sys_storge` directory, so the constraint is honoured
  literally wherever it still applies. **No amendment is required.** The retained prefix is
  convention, not enforcement (FR-040a).
- **Tenant `companyId` injection** via the global interceptor/plugin: untouched.
- **ACID transactions for dispatch and payment webhook**: untouched.
- **`TRUSTED_PROXY_HOPS` has no default and must not be given one.** It is `1` if nginx is the only
  proxy and `2` if a managed load balancer fronts it (FR-007d/FR-022). Defaulting to `1` where there
  are two makes the load balancer the attributed client for every request on the platform — the same
  undifferentiated-origin failure Story 4 exists to fix, arrived at differently, with no error and no
  symptom. Unset in production is a startup failure, not a fallback.

**Result: PASS on both passes. Complexity Tracking is empty — no principle is violated and no
deviation requires justification.**

## Project Structure

### Documentation (this feature)

```text
specs/012-production-hardening/
├── plan.md                              # This file
├── spec.md                              # 96 FRs, 18 SCs, 9 clarifications
├── research.md                          # 12 decisions (R1, R4, R5, R9–R12 overturn assumptions)
├── data-model.md                        # Phase 1 output
├── quickstart.md                        # Phase 1 output — includes the FR-072 pre-launch checklist
├── checklists/requirements.md           # Spec quality checklist
└── contracts/
    ├── health-contract.md               # GET /health/live, GET /health/ready
    ├── rest-api-delta.md                # The one changed response: GET /files/:id
    ├── operations-contract.md           # Deploy procedure, nginx, secrets, bucket, alert
    └── config-contract.md               # Every new environment variable
```

### Source Code (repository root)

```text
src/
├── server.ts                            # CHANGED — calls loadSecrets() then configureApp()
├── bootstrap/                           # NEW (Slice 0 — the keystone)
│   ├── configure-app.ts                 # helmet, versioning, prefix, pipes, filters, CORS,
│   │                                    #   trust proxy, shutdown hooks — one place
│   └── shutdown.service.ts              # draining flag + drain gate (FR-005, FR-012)
├── secrets/                             # NEW
│   ├── secrets-loader.ts                # runs BEFORE NestFactory (R8)
│   └── secret-manager.driver.ts         # GCP driver; 'env' driver is a no-op
├── modules/health/                      # NEW
│   ├── health.module.ts
│   └── health.controller.ts             # @Public, throttler-exempt (FR-004)
├── common/
│   ├── storage/                         # NEW (Story 6)
│   │   ├── file-storage.port.ts         # abstract FileStorage
│   │   ├── gcs-file-storage.ts          # production adapter — V4 signed URLs
│   │   ├── local-file-storage.ts        # dev/test adapter — writes real sys_storge,
│   │   │                                #   returns a token-addressed URL (FR-042b)
│   │   └── local-storage-token.ts       # sign/verify; scoped to one file, expiring
│   ├── scheduler/                       # NEW (Story 9)
│   │   ├── scheduler-lease.service.ts   # SET NX PX + Lua compare-and-delete
│   │   └── sweep-names.const.ts         # lease keys, never inline literals
│   ├── throttler/                       # NEW (Story 9)
│   │   └── resilient-throttler.storage.ts # Redis store + in-memory fallback (FR-061a)
│   ├── logging/                         # NEW (Story 5)
│   │   └── pino.config.ts               # redaction, level, severity mapping
│   ├── guards/
│   │   ├── global-throttler.guard.ts    # NEW — signature-verifying tracker (R5)
│   │   └── user-throttler.guard.ts      # UNCHANGED — its perUser profile is preserved
│   ├── context/tenant-context.service.ts # CHANGED — carries correlationId (R6)
│   ├── middleware/request-logger.middleware.ts # DELETED — pino-http replaces it
│   ├── realtime/realtime-gateway.service.ts   # UNCHANGED — adapter attaches upstream
│   └── redis/redis.module.ts            # UNCHANGED — its destroy hook finally runs
├── config/
│   ├── configuration.ts                 # CHANGED — new typed sections
│   └── validation.ts                    # CHANGED — production-required CORS origins
├── modules/files/
│   ├── files.module.ts                  # CHANGED — memoryStorage; driver-selected provider;
│   │                                    #   local byte route registered ONLY under local driver
│   ├── files.service.ts                 # CHANGED — writes via port, issues signed URLs
│   ├── files.controller.ts              # CHANGED — download returns 302 under EVERY driver,
│   │                                    #   Cache-Control: no-store; @Public token byte route
│   └── schemas/file.schema.ts           # CHANGED — comment only; storagePath keeps name+type
├── modules/tracking/
│   ├── tracking.gateway.ts              # CHANGED — Redis adapter; CORS allowlist not '*'
│   └── presence/presence.service.ts     # CHANGED — sweep takes the lease
├── modules/stop-detection/
│   └── stop-detection.service.ts        # CHANGED — sweep takes the lease
└── app.module.ts                        # CHANGED — Mongoose pool/timeouts, Redis throttler
                                         #   store, HealthModule, LoggerModule

test/
├── utils/
│   ├── test-app.factory.ts              # CHANGED — calls configureApp(); shared teardown budget
│   └── multi-instance.factory.ts        # NEW — two apps, one replica set, one Redis (FR-069)
└── e2e/
    ├── health.e2e-spec.ts               # NEW — Story 1
    ├── graceful-shutdown.e2e-spec.ts    # NEW — Story 2
    ├── cors.e2e-spec.ts                 # NEW — Story 3 (impossible before Slice 0)
    ├── rate-limit-proxy.e2e-spec.ts     # NEW — Story 4
    ├── request-logging.e2e-spec.ts      # NEW — Story 5
    ├── file-storage.e2e-spec.ts         # NEW — Story 6
    ├── file-access.e2e-spec.ts          # CHANGED — download now asserts 302
    ├── db-resilience.e2e-spec.ts        # NEW — Story 8
    ├── redis-degradation.e2e-spec.ts    # NEW — Story 9 (SC-019/SC-020)
    └── multi-instance.e2e-spec.ts       # NEW — Story 9 (FR-070's five assertions)

docker-compose.yml                       # CHANGED — local-driver development shape
docker-compose.prod.yml                  # NEW — two replicas, nginx, no env_file, no bind mount
nginx/nginx.conf                         # NEW — upstream, X-Forwarded-For, proxy_next_upstream
scripts/rolling-deploy.sh                # NEW — readiness-gated rolling replacement (FR-012a)
scripts/readiness-monitor.sh             # NEW — polls readiness, rewrites upstream, reloads
                                         #   (FR-007a; omitted if a load balancer fronts nginx)
Dockerfile                               # CHANGED — sys_storge only for local driver
```

**Structure Decision**: The existing NestJS layout is preserved exactly. Cross-cutting operational
concerns go under `src/common/` alongside the existing `redis/`, `realtime/`, `guards/` and
`plugins/` — matching how every prior feature added platform-level machinery. Two exceptions, both
forced and both deliberate: `src/bootstrap/` exists because `configureApp` must be importable by
`server.ts` *and* by the test factory without either importing the other, and `src/secrets/` exists
because `loadSecrets()` must run before `NestFactory.create` and therefore cannot be a Nest provider.
`modules/health/` is a normal feature module because it exposes routes.

## Implementation Slices

Ordered so that each slice is independently verifiable, and so that the two whose failure mode is
*silent* land alone.

| # | Slice | Stories | Lands |
|---|---|---|---|
| **0** | **`configureApp` extraction** | — | **Alone.** Nothing else is verifiable until both entry points share one bootstrap (R1). Pure refactor: no behaviour change, all 53 e2e suites must stay green. |
| 1 | Health endpoints **+ the FR-007d topology check** | US1 | With Slice 0's harness in place. Precondition for Slices 2, 4 and 8. The topology check gates every proxy decision and must happen first within this slice. |
| 2 | Graceful shutdown + deploy procedure + readiness monitor | US2 | After 1 — the drain gate flips the readiness flag Slice 1 introduces, and the monitor rewrites the nginx file this slice creates. |
| 3 | Production CORS (REST **and** WebSocket) | US3 | Independent; needs Slice 0 to be testable at all. |
| 4 | Proxy-aware rate limiting + attribution | US4 | Independent. Redis counter store deferred to Slice 9. |
| 5 | Structured logging + correlation | US5 | **Alone.** Touches every queue enqueue site (FR-030); a partial landing leaves order history complete for requests and empty for jobs. |
| 6 | Object storage | US6 | After 5, so storage failures are diagnosable. Includes the FR-038d device check. |
| 7 | Secrets | US7 | Independent of 1–6; changes only `server.ts` and deployment. |
| 8 | Database pool + timeouts | US8 | After 1 — readiness is how recovery is observed. |
| 9 | Horizontal readiness | US9 | **Last, and alone.** Redis socket adapter + scheduler lease + shared throttler store **with its fallback** + transport-loss detection + the multi-instance harness. Depends on 6 (documents must be shared before a second instance can serve them). The throttler store and its fallback must land together — the store alone leaves a window where a cache outage errors every request. |

## Risks

1. **The correlation id must cross into BullMQ jobs (FR-030).** Every `*QueueService.schedule` call
   site must write it into job data and every processor must re-establish it. This is the widest
   touch in the feature and the easiest to half-do; a partial landing produces an order history that
   looks complete and is missing every background action.
2. **`test-app.factory.ts` teardown pressure will worsen.** CLAUDE.md already records three suites
   reporting failure purely on `afterAll` `ctx.close()` exceeding 30 s across 53 sequential apps.
   Enabling shutdown hooks makes `close()` do strictly more, and Slice 9 doubles apps per test. The
   shared teardown budget CLAUDE.md already names must land with Slice 0.
3. **FR-038d cannot be verified in CI.** A mobile client forwarding `Authorization` across the
   cross-origin redirect is rejected by GCS, and browsers strip the header — so the dashboard passes
   and the app fails. Needs a real device. It is the highest-risk item in Slice 6 and belongs on the
   FR-072 checklist.
4. **Deleting `RequestLoggerMiddleware` changes `app.module.ts`'s `NestModule` implementation.** If
   `configure()` becomes empty the class should stop implementing `NestModule` rather than keep a
   no-op.
5. **Two sweeps, two shapes.** `PresenceService` is a static `@Cron`; `StopDetectionService`
   registers a `setInterval` at `onModuleInit` specifically so its interval stays configurable for
   tests and the quickstart. The lease must not break that configurability.
6. **The topology is unverified and gates the proxy work (FR-007d).** Whether a managed load balancer
   fronts nginx decides three things at once: whether the readiness monitor is needed, whether the
   trusted-hop count is one or two, and whether the operations contract's diagram is accurate. The
   hop count is the dangerous one — wrong, it attributes every request on the platform to one origin
   and produces no error. Check before writing any proxy configuration.
7. **The throttler store fails closed by default.** Landing the Redis store without the fallback
   wrapper creates a window in which a cache outage errors every request — strictly worse than the
   in-memory counters it replaces. They must land in the same change (T096 → T096a).
8. **The local byte route must not reach production.** It is `@Public()` and streams tenant documents,
   authorised only by a scoped expiring token. Driver-conditional registration is what keeps it out
   of a production build, and a test asserts its absence rather than a reviewer noticing.
9. **A same-origin redirect does not cover the cross-origin one.** T068 proving the controller emits a
   302 says nothing about bucket CORS, signed-expiry clock skew, or per-client redirect behaviour —
   where FR-038d's mobile-only failure lives. Green CI here must not be read as covering it.

## Complexity Tracking

> No Constitution Check violations. No deviations require justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)* | — | — |
