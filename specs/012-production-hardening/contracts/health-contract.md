# Contract: Health Signals

**Feature**: 012-production-hardening | **Story**: US1 | **FRs**: FR-001 – FR-007, FR-002a/b, FR-006a

Two endpoints. Both unauthenticated, both side-effect free, both exempt from rate limiting. They are
the only new routes this feature adds.

---

## `GET /api/v1/health/live`

**Purpose**: Is this process running? Nothing more.

- `@Public()` — no token, no tenant context (FR-001)
- Exempt from throttling via `@SkipThrottle()` (FR-004)
- **Performs no dependency checks.** This is not an oversight — it is FR-003.

**200 OK** — always, if the process can answer at all:

```json
{ "status": "ok", "instanceId": "app-1", "uptimeSeconds": 3421 }
```

There is no failure response. A process that cannot answer does not answer, and the caller's timeout
is the signal.

**Why it checks nothing**: a liveness probe wired to dependency health causes an orchestrator to
**restart** an instance whose own process is perfectly healthy. A database incident then becomes a
restart storm on top of a database incident. Liveness answers "should I be killed"; readiness
answers "should I be sent traffic". Conflating them is the classic form of this mistake.

---

## `GET /api/v1/health/ready`

**Purpose**: Should a proxy send this instance traffic right now?

- `@Public()`, `@SkipThrottle()`
- Checks MongoDB **and** Redis — but only MongoDB decides the verdict (Clarification Q7)

### 200 OK — ready

```json
{
  "status": "ok",
  "info":  { "mongodb": { "status": "up" }, "redis": { "status": "up" },
             "rateLimiting": { "status": "up" }, "realtimeFanout": { "status": "up" } },
  "error": {},
  "details": { "mongodb": { "status": "up" }, "redis": { "status": "up" },
               "rateLimiting": { "status": "up" }, "realtimeFanout": { "status": "up" } },
  "instanceId": "app-1"
}
```

### 200 OK — ready, but degraded

**This is the case that matters most.** Redis is down; the instance stays in rotation.

```json
{
  "status": "ok",
  "info":  { "mongodb": { "status": "up" } },
  "error": {
    "redis":          { "status": "down", "message": "connection refused" },
    "rateLimiting":   { "status": "down", "message": "per-instance fallback: effective budget is N× the limit" },
    "realtimeFanout": { "status": "down", "message": "events may not reach clients on other instances" }
  },
  "details": {
    "mongodb":        { "status": "up" },
    "redis":          { "status": "down", "message": "connection refused" },
    "rateLimiting":   { "status": "down", "message": "per-instance fallback: effective budget is N× the limit" },
    "realtimeFanout": { "status": "down", "message": "events may not reach clients on other instances" }
  },
  "instanceId": "app-1"
}
```

**`rateLimiting` and `realtimeFanout` are CAPABILITIES, not dependencies** (spec 012 FR-063b). They
are here because each degrades in a way that is otherwise **invisible from outside**:

- **`rateLimiting`** — counters fall back to per-instance (FR-061b), so the effective budget becomes
  N× the configured limit across N instances. Every request still succeeds and no error rate moves,
  so without this field a period of loosened limiting leaves no external trace whatsoever.
  `rateLimiting` reflects the wrapper's own state, not a ping: it is `down` because a real write
  failed, not because Redis looks unreachable.
- **`realtimeFanout`** — the one degradation that **cannot fail open**. If the socket adapter is
  down, events still reach the emitting instance's own clients, so from that instance's vantage
  point delivery is indistinguishable from success: no error, no exception, no failed request. It is
  inferred from Redis reachability, which is the only signal available — and that inference is
  exactly why the sweep-stall alert (operations-contract §6) exists as a separate safety net.

**`status` is `"ok"` and the HTTP status is 200 while `error` is non-empty.** That combination is
deliberate and is the contract's whole point (FR-002a). Redis loss degrades queues, cross-instance
realtime delivery and shared rate-limit counters — it does not stop the instance answering a
request. Disqualifying on it would take **every** instance out of rotation at the same instant and
leave nginx with an empty upstream: a partial degradation converted into a total outage.

Monitoring reads `error`. The proxy reads the status code. They are different consumers and this
response answers both.

> **Do not "fix" this later.** A future reader will see a 200 alongside a `down` entry and be tempted
> to make them agree. Agreeing is the bug. If Redis must ever become disqualifying, it needs the
> grace-period design (spec Q7 option D), not a one-line change.

### 503 Service Unavailable — not ready

MongoDB unreachable, **or** the instance is draining:

```json
{
  "status": "error",
  "info":  { "redis": { "status": "up" }, "rateLimiting": { "status": "up" },
             "realtimeFanout": { "status": "up" } },
  "error": { "mongodb": { "status": "down", "message": "connection timed out" } },
  "details": { "mongodb": { "status": "down", "message": "connection timed out" },
               "redis": { "status": "up" }, "rateLimiting": { "status": "up" },
               "realtimeFanout": { "status": "up" } },
  "instanceId": "app-1"
}
```

While draining (FR-005), `error` carries `{ "shutdown": { "status": "down", "message": "draining" } }`
and the response is 503 **regardless of dependency health** — the instance is leaving rotation on
purpose.

### Timing constraints

| Constraint | Requirement |
|---|---|
| Each check bounded by `HEALTH_TIMEOUT_MS` (default 1000) | FR-006 — a slow dependency resolves as *down*, never leaves the probe outstanding |
| Probe must not hold a connection request traffic needs | FR-006a — `MongooseHealthIndicator.pingCheck` pings over the existing connection; it must not open its own |

A readiness endpoint that hangs is indistinguishable, to a proxy, from an instance that has failed —
except that it also consumes a probe slot every interval.

### Disclosure

Neither endpoint reveals tenant data, configuration values, secrets or internal topology (FR-007).
`instanceId` is an opaque identifier for correlating with records (FR-035a), not a hostname or
address.

---

## Who consumes this

Three consumers, and they are not interchangeable:

| Consumer | Reads | Acts by |
|---|---|---|
| The rolling deploy script (FR-012a) | `/health/ready` on the replacement | Waiting for 200 before shifting traffic |
| The steady-state monitor (FR-007a) | `/health/ready` on every instance | Rewriting the upstream and reloading after sustained failure |
| The proxy itself | Nothing — **open-source nginx cannot actively poll** | Passive detection only, which FR-007b says is not sufficient alone |

```nginx
location /api/v1/health/ { proxy_pass http://app_upstream; access_log off; }
```

`access_log off` keeps probe traffic out of the collected records — at one probe every few seconds
per instance it would otherwise be a meaningful share of the log volume Clarification Q6 makes
billable.

See [operations-contract.md §2.1](./operations-contract.md) for the monitor, and note FR-007d: if a
managed load balancer already fronts nginx, its own health check becomes the active consumer and the
monitor reduces to alerting.

## Verification

| Scenario | Expect |
|---|---|
| Both dependencies up | 200, `status: ok`, both in `info` |
| Mongo down | 503, `mongodb` in `error` |
| **Redis down, Mongo up** | **200**, `redis`/`rateLimiting`/`realtimeFanout` in `error`, instance stays in rotation |
| Draining | 503 with `shutdown: draining`, even with both dependencies up |
| 720 probes over an hour | Zero throttled; no other client's budget affected (FR-004) |
| Mongo slow (> timeout) | 503 within the timeout; probe does not hang; request pool not starved |
