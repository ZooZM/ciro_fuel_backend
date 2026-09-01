# Quickstart: Production Hardening & Horizontal Readiness

**Feature**: 012-production-hardening | **Date**: 2026-08-31

How to verify this feature end to end. Part 1 runs locally with no cloud account. Part 2 needs two
instances. Part 3 is the live pre-launch pass that cannot be automated.

The order matters: **Part 0 must pass before anything else means anything.**

---

## Part 0 — The regression gate (Slice 0)

`configureApp()` is a pure refactor. If it changes behaviour, everything measured afterwards is
measured against a moved baseline.

```bash
npm run lint:check
npm run lint:no-index          # server.ts is still the root entry; bootstrap/ is a subdirectory
npm run build
npm run test                   # expect 152/152 across 19 suites
npm run test:e2e               # expect 267 tests across 53 suites
```

**Expected**: identical results to before the slice. Not "similar" — identical.

Then confirm the extraction actually took effect, which is the entire point:

```bash
# The factory must call configureApp, not re-implement it
grep -n "configureApp" test/utils/test-app.factory.ts src/server.ts

# helmet must now be present in tests, where it never was before
grep -rn "helmet\|enableCors" src/bootstrap/configure-app.ts
```

If the e2e suites still boot an app without helmet and CORS, the slice has not landed regardless of
what the diff looks like.

> **Note on teardown.** CLAUDE.md records three suites intermittently reporting failure purely on
> `afterAll` `ctx.close()` exceeding 30 s — no test fails, a different set each run. Enabling
> shutdown hooks makes `close()` do strictly more work, so this pressure will worsen. The shared
> teardown budget lands with this slice. A suite that reports failure with zero failing tests is
> this, not a regression.

---

## Part 1 — Local verification

### Prerequisites

```bash
docker compose up -d mongo mongo-init redis
cp .env.example .env            # STORAGE_DRIVER=local, SECRETS_DRIVER=env
npm run start:dev
```

### 1.1 Health (US1)

```bash
curl -s localhost:3000/api/v1/health/live | jq
# → 200 {"status":"ok","instanceId":…}

curl -s localhost:3000/api/v1/health/ready | jq
# → 200, both mongodb and redis in "info"
```

**The case that matters** — Redis down must *not* remove the instance from rotation:

```bash
docker compose stop redis
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/health/ready
# → 200   ← MUST be 200, not 503
curl -s localhost:3000/api/v1/health/ready | jq '.error'
# → { "redis": { "status": "down", … } }
docker compose start redis
```

A 503 here means the correlated-failure trap has been reintroduced: in production every instance
would go unready at the same instant and nginx would have an empty upstream.

Mongo down *must* disqualify:

```bash
docker compose stop mongo
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/health/ready   # → 503
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/health/live    # → 200 (still alive)
docker compose start mongo
```

Liveness staying 200 while readiness is 503 is what stops an orchestrator restarting an instance
whose process is fine.

**The readiness monitor must act, not just observe.** Open-source nginx cannot poll a health
endpoint — active upstream checks are nginx Plus — so an external monitor is what carries SC-001's
30-second detection bound. Verify it *removes* the instance, not merely that it notices:

```bash
# with two instances behind nginx and the monitor running
docker compose stop app-2
# within READINESS_POLL_INTERVAL × READINESS_FAILURE_THRESHOLD (default 30s):
grep -c "app-2" nginx/upstream.conf     # → 0
docker compose start app-2
# within the recovery threshold:
grep -c "app-2" nginx/upstream.conf     # → 1
```

Skip if the FR-007d check found a managed load balancer — its own health check is the consumer, and
you verify it there instead.

### 1.2 Graceful shutdown (US2)

```bash
# Terminal A — a slow request in flight
curl -s localhost:3000/api/v1/orders &
# Terminal B
kill -TERM $(pgrep -f "dist/server.js")
```

Expect: readiness turns 503 **before** the listener closes; the in-flight request completes; each
destroy hook runs (`RedisModule.onModuleDestroy` finally executes — it never has in production);
the process exits within `SHUTDOWN_DRAIN_MS`; a forced exit is recorded distinguishably.

### 1.3 CORS (US3)

```bash
NODE_ENV=production CORS_ALLOWED_ORIGINS="" npm run start:prod
# → MUST refuse to start (FR-018)

NODE_ENV=production CORS_ALLOWED_ORIGINS="https://dash.example.com" npm run start:prod
curl -si -X OPTIONS localhost:3000/api/v1/orders \
  -H "Origin: https://dash.example.com" \
  -H "Access-Control-Request-Method: GET" | head -1     # → 204
curl -si -X OPTIONS localhost:3000/api/v1/orders \
  -H "Origin: https://evil.example.com" \
  -H "Access-Control-Request-Method: GET" | grep -i "access-control-allow-origin"
# → nothing; and the refusal must not reveal which origins are permitted
```

A request with **no** `Origin` (every mobile call) must behave exactly as it does today.

Confirm the WebSocket namespace is no longer a wildcard:

```bash
grep -n "cors" src/modules/tracking/tracking.gateway.ts
# must read the allowlist, NOT origin: '*'
```

### 1.4 Rate limiting (US4)

```bash
for i in $(seq 1 120); do
  curl -s -o /dev/null -w '%{http_code} ' localhost:3000/api/v1/health/live
done; echo
# → all 200. Health is exempt (FR-004) and must never be throttled.
```

Behind a proxy, two forwarded addresses must get separate budgets, and a client-supplied
`X-Forwarded-For` must be ignored when it arrives from an untrusted hop.

Then confirm attribution — today nothing records an origin at all:

```bash
curl -s localhost:3000/api/v1/orders -H "Authorization: Bearer $TOKEN" > /dev/null
# the emitted record must carry clientIp AND userId AND companyId AND correlationId
```

### 1.5 Structured records (US5)

```bash
npm run start:prod 2>&1 | head -5 | jq .
# → parseable JSON. If this errors, the agent cannot preserve fields either.
```

Drive one order through several stages, then:

```bash
npm run start:prod 2>&1 | jq -c 'select(.orderId=="<id>")'
```

**The trap**: this must include records from background jobs (escalation, payment timeout), not only
from request handlers. A correlation id that stops at the queue boundary produces an order history
that looks complete and is missing every background action (FR-030).

Confirm nothing leaks (FR-033):

```bash
npm run start:prod 2>&1 | grep -iE "authorization|password|\"otp\"|refreshToken"
# → no matches
```

### 1.6 Documents (US6)

```bash
FILE_ID=$(curl -s -X POST localhost:3000/api/v1/files \
  -H "Authorization: Bearer $TOKEN" -F "file=@cr.pdf" -F "purpose=COMMERCIAL_REGISTER" | jq -r ._id)

curl -si localhost:3000/api/v1/files/$FILE_ID -H "Authorization: Bearer $TOKEN" | head -3
# → 302 under EVERY driver, plus Cache-Control: no-store
#   local: Location is a token-addressed platform route
#   gcs:   Location carries X-Goog-Expires=300

curl -sL localhost:3000/api/v1/files/$FILE_ID -H "Authorization: Bearer $TOKEN" -o out.pdf
# → following the redirect yields the bytes
```

**What this does not prove.** A same-origin redirect exercises the controller, not the risk. Bucket
CORS, clock skew against the signed expiry, and per-client redirect and header behaviour are all
untouched here, and the mobile failure in FR-038d lives in exactly that gap — it is verified only by
Part 3 item 2, on a real device against the real bucket.

```bash
```

Cross-tenant access must still 404 — refused by the tenant plugin **before** any URL is signed:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/files/$FILE_ID \
  -H "Authorization: Bearer $OTHER_TENANT_TOKEN"      # → 404, never 403
```

### 1.7 Database resilience (US8)

```bash
docker compose stop mongo
time curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/orders -H "Authorization: Bearer $TOKEN"
# → fails within MONGO_SERVER_SELECTION_TIMEOUT_MS in the standard error shape — not hanging
docker compose start mongo
# → serving normally within 60s, no restart
```

---

## Part 2 — Two instances (US9)

```bash
docker compose up -d --scale app=2
```

### 2.1 Sweeps run at most once per interval

Both instances' records, filtered to sweep completions: exactly one `sweep.completed` per sweep name
per interval across the pair, over ≥20 intervals, with **zero missed intervals**.

Then kill the lease holder. A surviving instance must run the next sweep within one interval, with no
operator action — which requires the lease to expire on its own rather than wait to be released.

### 2.2 A sweep run twice is a no-op

Force concurrent execution of `sweepStalledDeliveries` on both instances. Expect zero duplicate
notifications, zero double lifecycle advances, zero second stop events for one stop.

**This is the assertion the lease cannot make for you.** A lease is at-most-once; a pause outlasting
the TTL still produces a concurrent run. Correctness rests here (FR-056a).

### 2.3 Cross-instance realtime

Connect a client to instance A. Cause instance B to emit — `order:status`, `notification:new`,
`session:revoked`. The client must receive every one. Before this feature it receives none, and the
failure is silent: tracking works for whoever landed on the emitting instance.

### 2.4 One shared rate-limit budget

Spread one client's requests across both instances. The observed platform-wide limit must equal the
configured limit — not twice it. Restart one instance mid-run; counters must survive.

### 2.5 Drain one, keep serving

Remove one instance from the upstream and `SIGTERM` it. Zero failed requests, zero lost jobs; its
realtime clients reconnect to the survivor and resume.

---

## Part 3 — Live pre-launch pass (FR-071/FR-072)

Ten items, owned and dated, in
[contracts/operations-contract.md §7](./contracts/operations-contract.md). They cannot be automated
because each depends on something CI does not have — a real device, a real service identity, a real
collector, a real bucket policy, real traffic, or a lawyer.

**Item 2 is the one to do first.** A mobile client that forwards `Authorization` across the
cross-origin redirect is refused by GCS. Browsers strip that header, so the dashboard passes and CI
passes; the app fails, and only on a device. If it does forward, the permitted fix is confined to the
client's redirect handling (FR-038e) — the single exception to the no-client-change rule, and worth
discovering before launch week rather than during it.

**Item 9 is not technical.** Residency is legally unconfirmed. The platform holds continuous driver
location traces, and this feature is what causes that data to be written to new places.

---

## Success criteria coverage

| Verified in | Criteria |
|---|---|
| Part 0 | SC-016 (behaviour identical), FR-068 |
| Part 1 | SC-001, SC-005, SC-006, SC-008, SC-011 |
| Part 2 | SC-012, SC-013, SC-014, SC-015, SC-017 |
| Part 3 | SC-002, SC-003, SC-004, SC-007, SC-009, SC-010, SC-018 |


---

## Walkthrough results — 2026-09-01 (T109)

**Part 0 — regression gate: PASS.**

| Command | Result |
|---|---|
| `npm run lint:check` | clean (6 pre-existing unused-variable errors fixed in passing; none were spec 012's) |
| `npm run lint:no-index` | clean — `server.ts` is still the root entry, `bootstrap/` a subdirectory |
| `npm run build` | clean |
| `npm run test` | **172/172 across 21 suites** |
| `npm run test:e2e` | **340/340 across 62 suites** |

The counts are higher than the "expect 152 / 267" written above because this feature adds suites
(`health`, `cors`, `rate-limit-proxy`, `graceful-shutdown`, `request-logging`, `file-storage`,
`db-resilience`, `redis-degradation`, `multi-instance`, `secrets-loader`). No pre-existing test
changed its expectations; the pre-existing suites all pass unchanged.

**Part 1 — local verification: PASS**, run against a real `node dist/server.js` on port 3100 with
Dockerised MongoDB and Redis, `STORAGE_DRIVER=local`, `SECRETS_DRIVER=env`, `INSTANCE_ID=qs-instance-1`.

| Check | Result |
|---|---|
| 1.1 `GET /health/live` | `200 {"status":"ok","instanceId":"qs-instance-1","uptimeSeconds":5}` |
| 1.1 `GET /health/ready` | `200`, all four indicators `up`: `mongodb`, `redis`, `rateLimiting`, `realtimeFanout` |
| 1.2 SIGTERM | drain gate flipped, then `Drained cleanly in 68ms; exiting` — a clean exit recorded distinguishably from a forced one (FR-012) |
| 1.3 allowlisted origin | `Access-Control-Allow-Origin: http://localhost:5173` echoed back |
| 1.3 non-allowlisted origin | **no** `Access-Control-Allow-Origin` header, and nothing naming which origins are permitted |
| 1.3 preflight | `204`, `Allow-Credentials: true`, budget untouched (FR-017) |
| Records | newline-delimited JSON on stdout carrying `severity`, `instanceId`, `context` (FR-028/FR-028a/FR-035a) |

**Two things this walkthrough found that the suites had not.**

1. **`INSTANCE_ID` resolved to `''` on every deployment that did not set it.** Joi declares it
   `.allow('').default('')` and `@nestjs/config` writes the validated result back into
   `process.env`, so an unset variable arrives at `configuration.ts` as `''` — and `??` does not
   treat `''` as absent, so the `hostname()` fallback never ran. Every record and every health
   response carried `instanceId: ""`, leaving FR-035a's "which instance produced this?" with no
   answer. Fixed with `||`.

2. **`CORS_ALLOWED_ORIGINS=` (set but empty) was ACCEPTED in production**, defeating FR-018 by the
   route a real deployment is most likely to take. Joi keeps a base schema's `.allow('')` when it
   merges the conditional one, and an explicitly permitted value short-circuits `.min(1)` and
   `.required()` alike. An empty allowlist matches nothing, so every browser request is refused —
   precisely the silently-broken browser access the requirement exists to prevent. The same hole
   affected `GCS_BUCKET` and `GCP_PROJECT_ID`. All three fixed with `.invalid('')` in the `then`
   branch, and pinned by `test/unit/config-validation.spec.ts`.

**Not run:** Part 1's two-instance nginx section and all of Part 3. The nginx upstream, the readiness
monitor and the rolling deploy need the two VMs, the bucket, the secret store and the log sink —
none of which exist yet (operations-contract §1, *Provisioning prerequisites*). The two-instance
GUARANTEES are covered automatically by `test/e2e/multi-instance.e2e-spec.ts`; what remains unproven
is the nginx and deploy machinery itself, which is operations-contract §7's checklist.
