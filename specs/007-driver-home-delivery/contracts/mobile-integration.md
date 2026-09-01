# Mobile Integration Contract: Driver Home & Active Delivery

**Feature**: 007-driver-home-delivery | **Date**: 2026-08-24

How the Flutter app consumes this feature. Binding constraints, not suggestions — several exist
because the obvious approach is already known to fail here.

---

## Layering (Constitution IV)

| Concern | Layer | Notes |
|---|---|---|
| Active delivery + handover actions | `features/delivery/` | Existing stack. Reused, not rebuilt. |
| Driver's delivery **list** | `features/orders/` | Reuses `OrdersRemoteDataSource` / `OrdersRepository` / `GetOrders` (research R4). |
| Driver header figures | `features/delivery/` | New datasource method + repository + use case for `GET /drivers/me/summary`. |
| Customer rating submission | `features/orders/` | Client persona; lives with the order detail it attaches to. |

**Why the list reuses `orders/`**: `GET /orders` is one endpoint that already returns a
driver-scoped, correctly paginated list, and `orders/`'s datasource already parses it properly.
A second paginated list inside `delivery/` would deepen `mobile_app/CLAUDE.md` debt #2 ("two
datasources call one endpoint") at the exact moment this feature touches both.

---

## The envelope fix (FR-001, research R3)

`DeliveryRemoteDataSourceImpl.getActiveOrder()` currently reads:

```dart
(response.data!['data'] as List<dynamic>)   // ← key the endpoint does not return
```

It MUST use the shared helper instead:

```dart
final page = parsePaginatedResponse(response.data!, OrderMapper.fromJson);
```

Then scan `page.items` for the first order whose status is `inTransit` or `unloading`.

**First page is sufficient.** The list sorts `updatedAt` descending, page size is a fixed 20,
and a driver holds at most one delivery at a time — enforced by the unique partial index on
`activeOrderId`. An in-progress delivery has necessarily transitioned recently, and the driver
cannot have accumulated 20 more-recently-touched orders while blocked on it.

**`mobile_app/CLAUDE.md` debt #1 is stale and must be corrected** as part of this work: it
describes the endpoint as returning "a bare JSON array", which stopped being true when spec 005
introduced cursor pagination.

---

## Socket attachment (FR-007, research R2) — the one that fails silently

`DeliveryCubit` registers `_socket.onStatus(_handleStatus)` **in its constructor** and is a
`registerLazySingleton`. That must stop.

**Required shape**, mirroring spec 006's `SessionRevocationListener`:

```dart
case SessionAuthenticated():
  await trackingSocket.connect();          // await — connect() assigns _socket after an await
  SessionRevocationListener(…).attach();   // spec 006
  DeliveryListener(…).attach();            // this feature: order:status + ORDER_ASSIGNED
```

`TrackingSocket`'s registration methods are all `_socket?.on(...)`, so attaching before the
socket exists is a **silent** no-op, and a fresh socket object is created on every connect —
a handler bound to a previous socket is orphaned. This is `mobile_app/CLAUDE.md` debt #6's exact
failure mode, and it produces an app that looks correctly wired and simply never updates.

The listener is extracted as its own class (not an inline closure) for the same reason spec 006
extracted `SessionRevocationListener`: it makes the wiring unit-testable against a mocked
`TrackingSocket` without booting the DI graph.

---

## What the listener does

| Signal | Action |
|---|---|
| `order:status` where `to` is terminal (`DELIVERED` / `CANCELLED`) and `orderId` matches the active delivery | Reload the active delivery. Never mutate the displayed stage locally (FR-015). |
| `order:status` for the active delivery, any other transition | Reload, so the detail reflects the new stage (FR-026). |
| `notification:new` with type `ORDER_ASSIGNED` | Reload — this is how a new assignment appears without a restart (FR-002). |

Every case reloads from the platform rather than applying the transition locally. FR-015 makes
the platform's response the only thing that may change a displayed stage, and a payload-applied
optimistic update is precisely what that forbids.

---

## `NotificationType` repair (research R10) — a shared-surface change

The app's enum shares **no values** with the backend's; everything degrades to `unknown`, and
`ORDER_ASSIGNED` is absent entirely. It must be corrected to the backend's real values.

This enum is **shared with the client persona**. Today those notifications render as generic
entries; afterwards they render correctly. That is a fix, but it changes client-facing
behaviour, so it lands with **both** personas verified — the same discipline spec 006 applied to
its shared session-validation changes.

---

## Handover flow (FR-009–FR-018)

The four steps, and which are missing today:

| Step | Call | Status today |
|---|---|---|
| 1. Driver confirms arrival | `POST /orders/:id/arrive` | **Never called.** Issues the customer's arrival code. |
| 2. Driver submits arrival code | `POST /orders/:id/verify-arrival` | Wired via `DeliveryCubit.confirmHandover`, but unreachable (no active order loaded). |
| 3. Driver requests delivery code | `POST /orders/:id/request-delivery-otp` | **Never called.** Issues the customer's delivery code. |
| 4. Driver submits delivery code | `POST /orders/:id/verify-delivery` | Wired, same unreachable. |

Steps 1 and 3 are what `OtpVerifyCubit` was built for — it wraps `MarkArrived` and
`RequestDeliveryOtp` — but it is **never registered in DI and never used by any screen**. Wire
it or fold its use cases into `DeliveryCubit`; either way both steps must be reachable, because
without them the customer never receives a code and the delivery cannot complete.

`confirmHandover` already selects the right verify call from the order's own status — keep that.
FR-012 requires the stage, not the screen, to decide.

**Attempt exhaustion (FR-017)**: both verify endpoints throttle at 5 per 15 minutes. The app
must render that refusal as "have a fresh code sent", not as a generic failure.

**FR-014**: the driver's app never requests, stores, logs or displays a handover code.
`GET /orders/:id/otp/current` is CLIENT-only and must not be called from a driver build.

---

## Inert controls (FR-027)

Nine `onPressed: () {}` / `onTap: () {}` handlers exist across the driver delivery screens. Each
is either wired or removed — none may ship present-but-inert.

- **Call** → dial `clientSummary.phone` via the existing `phone_dialer.dart`. Absent when the
  order carries no `clientSummary` (FR-027b) — pre-feature orders have none.
- **Navigate** → the existing map handoff.
- **Arrive / request code** → steps 1 and 3 above.

---

## Delivery detail stage (FR-024, FR-025, research R11)

Delete `enum _OrderMockState` and `_cycleMockState()`, and the app-bar button wired to it.
Drive the display from the order's real `OrderStatus`:

| Real status | Displayed phase |
|---|---|
| `IN_TRANSIT` | Out for delivery |
| `UNLOADING` | Out for delivery (unloading) |
| `DELIVERED` | Completed |
| `CANCELLED` | Cancelled |

Removed outright rather than left behind a debug flag — FR-025 forbids any interaction changing
the displayed stage, and a flag is an interaction away from being wrong.

---

## Delivery list categories (FR-020)

Exactly four tabs, defaulting to **All**: All · In progress · Completed · Cancelled.

"In progress" spans `IN_TRANSIT` and `UNLOADING`. The current tabs come from `InvoicesKeys`
(`tabAll` / `tabDeferred` / `tabPaid` / `tabFailed`) — billing vocabulary on a delivery list.
New `driver_orders.*` keys are required; the `InvoicesKeys` import goes.

---

## State distinctness (FR-032, FR-044, FR-045)

These MUST render differently from one another. Collapsing any pair is the failure mode this
feature exists to end:

| State | Must not be confused with |
|---|---|
| No active delivery | Loading · could not load |
| Not yet rated | A score of zero · could not load |
| Zero deliveries today | Could not load |

An unreachable platform must never read as a poor record.

---

## Session lifecycle (FR-008)

`DeliveryCubit.clear()` is already called on `SessionUnauthenticated` (spec 006). Any new
session-lifetime state added here — the header summary in particular — must be cleared on the
same branch, or the next driver's first frame shows the previous driver's rating and day count.
