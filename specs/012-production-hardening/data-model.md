# Data Model: Production Hardening & Horizontal Readiness

**Feature**: 012-production-hardening | **Date**: 2026-08-31

This feature is about how the platform is operated, not what it stores. **No new collection is
created, no existing document schema gains or loses a field, and no index changes.** What follows
is therefore in three parts: the one persisted field whose *meaning* changes, the runtime and
external structures the feature introduces, and an explicit statement of what is deliberately not
persisted.

---

## 1. Persisted changes

### `FileRecord.storagePath` — same name, same type, new content

The only persisted change in the entire feature, and it is a change of *content*, not of schema.

| | Before | After |
|---|---|---|
| Type | `string` (required) | `string` (required) — unchanged |
| Content | Absolute filesystem path, e.g. `/app/sys_storge/{companyId}/{uuid}.pdf` | Object key, e.g. `sys_storge/{companyId}/{uuid}.pdf` |
| Produced by | Multer `diskStorage`, or `join(process.cwd(), …)` | `FileStorage.put()` |
| Consumed by | `res.sendFile(file.storagePath)` | `FileStorage.signedUrl(file.storagePath)` |

**Why the field is not renamed.** `storagePath` is returned in the upload responses of
`POST /files` and the company-registration flow. FR-038 freezes upload payloads, so renaming it to
`objectKey` — which would read better — would break the freeze. Keeping the name and type preserves
the payload's shape exactly. Neither client reads the field (both address files by `_id`), and its
value was never a stable contract: it already differed between machines, since it embedded
`process.cwd()`.

**Migration**: none. Per spec Assumptions, existing documents are development and test data on a
pre-production platform. Any `FileRecord` written before this feature holds an absolute path that
`GcsFileStorage` cannot resolve; those records are stale test fixtures and are not migrated. **If a
production document exists before this ships, a migration becomes in scope** — this is the one
assumption whose falsification changes the work.

**What must not be "tidied"**: `FileRecordSchema` is `markTenantScoped`. `findForDownload`'s
`findById` is therefore scoped by the global tenant plugin, which is why
`files.controller.ts:download` has no explicit tenant check and correctly needs none. Removing the
marker, or reading the record outside the plugin's path, opens a cross-tenant read on a controller
that *looks* unprotected. A schema comment records this.

**Also recorded in the schema**: the `sys_storge/{companyId}/…` prefix is organisational only. GCS
enforces nothing about a key's prefix; the tenant boundary is held entirely by the scoped read
before the URL is signed (FR-040a). Any future code that infers tenancy from a key path is a defect.

### Nothing else

No field is added to `User`, `Order`, `Notification`, `Company`, `Truck`, `Tank`, `Warehouse`,
`Station`, `Invoice`, `Payment`, `SessionEvent`, `DeliveryRating`, `VehicleVerification` or any
embedded sub-schema. No index is created, altered or dropped. Every tenant-scope marker and
multi-party marker stays exactly as it is.

---

## 2. Runtime structures (not persisted)

### `AppHealth` — the readiness answer

Computed per request, never stored.

| Field | Type | Notes |
|---|---|---|
| `status` | `'ok' \| 'error'` | Drives the HTTP status: 200 or 503 (FR-002b) |
| `info` | `Record<string, { status: 'up' }>` | Healthy indicators |
| `error` | `Record<string, { status: 'down', message?: string }>` | Unhealthy indicators (FR-006) |
| `details` | `Record<string, …>` | Union of both, Terminus's standard shape |

**The verdict is computed from Mongo alone** (Clarification Q7). Redis appears in `details` and
`info`/`error` but **never** changes `status`. This asymmetry is the whole point of Q7 and is the
single most important thing not to "simplify" later: routing every instance out of rotation on a
Redis blip converts a partial degradation into a total outage.

### `ShutdownState` — the drain gate

A single process-wide flag.

| Field | Type | Notes |
|---|---|---|
| `draining` | `boolean` | Set by the signal handler **before** `app.close()` |

Read by `GET /health/ready`, which returns 503 whenever it is true, regardless of dependency
health (FR-005). Not persisted; a restarted process starts `false`.

### `RequestContext` — extended, not duplicated

`TenantContextService` already runs an `AsyncLocalStorage` keyed per request. It gains one field
rather than a second store being introduced (research R6).

| Field | Type | Status |
|---|---|---|
| `companyId` | `string \| undefined` | existing |
| `role` | `UserRole \| undefined` | existing |
| `userId` | `string \| undefined` | existing |
| `correlationId` | `string` | **new** |

**Why not a second store**: two request-scoped stores can disagree. A background job that
establishes one and not the other yields records attributed to a tenant with no correlation, or a
correlation with no tenant — and the disagreement is invisible until someone tries to reconstruct an
order's history and finds half of it. One store, one lifetime, one place a job must establish
context.

### `StructuredRecord` — the emitted log line

Newline-delimited JSON on stdout, collected with fields preserved (FR-028).

| Field | Source | Requirement |
|---|---|---|
| `time`, `level`/`severity` | Pino | FR-028a — severity in the form the log service recognises |
| `correlationId` | `RequestContext` | FR-029 |
| `userId`, `companyId` | `RequestContext` | FR-031 |
| `role` | `RequestContext` | FR-031 |
| `orderId` | Explicit, where an order is in scope | **FR-032** — must be a field, not text |
| `method`, `url`, `statusCode`, `responseTime` | `pino-http` | FR-031 |
| `clientIp` | `req.ip` (post-`trust proxy`) | **FR-025** |
| `instanceId` | Process-level | FR-035a |

**Redacted, never emitted** (FR-033): `req.headers.authorization`, `password`, `otp`, `code`,
`token`, `refreshToken`, and any payment secret. This list is a constant, not a convention.

`orderId` is the field that makes FR-032 work, and it is the one that will be missed: it must be
attached by background-job processors too, not only by request handlers, or an order's history is
complete for requests and silently empty for every escalation and timeout that acted on it.

---

## 3. External structures

### GCS object key

```
sys_storge/{companyId}/{uuid}{ext}
```

Identical in shape to today's filesystem layout, deliberately (FR-040a). Organisation only —
enforces nothing.

### Signed URL

| Property | Value | Requirement |
|---|---|---|
| Signing scheme | V4 | Clarification Q4 |
| Method | `GET` only | FR-040 |
| Scope | One object | FR-040 |
| Lifetime | 300 s | FR-038b |
| Issued after | The tenant-scoped read succeeds | FR-039 |

A bearer capability for its lifetime: GCS re-checks nothing. Revoking a user's access does not
invalidate an already-issued URL — the 5-minute lifetime is the entire bound (spec Edge Cases).

### Local storage token (development and tests only)

The local driver's equivalent of a signed URL, so the download route can issue the same redirect
under every driver (FR-042a).

| Property | Value | Requirement |
|---|---|---|
| Carried in | The URL, as a query parameter | FR-042b |
| **Not** carried in | The `Authorization` header | FR-042b |
| Scope | One file id | FR-042b |
| Lifetime | `LOCAL_STORAGE_TOKEN_TTL_SECONDS`, default 300 | matches the GCS expiry |
| Signed with | `LOCAL_STORAGE_TOKEN_SECRET`, or derived from `JWT_SECRET` via a fixed named context | Constitution I |
| Exists when | `STORAGE_DRIVER=local` only | must not exist in production |

**Why it is not header-authenticated**: clients differ in whether they forward `Authorization` across
a redirect, which is the entirety of FR-038c. An authenticated local route would pass for some
clients and fail for others — closing one trap by opening the same one in the test environment. A
header-less, expiring, single-object URL also mirrors the production credential shape, so the local
path is faithful in the security-relevant dimension rather than only in its status code.

The token **is** the authorization, so the route is public. That is acceptable only because all three
of scoped, expiring, and absent-from-production hold together.

### Scheduler lease (Redis)

| | |
|---|---|
| Key | `lease:sweep:{sweepName}` |
| Value | A token unique to the acquiring run |
| Acquire | `SET key token NX PX ttl` — one atomic operation (FR-056b) |
| Release | Lua compare-and-delete: delete **only** if the value still equals this run's token |
| TTL | `SCHEDULER_LEASE_TTL_MS`, above the measured p99 sweep duration |
| Renewal | Extend while a legitimately long run continues |

Two leases exist, one per sweep: `presence-offline` and `stop-detection`. Both sweeps are
**fleet-wide**, so both take a lease keyed by sweep name — neither becomes per-entity work.

**The lease is not the correctness boundary.** It is at-most-once, not exactly-once: a pause
outlasting the TTL produces a concurrent run no lease can prevent. Correctness rests on FR-056a —
every sweep idempotent via the conditional-write/`modifiedCount` discipline. The compare-and-delete
release exists so a run whose lease already expired cannot delete the lease a *different* instance
now holds.

### Throttler counters (Redis)

Replace the default in-memory store. Shared across instances, so the platform-wide limit is the
configured limit rather than a multiple of it, and counters survive a restart (FR-061).

### Socket.io Redis adapter (pub/sub)

Attached to the single `Server` instance in `TrackingGateway.afterInit`. Every emission already
funnels through `RealtimeGatewayService.emitToOrderRoom` / `emitToUser`, so attaching it once covers
`order:location`, `order:status`, `order:otp`, `notification:new` and `session:revoked` — every
addressing mode and every emission path (FR-059/FR-060) — without touching the six services that
call it.

---

## 4. Deliberately not persisted

| Not stored | Why |
|---|---|
| Health check results | A time series of probe outcomes is monitoring's job, not the platform's. Storing them would put a write on every probe. |
| Correlation identifiers as their own records | The identifier lives on the records it correlates. A table of identifiers correlates nothing. |
| Structured records in MongoDB | Considered and rejected (spec Q6 option D): a write per request, duplicating what log collection already does, on the same database whose interruption Story 8 exists to survive. |
| Secret values | The entire point of Story 7. Read into `process.env` at boot, never written anywhere the platform controls. |
| Secret read audit | Recorded by the secret store's own audit logging, deliberately **not** by the platform (FR-045) — a system auditing its own secret access is not an independent record. |
| Signed URLs | Derived on demand from the object key. Storing one would outlive its own expiry and become a leaked bearer capability at rest. |
| Lease state beyond Redis | The lease *is* the Redis key. A durable copy would survive the failure the TTL exists to recover from. |
| Per-driver stop or movement history | Out of scope for feature 011 and remains so. Nothing here creates a queryable location history — FR-064d's enumeration of personal data written outside the primary database covers documents and record fields only. |
