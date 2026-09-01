# Contract: Configuration

**Feature**: 012-production-hardening | **FRs**: FR-015, FR-018, FR-022, FR-035, FR-038b, FR-042,
FR-046, FR-048, FR-049, FR-050, FR-051, FR-055

Every new value follows the platform's existing pattern: a typed section in
`src/config/configuration.ts`, a Joi rule in `src/config/validation.ts`, and no literal anywhere
else (Constitution I). Two rules are **production-required** using the `.when('NODE_ENV', { is:
'production' })` idiom already established for `SMS_PROVIDER`.

---

## New environment variables

### Story 1 — Health

| Variable | Type | Default | Notes |
|---|---|---|---|
| `HEALTH_TIMEOUT_MS` | number | `1000` | Per-indicator bound (FR-006). A slow dependency must resolve as down, not hang. |
| `INSTANCE_ID` | string | hostname | Identifies the instance in health responses and records (FR-035a). |
| `READINESS_POLL_INTERVAL_SECONDS` | number | `10` | Steady-state monitor's poll period (FR-007a). Three consecutive failures at 10 s meets SC-001's 30-second detection bound. |
| `READINESS_FAILURE_THRESHOLD` | number | `3` | Consecutive failures before the instance is removed from the upstream. |
| `READINESS_RECOVERY_THRESHOLD` | number | `3` | Consecutive successes before it is restored. |

Unused if FR-007d finds a managed load balancer already fronting nginx — its own health check becomes
the active consumer and the monitor reduces to alerting.

### Story 2 — Shutdown

| Variable | Type | Default | Notes |
|---|---|---|---|
| `SHUTDOWN_DRAIN_MS` | number | `30000` | Bounded drain (FR-012). Must exceed nginx's health-check interval, or traffic still arrives while draining. |

### Story 3 — CORS

| Variable | Type | Default | Notes |
|---|---|---|---|
| `CORS_ALLOWED_ORIGINS` | csv | `''` | **Required in production** (FR-018). Exact-match origins; scheme, host and port all significant. |

```js
CORS_ALLOWED_ORIGINS: Joi.string()
  .allow('')
  .default('')
  .when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(1).required(),   // refuse to start rather than block the dashboard silently
  }),
```

The same list drives the API allowlist, the WebSocket namespace and the GCS bucket's CORS policy, so
the three cannot drift apart.

**Trailing slashes fail.** `https://app.example.com/` never matches `https://app.example.com`. This
is exact-match by design (spec Edge Cases) and must fail closed and diagnosably.

### Story 4 — Proxy and throttling

| Variable | Type | Default | Notes |
|---|---|---|---|
| `TRUSTED_PROXY_HOPS` | number | **none — see below** | The proxy immediately in front must **set**, not append to, `X-Forwarded-For` (FR-022). |

> **⚠ `TRUSTED_PROXY_HOPS` has no safe default and MUST NOT be assumed** (FR-022, Clarification Q11).
> It is `1` if nginx is the only proxy and `2` if a managed load balancer fronts it — and which holds
> is FR-007d's finding, which must be established before this value is set. Configuring `1` where
> there are two makes the load balancer the attributed client for **every request on the platform**:
> the same undifferentiated-origin failure Story 4 exists to fix, reached by a different route,
> producing no error and no symptom. Treat an unset value as a configuration error in production
> rather than silently defaulting.

Existing `THROTTLE_TTL` / `THROTTLE_LIMIT` keep their values and meaning. When the shared counter
store is unreachable, limiting falls back to per-instance counting at N× these values across N
instances — bounded, not absent (FR-061a/b).

### Story 5 — Logging

| Variable | Type | Default | Notes |
|---|---|---|---|
| `LOG_LEVEL` | enum | `info` (prod), `debug` (dev) | FR-035. Volume is billable (Q6). |
| `LOG_PRETTY` | boolean | `false` | Human-readable in development only; production must stay newline-delimited JSON or the agent cannot preserve fields. |

**The production default must not emit per position update.** The tracking stream would otherwise
dominate log volume, and nothing in Story 5 needs it (FR-035).

### Story 6 — Object storage

| Variable | Type | Default | Notes |
|---|---|---|---|
| `STORAGE_DRIVER` | `gcs \| local` | `local` | `local` keeps development and all 53 e2e suites free of cloud dependencies (FR-042). |
| `GCS_BUCKET` | string | `''` | **Required when `STORAGE_DRIVER=gcs`.** |
| `SIGNED_URL_TTL_SECONDS` | number | `300` | FR-038b. |
| `STORAGE_DIR` | string | `sys_storge` | **Existing, unchanged.** Now the local driver's directory *and* the GCS key prefix. |
| `LOCAL_STORAGE_TOKEN_TTL_SECONDS` | number | `300` | Lifetime of the local driver's byte-route token. Matches `SIGNED_URL_TTL_SECONDS` deliberately, so the two drivers expire alike (FR-042b). |
| `LOCAL_STORAGE_TOKEN_SECRET` | string | derived from `JWT_SECRET` | Signs the local byte-route token. May be set separately; when unset it derives from `JWT_SECRET` via a fixed, named context string so the two are never the same key material. |

No service-account key file variable exists, deliberately: the VM's attached identity supplies
credentials (FR-043), so there is nothing to leak or rotate.

**On the local token** (FR-042b, research R12): the token *is* the authorization for that route —
there is no `Authorization` header on it by design, because clients differ in whether they forward
one across a redirect and that difference is the whole of FR-038c. Three consequences the
implementation must honour, none of which is optional:

1. The route is `@Public()` — an unauthenticated endpoint that streams tenant documents.
2. It is registered **only** when `STORAGE_DRIVER=local`. It must not exist in a production build,
   and a test must assert its absence under the GCS driver.
3. The token is scoped to one file id and expires. It is a bearer capability exactly as the GCS
   signed URL is, and carries the same exposure window (FR-040).

Neither value belongs inline. Both are named here so they cannot become magic values in the one
component whose entire job is bearer-token security (Constitution I).

### Story 7 — Secrets

| Variable | Type | Default | Notes |
|---|---|---|---|
| `SECRETS_DRIVER` | `env \| gcp` | `env` | `env` is a complete no-op — development and tests are untouched (FR-048). |
| `GCP_PROJECT_ID` | string | `''` | **Required when `SECRETS_DRIVER=gcp`.** |
| `SECRETS_MANIFEST` | csv | see below | The explicit list of names treated as secret (FR-049). |

Default manifest: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PAYMENT_SADAD_SECRET`,
`PAYMENT_MADA_SECRET`, `SMS_API_KEY`, `GOOGLE_MAPS_API_KEY`, `MONGODB_URI`, `REDIS_URL`.

Everything not on this list stays ordinary configuration. `loadSecrets()` runs **before**
`NestFactory.create` and writes into `process.env`, so Joi still validates exactly as it does today
and an absent secret fails in the same place, and the same way, as an absent config value (FR-049).
A fetch failure throws before the process listens (FR-046).

### Story 8 — Database resilience

| Variable | Type | Default | Notes |
|---|---|---|---|
| `MONGO_MAX_POOL_SIZE` | number | `20` | FR-050 |
| `MONGO_MIN_POOL_SIZE` | number | `2` | FR-050 |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | number | `5000` | Fail fast when unreachable (FR-052) |
| `MONGO_CONNECT_TIMEOUT_MS` | number | `10000` | FR-051 |
| `MONGO_SOCKET_TIMEOUT_MS` | number | `45000` | FR-051 |
| `MONGO_WAIT_QUEUE_TIMEOUT_MS` | number | `10000` | Bounded queue, then prompt refusal (FR-052) |

**`MONGO_SOCKET_TIMEOUT_MS` must exceed the longest legitimate transaction**, or Story 8's
resilience work becomes Story 8's data-integrity bug: a timeout mid-transaction must abort cleanly,
never leave effects half-applied (FR-054).

### Story 9 — Horizontal readiness

| Variable | Type | Default | Notes |
|---|---|---|---|
| `SCHEDULER_LEASE_TTL_MS` | number | `55000` | Must exceed the measured p99 sweep duration (FR-056b). Below the 60 s sweep interval so a dead holder's lease expires before the next tick. |
| `SCHEDULER_LEASE_ENABLED` | boolean | `true` | Disable for single-instance local runs. |

No variable enables the socket Redis adapter or the shared throttler store — both are unconditional.
Making them optional would create a configuration in which the platform *looks* multi-instance and
silently is not, which is the failure Story 9 exists to remove.

---

## Precedence and startup order

```
1. loadSecrets()          # SECRETS_DRIVER=gcp: fetch manifest → process.env. Throws on failure.
2. ConfigModule.forRoot() # Joi validates process.env — unchanged, sees a complete environment
3. configureApp(app)      # helmet, versioning, prefix, pipes, filters, CORS, trust proxy, hooks
4. app.listen()
```

Nothing after step 1 re-reads a secret (FR-044a), so no value changes inside a process's lifetime and
the "rotated mid-request" failure mode does not exist.

---

## Existing variables: unchanged

`PORT`, `NODE_ENV`, `MONGODB_URI`, `REDIS_URL`, `JWT_*`, `PAYMENT_*`, `OTP_EXPIRY_MINUTES`,
`STORAGE_DIR`, `MAX_FILE_SIZE_BYTES`, `THROTTLE_*`, `PRESENCE_*`, `TRACKING_*`, `SUPER_ADMIN_*`,
`ORDER_*`, `GOOGLE_MAPS_API_KEY`, `SMS_*`, `PASSWORD_RESET_*`, `PLATFORM_DAY_BOUNDARY_TIMEZONE`,
`WAREHOUSE_GEOFENCE_RADIUS_METERS`, `ASSIGNMENT_*`, `STOP_DETECTION_*`, `STOP_RESPONSE_WINDOW_MINUTES`.

Every default keeps its current value. `STOP_DETECTION_SWEEP_SECONDS` in particular must remain
honoured at runtime — the e2e suite and the quickstart both lower it, which is the entire reason that
sweep is registered dynamically rather than by decorator. The scheduler lease must not break that.

---

## Test and development posture

`test/utils/test-app.factory.ts` sets `STORAGE_DRIVER=local` and `SECRETS_DRIVER=env` and leaves
everything else as it is today. No suite requires GCS, Secret Manager or a proxy (FR-042/FR-048).
Slice 0 makes the factory call `configureApp()`, so the suites begin exercising helmet, CORS and
trust-proxy configuration they have never exercised before — which is the point.
