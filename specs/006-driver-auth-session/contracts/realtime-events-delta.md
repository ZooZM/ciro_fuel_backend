# Realtime Events Delta — Driver Authentication & Session

Additions to the `/tracking` Socket.io namespace. One new server → client event, and one
behaviour change at the handshake. No new namespace, no new room, no new middleware.

---

## New: `session:revoked` (server → client)

**Requirements**: FR-035, FR-036, FR-042.

Emitted into the `user:{userId}` room the moment a session is revoked, so a connected device
learns immediately rather than at its next request.

**Payload**

```jsonc
{
  "cause": "SIGNED_IN_ELSEWHERE",   // SessionRevocationCause
  "occurredAt": "2026-08-23T09:14:22.104Z"
}
```

**Emitted on**: sign-in elsewhere (`SIGNED_IN_ELSEWHERE`), completed password reset
(`PASSWORD_RESET`), account deactivation (`ACCOUNT_DEACTIVATED`). Not emitted on the driver's
own sign-out — that device already knows.

**No new plumbing.** `TrackingGateway.handleConnection` already joins every socket to
`user:${userId}`, and `RealtimeGatewayService.emitToUser` already emits into it — both added
for `notification:new` and `order:otp`. This event is a third caller of machinery already in
production.

**Ordering is deliberate**: `sessionGeneration` is incremented **before** the emit, so the
session is genuinely dead when the notice goes out. Socket.io does not re-validate the
handshake per frame, so the message still reaches the socket whose credentials just became
stale — the notice lands on a connection that has already lost its authority, which is
exactly the intent.

**Client handling** (single place — the session lifecycle listener in `injector.dart`, never
per-screen):

1. Clear `TokenStore`.
2. `SessionCubit.signOut(reason: <localized message for cause>)`.
3. The router redirect already reacts to `SessionUnauthenticated` and lands on `/login`.
4. The existing `SessionUnauthenticated` branch already disposes the socket and clears the
   per-user cubits, so no cleanup is added here.

---

## Changed: handshake refusal on a revoked session

**Requirements**: FR-035a.

**No code change in the gateway.** `TrackingGateway.afterInit`'s middleware calls
`authenticateSocket`, which calls `UsersService.validateActiveSessionWithScoping` — the same
method that gains the `sgen` comparison. A revoked session therefore fails the handshake and
is refused with `connect_error UNAUTHORIZED`, using the identical path an inactive account
already takes.

This is what makes the offline fallback free: a device that was disconnected when the
revocation was pushed, and so never received `session:revoked`, cannot re-establish the
connection when it comes back. The mobile client already treats `connect_error` as a session
failure.

**One consequence worth stating**: because `authenticateSocket` receives the full JWT payload
rather than just `sub`, its signature changes alongside `JwtStrategy.validate`. Both are Phase
0 work and both are shared with the CLIENT persona.

---

## Unchanged

`order:watch`, `order:unwatch`, `location:update`, `order:location`, `order:status`,
`order:otp`, `notification:new` — none are touched by this feature.

**Presence is deliberately untouched.** `PresenceService.touch` still marks a driver online on
handshake and on every location frame, and the 60-second sweep still marks them offline after
silence. Per FR-018a a locked device stays on duty and dispatchable, so the mandatory app lock
must **not** disconnect the socket, stop location reporting, or otherwise alter presence. The
only session state that ends presence is sign-out or revocation, both of which disconnect the
socket through the existing `SessionUnauthenticated` branch.

---

## Flutter constant

`SocketEvents` in `mobile_app/lib/core/realtime/socket_events.dart` is documented as the only
place these literals appear (Principle I). Add under "Server → Client":

```dart
static const String sessionRevoked = 'session:revoked';
```
