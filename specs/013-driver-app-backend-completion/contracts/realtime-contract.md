# Realtime Contract Delta — Feature 013

**Baseline**: feature 001's `/tracking` WebSocket contract, as amended by specs 006, 007, 011 and 012.

No new event. One existing message gains a refusal, and the server gains an obligation it did not have.

---

## 1. `location:update` — refused when the session has been displaced

### Today

The namespace middleware verifies the handshake once. `WsJwtGuard` — despite the name — verifies
nothing; its own docstring says it "just confirms the middleware already populated `socket.data.user`."
Nothing re-checks afterwards. A device whose session was displaced minutes ago keeps writing the
authoritative position of that truck for as long as its socket stays open.

### New refusal

```json
{ "ok": false, "error": "SESSION_REVOKED" }
```

Returned when the `sgen` stamped on the socket at handshake differs from the driver's current
`sessionGeneration`. Absent values normalise to `0` on both sides — dropping that normalisation would
make every token minted before spec 006 a permanent mismatch, and the failure would look exactly like
the guard working.

Reuses the existing `{ ok, error }` ack shape (`FORBIDDEN_ROLE` already uses it). No new error channel.

### Ordering — load-bearing, not stylistic

The handler currently runs `presenceService.touch()` **before** loading the driver document. `touch`
writes `isOnline: true, lastSeenAt: now`. A displaced device touching presence keeps a dead handset
presenting as online and dispatchable, which is the opposite of what enforcing displacement is for.

Required order:

```
1. load the driver document          ← already happens on every frame, unconditionally
2. compare sgen; refuse on mismatch  ← FREE: the document is already in hand
3. touch presence
4. displacement / heartbeat gate
5. write location + movement bookkeeping
```

Step 2 adds **zero I/O**. `this.userModel.findById(...)` already runs on every frame before the
abuse-ceiling early return, and the document it returns carries `sessionGeneration`. This is the finding
that removes the usual objection to per-message session checks (research R2) — do not replace it with a
Redis-cached generation, which would be slower *and* would add a degradation path spec 012's
Clarification Q7 would then have to answer for.

### Guarantee

A refused frame MUST NOT:

- write `location` or `locationUpdatedAt`
- advance `lastMovedAt` or `lastMovedLocation`
- touch presence
- broadcast into the order room

---

## 2. Handshake — `sgen` is stamped on the socket

`authenticateSocket` already verifies the token and reads the payload; it currently discards `sgen`.
It must now carry it onto `socket.data.user`.

**Stamped at handshake, never re-read.** The comparison is *what this connection claimed when it
opened* against *what the account holds now*. Sourcing both from the account compares it to itself,
always agrees, and yields a guard that is silently inert — the same shape of defect as registering a
socket handler against a null socket (research R1).

Handshake refusal for an already-revoked session is unchanged from spec 006: `validateActiveSessionWithScoping`
throws, the middleware answers `UNAUTHORIZED`, and the app treats that as a revocation (FR-018).

---

## 3. Server-initiated disconnect on displacement

### New obligation

When `AuthService.login` bumps the session generation, it already emits `session:revoked` into
`user:{userId}`. It must additionally **disconnect every socket in that room**.

Ordering matches the existing comment on the emit: the generation must already be bumped — genuinely
dead — before either the push or the disconnect goes out, because Socket.io will not re-validate a frame
already in flight.

### Cross-instance reach is already solved

Spec 012 attached the Redis socket adapter, so a room operation reaches sockets connected to any
instance — the same mechanism `emitToUser` already depends on. **This is exactly the capability spec 012
found silently dead** (`afterInit` receives a namespace, not the root `Server`, and `Namespace.adapter`
is a property rather than a method), which is why the multi-instance suite is the only thing that can
prove this works.

### Why the disconnect is not sufficient on its own

A disconnect is a network operation that can be lost, and the adapter it travels over is a dependency
spec 012's Q7 deliberately allows to degrade. Enforcement resting on successful delivery of a disconnect
fails open during precisely the incident that makes it matter. §1 is the guarantee; §3 is the tidy-up
that satisfies FR-017's "not left open and inert."

### Why it is not redundant either

Without it, a displaced device holds a connection indefinitely, retrying and consuming a socket slot,
with every frame rejected. FR-017 requires the connection to end.

---

## 4. Notification and status pushes — delivery, not shape

`notification:new`, `order:status`, `order:otp` and `session:revoked` are **unchanged on the wire**.

What changes is that the mobile client will actually receive them. Every `on*` on `TrackingSocket` is
`_socket?.on(...)`, so a handler registered before `connect()` resolves is a silent no-op — which is why
`NotificationsCubit` has never received a push for either persona. Specs 006 and 007 worked around this
twice with external listeners attached after `await connect()`; Slice 0 fixes it at the socket
(research R1).

**Server-side implication: none.** This is stated here so that a reader comparing "notifications now
arrive live" against the backend diff does not go looking for a platform change that does not exist.
