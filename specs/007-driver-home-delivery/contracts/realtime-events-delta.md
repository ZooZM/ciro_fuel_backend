# Realtime Events Delta: Driver Home & Active Delivery

**Feature**: 007-driver-home-delivery | **Date**: 2026-08-24

Delta against feature 001's WebSocket contract. One routing change, no new event names.

---

## Changed routing: `order:status` also reaches the assigned driver

**Requirements**: FR-007, FR-026, SC-007.

`OrderStateService.transition` currently emits only to the order room:

```ts
this.realtimeGateway.emitToOrderRoom(String(orderId), 'order:status', { … });
```

It must **additionally** emit the identical payload to `user:{driverId}` when the order carries
a driver.

### Why this is required, not an optimisation

A driver cannot join an order room. `TrackingGateway.watch` refuses them outright:

```ts
if (client.data.user.role === UserRole.DRIVER) {
  return { ok: false, error: 'FORBIDDEN_ROLE' };
}
```

So today **no order status change can reach a driver by any path**. `DeliveryCubit._handleStatus`
listens for `order:status` and has never once fired. Without this change, FR-007 and SC-007 are
unimplementable and the listener stays dead code.

### Payload — unchanged

```json
{ "orderId": "…", "from": "IN_TRANSIT", "to": "UNLOADING", "at": "2026-08-24T13:05:00.000Z" }
```

Deliberately identical to the order-room emit, so the app registers **one** `order:status`
handler regardless of which room delivered it. A client watching their own order receives it via
the order room; the assigned driver receives it via their user room. Neither receives it twice:
a driver is never in the order room, and a client is never the order's driver.

### Ordering

Emit after the status write, matching the existing emit's placement and its recorded reasoning
(a rolled-back transaction self-corrects on the next fetch).

---

## Existing, reused: `notification:new` carrying `ORDER_ASSIGNED`

**Requirements**: FR-002, and the Edge Case "a driver is assigned while the app is open".

`DispatchService.assignDriver` already notifies the driver:

```ts
await this.notificationsService.notify({
  recipientUserId: result.driverId!,
  type: NotificationType.ORDER_ASSIGNED,
  …
});
```

`NotificationsService` emits `notification:new` to `user:{recipientUserId}`, so this **already
reaches the driver's device**. No backend change is needed — the app simply cannot act on it,
because its `NotificationType` enum shares no values with the backend's and everything degrades
to `unknown` (research R10, `mobile_app/CLAUDE.md` debt #5).

Once the enum is corrected, receiving `ORDER_ASSIGNED` is the app's signal to reload the active
delivery, which is what makes a new assignment appear without a restart.

---

## Client-side attachment rule (binding)

Every handler for the events above MUST be attached **after** `trackingSocket.connect()` has
completed, from the `SessionAuthenticated` branch in `injector.dart` — the seam spec 006
established for `SessionRevocationListener`.

`TrackingSocket`'s registration methods are all `_socket?.on(...)`. Attaching before the socket
exists is a **silent** no-op, and a fresh socket object is created on every connect, so a handler
bound to a previous socket is orphaned. `DeliveryCubit` registers `onStatus` in its constructor
today and is a lazy singleton — it must stop doing so (research R2).

This is the same failure `mobile_app/CLAUDE.md` debt #6 records for `NotificationsCubit`. A
revocation handler that repeated it would fail exactly as invisibly, which is why spec 006
called it out and why it is restated here as a contract rather than left to memory.

---

## Explicitly unchanged

- **`order:watch` stays closed to drivers.** That room also carries the client's live
  driver-position feed; the user-room emit above gives the driver what they need without opening
  it (research R1).
- **`order:otp` stays client-only.** It carries the handover code, which FR-014 forbids the
  driver's app from ever receiving.
- **`location:update`** — the driver's outbound position stream is unchanged; it already starts
  and stops with the active delivery via `LocationStreamService`.
