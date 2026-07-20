# WebSocket Contract — `/tracking` namespace (Socket.io 4)

**Handshake**: `io('/tracking', { auth: { token: <JWT> } })`. Invalid/expired token ⇒ connection refused (`connect_error`, `UNAUTHORIZED`). The socket's user/role/company context is fixed at handshake.

## Rooms

- `order:{orderId}` — watchers (CLIENT owner, company COMPANY_ADMIN, SUPER_ADMIN) receive location + status events for one order.
- Drivers do not join rooms; they only emit.

## Client → Server events

### `order:watch`
Join tracking room for an order.

```jsonc
// payload
{ "orderId": "6633aa…" }
// ack
{ "ok": true }                                   // joined
{ "ok": false, "error": "NOT_FOUND" }            // cross-tenant or nonexistent (FR-017: indistinguishable)
{ "ok": false, "error": "FORBIDDEN_ROLE" }       // e.g., another company's driver
{ "ok": false, "error": "NOT_TRACKABLE" }        // order not IN_TRANSIT / UNLOADING
```

### `order:unwatch`
`{ "orderId": "…" }` → ack `{ ok: true }`.

### `location:update` — DRIVER role only
Sent by the driver app when displacement > 50 m since last accepted point OR ≥ 3 min elapsed (heartbeat). **Server re-enforces this policy** and silently drops violations (FR-016).

```jsonc
// payload
{ "lat": 24.7136, "lng": 46.6753, "recordedAt": "2026-07-19T10:15:00Z" }
// ack
{ "ok": true, "accepted": true }                 // stored + broadcast
{ "ok": true, "accepted": false, "reason": "BELOW_THRESHOLD" }  // < 50 m and < 3 min
{ "ok": false, "error": "NO_ACTIVE_ORDER" }
```

Rate guard: max 1 accepted update / 5 s per driver regardless of movement (abuse ceiling).

**Presence side-effect (FR-024)**: every inbound driver frame on this namespace — handshake, `location:update` (accepted OR `BELOW_THRESHOLD`) — sets `lastSeenAt = now` and `isOnline = true` on the driver. A server cron marks drivers `isOnline: false` after 6 silent minutes (two missed heartbeats), removing them from dispatch eligibility until their next frame. No event is emitted to the driver for presence changes; admins see presence via the users list.

## Server → Client events (to `order:{orderId}` room)

### `order:location`
```jsonc
{ "orderId": "…", "lat": 24.7136, "lng": 46.6753, "recordedAt": "…", "receivedAt": "…" }
```
`receivedAt` lets UIs show staleness when heartbeats stop (edge case: driver connectivity loss).

### `order:status`
Emitted on every lifecycle transition of a watched order.
```jsonc
{ "orderId": "…", "from": "IN_TRANSIT", "to": "UNLOADING", "at": "…" }
```

### `order:otp` — sent ONLY to the order's CLIENT user (direct socket, never the room)
```jsonc
{ "orderId": "…", "purpose": "ARRIVAL", "otp": "482913", "expiresAt": "…" }
```
Never emitted to driver sockets or rooms (FR-023).

### `notification:new` — direct to recipient user's sockets
```jsonc
{ "id": "…", "type": "PAYMENT_TIMEOUT", "orderId": "…", "payload": { } }
```

## Disconnect semantics

- Driver disconnect: no state change; last stored location remains; watchers infer staleness from `receivedAt` + missing 3-min heartbeat.
- Watcher sockets are removed from rooms automatically; rooms for orders reaching a terminal state are closed after a final `order:status` emit.
