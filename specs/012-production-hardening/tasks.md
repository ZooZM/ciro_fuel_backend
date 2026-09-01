---
description: "Task list for 012-production-hardening"
---

# Tasks: Production Hardening & Horizontal Readiness

**Input**: Design documents from `specs/012-production-hardening/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Test tasks ARE included. The spec requires them explicitly — FR-068 (existing suites stay
green), FR-069/FR-070 (an automated multi-instance suite is the *only* way Story 9's guarantees are
observable), SC-017 (zero guarantees resting on a manual step) — and the constitution requires
automated tests before a testable guarantee is considered done.

**Organization**: Grouped by user story. Phase 2 is the keystone: **nothing in Phases 3–11 is
verifiable until it lands** (research R1).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on incomplete work
- **[Story]**: US1–US9, mapping to the spec's user stories

---

## Phase 1: Setup

**Purpose**: Dependencies and typed configuration. No behaviour changes.

- [X] T001 Install runtime dependencies: `npm i @nestjs/terminus nestjs-pino pino pino-http @socket.io/redis-adapter @nest-lab/throttler-storage-redis @google-cloud/storage @google-cloud/secret-manager` and `npm i -D pino-pretty` in `package.json`
- [X] T002 [P] Add `StorageDriver` enum (`GCS`, `LOCAL`) in `src/common/enums/storage-driver.enum.ts` — no magic strings (Constitution I)
- [X] T003 [P] Add `SecretsDriver` enum (`ENV`, `GCP`) in `src/common/enums/secrets-driver.enum.ts`
- [X] T004 [P] Add `SWEEP_NAMES` const map (`PRESENCE_OFFLINE`, `STOP_DETECTION`) in `src/common/scheduler/sweep-names.const.ts` — lease keys must never be inline literals
- [X] T005 Extend `AppConfig` in `src/config/configuration.ts` with the typed sections from [config-contract.md](./contracts/config-contract.md): `health`, `shutdown`, `cors`, `proxy`, `logging`, `storage.driver/bucket/signedUrlTtlSeconds`, `secrets`, `mongo` (pool + timeouts), `scheduler`
- [X] T006 Add Joi rules in `src/config/validation.ts` for every T005 variable, with `CORS_ALLOWED_ORIGINS` **required in production** via the existing `.when('NODE_ENV', { is: 'production' })` idiom already used for `SMS_PROVIDER` (FR-018)
- [X] T007 [P] Update `.env.example` with every new variable, its default, and a one-line note on why it exists
- [X] T007a Create `docker-compose.prod.yml` (or Compose profiles) separating local-driver development from the production shape. T070, T079 and T101 each modify Compose under mutually exclusive conditions — bind-mount for local only, no `env_file` in production, two replicas behind nginx — which one undifferentiated file cannot express

---

## Phase 2: Foundational — Slice 0, the bootstrap extraction

**Purpose**: `test-app.factory.ts` re-implements a subset of `server.ts` and omits `helmet` and
`enableCors` entirely, so all 53 e2e suites run against an app configured differently from
production. Until both entry points share one bootstrap, every property added in Phases 3–11 would
be asserted by nothing, and Story 3 could not be tested at all.

**⚠ BLOCKING: no user story phase may begin until this phase is complete and green.**

- [X] T008 Create `src/bootstrap/configure-app.ts` exporting `configureApp(app: NestExpressApplication, options?: ConfigureAppOptions): void` — moves `helmet()`, `enableVersioning`, `setGlobalPrefix('api')`, `useGlobalPipes(ValidationPipe)` and `useGlobalFilters(HttpExceptionFilter)` verbatim out of `src/server.ts`. It MUST NOT call `listen()` and MUST NOT read `process.env` directly (take a `ConfigService`), so the test factory can use it
- [X] T009 Rewrite `src/server.ts` to call `configureApp(app)`, keeping the non-production Swagger and static-dashboard block in `server.ts` (they are genuinely production-excluded, unlike CORS). Confirm the file is still the root entry named exactly `server.ts`
- [X] T010 Change `test/utils/test-app.factory.ts` to call `configureApp(app)` instead of re-declaring versioning/prefix/pipes/filters. Set `STORAGE_DRIVER=local` and `SECRETS_DRIVER=env` in its env block
- [X] T011 Add a shared teardown budget to `test/utils/test-app.factory.ts`'s `close()` — CLAUDE.md records three suites intermittently reporting failure purely on `afterAll` exceeding 30 s across 53 sequential apps; enabling shutdown hooks (T020) makes `close()` do strictly more, and Phase 11 doubles apps per test
- [X] T012 Run `npm run test` and `npm run test:e2e`. **Expect exactly 152/152 unit and 267/267 e2e — identical, not "similar".** Any delta is a behaviour change introduced by a refactor that must not have one
- [X] T013 Run `npm run lint:no-index` and `npm run build` to confirm `src/bootstrap/` is a subdirectory and does not trip the root-`index.ts` CI guard

**Checkpoint**: Both entry points share one bootstrap. Every suite now exercises helmet for the first
time in this repository's history.

---

## Phase 3: User Story 1 — Liveness and readiness (P1)

**Goal**: An unauthenticated caller can ask whether this instance is alive and whether it should
receive traffic.

**Independent test**: Stop the database → readiness 503, liveness still 200. Stop Redis → readiness
**200** with Redis reported down. Poll 720 times in an hour → zero throttled.

- [X] T014 [P] [US1] Create `src/modules/health/health.module.ts` importing `TerminusModule` and registering `HealthController`; add it to `src/app.module.ts`
- [X] T015 [US1] Implement `GET /health/live` in `src/modules/health/health.controller.ts` — `@Public()`, `@SkipThrottle()`, returns `{ status, instanceId, uptimeSeconds }`, performs **no** dependency checks (FR-003: a liveness probe wired to dependencies makes an orchestrator restart a healthy process during a database incident)
- [X] T016 [US1] Implement `GET /health/ready` in `src/modules/health/health.controller.ts` — Mongo via `MongooseHealthIndicator.pingCheck` with `HEALTH_TIMEOUT_MS`, which pings over the existing connection and MUST NOT open its own or take one the request pool needs (FR-006a)
- [X] T017 [US1] Add the Redis indicator to the readiness **body only** in `src/modules/health/health.controller.ts` — it populates `info`/`error`/`details` and **never** changes the HTTP status (FR-002a). Add the code comment from [health-contract.md](./contracts/health-contract.md) explaining that a 200 alongside a `down` entry is deliberate, so a future reader does not "fix" the disagreement and reintroduce the correlated-failure trap
- [X] T018 [P] [US1] Verify both routes bypass `JwtAuthGuard` and `ThrottlerGuard` — check `@Public()` is honoured given the guard order in `src/common/common.module.ts` (FR-004)
- [X] T019 [P] [US1] Write `test/e2e/health.e2e-spec.ts`: both up → 200; Mongo down → 503 while liveness stays 200; **Redis down → 200 with `error.redis` populated**; slow Mongo → 503 within the timeout rather than hanging; 120 rapid probes → zero 429s; and **neither response discloses tenant data, configuration values, secrets or hostnames** (FR-007)
- [X] T019a [US1] **RESOLVED 2026-08-31: no load balancer, because no deployment exists — 0 forwarding rules, 0 backend services, 0 instance groups, 0 VMs across both projects; Secret Manager API not even enabled. So `TRUSTED_PROXY_HOPS`=1 under the planned topology and T028b IS required. Treat as a decision, not an observation: re-verify if an LB is introduced at provisioning time.** Original task — establish whether a managed load balancer or instance group already fronts nginx** (FR-007d). This gates T028, T028b, T035 and T039: if one exists, its health check supplies active readiness-based routing, T028b is skipped, and `TRUSTED_PROXY_HOPS` is **two**, not one. Configuring one hop where there are two makes the load balancer the attributed client for every request — the same undifferentiated-origin failure US4 exists to fix, reached by another route
- [X] T019b [US1] Confirm the readiness response is shaped for an external poller — an unambiguous status code and a body naming the failing dependency — and record the polling contract (interval, failure and recovery thresholds) in [config-contract.md](./contracts/config-contract.md). The monitor that *consumes* this is T028b, which lands after `nginx.conf` exists

**Checkpoint**: US1 independently verifiable.

---

## Phase 4: User Story 2 — Graceful shutdown (P1)

**Goal**: A deploy stops severing in-flight requests, realtime connections and background jobs.

**Independent test**: `SIGTERM` under load → readiness flips 503 first, in-flight request completes,
job finishes or is released for redelivery, clients disconnect cleanly, process exits within the
deadline.

- [X] T020 [US2] Call `app.enableShutdownHooks()` in `src/bootstrap/configure-app.ts` — one line that restores **every** destroy hook already written, including `RedisModule.onModuleDestroy`, which was written specifically to close the ioredis connection and has never once run in production
- [X] T021 [US2] Create `src/bootstrap/shutdown.service.ts` holding a process-wide `draining` flag, and register a `SIGTERM`/`SIGINT` handler in `configure-app.ts` that sets it **before** `app.close()` is invoked (`OnApplicationShutdown` fires after teardown has begun, which is too late for FR-005)
- [X] T022 [US2] Make `GET /health/ready` return 503 with `error.shutdown = 'draining'` whenever the flag is set, regardless of dependency health, in `src/modules/health/health.controller.ts`
- [X] T023 [US2] Enforce the `SHUTDOWN_DRAIN_MS` bound in `src/bootstrap/shutdown.service.ts` — exit regardless once it expires, and record a forced exit distinguishably from a clean one (FR-012)
- [X] T024 [P] [US2] **NO CODE NEEDED — verified framework-provided.** `NestApplication.close()` runs all four hook phases unconditionally (`callDestroyHook`, `callBeforeShutdownHook`, `dispose`, `callShutdownHook` — `nest-application-context.js:118-124`), and `@nestjs/bullmq` closes its workers in `onApplicationShutdown` (`bull.explorer.js:30`). Adding hooks to the processors would duplicate that and risk a double-close. Asserted instead in `graceful-shutdown.e2e-spec.ts`. ~~Add `OnModuleDestroy` calling `Worker.close()` to all three processors~~ — `src/modules/assignment-escalation/queues/assignment-escalation.processor.ts`, `src/modules/payments/queues/payment-timeout.processor.ts`, `src/modules/stop-detection/queues/stop-escalation.processor.ts` — so in-flight handlers finish and unfinished jobs are **released for redelivery**, never abandoned mid-write (FR-009)
- [X] T025 [P] [US2] **NO CODE NEEDED — verified framework-provided.** `close()` → `dispose()` → `SocketModule.close()` → `adapter.close(server)`, so clients receive a named disconnect reason rather than a vanished socket. Asserted in `graceful-shutdown.e2e-spec.ts`. ~~Add an orderly Socket.io disconnect on shutdown~~ in `src/modules/tracking/tracking.gateway.ts` so clients see a close their existing reconnect logic recognises rather than a vanished connection (FR-010)
- [X] T026 [P] [US2] Write `test/e2e/graceful-shutdown.e2e-spec.ts`: in-flight request completes; readiness turns 503 before the listener closes; an interrupted job is redelivered rather than lost; a transaction is never left half-applied (FR-013); forced exit recorded distinguishably
- [X] T027 [US2] Write the rolling deploy procedure into `specs/012-production-hardening/contracts/operations-contract.md` §3 as an executable script at `scripts/rolling-deploy.sh` — start replacement, poll readiness, shift nginx upstream, `SIGTERM` outgoing, wait, **then** move to the next instance (FR-012a). Compose has no rolling deploy; without this, graceful shutdown is implemented and never exercised
- [X] T028 [US2] Create `nginx/nginx.conf` per [operations-contract.md](./contracts/operations-contract.md) §2 with the passively-detected upstream and the WebSocket `proxy_read_timeout`. **Open-source nginx cannot actively poll a health endpoint** — that is nginx Plus — so the upstream uses `max_fails`/`fail_timeout` and the active consumer is T019b
- [X] T028a [US2] Add `proxy_next_upstream error timeout http_502 http_503` and `proxy_next_upstream_tries 2` to `nginx/nginx.conf` (FR-007c). Two jobs: it retries a failed request against the healthy instance, which is what actually protects users during the detection gap; and it makes 502/503 **count** as upstream failures, since `max_fails` counts exactly what this directive names and the default set is `error timeout` only — without it a readiness-failing instance returning clean 503s is never marked down at all. **Do not add `non_idempotent`**: nginx already refuses to retry POST/PATCH/LOCK without it, and the platform's write endpoints are not established as safe to replay
- [X] T028b [US2] Build the steady-state readiness monitor per [operations-contract.md §2.1](./contracts/operations-contract.md) — poll every instance and, on sustained failure, **rewrite the nginx upstream and reload**, not merely alert (FR-007a). Ordered after T028 because it rewrites the file T028 creates. Passive `max_fails` detection cannot be relied on as the consumer: it counts only failed proxied requests, so an instance failing readiness without erroring on every route stays in rotation indefinitely (FR-007b). **Skip entirely if T019a found a managed load balancer** — its health check is then the active consumer. Adopt the documented HAProxy fallback if the upstream rewrite proves too hand-rolled

**Checkpoint**: US2 verifiable; deploys no longer corrupt in-flight work.

---

## Phase 5: User Story 3 — Browser access in production (P1)

**Goal**: The web dashboard can reach the API in production.

**Independent test**: Production config + allowlisted origin → succeeds. Non-allowlisted → refused
without disclosing the allowlist. No `Origin` header → unchanged. Empty allowlist in production →
refuses to start.

- [X] T029 [US3] Move `enableCors` out of the `NODE_ENV !== 'production'` branch in `src/server.ts` into `src/bootstrap/configure-app.ts`, driven by `CORS_ALLOWED_ORIGINS` with `credentials: true` (FR-014, FR-015)
- [X] T030 [US3] Ensure a non-allowlisted origin is refused without revealing which origins are permitted, and that exact matching treats scheme, host and port as significant — a trailing slash must fail closed and diagnosably (FR-016, spec Edge Cases)
- [X] T031 [US3] **Replace the hardcoded `cors: { origin: '*' }` in `src/modules/tracking/tracking.gateway.ts`** with the same allowlist. This is a *second, opposite* CORS defect the spec did not name: the REST API is closed in production while the WebSocket namespace is wide open in **every** environment. Both must read one config value so they cannot drift (research R4)
- [X] T032 [P] [US3] Confirm preflight succeeds without credentials and without consuming a rate-limit budget (FR-017)
- [X] T033 [P] [US3] Write `test/e2e/cors.e2e-spec.ts` — **impossible before Phase 2**, since the factory never applied CORS: allowlisted origin passes; unknown origin refused; no-`Origin` request unchanged; preflight not throttled
- [X] T034 [US3] Add a unit test in `test/unit/config-validation.spec.ts` asserting the app refuses to start when `NODE_ENV=production` and `CORS_ALLOWED_ORIGINS` is empty (FR-018)

**Checkpoint**: US3 verifiable; the dashboard works in production and the socket wildcard is closed.

---

## Phase 6: User Story 4 — Client-differentiated rate limiting (P1)

**Goal**: Behind a proxy, one client's burst cannot lock out the platform, and the origin of a burst
is recoverable afterwards.

**Independent test**: Two forwarded addresses get separate budgets; a forged `X-Forwarded-For` from
an untrusted hop is ignored; each request's record identifies its origin.

- [X] T035 [US4] Call `app.set('trust proxy', TRUSTED_PROXY_HOPS)` in `src/bootstrap/configure-app.ts` so `req.ip` is the client rather than the proxy (FR-021). **Set the value from T019a's finding — it has no safe default** (FR-022): `1` if nginx is alone, `2` if a managed load balancer fronts it. Treat it as unset-is-an-error in production rather than defaulting, because guessing `1` where there are two attributes every request on the platform to the load balancer and produces no error and no symptom
- [X] T036 [US4] Create `src/common/guards/global-throttler.guard.ts` extending `ThrottlerGuard`, with a `getTracker` that returns `user:{sub}` from a **signature-verified** JWT and falls back to `req.ip`. Register it in `src/common/common.module.ts` in place of the bare `ThrottlerGuard`, **keeping its position before `JwtAuthGuard`**
- [X] T037 [US4] Add the rationale comment to `global-throttler.guard.ts` recording why the tracker cannot read `req.user` and why the two obvious alternatives are worse: the throttler runs **before** `JwtAuthGuard` (deliberately, per `common.module.ts`), so `req.user` does not exist; reordering would let a malformed token bypass rate limiting entirely; decoding without verifying would make `sub` attacker-controlled and let anyone drain a named user's budget (research R5)
- [X] T038 [P] [US4] Leave `src/common/guards/user-throttler.guard.ts` **untouched** — its `perUser` profile and its `retryAfterSeconds` 429 body are preserved exactly (FR-026, FR-027). Add a test in `test/e2e/rate-limit-proxy.e2e-spec.ts` pinning the 429 body shape
- [X] T039 [US4] (with T028) Configure nginx to **set**, not append to, `X-Forwarded-For` in `nginx/nginx.conf` — `proxy_add_x_forwarded_for` would preserve a client-supplied value and, with `trust proxy = 1`, let anyone forge a fresh budget. This single line is the whole trust boundary (FR-022)
- [X] T040 [P] [US4] Write `test/e2e/rate-limit-proxy.e2e-spec.ts`: two forwarded addresses get independent budgets; exhausting one does not affect the other; a client-supplied forwarded header from an untrusted hop is not honoured; health routes are never throttled
- [X] T041 [US4] Verify the five `@Throttle({ default: … })` routes — `src/modules/auth/auth.controller.ts:27,:53` and `src/modules/orders/orders.controller.ts:434,:662,:696` — become per-client rather than sharing one platform-wide bucket. These are **fixed**, not merely preserved: behind a proxy today, ten failed logins from any one client would lock every user out of logging in (research R5)

**Checkpoint**: All four P1 launch blockers complete. **Suggested MVP boundary.**

---

## Phase 7: User Story 5 — Diagnosable records (P2)

**Goal**: Everything that happened to one order is retrievable by that order's identifier alone.

**⚠ Lands alone.** FR-030 touches every queue enqueue site; a partial landing produces an order
history that looks complete and is silently missing every background action.

**Independent test**: Drive one order through several stages and at least one background job, then
retrieve the complete ordered set by `orderId` alone.

- [X] T042 [US5] Create `src/common/logging/pino.config.ts` with the level from `LOG_LEVEL`, severity mapped to the form the log service recognises (FR-028a), and `redact` covering `req.headers.authorization`, `password`, `otp`, `code`, `token`, `refreshToken` as a **constant, not a convention** (FR-033)
- [X] T043 [US5] Register `LoggerModule.forRootAsync` in `src/app.module.ts` and `app.useLogger(app.get(Logger))` in `src/bootstrap/configure-app.ts`
- [X] T044 [US5] Extend the stored shape of `src/common/context/tenant-context.service.ts` with `correlationId` — **do not introduce a second `AsyncLocalStorage`**. Two request-scoped stores can disagree, and a job that establishes one but not the other yields a record with a tenant and no correlation, invisible until someone tries to reconstruct an order's history (research R6)
- [X] T045 [US5] Generate a correlation id per request and populate it into the tenant context in `src/common/interceptors/tenant-isolation.interceptor.ts`, honouring an inbound correlation header when present
- [X] T046 [US5] Delete `src/common/middleware/request-logger.middleware.ts` and its `consumer.apply(...)` wiring in `src/app.module.ts`; `pino-http` replaces it. If `configure()` becomes empty, drop `implements NestModule` rather than leaving a no-op
- [X] T047 [US5] Bind `correlationId`, `userId`, `companyId`, `role`, `clientIp` and `instanceId` onto every request-scoped record via the pino-http customProps in `src/common/logging/pino.config.ts` (FR-025, FR-031, FR-035a)
- [X] T048 [P] [US5] Write the correlation id into job data in `src/modules/assignment-escalation/queues/assignment-escalation-queue.service.ts`
- [X] T049 [P] [US5] Write the correlation id into job data in `src/modules/payments/queues/payment-timeout-queue.service.ts`
- [X] T050 [P] [US5] Write the correlation id into job data in `src/modules/stop-detection/queues/stop-escalation-queue.service.ts`
- [X] T051 [P] [US5] Re-establish the correlation id from job data in `src/modules/assignment-escalation/queues/assignment-escalation.processor.ts`
- [X] T052 [P] [US5] Re-establish the correlation id from job data in `src/modules/payments/queues/payment-timeout.processor.ts`
- [X] T053 [P] [US5] Re-establish the correlation id from job data in `src/modules/stop-detection/queues/stop-escalation.processor.ts`
- [X] T054 [US5] Attach `orderId` as a **field** (never interpolated into a message) wherever an order is in scope, in all three processors and in `src/modules/orders/services/order-state.service.ts` — this is what makes FR-032 work and is the single easiest thing to half-do
- [X] T055 [US5] Set the production default so no record is emitted per successful database operation or per realtime position update in `src/common/logging/pino.config.ts` — the tracking stream would otherwise dominate a billable log volume (FR-035)
- [X] T056 [US5] Ensure unhandled failures are recorded with their correlation id in `src/common/filters/http-exception.filter.ts` **while the response body stays byte-identical** (FR-034)
- [X] T057 [P] [US5] Write `test/e2e/request-logging.e2e-spec.ts`: every record is parseable JSON with the required fields; a request and the job it enqueues share one correlation id; **an order's history includes background-job records**; no redacted value ever appears

**Checkpoint**: US5 verifiable; incidents are diagnosable.

---

## Phase 8: User Story 6 — Durable documents (P2)

**Goal**: Documents survive the machine that received them, and any instance can serve any document.

**Independent test**: Upload, destroy and recreate the serving environment, retrieve byte-identical.
Cross-tenant request still 404s. Verify the redirect on a real device.

- [X] T058 [US6] Create the `FileStorage` port (`put`, `signedUrl`, `delete`) in `src/common/storage/file-storage.port.ts` — an abstract class so `FilesService` gains no cloud-vendor import (Constitution IV)
- [X] T059 [P] [US6] Implement `src/common/storage/local-file-storage.ts` writing to a real `sys_storge` directory and returning a platform-served URL carrying a **short-lived signed token scoped to one file**, never relying on the `Authorization` header — clients differ in whether they forward that header across a redirect, so an authenticated local route would pass for some and fail for others, reintroducing FR-038c's trap in the test environment (FR-042, FR-042b)
- [X] T060 [P] [US6] Implement `src/common/storage/gcs-file-storage.ts` using the VM's attached service identity — no key file — with V4 signed URLs, `GET`-only, single-object, `SIGNED_URL_TTL_SECONDS` (FR-038b, FR-040)
- [X] T061 [US6] Register the driver-selected provider in `src/modules/files/files.module.ts` by `STORAGE_DRIVER`
- [X] T062 [US6] Switch Multer from `diskStorage` to `memoryStorage` in `src/modules/files/files.module.ts`. The current `destination` callback reads `req.user.companyId` and creates a directory; with no filesystem target the buffer goes to the service instead. Keep the 10 MB limit and the MIME allowlist exactly as they are
- [X] T063 [US6] Unify `recordUpload` and `writeBufferAndRecord` onto one `FileStorage.put` path in `src/modules/files/files.service.ts` — with `memoryStorage` both now receive a buffer, so the two write paths collapse into one
- [X] T064 [US6] Change `download` in `src/modules/files/files.controller.ts` to issue a **302** to `FileStorage.signedUrl(...)` under **every** driver, including local, issued only **after** `findForDownload`'s tenant-scoped read succeeds, with `Cache-Control: no-store` — a cached redirect to an expired location fails intermittently and reads as a storage fault (FR-039, FR-042a, FR-042c)
- [X] T064a [US6] Add the token-addressed local byte route serving from `sys_storge`, reachable only with a valid unexpired token scoped to one file id (FR-042b). It exists solely so the local driver can complete the same redirect the GCS driver does. **The token is the authorization**, so three properties are load-bearing and none is optional: the route is `@Public()` (excluded from the global `JwtAuthGuard`, which requires an explicit decorator given the guard order in `src/common/common.module.ts`); it is registered **only** when `STORAGE_DRIVER=local`; and the token is signed with `LOCAL_STORAGE_TOKEN_SECRET` (deriving from `JWT_SECRET` via a fixed named context string when unset — never the same key material) with `LOCAL_STORAGE_TOKEN_TTL_SECONDS`
- [X] T064b [US6] Write a test asserting the local byte route **does not exist** under `STORAGE_DRIVER=gcs`, and that it refuses an expired token, a token for a different file, and a request with no token. This is an unauthenticated endpoint that streams tenant documents — acceptable only because it is scoped, expiring and absent from production, so each of those must be asserted rather than assumed
- [X] T065 [US6] Add the schema comments to `src/modules/files/schemas/file.schema.ts`: (a) `storagePath` keeps its name and type and now holds an object key — renaming to `objectKey` would read better and would break FR-038's payload freeze; (b) the `sys_storge/{companyId}/…` prefix is **organisation only** and enforces nothing, since the tenant boundary is held entirely by the scoped read before signing (FR-040a)
- [X] T066 [US6] Verify `FileRecordSchema` keeps `markTenantScoped` and that `findForDownload` still runs through the plugin. `files.controller.ts:download` has no explicit tenant check and correctly needs none — removing the marker would open a cross-tenant read on a controller that *looks* unprotected
- [X] T067 [P] [US6] Surface storage read/write failures in the platform's standard error shape, ensuring no `FileRecord` is persisted for bytes that did not land (FR-041)
- [X] T068 [US6] Update `test/e2e/file-access.e2e-spec.ts` — download asserts a **302 under every driver**, that following it yields the bytes, that `Cache-Control: no-store` is present, and that the local token route refuses an expired or wrong-file token. Cross-tenant access still 404, never 403. Add a comment recording what this does **not** establish: it never exercises a *cross-origin* redirect, so bucket CORS, clock skew against the signed expiry and per-client redirect behaviour remain unverified here (FR-042d)
- [X] T069 [P] [US6] Write `test/e2e/file-storage.e2e-spec.ts`: upload then serve from a second app instance; expired signed location no longer serves; no metadata record for a failed upload
- [X] T070 [US6] Remove the `./sys_storge:/app/sys_storge` bind mount from `docker-compose.yml` for the GCS driver and drop the `mkdir sys_storge` from `Dockerfile` where it is no longer needed; keep both for local-driver development
- [X] T071 [US6] Record the bucket configuration in [operations-contract.md](./contracts/operations-contract.md) §4: regional, same region as compute, **public access prevention enforced**, CORS naming the dashboard origin explicitly and never `*` (FR-040b, FR-040c, FR-064c)
- [X] T072 [US6] **Add the mobile-redirect check to the pre-launch checklist** in [operations-contract.md](./contracts/operations-contract.md) §7 item 2 (FR-038d, FR-042e) — download a file on a real mobile client, against the real bucket, and assert the bytes arrive. A client that forwards `Authorization` across the cross-origin redirect is refused by the object store; browsers strip the header, so the dashboard and CI both pass and only a real device fails. T068's same-origin redirect does **not** cover this (FR-042d). Highest-risk item in this feature
- [X] T072a [US6] Add a conditional follow-up task: **if T072 shows the mobile client forwards the header**, apply a fix confined to that client's redirect handling in `mobile_app/`, altering no request it sends to the platform itself (FR-038e). This is the single permitted exception to FR-067, and it needs to exist as planned work rather than be discovered during launch week

**Checkpoint**: US6 verifiable; documents outlive their machine.

---

## Phase 9: User Story 7 — Secrets (P2)

**Goal**: No secret in any artifact; rotatable without a rebuild; every read attributable.

**Independent test**: Inspect an image — no secret recoverable. Rotate at source, roll, adopted. Read
a secret, find the read in the provider's audit log.

- [X] T073 [US7] Create `src/secrets/secrets-loader.ts` exporting `loadSecrets(): Promise<void>`, dispatching on `SECRETS_DRIVER`. `env` is a **complete no-op**, so development and all tests are untouched (FR-048)
- [X] T074 [US7] Implement `src/secrets/secret-manager.driver.ts` fetching each name in `SECRETS_MANIFEST` via the VM's attached service identity and writing it into `process.env` (FR-043)
- [X] T075 [US7] Call `await loadSecrets()` in `src/server.ts` **before** `NestFactory.create`. This ordering is the design: `ConfigModule.forRoot` validates `process.env` at construction, so a Nest custom loader would run *after* Joi and fail validation before ever loading. Not one line of `configuration.ts` or `validation.ts` changes, and Joi remains the thing that fails on an absent secret (FR-046, FR-049, research R8)
- [X] T076 [P] [US7] Confirm a fetch failure throws before `listen()`, so a partially-configured instance never serves and never reports ready (FR-046)
- [X] T077 [P] [US7] Write `test/unit/secrets-loader.spec.ts`: `env` driver is a no-op; a missing required secret prevents startup; secrets are read once and never re-read (FR-044a)
- [X] T078 [US7] Document rotation in [operations-contract.md](./contracts/operations-contract.md) §5, including that rotating a **token-signing key is a sign-everyone-out event** (FR-047a) — during the rollout the two instances hold different keys so tokens issued by one are refused by the other, and afterwards every previously-issued token is invalid. Correct for a suspected compromise, wrong as routine maintenance
- [X] T079 [US7] Verify no secret value can appear in a deployment artifact: remove `env_file: .env` from the app service in `docker-compose.yml` for the production profile, and confirm `.env` is in `.dockerignore` and `.gitignore`

**Checkpoint**: US7 verifiable.

---

## Phase 10: User Story 8 — Database resilience (P2)

**Goal**: A brief database interruption produces prompt failures and self-recovery, not a pile-up.

**Independent test**: Interrupt the database under load → prompt failures in the standard error
shape; serving normally within 60 s of its return, without a restart.

- [X] T080 [US8] Add explicit pool bounds and timeouts to `MongooseModule.forRootAsync` in `src/app.module.ts` — `maxPoolSize`, `minPoolSize`, `serverSelectionTimeoutMS`, `connectTimeoutMS`, `socketTimeoutMS`, `waitQueueTimeoutMS` from config (FR-050, FR-051, FR-055)
- [X] T081 [US8] Verify `MONGO_SOCKET_TIMEOUT_MS` exceeds the longest legitimate transaction — dispatch assignment and payment webhook. Set too low, Story 8's resilience work becomes Story 8's data-integrity bug (FR-054)
- [X] T082 [P] [US8] Confirm requests fail within the bound in the platform's standard error shape through `HttpExceptionFilter`, rather than accumulating (FR-052)
- [X] T083 [P] [US8] Confirm a timeout never leaves a transaction partially applied — every existing boundary keeps its all-or-nothing behaviour (FR-054)
- [X] T084 [P] [US8] Write `test/e2e/db-resilience.e2e-spec.ts`: unreachable database → prompt failures, no pile-up; recovery within the window without a restart; the pool ceiling is never exceeded
- [X] T085 [US8] Confirm readiness reports not-ready while the database is unreachable and returns to ready on its own once it recovers, with no single failed probe permanently condemning an instance (FR-005, spec Edge Cases)

**Checkpoint**: All P2 stories complete.

---

## Phase 11: User Story 9 — Horizontal readiness (P3)

**Goal**: The platform can run as more than one instance. **Lands last and alone.**

**Independent test**: Two instances, one shared database and Redis. Sweep runs at most once per
interval; a sweep forced to run twice has the effect of one; an event from one instance reaches a
client on the other; one shared rate-limit budget; drain one, the other keeps serving.

- [X] T086 [US9] Attach `@socket.io/redis-adapter` to the `Server` in `src/modules/tracking/tracking.gateway.ts` `afterInit`. **This is the entire realtime fix**: every outbound emission already funnels through `RealtimeGatewayService.emitToOrderRoom`/`emitToUser`, and `TrackingGateway` makes no direct emit, so one attachment covers `order:location`, `order:status`, `order:otp`, `notification:new` and `session:revoked` — every addressing mode and every emission path (FR-059, FR-060)
- [X] T087 [P] [US9] Leave `src/common/realtime/realtime-gateway.service.ts` **unchanged** — the adapter attaches upstream of it. Add a comment recording that the six calling services need no change
- [X] T088 [US9] Create `src/common/scheduler/scheduler-lease.service.ts` — acquire with `SET key token NX PX ttl` (unique token, expiry, one atomic operation), release by **Lua compare-and-delete** verifying the token, and renew for a legitimately long run (FR-056b)
- [X] T089 [US9] Add the comment to `scheduler-lease.service.ts` recording that the lease is **at-most-once, not exactly-once**: a pause outlasting the TTL still produces a concurrent run no lease can prevent. Correctness rests on FR-056a's idempotency; the compare-and-delete exists so an expired holder cannot delete the lease a different instance now holds
- [X] T090 [US9] Guard `PresenceService.sweepOfflineDrivers` in `src/modules/tracking/presence/presence.service.ts` with the lease keyed `presence-offline`
- [X] T091 [US9] Guard `StopDetectionService.sweepStalledDeliveries` in `src/modules/stop-detection/stop-detection.service.ts` with the lease keyed `stop-detection`. **Both sweeps are fleet-wide**, so both take a lease keyed by sweep name; neither becomes per-entity work. The dynamic `SchedulerRegistry.addInterval` registration must keep honouring `STOP_DETECTION_SWEEP_SECONDS`, which the e2e suite and quickstart both lower — that configurability is the entire reason it is not a decorator (FR-057)
- [X] T092 [US9] Leave `src/modules/stop-detection/queues/stop-escalation-queue.service.ts` **unchanged** and add a comment saying so: the per-delivery escalation already runs on the shared queue with a deterministic per-order job id, already distributes correctly across instances, and was never a single-instance constraint. Applying a lease to it would be a regression (FR-057a)
- [X] T093 [US9] Audit `sweepOfflineDrivers` for idempotency in `src/modules/tracking/presence/presence.service.ts` — a single `updateMany` with the target state in its own filter; confirm and record it (FR-056a)
- [X] T094 [US9] Audit `sweepStalledDeliveries` for idempotency against a **concurrent** second run in `src/modules/stop-detection/stop-detection.service.ts` — feature 011's `unblockedStopFilter` and the escalation's conditional write suggest it is safe, but this must be **asserted, not assumed** (FR-056a)
- [X] T095 [US9] Emit a `sweep.completed` structured record from both sweeps, carrying the sweep name, so the FR-058a alert has something to observe
- [X] T096 [US9] Replace the default in-memory throttler storage with `ThrottlerStorageRedisService` in `src/app.module.ts`, so counters are shared across instances and survive a restart. **This is the third single-instance constraint** — unnamed in the original framing and found during spec verification (FR-061)
- [X] T096a [US9] Wrap the shared counter store so a storage error **falls back to per-instance in-memory counting** rather than failing the request (FR-061a). Without this, T096 makes Redis a *harder* dependency than the database: every request would error during a Redis outage, contradicting FR-002a's decision to keep such an instance in rotation and turning a partial degradation into the total outage that decision exists to prevent
- [X] T096b [US9] Ensure the fallback still **limits** rather than allowing everything (FR-061b) — the degraded budget is N× the configured limit across N instances, approximate but bounded. Failing open would leave login, refresh and the one-time-code routes with no brute-force protection for the duration, exploitable by anyone able to induce a cache outage
- [X] T096c [P] [US9] Record entering and leaving the fallback (FR-061c) so a period of degraded limiting is identifiable afterwards rather than inferred
- [X] T096d [P] [US9] Detect and alert on loss of the cross-instance transport (FR-063, FR-063a), and report it in the readiness body (FR-063b). **Nothing else can surface it**: an event emitted while the transport is down still reaches clients on the emitting instance, so from that instance's vantage point delivery is indistinguishable from success — and FR-002a keeps every instance in rotation reporting itself healthy throughout
- [X] T096e [US9] Write `test/e2e/redis-degradation.e2e-spec.ts`: with the shared store unavailable, requests still succeed; a client exceeding N× the budget is still refused; the degradation is recorded; readiness stays 200 (SC-019, SC-020)
- [X] T097 [US9] Leave BullMQ job distribution **unchanged** and add a comment to the three processors recording that delivery is at-least-once by design: `Worker.close()` deliberately releases an unfinished job for redelivery, which is what FR-009 wants, so a redelivered job must reach the same end state as a single delivery (FR-062)
- [X] T098 [US9] Create `test/utils/multi-instance.factory.ts` booting **two** `INestApplication`s against the **same** `MongoMemoryReplSet` uri and the same `REDIS_URL` on distinct ports. `createTestApp` currently creates a new replica set per call, so two calls give two isolated databases (research, Cross-cutting)
- [X] T099 [US9] Write `test/e2e/multi-instance.e2e-spec.ts` asserting FR-070's five cases: a contested lease; a sweep run twice concurrently producing **no** duplicate notification or double state change; an event emitted by one instance reaching a client on the other; one client's requests across both instances counting against one budget; one instance draining while the other serves
- [X] T100 [US9] Add an assertion that the lease holder's death lets a surviving instance run the next sweep within one interval, with no operator action — which requires the lease to expire on its own (FR-058)
- [X] T101 [US9] Update `docker-compose.yml` to run two app replicas behind the nginx service, with `INSTANCE_ID` distinct per replica
- [X] T102 [US9] Verify `SCHEDULER_LEASE_TTL_MS` sits above the measured p99 sweep duration and below the sweep interval, so a dead holder's lease expires before the next tick (FR-056b)

**Checkpoint**: Redundancy is possible. The deployment becomes final rather than provisional.

---

## Phase 12: Polish & Cross-Cutting

- [X] T103 [P] Add the sweep-stall alert definition to [operations-contract.md](./contracts/operations-contract.md) §6 — no `sweep.completed` for a sweep name within three intervals. **The one required alert**: Redis being unreachable no longer takes instances out of rotation (Q7), so a Redis outage stalls every leased sweep while the platform keeps serving and reporting itself healthy. Stalled stop-detection means a stalled delivery goes unnoticed — the precise harm feature 011 exists to prevent (FR-058a)
- [X] T104 [P] Publish the personal-data inventory required by FR-064d — documents in the bucket, and the identifiers and locations appearing in records — so a residency review runs against a list rather than a code search
- [X] T105 [P] Verify FR-064c: bucket, log destination and secret store are all provisioned in the **same region as the compute**, none placed elsewhere for convenience
- [X] T105a [P] Review that every provider-specific client reaches its API **through a port with a second working implementation** (FR-064b) — `FileStorage` has the local driver, `SecretsLoader` has the env driver. A component reaching a provider API without such a port is a violation; through one is not. This is the difference between portability and the appearance of it, and it is a review check because no test can distinguish the two
- [X] T105b [P] Record in [operations-contract.md](./contracts/operations-contract.md) §5 that FR-045's secret-read auditing is verified **only** in the live pre-launch pass (§7 item 3) — continuous integration has no attached service identity, and a test against a stubbed store would assert the stub's behaviour rather than the store's. A deliberate limit, stated so it is not mistaken for an oversight
- [X] T106 Run the full regression: `npm run lint:check`, `npm run build`, `npm run test`, `npm run test:e2e`. Every pre-existing suite must pass unchanged except where a test asserts on an operational behaviour this feature deliberately alters (FR-068)
- [X] T107 [P] Confirm both clients require no change (FR-067) — run `flutter test` in `mobile_app/` and `vitest run` + `tsc -b --force` in `web_dashboard/`, recording the same pre-existing baseline failures earlier features documented, and no new ones
- [X] T108 [P] Update `specs/001-fuel-delivery-platform/contracts/rest-api.md` with the two health endpoints and the changed `GET /files/:id` response
- [X] T109 Walk `specs/012-production-hardening/quickstart.md` Parts 0–2 end to end and record the results
- [ ] T110 Complete the FR-072 pre-launch checklist in [operations-contract.md](./contracts/operations-contract.md) §7 — assign a named owner and a date to each of the ten items. **Five consecutive features in this repository ended with a live verification step outstanding**; this list exists so this one's remaining work is visible rather than discovered in an incident

---

## Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Slice 0 — configureApp)  ⚠ BLOCKS EVERYTHING
    ↓
    ├─→ Phase 3  (US1 Health)  ──┬─→ Phase 4  (US2 Shutdown)
    │                            └─→ Phase 10 (US8 DB resilience)
    ├─→ Phase 5  (US3 CORS)          [independent]
    ├─→ Phase 6  (US4 Rate limiting) [independent]
    ├─→ Phase 7  (US5 Logging)       [alone]
    │       ↓
    │   Phase 8  (US6 Storage) ──────────┐
    ├─→ Phase 9  (US7 Secrets)           │  [independent of 1–6]
    │                                    ↓
    └────────────────────────→ Phase 11 (US9 Horizontal)  [last, alone]
                                         ↓
                                    Phase 12 (Polish)
```

**Hard orderings and why**

- **Phase 2 before everything**: without it, four bootstrap-level properties are added to `server.ts`
  and asserted by nothing, and US3 cannot be tested at all.
- **T019a before T028, T028b, T035 and T039** — the topology finding. It decides whether the
  readiness monitor is needed at all and whether the trusted-hop count is one or two. Guessing the
  hop count wrong produces no error and no symptom, so this must be settled, not assumed.
- **T028 before T028b**: the monitor rewrites the upstream file T028 creates.
- **US1 before US2**: the drain gate flips the readiness flag US1 introduces.
- **US1 before US8**: readiness is how recovery is observed.
- **US5 before US6**: storage failures should be diagnosable when they first occur.
- **US6 before US9**: documents must be shared before a second instance can serve them.
- **T007a before T070, T079 and T101** — each modifies Compose under a condition the others exclude.
- **T096 before T096a**: the fallback wraps the shared store, so the store exists first. Landing T096
  without T096a leaves a window in which a Redis outage errors every request on the platform.
- **US5 and US9 land alone**: US5's correlation propagation is half-doable in a way that looks
  complete; US9's guarantees are invisible when wrong.

## Parallel Opportunities

| Phase | Parallel set |
|---|---|
| 1 | T002, T003, T004, T007 |
| 3 | T014, T018, T019 |
| 4 | T024, T025, T026 |
| 5 | T032, T033 |
| 6 | T038, T040 |
| 7 | **T048–T053** — six queue files, one per enqueue site and processor |
| 8 | T059, T060 (two adapters); T067, T069; T064b alongside T072a |
| 9 | T076, T077 |
| 10 | T082, T083, T084 |
| 11 | T087 alongside T088; T096c, T096d |
| 12 | T103, T104, T105, T107, T108 |

Not parallelizable despite appearances: **T019a** (everything about the proxy waits on it),
**T028b** (needs T028's file), **T096a** (needs T096's store).

## Implementation Strategy

**MVP = Phases 1, 2, 3, 4, 5, 6** (T001–T041). That is Slice 0 plus the four P1 launch blockers, and
it is the smallest set that makes the platform launchable: it can be monitored, deployed without
corrupting in-flight work, reached by the dashboard, and rate-limited per client.

**Then Phases 7–10** (T042–T085) — diagnosability and durability. An incident becomes tractable and a
document outlives its machine.

**Then Phase 11** (T086–T102) — redundancy becomes possible. This is what makes the deployment final
rather than provisional, and it is genuinely deferrable: the platform is correct on one instance
without it.

**Task count**: 125 · US1 8 · US2 11 · US3 6 · US4 7 · US5 16 · US6 18 · US7 7 · US8 6 · US9 22 ·
Setup 8 · Foundational 6 · Polish 8 · 40 parallelizable

## Notes

- **T012 is a gate, not a checkbox.** Phase 2 is a pure refactor; anything other than an identical
  152/152 and 267/267 means it changed behaviour it must not change.
- **T054 and T048–T053 are the feature's most skippable real work.** Half-done, an order's history
  looks complete and silently omits every escalation and timeout that acted on it.
- **T072 cannot be closed in CI.** A mobile client forwarding `Authorization` across the redirect is
  refused by the object store; the dashboard and CI both pass. Needs a real device.
- **T017 and T089 exist to stop a future reader "fixing" a deliberate asymmetry** — a 200 alongside a
  `down` entry, and a lease that does not promise exactly-once. Both look like bugs and are not.
- **T031, T092, T096 and T097 come from verification, not from the original framing**: a production
  WebSocket CORS wildcard, an escalation queue that must be left alone, in-memory throttler counters
  as a third single-instance constraint, and at-least-once job delivery as a property to preserve.

---

## Corrections found while implementing

Each is a case where following the plan as written would have shipped something plausible and wrong.

- **`INSTANCE_ID` resolved to `''` on every deployment that did not set it**, so FR-035a had no
  answer anywhere — not in a single log record, not in either health response. Joi declares it
  `.allow('').default('')` and `@nestjs/config` writes the *validated* result back into
  `process.env`, so an unset variable reaches `configuration.ts` as `''`, and `??` does not treat
  `''` as absent. One character (`??` → `||`). Found by `request-logging.e2e-spec.ts`; the same trap
  is documented in `test/setup-env.ts` and was walked into anyway.

- **`CORS_ALLOWED_ORIGINS=` (set but empty) was ACCEPTED in production**, defeating FR-018 by the
  route a real deployment is likeliest to take. Joi keeps a base schema's `.allow('')` when it merges
  the conditional one, and an explicitly-permitted value short-circuits `.min(1)` and `.required()`
  alike. An empty allowlist matches nothing, so every browser request is refused — the exact silent
  breakage the requirement exists to prevent. **`GCS_BUCKET` and `GCP_PROJECT_ID` had the identical
  hole.** Fixed with `.invalid('')` in each `then` branch. Found by walking quickstart Part 1
  against a real server, not by any suite.

- **`customProps` covers only the request-completion record, so no background job's records carried a
  correlation id at all** — FR-030 would have been half-implemented in exactly the way the task list
  warns about, with the request half present, the job half present, and the join between them
  missing. Replaced with a pino `mixin`, which runs for every record whatever produced it.
  `customProps` remains for `clientIp`, which genuinely does not exist outside a request.
  Then the mirror-image problem: pino-http emits its record from `res.on('finish')`, **outside** the
  AsyncLocalStorage scope, so the mixin sees nothing there — the interceptor stashes the fields on
  `req` for that one record.

- **`server.adapter is not a function` — the Redis adapter never attached.** `afterInit` hands a
  **namespace**, not the root `Server`, for a gateway declared with `namespace: 'tracking'`, and
  `Namespace.adapter` is a property rather than a method. The throw was caught and logged, so every
  single-instance test passed and cross-instance delivery was silently dead — the precise failure
  mode Story 9 exists to remove. Caught by `multi-instance.e2e-spec.ts` and by nothing else.

- **An unhandled `'error'` event on a BullMQ queue or worker CRASHES the process.** `QueueBase`
  re-emits its Redis connection's errors, and Node's EventEmitter throws when `'error'` has no
  listener. Story 9 makes Redis load-bearing for five subsystems while Q7 deliberately keeps a
  Redis-less instance in rotation on the grounds that its loss *degrades* the platform — an
  EventEmitter default would have turned that same loss into an instance crash. Six listeners
  (`attachQueueErrorHandler`).

- **`TrackingGateway.handleConnection` could crash the instance on every driver connect.** Socket.io
  invokes it and ignores the returned promise, and both statements in it can reject — `client.join`
  round-trips through the Redis adapter, `presenceService.touch` is a Mongo write. An unawaited
  rejecting promise is an unhandled rejection, which terminates the process under Node's default, so
  during a Mongo or Redis interruption the platform would have gone down one driver connect at a
  time. Same class as the BullMQ `'error'` emitter, and squarely contrary to Q7: those dependencies
  are meant to degrade the platform, never crash it. Now caught and recorded; the socket stays
  connected and both effects self-correct (the client reconnects; the next location frame touches
  presence). Found while chasing a teardown flake that turned out to be this.

- **Both new Redis-owning components closed their connections in the wrong lifecycle phase.** Nest
  runs `callDestroyHook()` **before** `dispose()`, so an `onModuleDestroy` closes connections while
  the HTTP server is still accepting and the Socket.io adapter still holds subscriptions — producing
  "Connection is closed" rejections during every shutdown. Both moved to `onApplicationShutdown`, and
  the adapter additionally waits one turn of the event loop for the unsubscribes `dispose()` triggers.

- **A scheduled sweep firing during the drain made a clean shutdown report itself as a failed one.**
  Its Mongo connection is closed underneath it by `callDestroyHook()`, `app.close()` rejects, and
  `configureApp`'s handler takes its failure branch and exits 1 — destroying the distinction FR-012
  exists to make. `beginDraining` now stops every cron and interval first: draining means finishing
  what is in flight, not starting more, which is the same rule BullMQ workers already follow.

- **Establishing a correlation id on public routes nearly broke every login.** Both scoping plugins
  bypassed on `!ctx` — "no store at all". Once anonymous requests carry a store (they must, to be
  correlated), that test admits a context with no `role` into the authenticated branch and throws
  *"authenticated non-SUPER_ADMIN context is missing companyId"* on every unauthenticated request.
  The discriminator is now `!ctx?.role`, stated in both plugins and asserted by test.

- **`FilesService` had two write paths and only one could survive Story 6.** `recordUpload` recorded
  metadata for bytes Multer had already written to local disk. With `memoryStorage` both callers
  arrive holding a buffer, so they collapse into one `store()` — keeping both would have left one of
  them writing to a disk production no longer has.

- **The e2e harness leaked a mongod and hung whenever a teardown failed.** `withTeardownBudget`
  rethrew, so a rejecting `app.close()` skipped `replSet.stop()` entirely — turning one bad close
  into a stuck process and a string of slow suites after it. It also let a *late* rejection (arriving
  after the budget's race resolved) escape as an unhandled rejection no caller could catch. Both
  fixed; a failing teardown is now a warning, like a slow one, and the shutdown story's guarantees
  are asserted directly rather than resting on teardown noise.

- **Moving throttler counters to Redis broke 52 e2e tests before it fixed anything.** Counters became
  shared across every suite in the run — and across previous runs — so the 10/min login budget was
  exhausted within the first few suites and everything after failed with unrelated 429s. The test
  factory now resets the store per app, restoring the per-app assumption the suites were always
  written against; four suites that reached into the old in-memory `Map` were moved onto a real
  `reset()`.

- **`ResilientThrottlerStorage` is not a nicety.** `ThrottlerStorageRedisService` fails **closed**,
  and the guard is global, so a Redis outage would have been a 500 on every request on the platform
  — making Redis a harder dependency than MongoDB, and turning Q7's decision into the cause of the
  outage it was taken to prevent.

### Not completed

- **T110 — the pre-launch checklist's owners and dates.** It needs named people; a placeholder would
  make the list look closed when it is not, which is the one thing the table exists to prevent.
- **Quickstart Part 1's two-instance nginx section, and all of Part 3.** No VMs, bucket, secret store
  or log sink exist yet (operations-contract §1). The two-instance *guarantees* are covered by
  `multi-instance.e2e-spec.ts`; the nginx, monitor and deploy machinery themselves are unproven and
  are what §7's checklist tracks.
