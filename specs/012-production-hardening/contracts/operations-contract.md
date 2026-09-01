# Contract: Operations

**Feature**: 012-production-hardening | **FRs**: FR-012a, FR-022, FR-040b/c, FR-043, FR-045,
FR-058a, FR-064c/d, FR-071, FR-072

The deployment supplies compute and nothing else. Managed object storage, secret store and log
collection come from the same cloud project; **orchestration does not exist** — no rolling deploy,
no scheduler arbitration, no service discovery. This document is the contract for what must be built
and configured to fill that gap. It is a deliverable of the feature, not a description of it.

---

## 1. Topology

> **✅ FR-007d resolved — 2026-08-31.** Checked against both GCP projects with an authenticated
> account (`zeyad@ciro.app`):
>
> | Resource | `ciro-fuel-dev` | `ciro-shared` |
> |---|---|---|
> | Forwarding rules (load balancers) | 0 | Compute API not enabled |
> | Backend services | 0 | — |
> | Instance groups | 0 | — |
> | Compute instances | 0 | — |
> | Storage buckets | 0 | — |
> | Secret Manager | **API not enabled** | — |
>
> **No load balancer fronts nginx, because no deployment exists yet.** So under the planned topology
> (Clarification Q1: VMs running Compose behind nginx) `TRUSTED_PROXY_HOPS` is **1**, §2.1's monitor
> **is** required, and the diagram below is accurate as drawn.
>
> Two caveats, both load-bearing:
>
> 1. **This is a decision, not an observation.** Nothing was measured, because there is nothing to
>    measure. If a managed load balancer is introduced during provisioning — which is a reasonable
>    thing to do — the hop count becomes **2** and the monitor reduces to alerting. Re-verify at
>    provisioning time; do not treat "1" as settled because it is written here.
> 2. **None of this feature's infrastructure exists.** No VMs, no bucket, no secret store, no
>    logging sink. The task list assumes they do. See *Provisioning prerequisites* below.

### Provisioning prerequisites (none of these exist yet)

Verified absent on 2026-08-31. Every one is a precondition for the corresponding story, and none is
covered by the implementation tasks — they are infrastructure, not code:

| Needed for | Resource | State |
|---|---|---|
| Story 6 | Regional GCS bucket, public-access-prevention enforced, CORS naming the dashboard origin | **absent** |
| Story 7 | Secret Manager API enabled; the eight manifest secrets created | **API not enabled** |
| Story 7 | Service identity attached to the VM, granted bucket write + URL signing + secret read | **absent** |
| Stories 1–4, 9 | Two Compute Engine VMs, in the region a residency review would accept | **absent** |
| Story 6/9 | Mongo replica set with genuinely multiple members | **absent** |
| Story 6 | Redis reachable by both instances | **absent** |
| Story 5 | Cloud Logging receiving the VMs' container output | **absent** |

The code can be written and tested against the local drivers without any of this — that is what
`STORAGE_DRIVER=local` and `SECRETS_DRIVER=env` are for. But **nothing in Part 3 of quickstart.md is
verifiable until this list is provisioned**, and the platform is described as going to production
this week.

```
                       ┌─────────────────────────┐
   clients ──── 443 ───│  nginx (TLS, allowlist) │
                       └───────────┬─────────────┘
                    upstream, passive failure detection
                       ┌───────────┴───────────┐
                  ┌────▼────┐             ┌────▼────┐
                  │  app-1  │             │  app-2  │
                  └────┬────┘             └────┬────┘
                       └───────────┬───────────┘
              ┌────────────────────┼────────────────────┐
        ┌─────▼─────┐        ┌─────▼─────┐        ┌──────▼──────┐
        │  MongoDB  │        │   Redis   │        │  GCS bucket │
        │ (replica) │        │  shared   │        │  (regional) │
        └───────────┘        └───────────┘        └─────────────┘
```

Redis carries four distinct responsibilities after this feature: BullMQ queues (existing), cache
(existing), throttler counters (FR-061), scheduler leases (FR-056b) and the Socket.io pub/sub adapter
(FR-059). Its loss therefore degrades more than it used to — which is exactly why readiness reports
it without acting on it (Q7), and why sweeps stalling needs its own alert (§6).

---

## 2. nginx

**Built: [`nginx/nginx.conf`](../../../nginx/nginx.conf) and
[`nginx/upstream.conf`](../../../nginx/upstream.conf).** They are split because the readiness
monitor below *rewrites* the upstream, and it must not be able to corrupt the server blocks.

Two deviations from the sketch below, both deliberate:

- **Upstream targets are Compose service names (`app-1:3000`), not `127.0.0.1:3001`.** nginx runs as
  a container in `docker-compose.prod.yml`, so loopback is the nginx container itself. The published
  host ports `127.0.0.1:3001/3002` still exist and are what the **monitor** polls, from the host.
- **A `listen 80` block** redirects to https and passes health probes through unredirected, so the
  monitor does not need a certificate to ask an instance whether it is alive.

```nginx
upstream app_upstream {
    server 127.0.0.1:3001 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:3002 max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 443 ssl http2;

    # FR-022: SET, never append. proxy_add_x_forwarded_for would preserve a
    # client-supplied value and let anyone forge their way into a fresh
    # rate-limit budget. This single line is the whole trust boundary.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;

    location /tracking/ {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    location /api/v1/health/ {
        proxy_pass http://app_upstream;
        access_log off;          # ~720 probes/hour/instance would be billable noise
    }

    location / {
        proxy_pass http://app_upstream;

        # FR-007c. Two jobs, and the second is the non-obvious one:
        #  1. Retry a failed request against the healthy instance — this is what
        #     actually protects users during the detection gap.
        #  2. Make 502/503 COUNT as upstream failures. nginx's default set is
        #     `error timeout` only, and max_fails counts exactly what this
        #     directive names — so without http_502/http_503 a readiness-failing
        #     instance returning clean 503s is never marked down at all, and the
        #     passive detection below does nothing.
        proxy_next_upstream error timeout http_502 http_503;
        proxy_next_upstream_tries 2;
        # `non_idempotent` is deliberately ABSENT: nginx already refuses to retry
        # POST/PATCH/LOCK unless it is present, and the platform's write endpoints
        # are not established as safe to replay. Do not add it.
    }
}
```

### 2.1 Active readiness consumption (FR-007a, FR-007b)

**Open-source nginx cannot poll `/health/ready`.** Active upstream health checks are an nginx Plus
feature. What OSS nginx has is `max_fails`/`fail_timeout` — *passive* detection, which marks an
upstream down only after real proxied requests fail, and only for the conditions
`proxy_next_upstream` names. It never reads the readiness endpoint.

That is not sufficient on its own (FR-007b): an instance failing readiness for a reason that does not
produce those errors on every route stays in rotation indefinitely, serving whatever subset of
traffic still works — while readiness has been saying "do not send me traffic" the entire time.

So a **monitor that can act** is required, not merely one that alerts. **Built: [`scripts/readiness-monitor.sh`](../../../scripts/readiness-monitor.sh)** (systemd unit at the foot of the file), implementing exactly this loop:

```
every 10s:
  for each instance:
    poll GET /api/v1/health/ready
    if failing for 3 consecutive polls:
      rewrite the nginx upstream file to drop it; nginx -s reload
    if healthy again for 3 consecutive polls:
      restore it; nginx -s reload
```

Alert-only leaves a broken instance serving traffic until a human intervenes, which does not satisfy
the situation Story 1 exists to fix. This is also what meets SC-001's 30-second detection bound:
three failures at a 10-second interval.

**The monitor never removes the last healthy instance.** If both fail readiness the upstream is
left as it is and the platform serves degraded — emptying an upstream turns a partial outage into
a total one, and nginx refuses to load a config whose upstream block has no servers.

**Recovery has its own threshold**, so an instance that flaps does not flap the upstream with it;
every reload drops idle keepalive connections.

**Fallback if the FR-007d check comes back negative and rewriting an upstream file looks too
hand-rolled**: HAProxy does native active health checks in roughly fifteen lines —

```
backend app
    option httpchk GET /api/v1/health/ready
    http-check expect status 200
    server app1 127.0.0.1:3001 check inter 5s fall 3 rise 2
    server app2 127.0.0.1:3002 check inter 5s fall 3 rise 2
```

That is a smaller, better-understood mechanism than a bespoke reload loop, at the cost of replacing a
component during launch week. Decide deliberately; do not drift into the hand-rolled version by
default.

**`proxy_set_header X-Forwarded-For $remote_addr` is not interchangeable with
`$proxy_add_x_forwarded_for`.** The latter appends, preserving whatever the client sent, and with
`trust proxy = 1` the application would then read a client-controlled value as the origin. The
resulting defect is invisible: rate limiting appears to work, and anyone who wants a fresh budget can
have one.

**Socket.io needs no sticky sessions once the Redis adapter is attached** — but it does need
`proxy_read_timeout` well above the ping interval, or long-lived connections are cut by the proxy and
reconnect in a loop.

---

## 3. Rolling deploy (FR-012a)

Compose replaces containers by stopping them, so a deploy that does not interrupt users must be
built. Without this procedure, graceful shutdown is implemented and never exercised, and SC-003 is
unreachable.

**Built: [`scripts/rolling-deploy.sh`](../../../scripts/rolling-deploy.sh)** — executable, not a
description. It implements the sequence below with three refusals the prose does not capture:

- **It refuses to start while the readiness monitor is running.** Both rewrite `upstream.conf`; the
  monitor would see the instance being drained, decide it is unhealthy, and fight the deploy for the
  same lines.
- **It refuses to start if either instance is already unready.** Taking one out of rotation would
  then leave zero healthy instances.
- **On a replacement that never becomes ready it stops with that instance still OUT of the
  upstream**, leaving the other one serving the previous image. A broken deploy costs capacity, not
  the platform.

`compose stop -t` is the drain signal: SIGTERM, wait, escalate to SIGKILL only at the timeout — which
is the app's *own* `SHUTDOWN_DRAIN_MS` plus a margin, so a clean drain always wins the race and a
forced exit is recorded by the application (FR-012) rather than being a silent kill.

```
for each instance in (app-1, app-2):
  1. Start the replacement alongside the current one, on a new port.
  2. Poll GET /health/ready on the replacement until 200. Abort if it does not
     become ready within a bound — a replacement that never starts must not take
     the running instance down with it.
  3. Add the replacement to the nginx upstream; reload nginx.
  4. Remove the outgoing instance from the upstream; reload nginx.
  5. Send SIGTERM to the outgoing instance.
       → readiness flips to 503 immediately (FR-005)
       → in-flight requests complete (FR-008)
       → BullMQ workers stop fetching and finish or release in-flight jobs (FR-009)
       → realtime clients receive an orderly disconnect (FR-010)
       → connections closed deliberately (FR-011)
       → forced exit after SHUTDOWN_DRAIN_MS, recorded distinguishably (FR-012)
  6. Wait for exit or the drain deadline. Only then move to the next instance.
```

**Never both at once.** Step 6's serialisation is what makes the deploy invisible; parallel
replacement empties the upstream for the duration.

**A secret rotation is completed by this procedure** (FR-044) — secrets are read once at startup, so
a rolling restart is the adoption mechanism. Rotating a *signing* key is a different matter: see §5.

---

## 4. Object storage

| Setting | Value | FR |
|---|---|---|
| Location | Regional, **same region as the VMs** | FR-064c |
| Public access prevention | **Enforced** | FR-040b |
| Uniform bucket-level access | Enabled | FR-040b |
| CORS origins | The dashboard's origins, explicitly. Never `*` | FR-040c |
| Object versioning | Enabled | Recovery from mistaken deletion |

Service identity grant: write objects, sign read URLs, for **this bucket only**. No project-wide
storage role. **No key file** — the identity is attached to the instance, so `GcsFileStorage`
constructs its client with no credentials argument and there is nothing in any image, snapshot or
backup to leak.

**CORS on the bucket must name the dashboard's origins explicitly** (FR-040c). `*` would let any
page a user visits read a document through a signed URL the user happens to hold. The origins are
the same list `CORS_ALLOWED_ORIGINS` carries; they are configured in two places and must be kept in
step, because a mismatch shows up only as a browser-only download failure.

```
gcloud storage buckets update gs://BUCKET \
  --public-access-prevention \
  --uniform-bucket-level-access \
  --versioning \
  --cors-file=cors.json      # origins listed explicitly; never ["*"]
```

None of the above is verifiable from application code, which is why each is a §7 checklist item
rather than a comment asserting it is done.

**The key prefix `sys_storge/{companyId}/…` enforces nothing.** GCS serves any object to any holder
of a valid signed URL regardless of prefix. The tenant boundary is held entirely by the scoped read
that precedes signing (FR-040a). A leaked URL also discloses a `companyId` — a minor disclosure worth
knowing about, and a further reason the lifetime is 5 minutes.

---

## 5. Secrets

Read once at startup through the VM's attached service identity — no key file exists, so there is no
credential to leak or rotate (FR-043). Reads are recorded by the store's own audit logging, which
the platform does not write and cannot alter (FR-045).

Implemented by [`src/secrets/secrets-loader.ts`](../../../src/secrets/secrets-loader.ts) and
[`src/secrets/secret-manager.driver.ts`](../../../src/secrets/secret-manager.driver.ts), called from
`server.ts` **before `NestFactory.create`** — that ordering is the design (research R8), since
`ConfigModule.forRoot` validates `process.env` with Joi at construction and a Nest custom loader
would run after it. Nothing in `configuration.ts` or `validation.ts` changed, and Joi is still the
single thing that fails on an absent secret.

**Rotation for an ordinary secret**: add a version, run the §3 rolling deploy.

```
gcloud secrets versions add JWT_REFRESH_SECRET --data-file=-
./scripts/rolling-deploy.sh
```

Secrets are read **once**, at startup (FR-044a) — there is no refresh path, deliberately, so no
value changes inside a process's lifetime and adoption happens at a moment an operator chose. A
version added without a deploy is simply not in use; nothing degrades and nothing warns, so the
deploy is not optional.

**Rotation for a token-signing key — `JWT_SECRET` or `JWT_REFRESH_SECRET` — is a sign-everyone-out
event (FR-047a).** During the rollout the
two instances hold different keys, so a token issued by one is refused by the other; afterwards every
previously-issued token is invalid. This is the correct response to a suspected compromise and the
wrong thing to schedule as routine maintenance. It must be run deliberately, announced, and never
during business hours in the belief that it is transparent.

Concretely, during the rolling window: instance A holds the old key and instance B the new one, and
nginx sends a given request to either. A token minted by A is refused by B, so users see
intermittent 401s for the length of the deploy — and their client's silent refresh cannot recover,
because the refresh token is signed with the same rotated key. Afterwards **every** previously-issued
access and refresh token is invalid and every user must sign in again, including drivers mid-delivery.

A driver signed out mid-delivery loses their location stream until they sign back in, which is the
concrete operational cost and the reason this is not maintenance.

---

## 6. Observability

Records go to stdout as newline-delimited JSON and are collected by the VM's logging agent with
fields preserved (FR-028). Retrieval for an incident is a field filter:

```
jsonPayload.orderId = "652f…"        # everything that happened to one order (FR-032, SC-007)
jsonPayload.correlationId = "…"      # one request and every job it caused (FR-029, FR-030)
jsonPayload.instanceId = "app-2"     # is this instance-specific? (FR-035a)
```

### The one required alert (FR-058a)

**Alert when a sweep stops completing.** Every other alert is out of scope; this one is not,
because this feature *creates* the silence it detects.

Redis being unreachable no longer takes instances out of rotation (Q7), so a Redis outage stalls
every leased sweep while the platform continues serving and reporting itself healthy. Stalled
stop-detection means a stalled delivery goes unnoticed — the precise harm feature 011 exists to
prevent — and nothing else surfaces it.

Condition: **no `sweep.completed` record for a given sweep name within three intervals.**

Both sweeps emit one at `info` on the instance that actually held the lease
(`PresenceService.markSilentDriversOffline`, `StopDetectionService.detectStalledDeliveries`):

```json
{ "event": "sweep.completed", "sweep": "stop-detection", "instanceId": "app-2", "severity": "INFO" }
```

```
# Cloud Logging / Monitoring, one condition per sweep name
jsonPayload.event = "sweep.completed" AND jsonPayload.sweep = "stop-detection"
  → absent for 180s   (3 × the 60s interval)
```

Three intervals rather than one: a single missed tick is a lease contended at an unlucky moment or
one slow sweep, and paging on that trains people to ignore the alert.

**`presence-offline` needs the alert as much as `stop-detection` does**, though less obviously: its
silence means drivers are never marked offline, so dispatch keeps offering drivers who are gone and
assignments are made to phones that will never receive them.

`SchedulerLeaseService` skips a sweep outright when the lease store is unreachable, rather than
running it unarbitrated on every instance. **That choice is safe ONLY because of this alert** —
without it, the skip is a stalled delivery nobody hears about, which is the exact harm feature 011
exists to prevent.

---

## 7. Pre-launch checklist (FR-071, FR-072)

Owned, dated, and closed before launch. Five consecutive features in this repository ended with a
live verification step outstanding; this list exists so this one's remaining work is visible rather
than discovered in an incident.

| # | Item | Why only live | Owner | Status |
|---|---|---|---|---|
| 1 | Rolling deploy: 50 consecutive deploys under traffic, zero severed requests | Needs real nginx, real Compose, real traffic (SC-002) | | ☐ |
| 2 | **Mobile document redirect on a real device** — open a document in the Flutter app, against the REAL bucket, and confirm the bytes arrive | Browsers strip `Authorization` on a cross-origin redirect; mobile HTTP clients may not, and GCS **refuses** a request carrying both a V4 signed URL and an `Authorization` header. The dashboard passes, CI passes (`file-access.e2e-spec.ts`'s redirect is same-origin, FR-042d), and only a real device fails. **Highest-risk item in this feature** (FR-038d, FR-042e) | | ☐ |
| 3 | Secret retrieval via attached identity; a read appears in audit logs | No service identity exists in CI (FR-043/FR-045) | | ☐ |
| 4 | Order history retrievable by `orderId` in collected records, under 1 minute | Needs the real collector (SC-007) | | ☐ |
| 5 | Dashboard signs in and completes every role action against production | Real origins, real TLS, real browser (SC-004) | | ☐ |
| 6 | Bucket refuses an unsigned object request; public access prevention enforced | Real bucket policy (FR-040b) | | ☐ |
| 7 | Sweep-stall alert fires when Redis is stopped | Real alerting (FR-058a) | | ☐ |
| 8 | p99 sweep duration measured; `SCHEDULER_LEASE_TTL_MS` set above it and below the 60 s sweep interval | Needs production data volume (FR-056b). Currently **55 s**, chosen to satisfy the ordering, not measured — a laptop's p99 is not the platform's. **Too low**: a slow-but-healthy holder loses its lease mid-run and a second instance sweeps concurrently. **Too high**: a dead holder's lease outlives the next tick and a sweep is silently skipped. Read the p99 from `sweep.completed` timestamps once real volume exists | | ☐ |
| 9 | **Residency confirmed with the customer**, or accepted as open risk | Legal, not technical (Q2, FR-064c) | | ☐ |
| 10 | Personal-data inventory published for residency review | FR-064d | | ☐ |
| 11 | **Conditional on item 2 failing**: strip `Authorization` on redirect in the mobile client's Dio configuration | Only reachable once item 2 has been run on a device (FR-038e) | | ☐ |

**Item 11 is conditional, and it is planned work rather than a discovery.** If item 2 shows the
mobile client forwarding `Authorization` across the redirect, the fix is confined to that client's
redirect handling in `mobile_app/` — Dio's `followRedirects` path, dropping the header on a
cross-origin hop. It alters **no request the app sends to the platform**, which is what keeps it
inside FR-067's "no client changes": it is the single permitted exception (FR-038e), and it exists
here so that launch week finds a task rather than a surprise.

Item 9 is not a technical task and has no technical fallback. The platform holds continuous driver
location traces, and this feature is what causes that data to be written to new places. It is
tracked as a risk rather than a blocker only because the design is valid under either answer.
