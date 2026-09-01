# Realtime Contract — Feature 009

**Namespace**: `/tracking` · **Transport**: Socket.io · **Auth**: access token at handshake

The dashboard has no realtime client today. This contract defines the **one** connection it may
hold and the narrow purpose it serves, because the governing constraint on this surface is server
cost.

---

## The division of labour

Settled in clarification: a hybrid, chosen because refresh is cheap at the interval stages need
and ruinous at the interval a moving truck needs.

| Concern | Mechanism | Bound | Requirement |
|---|---|---|---|
| Stage changes, lists, detail | Background refresh | 15s | FR-020, SC-003 |
| Overview counts | Background refresh, one request | — | FR-067, SC-015 |
| **Truck position on the map** | **Live connection** | 60s | FR-021, SC-004 |

**Why stages do not use the connection.** A transport administrator *cannot* receive
`order:status` for the transitions that matter most to them. The platform emits it to the
`order:{orderId}` room and to `user:{driverId}` — and joining the order room requires
`order:watch`, which refuses any order not already `IN_TRANSIT` or `UNLOADING`. So assignment →
loading → transit are unreachable over the socket for this role. Refresh covers them inside the
required 15 seconds, so no platform change is warranted. Recorded in research R4 as the natural
extension should that bound ever tighten.

---

## Connection lifecycle

**One connection per administrator session** (FR-024), regardless of how many deliveries are
observed.

- **Opened** only when a tracking screen mounts on a delivery the platform considers trackable.
- **Closed** when that screen unmounts (FR-023).
- **Never opened** merely because the dashboard is open, a list is visible, or a delivery is
  selected but not being tracked.

Confined to a hook (`lib/realtime/`); no component touches a socket directly (Constitution IV).

---

## Handshake

The access token is presented at connection. Failure is terminal for that attempt, not retried
blindly:

| Outcome | Dashboard behaviour |
|---|---|
| `UNAUTHORIZED` | Do not retry. Let the ordinary refresh path run; reconnect only after a fresh token. |
| Disconnected | Bounded backoff, capped. Never an unbounded reconnect storm — that is the cost constraint. |
| Tab hidden | Position updates are not needed by anyone not looking. Consistent with FR-022. |

---

## `order:watch` — the platform decides trackability

```
emit  → 'order:watch'  { orderId }
ack   ← { ok: true } | { ok: false, error: 'NOT_TRACKABLE' | 'NOT_FOUND' | 'FORBIDDEN_ROLE' }
```

| Ack | Meaning | Screen |
|---|---|---|
| `ok: true` | Joined; positions will arrive | Live map |
| `NOT_TRACKABLE` | Not `IN_TRANSIT`/`UNLOADING` | **"Not currently trackable"** — FR-017 |
| `NOT_FOUND` | Absent **or another company's** | Not found — never distinguish (Constitution II) |
| `FORBIDDEN_ROLE` | Drivers only; unreachable here | Treat as a defect |

**The screen never judges trackability itself.** It asks and reports. This is why FR-017 needs no
client-side stage logic — the platform's existing refusal *is* the requirement, and a local rule
could drift from it.

`order:unwatch` on leaving; the connection closes with the screen.

---

## `order:location` — inbound

```jsonc
{ "orderId": "...", "lat": 24.7136, "lng": 46.6753, "recordedAt": "2026-08-26T09:14:22Z" }
```

Emitted to the `order:{orderId}` room as the driver moves. Throttled by the platform — the
dashboard must not assume a fixed cadence.

**Staleness (FR-018)**: track `lastReceivedAt`. When the gap exceeds the freshness bound, the
screen must **state that the position is stale and how old it is** — never continue presenting the
last point as current. Silence is ambiguous between a stopped truck, lost connectivity and a
crashed tab; the screen must not resolve that ambiguity in the platform's favour.

The map seeds from `driverLocation` on `GET /orders/:id`, so it draws immediately rather than
staying blank until the first throttled update.

---

## Events this surface must not consume

| Event | Why not |
|---|---|
| `order:otp` | The customer's handover code. Emitted only to `user:{clientId}`. Must never be requested, received, rendered, cached or logged — FR-071. |
| `session:revoked` | Sessions here are administrator sessions; revocation is the mobile driver's lifecycle. |
| `location:update` | **Outbound, driver-only.** This surface never emits it. |

`notification:new` arrives in the administrator's own user room and may be consumed for the
notification bell — but it is **not** a substitute for the stage refresh, and a stage must never be
inferred from a notification.

---

## Cost checks

These are testable properties, not aspirations:

- Idle for 10 minutes with a screen open ⇒ no requests beyond the open connection (SC-013).
- Any number of deliveries observed ⇒ exactly one connection (SC-014).
- Tab hidden ⇒ no background refresh (FR-022).
- Dashboard home opened ⇒ exactly one summary request, not one per figure (FR-067).
