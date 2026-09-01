# Research: Production Hardening & Horizontal Readiness

**Feature**: 012-production-hardening | **Date**: 2026-08-31

Nine decisions. Each was checked against the code on this branch rather than inferred from the
spec, and four of them (**R1**, **R4**, **R6**, **R9**) overturn something the spec or the
clarification session assumed. Those four are the reason this document exists; the rest record
choices that were genuinely open.

---

## R1 — Bootstrap configuration must be extracted before anything else is added

**Decision**: Extract every `app.*` bootstrap call out of `src/server.ts` into a single exported
`configureApp(app, options)` in `src/bootstrap/configure-app.ts`, and have **both** `server.ts` and
`test/utils/test-app.factory.ts` call it. This lands **first**, alone, before any operational
behaviour is added.

**Rationale**: This is the highest-leverage finding in the feature, and it inverts the natural
implementation order.

`test-app.factory.ts` does **not** boot the application the way production does. It re-implements a
subset of `server.ts` by hand:

| `server.ts` does | `test-app.factory.ts` does |
|---|---|
| `app.use(helmet())` | — **missing** |
| `enableVersioning` | ✅ duplicated |
| `setGlobalPrefix('api')` | ✅ duplicated |
| `useGlobalPipes(ValidationPipe)` | ✅ duplicated |
| `useGlobalFilters(HttpExceptionFilter)` | ✅ duplicated |
| `enableCors` (non-prod only) | — **missing** |

So all **53 e2e suites and 267 tests** run against an app that has never had helmet or CORS applied.
Every property this feature adds at bootstrap — CORS (Story 3), `trust proxy` (Story 4), shutdown
hooks (Story 2) — would be added to `server.ts` and silently **not exercised by a single test**.

That is precisely the failure mode this feature exists to eliminate: a production-only behaviour
that no test observes. Adding four such behaviours through a duplicated bootstrap would mean the
hardening feature reintroduces, four times over, the class of defect it was written to remove.

The extraction also makes Story 3 testable at all. FR-014–FR-019 are assertions about CORS
behaviour in production configuration; with the current factory there is no way to write them.

**Alternatives considered**:

- *Add to `server.ts` and test manually.* Rejected — five consecutive features in this repository
  ended with an unperformed manual verification step. A property nothing asserts is a property that
  regresses silently.
- *Duplicate the new configuration into the factory as well.* Rejected — it doubles the drift
  surface that caused the problem, and the next feature inherits two bootstraps to keep in sync.
- *Have `server.ts` export its own `bootstrap()` for tests to call.* Rejected — `bootstrap()` also
  calls `listen()` and reads `process.env` directly; the factory needs configuration without those.
  A separate `configureApp` that neither listens nor reads the environment is the honest seam.

**Consequence for sequencing**: R1 is Phase 0 of implementation. Nothing else in this feature can be
verified until it lands.

---

## R2 — Health endpoints: `@nestjs/terminus`, with the readiness verdict split from the report

**Decision**: Add `@nestjs/terminus`. Expose `GET /api/v1/health/live` (process only, no dependency
checks) and `GET /api/v1/health/ready` (Mongo disqualifying, Redis reported-only). Both are
`@Public()` and both bypass the throttler. A `HealthModule` owns them.

**Rationale**: Terminus is the first-party NestJS health-check package, already integrates with the
Mongoose connection (`MongooseHealthIndicator`), and produces a `{ status, info, error, details }`
body with a 200/503 status — which satisfies FR-002b's split between "verdict in the status" and
"detail in the body" without inventing a shape.

Clarification Q7 requires Redis to be **reported but not disqualifying**. Terminus's default
`HealthCheckService` fails the whole check if any indicator fails, so the Redis indicator cannot be
passed to it directly. The implementation puts Mongo in the Terminus check and attaches Redis status
as an extra key on the response, computed independently — Redis's state changes the body, never the
status code.

**FR-006a is a real constraint here, not a formality.** The Mongo indicator must not consume a
connection the request traffic needs. `MongooseHealthIndicator.pingCheck` issues an admin ping over
the existing connection rather than opening a new one, which satisfies this — but the timeout must
be set explicitly (Terminus defaults to 1000 ms; we set it from config) so a slow primary resolves as
unavailable rather than leaving the probe outstanding.

**Alternatives considered**:

- *Hand-rolled controller with no dependency.* Viable and briefly attractive, but re-implements
  timeout handling, the response shape and the status mapping. No benefit.
- *Single `/health` endpoint.* Rejected by FR-003 — a liveness probe that fails when Mongo is down
  causes the orchestrator to **restart** an instance whose own process is fine, turning a database
  incident into a restart storm.

---

## R3 — Graceful shutdown: `enableShutdownHooks()` plus an explicit drain gate

**Decision**: Call `app.enableShutdownHooks()` in `configureApp`. Add a `ShutdownService`
implementing `OnApplicationShutdown` that flips a `draining` flag which `/health/ready` reads
(FR-005). Set `app.getHttpServer().keepAliveTimeout` and a `SHUTDOWN_DRAIN_MS` bounded wait.
BullMQ workers get `Worker.close()` via their own `OnModuleDestroy`.

**Rationale**: `enableShutdownHooks()` is simply absent today — which is why `RedisModule`'s
`onModuleDestroy` (written specifically to close the ioredis connection, with a comment saying so)
has **never run in production**. One line restores every destroy hook already written.

The drain gate is separate from the hooks because ordering matters and Nest does not guarantee it:
readiness must go negative *before* the server stops accepting connections (FR-005), so nginx
removes the instance from rotation while it is still serving. `OnApplicationShutdown` fires after
Nest has begun tearing down, which is too late — so the flag is set by a signal handler registered
in `configureApp`, before `app.close()` is invoked.

**BullMQ's `Worker.close()` is the mechanism FR-009 relies on.** It stops fetching new jobs and waits
for in-flight handlers, then releases the lock so an unfinished job is redelivered rather than lost.
This is why FR-062 must state at-least-once rather than exactly-once (see R9).

**Alternatives considered**:

- *Rely on `enableShutdownHooks()` alone.* Rejected — it does not sequence readiness ahead of socket
  close, so a proxy keeps sending requests to a draining instance.
- *`process.on('SIGTERM')` doing all the work manually.* Rejected — it bypasses the destroy hooks
  modules already declare, and would need re-writing every time a module adds one.

---

## R4 — CORS: an explicit origin allowlist, required in production — and the WebSocket namespace is a second, separate hole

**Decision**: Move `enableCors` out of the non-production branch into `configureApp`, driven by a new
`CORS_ALLOWED_ORIGINS` (comma-separated). Joi requires it in production via the existing
`.when('NODE_ENV', { is: 'production' })` pattern already used for `SMS_PROVIDER` (FR-018).
`credentials: true`. **Additionally**: `TrackingGateway`'s `@WebSocketGateway({ cors: { origin: '*' } })`
is replaced with the same allowlist.

**Rationale — the correction**: The spec describes one CORS defect. There are **two**, and the second
is the opposite of the first.

1. The REST API grants CORS *only outside production* (`server.ts` line 25) — so the dashboard is
   blocked in production. This is the defect the spec describes.
2. `TrackingGateway` is declared `cors: { origin: '*' }` — a hardcoded wildcard that applies in
   **every** environment including production. So the realtime namespace is wide open to any origin
   right now, while the REST API is closed.

Fixing only the first would leave a production wildcard in place on the socket namespace, and the
feature would have "fixed CORS" while leaving the more permissive of the two untouched. Both read
from one config value so they cannot drift.

The socket wildcard also matters for Story 9: the Redis adapter is attached to that same server, and
an origin policy is easier to reason about when there is exactly one.

**Alternatives considered**:

- *`origin: true` (reflect any origin) in production.* Rejected — with `credentials: true` this is
  equivalent to no policy at all, and Q2's unresolved residency posture makes a permissive default
  worse than a strict one.
- *Leave the gateway wildcard, since Socket.io's own auth guards it.* Rejected — authentication is
  not an origin policy, and FR-040c already requires the bucket's CORS to name the dashboard origin;
  leaving the socket wildcard would make the platform's three origin policies disagree.

---

## R5 — Rate limiting: `trust proxy`, a Redis-backed store, and a signature-verifying tracker

**Decision**: Three changes, all in Story 4 except the storage which lands with Story 9.

1. `app.set('trust proxy', TRUSTED_PROXY_HOPS)` in `configureApp`, so `req.ip` is the client rather
   than the proxy. The proxy immediately in front must *set*, not append to, `X-Forwarded-For`.
   **The hop count has no default and MUST NOT be assumed** (FR-022, amended by Clarification Q11):
   it is `1` if nginx is the only proxy and `2` if a managed load balancer fronts it, and which of
   those holds is FR-007d's finding — see R10. Shipping `1` where there are two makes the load
   balancer the attributed client for every request on the platform, which is the same
   undifferentiated-origin failure this story exists to fix, reached by a different route and
   equally invisible.
2. `ThrottlerStorageRedisService` (`@nest-lab/throttler-storage-redis`) replaces the default
   in-memory store, so counters are shared and survive restarts (FR-061) — wrapped so a storage
   error falls back to per-instance counting rather than failing the request (FR-061a, see R11).
3. A `GlobalThrottlerGuard extends ThrottlerGuard` whose `getTracker` returns
   `user:{sub}` when the request carries a **signature-verified** JWT, else `req.ip`.

**Rationale — the correction**: The spec's FR-023 ("an authenticated request counted against a
user-keyed budget") is not implementable as a simple `req.user` read, because of guard ordering.
`common.module.ts` registers `ThrottlerGuard` **before** `JwtAuthGuard`, deliberately and with a
comment explaining the order. So at the moment the global throttler runs, `req.user` **does not
exist**. A tracker reading `req.user?.userId` would silently always fall through to the IP branch —
compiling, passing tests, and doing nothing.

Three ways out were considered:

- *Reorder the guards so Jwt runs first.* **Rejected, and this is the important one**: it would mean
  a request bearing a malformed token is rejected by `JwtAuthGuard` **before** the throttler ever
  counts it. An attacker could then bypass rate limiting entirely by sending garbage tokens — turning
  a rate-limit fix into a rate-limit removal.
- *Decode the JWT without verifying, to read `sub` cheaply.* **Rejected**: the tracker key would then
  be attacker-controlled. Anyone could forge `sub` and exhaust another user's budget — a targeted
  denial of service against a named user, introduced by the fix.
- *Verify the signature inside `getTracker`.* **Chosen.** HMAC verification is microseconds, the key
  is trustworthy, and a failed verification falls back to the IP branch, where the request will be
  rejected by `JwtAuthGuard` moments later anyway.

**A second correction, on blast radius.** The spec says the per-route limits are unaffected by the
proxy problem. That is true of exactly one route. `@Throttle({ default: ... })` is read by the
**global, IP-tracked** guard, and it decorates:

- `auth.controller.ts:27` and `:53` — login and refresh, 10/min
- `orders.controller.ts:434, :662, :696` — OTP issue/verify paths, 5/15min

Behind a proxy all five collapse to one bucket for the entire platform. **Ten failed logins from any
one user would lock every user out of logging in.** Only `users.controller.ts:190` uses
`UserThrottlerGuard`'s separate `perUser` profile, which is genuinely unaffected. FR-026's
preservation requirement therefore applies to one route, and the other five are *fixed* by this work
rather than merely preserved.

---

## R6 — Structured logging: Pino, with the correlation id in AsyncLocalStorage — reusing the existing store

**Decision**: `nestjs-pino` + `pino-http`, replacing the default Nest logger via
`app.useLogger(app.get(Logger))`. Correlation id generated per request, carried in
`TenantContextService`'s **existing** AsyncLocalStorage rather than a second one. `RequestLoggerMiddleware`
is deleted; `pino-http` replaces it. Production level `info`, `PINO_LEVEL` overridable.

**Rationale**: Pino emits newline-delimited JSON on stdout, which the deployment's logging agent
collects with fields preserved (FR-028). Its `severity`/`level` mapping is configured to the form the
logging service recognises (FR-028a).

**The correction**: the natural implementation is a new `AsyncLocalStorage` for the correlation id.
That would be a second request-scoped store alongside `TenantContextService`'s, and the two could
disagree — a background job that sets one and not the other produces records attributed to a tenant
with no correlation, or vice versa. `TenantContextService` already runs an ALS keyed per request and
is already `@Global()`; extending its stored shape with `correlationId` keeps one store, one lifetime
and one place where a background job must establish context.

**FR-030 (correlation crossing into background jobs) is where this gets real.** BullMQ jobs run in a
worker with no request ALS context. The correlation id must be written into the job's `data` at
enqueue time and re-established by each processor. Every existing `*QueueService.schedule` call site
is affected — this is the widest-touching part of Story 5 and the part most likely to be quietly
skipped, leaving FR-032's order history complete for requests and empty for jobs.

**FR-033 (no secrets in records)** is served by Pino's `redact` option, configured for
`req.headers.authorization`, `password`, `otp`, `code`, `token`, `refreshToken`.

**Alternatives considered**:

- *Winston.* Comparable capability; Pino is faster and `nestjs-pino` handles request context binding
  natively.
- *Keep `Logger` and add a JSON transport.* Rejected — Nest's default logger has no structured field
  API, so every call site would have to be rewritten to pass objects anyway.

---

## R7 — Object storage: a `FileStorage` port with GCS and filesystem adapters; `storagePath` becomes the object key

**Decision**: Introduce `FileStorage` (`put`, `signedUrl`, `delete`) with two adapters —
`GcsFileStorage` (production) and `LocalFileStorage` (development and tests), selected by
`STORAGE_DRIVER`. Multer switches from `diskStorage` to `memoryStorage`. `FileRecord.storagePath`
**keeps its name and its type** and now holds the object key `sys_storge/{companyId}/{uuid}{ext}`.
`GET /files/:id` returns `302` to a V4 signed URL, 5-minute expiry.

**Rationale**: The seam is genuinely narrow — three write paths (`recordUpload`,
`writeBufferAndRecord`, and Multer's `diskStorage` destination) and one read path
(`findForDownload` + `res.sendFile`).

**Resolving the open item the spec flagged**: `storagePath` reaches the upload responses, and FR-038
freezes upload payloads. Keeping the field name and type, and changing only its *content* from an
absolute filesystem path to an object key, preserves the payload's shape exactly. No client reads it
(both clients use the file's `_id`), and the value was never a stable contract — it already differs
between machines. Renaming it to `objectKey` would be cleaner and would break FR-038; the field keeps
its name, with a schema comment recording why.

**Multer must move to `memoryStorage`.** The current `diskStorage.destination` callback reads
`req.user.companyId` and creates a directory. With no filesystem target, the buffer goes to the
service, which then calls `FileStorage.put`. This unifies the two write paths — `writeBufferAndRecord`
(which already buffers, for company registration where no `companyId` exists yet) and `recordUpload`
become the same code path. The 10 MB `MAX_FILE_SIZE_BYTES` limit makes buffering safe.

**Tenant isolation is already structural and stays that way.** `FileRecord` is `markTenantScoped`,
so `findForDownload`'s `findById` is scoped by the global plugin — `files.controller.ts:download`
has no explicit tenant check and needs none. This must not be "tidied" during the change: removing
the marker or bypassing the plugin would open a cross-tenant read, and the controller looks like it
has no protection.

**Alternatives considered**:

- *GridFS.* No new vendor, inherits DB replication — rejected once Q3 chose GCS, and it would put
  document bytes in every database backup.
- *Keep proxying bytes through the API.* Reverses Q3/Q4.
- *Rename `storagePath` to `objectKey`.* Cleaner, breaks FR-038.

---

## R8 — Secrets: a `SecretsLoader` that runs before `ConfigModule`, populating `process.env`

**Decision**: A `loadSecrets()` function invoked in `server.ts` **before** `NestFactory.create`,
which (in production) fetches each declared secret from Secret Manager via the VM's attached service
identity and writes it into `process.env`. Joi validation and `configuration.ts` are then unchanged.
`SECRETS_DRIVER=env` (default) skips it entirely for development and tests.

**Rationale**: This is the smallest change that satisfies FR-043–FR-049. `ConfigModule.forRoot`
validates `process.env` at module construction; anything that must be present for validation has to
exist before Nest boots. Loading into `process.env` beforehand means **not one line of
`configuration.ts` or `validation.ts` changes**, and FR-049's requirement that an absent secret fail
in the same place as an absent config value is satisfied by construction — Joi is still the thing
that fails.

FR-044a (read once, never re-read) falls out for free: `process.env` is populated once at boot.

**FR-046 becomes load-bearing**: a Secret Manager failure means `loadSecrets()` throws and the
process exits before listening, so an instance that cannot read its secrets never reports ready. This
is the desired behaviour and needs no extra guard.

**FR-047a's rotation hazard is documented, not engineered around.** Rotating `JWT_SECRET` invalidates
every token; during a rolling restart the two instances briefly disagree. No multi-key verification
is added — that would change `jwt.strategy.ts`, which FR-047 forbids. The operations runbook records
that a signing-key rotation is a sign-everyone-out event.

**Alternatives considered**:

- *A Nest `ConfigModule` custom loader.* Rejected — runs after Joi, so validation would see empty
  values and fail before the loader ran.
- *Fetch secrets lazily at each use site.* Rejected by FR-044a and by FR-045's audit volume — one
  read per boot is auditable, one per request is noise.

---

## R9 — Horizontal readiness: Socket.io Redis adapter, a Redis lease, and the shared throttler store

**Decision**: Three independent changes.

1. **Realtime**: `@socket.io/redis-adapter` attached in `TrackingGateway.afterInit`.
2. **Scheduling**: a `SchedulerLeaseService` wrapping `SET key token NX PX ttl` with a Lua
   compare-and-delete release, guarding both sweeps.
3. **Rate limiting**: the Redis throttler store from R5.

**Rationale — the good news**: the realtime fix is a **one-file change**. Every outbound emission in
the entire codebase goes through `RealtimeGatewayService` — verified: `emitToOrderRoom` and
`emitToUser` are the only `.emit(` call sites outside that file, used by `auth.service`,
`users.controller`, `tracking.gateway`, `otp.service`, `order-state.service` and
`notifications.service`. `TrackingGateway` itself makes no direct emit. So attaching the adapter to
the one `Server` instance that `setServer` receives covers every path, and FR-060's "every emission
path" is satisfied without touching six services.

**The lease guards two sweeps with different shapes.** `PresenceService.sweepOfflineDrivers` is a
static `@Cron('*/60 * * * * *')`. `StopDetectionService` registers a `setInterval` at
`onModuleInit` via `SchedulerRegistry.addInterval`, and its own comment records why: a decorator's
compile-time constant cannot honour `STOP_DETECTION_SWEEP_SECONDS`, which the e2e suite and the
quickstart both lower. Both are **fleet-wide** sweeps, so both take the same lease; neither becomes a
per-entity job.

**The correction to FR-062, carried from the spec's own Q8 amendment**: BullMQ is at-least-once.
`Worker.close()` (R3) releases an unfinished job for redelivery, which is exactly what FR-009 wants —
so a redelivered job must be idempotent. This is a property to *preserve*, not build: the queues
already distribute correctly across instances, and `StopEscalationQueueService` already folds
`escalatedAt: null` into its conditional write for precisely this reason.

**Idempotency audit (FR-056a) is a real task, not a formality.** `sweepOfflineDrivers` is a single
`updateMany` with the target state in its own filter — already idempotent. `sweepStalledDeliveries`
must be re-read against a concurrent second run; feature 011's `unblockedStopFilter` and the
escalation's conditional write suggest it is, but this must be asserted rather than assumed.

**Alternatives considered**:

- *BullMQ repeatable jobs instead of a lease.* Legitimate and satisfies FR-056. Rejected because it
  would restructure two working schedulers and change how `STOP_DETECTION_SWEEP_SECONDS` is honoured,
  for no gain over a lease that leaves both in place.
- *A designated scheduler instance by configuration.* Rejected by FR-058 — single point of failure.
- *Redlock across multiple Redis nodes.* Rejected — Redis is a single shared instance (spec
  Assumptions); Redlock's complexity buys nothing here, and the lease is not the correctness boundary
  anyway. Idempotency is.

---

## R10 — The readiness signal needs an active consumer, and open-source nginx cannot be it

**Decision**: Establish first whether a managed load balancer or instance group already fronts nginx
(FR-007d). If not, build an external monitor that polls `/health/ready` and, on sustained failure,
**rewrites the nginx upstream and reloads** — not one that merely alerts. Configure
`proxy_next_upstream error timeout http_502 http_503` with `proxy_next_upstream_tries 2` either way.
HAProxy is the documented fallback.

**Rationale — the correction**: the operations contract originally said "the upstream health check
polls `/api/v1/health/ready`". **Open-source nginx cannot do that** — active upstream health checks
are an nginx Plus feature. What OSS nginx has is `max_fails`/`fail_timeout`, which is *passive*: it
marks an upstream down only after real proxied requests fail, and never reads the readiness endpoint.

Two consequences, and the second is the one that makes this more than a documentation fix.

**Passive detection is not a sufficient consumer** (FR-007b). It counts only failed proxied requests,
so an instance failing readiness for a reason that does not error on *every* route stays in rotation
indefinitely, serving whatever subset still works — while readiness has been saying "do not send me
traffic" the whole time. Story 1's stated purpose is that a proxy can route away from a broken
instance; alert-only leaves that to a human.

**And passive detection would not have fired at all.** `max_fails` counts exactly the conditions
`proxy_next_upstream` names, and its default set is `error timeout` — **502 and 503 are not in it**.
A readiness-failing instance returning clean 503s would never have been marked down. So
`proxy_next_upstream error timeout http_502 http_503` does two jobs: it retries the request against a
healthy instance (which is what actually protects users during the detection gap) *and* it makes
those responses count as failures so the passive layer works at all.

`non_idempotent` is deliberately **omitted**: nginx already refuses to retry POST/PATCH/LOCK without
it, and the platform's write endpoints are not established as safe to replay. The default is the
correct scoping; the task is to leave it alone, not to configure it.

**Alternatives considered**: nginx Plus (licence cost) · replacing nginx with HAProxy, which does
native active checks in ~15 lines and is a smaller, better-understood mechanism than a bespoke reload
loop — kept as the documented fallback rather than chosen, because replacing a proxy in launch week
is a larger risk than the loop · accepting passive-only and weakening SC-001, rejected because it
means users discover the failure first.

---

## R11 — Every subsystem the shared cache now carries needs a defined degradation

**Decision**: Rate-limit counters fall back to **per-instance in-memory counting** on a storage error
(FR-061a/b). Loss of the cross-instance transport is detected and alerted (FR-063a). Both are
recorded so a degraded period is identifiable afterwards.

**Rationale — the correction**: this feature makes Redis load-bearing for **five** things — queues,
cache, throttler counters, scheduler leases, socket fan-out — while Clarification Q7 decided Redis
must never affect the readiness verdict. That combination is only sound if each of the five degrades
gracefully. Three did not, and the throttler was the sharpest: `ThrottlerStorageRedisService` fails
closed, so during a Redis outage **every request would error**. Redis would then be a *harder*
dependency than MongoDB — which at least disqualifies cleanly — and Q7's decision to keep instances
in rotation would convert a partial degradation into the total outage it exists to prevent.

Fail-open was rejected: it leaves login, refresh and the one-time-code routes with **no** brute-force
protection for the duration, exploitable by anyone able to induce a cache blip. The in-memory
fallback keeps limiting at N× the configured budget across N instances — approximate, but *bounded*,
which is categorically different from unlimited — and it is exactly the platform's behaviour today,
so the fallback path is not novel code.

The realtime half cannot "fail open" in the same sense: fan-out simply stops crossing instances,
while events still reach clients on the emitting instance. **From that instance's own vantage point
it is indistinguishable from success.** With every instance staying in rotation and reporting itself
healthy (FR-002a), the platform would show no symptom at all while live tracking worked for some
users and not others — the exact failure Story 9 exists to remove. Only an alert surfaces it.

---

## R12 — One download path, exercised identically by tests and production

**Decision**: The download route issues a 302 under **every** storage driver including local
(FR-042a). The local driver's byte route is addressed by a short-lived signed token in the URL, never
by the `Authorization` header (FR-042b). `Cache-Control: no-store` on the redirect (FR-042c).

**Rationale**: every e2e suite runs the local driver. Had local returned bytes and only GCS
redirected, the redirect would have executed first **in production** — the identical
untested-in-test defect R1 was written about, reintroduced inside Story 6, and compounding a risk
already flagged as the feature's highest (FR-038d).

**The token, not the header, is the subtle part.** An authenticated local byte route would depend on
the client forwarding `Authorization` across a redirect — and clients differ in exactly that, which
is the whole of FR-038c. It would pass for some clients and fail for others, closing one trap by
opening the same one in the test environment. A header-less, expiring, single-object URL also mirrors
the production credential shape, so the local path is faithful in the security-relevant dimension and
not merely in its status code.

Because the token *is* the authorization, the route must be `@Public()` and registered **only** under
the local driver — an unauthenticated file-serving endpoint that must not exist in production.

**`Cache-Control: no-store`** because a cached 302 pointing at an expired signed location fails only
sometimes and presents as an intermittent storage fault rather than a caching one.

**What this does not establish** (FR-042d): it proves the controller emits a redirect. It never
exercises a *cross-origin* redirect, so bucket CORS, clock skew against the signed expiry, and
per-client redirect behaviour remain unverified — which is why FR-042e puts a real-device download
against the real bucket on the pre-launch checklist. Green CI here must not be read as covering
FR-038d.

**Alternatives considered**: a stubbed GCS adapter asserting the 302 — rejected, it asserts the
mock's behaviour rather than the adapter's · a GCS emulator in CI — defensible later if signed-URL
generation grows more complex, not worth a container in every contributor's setup for one code path.

---

## Cross-cutting: what the multi-instance test harness needs

FR-069 requires two app instances against one shared database and coordination backend.
`createTestApp` currently creates a **new `MongoMemoryReplSet` per call**, so two calls give two
isolated databases. The harness needs a variant that boots a second `INestApplication` against the
**same** `replSet.getUri()` and the same `REDIS_URL`, with distinct ports.

CLAUDE.md already records that 53 sequential apps in one `--runInBand` process cause teardown
pressure — three suites report failed purely on an `afterAll` `ctx.close()` exceeding 30 s. Enabling
shutdown hooks (R3) makes `app.close()` do strictly more work, so this pre-existing pressure is
likely to worsen. The multi-instance suite doubles apps per test. Both point at the same fix CLAUDE.md
already names: a shared teardown budget in `test-app.factory.ts`. It is test infrastructure rather
than feature work, but this feature is the one that makes it necessary.
