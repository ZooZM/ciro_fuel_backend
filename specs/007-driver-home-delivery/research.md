# Research: Driver Home & Active Delivery

**Feature**: 007-driver-home-delivery | **Date**: 2026-08-24

Every decision below was taken against the code as it actually is, verified by reading it.
Several overturn assumptions that looked safe from the spec alone; those are called out.

---

## R1 — How a driver's app learns that a delivery changed

**Decision**: Emit `order:status` to the **driver's own user room** (`user:{driverId}`), in
addition to the existing order-room emit, whenever the order carries a `driverId`.

**Rationale**: The obvious approach — have the driver watch the order room — is *forbidden by
design*. `TrackingGateway.watch` opens with:

```ts
if (client.data.user.role === UserRole.DRIVER) {
  return { ok: false, error: 'FORBIDDEN_ROLE' };
}
```

A driver can never join `order:{id}`. Since `OrderStateService.transition` emits `order:status`
only via `emitToOrderRoom`, **no order status change has ever been able to reach a driver**.
That makes `DeliveryCubit._handleStatus` — which listens for exactly that event — dead code
today, and it would have stayed dead had this feature only fixed the loading path. FR-007 and
SC-007 (terminal delivery disappears within 5s, no driver action) depend on closing this gap.

The user room is the right channel: every socket joins it on connect
(`handleConnection` → `client.join('user:{userId}')`), spec 006 already pushes `session:revoked`
through it, and a driver receives only events for orders that are theirs. The payload is
unchanged, so the app registers one `order:status` handler regardless of which room delivered it.

**Alternatives considered**:
- *Relax the DRIVER ban on `order:watch`.* Rejected. That room also carries the client's live
  driver-position feed; opening it to drivers widens what a driver can observe for no gain, and
  the driver would need the order id before they have the order.
- *Poll the active delivery.* Rejected: meeting SC-007's 5 seconds means polling every few
  seconds per driver, forever, to catch an event that happens twice a delivery.
- *A new dedicated `delivery:status` event.* Rejected as gratuitous — identical payload,
  identical meaning, one more name to keep in sync.

---

## R2 — When the app attaches its socket handlers

**Decision**: `DeliveryCubit` MUST NOT register its socket handler in its constructor. Attach
after `trackingSocket.connect()` has completed, from the `SessionAuthenticated` branch in
`injector.dart` — the same seam spec 006 established for `SessionRevocationListener`.

**Rationale**: `DeliveryCubit` is a `registerLazySingleton` whose constructor runs
`_socket.onStatus(_handleStatus)`. Construction happens at whatever moment something first
resolves it — today that is either `getIt<DeliveryCubit>().clear()` on sign-out or the scan
screen. `TrackingSocket.on*` methods are all `_socket?.on(...)`, so if the underlying socket is
still null the registration is a silent no-op, and a *fresh socket object is created on every
connect*, so a handler attached to a previous socket is orphaned.

This is precisely the failure `mobile_app/CLAUDE.md` debt #6 records for `NotificationsCubit`,
and spec 006's `SessionRevocationListener` documents the fix. Repeating the mistake here would
be invisible: the app would look wired and simply never update.

**Alternatives considered**:
- *Make `DeliveryCubit` an eager singleton.* Does not help — DI registration still runs before
  the socket connects.
- *Have `TrackingSocket` queue handlers registered before connect and replay them on connect.*
  A genuinely better long-term fix that would retire debt #6 for every listener at once, but it
  changes shared realtime infrastructure the client persona also depends on. Out of scope here;
  recorded as a follow-up.

---

## R3 — Fetching the active delivery

**Decision**: Parse the response with the existing `parsePaginatedResponse` helper
(`items` / `nextCursor`), and scan only the **first page** for a delivery in transit or
unloading.

**Rationale**: `getActiveOrder()` currently reads `response.data!['data']`, a key the endpoint
does not return. `GET /orders` returns `{ items, nextCursor }` (cursor pagination, spec 005),
which `OrdersRemoteDataSourceImpl` already parses correctly via `parsePaginatedResponse` —
including explicit `FormatException`s for a missing `items`/`nextCursor`. Reusing that helper
fixes the bug and keeps one parser.

`mobile_app/CLAUDE.md` debt #1 describes this bug but is itself **stale**: it says the endpoint
returns "a bare JSON array", which stopped being true when spec 005 introduced pagination. The
debt entry needs correcting as part of this work.

First-page-only is sound rather than lazy: the list sorts by `updatedAt` descending
(`ORDER_LIST_SORT_KEYS`), page size is a fixed 20 (`DEFAULT_PAGE_SIZE`), and a driver holds at
most one delivery at a time — enforced structurally by the unique partial index on
`activeOrderId`. A delivery that is in transit or unloading has necessarily transitioned
recently, and the driver cannot have accumulated 20 more-recently-touched orders while blocked
on it.

**Alternatives considered**:
- *Add a multi-status server filter.* `?status=` takes one value and cannot express
  "IN_TRANSIT OR UNLOADING". Adding one is new API surface for something the client can
  determine from a page it already fetches.
- *Two requests, one per status.* Doubles the calls on the app's most-opened screen.

---

## R4 — Which stack serves the driver's delivery list

**Decision**: Serve the driver's list (US3) from the **existing `orders/` data + domain stack**
(`OrdersRemoteDataSource` / `OrdersRepository` / `GetOrders`). Keep `delivery/` for the active
delivery and the handover actions.

**Rationale**: `GET /orders` is one endpoint that already returns a driver-scoped, correctly
paginated list, and `orders/`'s datasource already parses it properly. Building a second
paginated list inside `delivery/` would deepen `mobile_app/CLAUDE.md` debt #2 ("two datasources
call one endpoint") at exactly the moment this feature is touching both.

The backend scopes by role with no client input — `query.driverId = user.userId` for a DRIVER —
so the same call returns the right rows for either persona. Only the presentation differs.

**Alternatives considered**:
- *Add list methods to `delivery/`.* Rejected — knowingly worsens recorded debt.
- *Fully fold `delivery/` into `orders/` now.* The correct end state per CLAUDE.md §3, but a
  large refactor of a persona this feature is already changing heavily. Deferred.

---

## R5 — Giving the driver the customer's contact details

**Decision**: Add `clientSummary { fullName, phone }` to `Order`, snapshotted inside
`DispatchService.assignDriver`'s existing transaction — an exact mirror of the `driverSummary`
already snapshotted there for the customer's benefit.

**Rationale**: The platform records the driver's name, phone and plate onto the order so the
*customer* can identify and call them. There is no mirror, so a driver has only a `clientId` and
an address. That is why the design's call button is `onPressed: () {}`, and why the design's own
mock note reads *"Please call 10 minutes before arrival, and enter through the back gate."*

Snapshotting rather than joining on read follows the discipline already established for
`driverSummary` and `deliveryAddressText`: the order keeps its own immutable copy, so a later
profile edit cannot rewrite what the driver saw at the time. `assignDriver` already loads the
booked driver and writes `driverSummary` in one transaction; the client lookup joins it there.

**Exposure**: the field is returned on the order, so the customer sees their own details
(harmless) and admins see what they already see. `findOneForUser` restricts a DRIVER to orders
where `String(order.driverId) === user.userId`, so no driver can read another delivery's
contact details.

**Alternatives considered**:
- *Look the client up on read.* Rejected — breaks the snapshot discipline and adds a lookup to
  every order read.
- *Phone only, no name.* Rejected — the driver needs to know who to ask for.

---

## R6 — Storing ratings

**Decision**: A dedicated `DeliveryRating` collection, one document per rated order, unique on
`orderId`. The driver's aggregate (`ratingAverage`, `ratingCount`) is maintained on the `User`
document and updated in the **same transaction** as the rating insert.

**Rationale**:
- A unique index on `orderId` is what enforces FR-039 ("rateable at most once") at the data
  layer rather than by application ordering — Principle V's explicit requirement.
- Keeping score and free-text review off `Order` avoids growing a document that is already
  multi-party, heavily indexed, and read on every list page.
- Maintaining the aggregate on `User` means the driver's home header — the app's most-opened
  screen — reads a field the request already has, instead of running an aggregation per open.
- Insert + aggregate bump is a textbook partial-write risk, so it goes in a `ClientSession`
  (Principle V).

`DeliveryRating` is a **multi-party** document (the rater is a client of a fuel company; the
subject is a driver of a transport company) and therefore carries `markMultiParty`, matching
`Order`, not the single-tenant plugin.

**Alternatives considered**:
- *Embed the rating on `Order`.* No natural home for the driver-level aggregate, and it would
  put customer free text inside the order lifecycle document.
- *Compute the average on every read.* An aggregation on the most-opened screen, to avoid a
  bump that a transaction already covers.
- *Maintain the aggregate with a background job.* Adds staleness and a scheduler for a number
  that changes a handful of times a day per driver.

---

## R7 — Counting a driver's completed deliveries today

**Decision**: Add a `deliveredAt` timestamp to `Order`, set when the order transitions to
`DELIVERED`. Count with `{ driverId, status: DELIVERED, deliveredAt: { $gte: startOfDay } }`.
The day boundary is the platform's configured timezone, not the device's.

**Rationale**: The obvious candidates are both wrong. `updatedAt` is not the delivery moment — a
delivered order is still touched by invoice and payment settlement afterwards, so counting on it
would drift. `statusHistory` *does* hold the truth (`{ from, to, at }` entries), but querying it
means an `$elemMatch` on an array for a number rendered on every home-screen open.

An explicit `deliveredAt` is one indexed field, unambiguous, and set exactly once at the
transition that defines it. FR-033 requires a single consistent day boundary; deriving it
server-side from platform configuration is the only way a driver's day cannot shift with a
device clock or a traveller's timezone.

**Alternatives considered**:
- *Count on `updatedAt`.* Wrong by construction (see above).
- *Query `statusHistory` with `$elemMatch`.* Correct but needlessly expensive and unindexed for
  this access pattern.
- *Maintain a counter on `User`.* Requires a daily reset job and drifts if a transition is
  replayed.

---

## R8 — Administrator-override completions (deferred clarification)

**Decision**: An order completed by administrator override **counts** toward the driver's day.

**Rationale**: The spec's Edge Cases flagged this as needing a decision rather than leaving it
accidental. `OrdersService.forceComplete` reaches `DELIVERED` through the same
`releaseDriverIfAssigned` + transition path as a normal completion, so `deliveredAt` is set
identically and the count includes it with no special-casing. That is also the fair reading: the
fuel was delivered and the driver drove it; an administrator resolving a stuck OTP does not undo
the work. Special-casing it would require distinguishing override completions at query time to
produce a *less* accurate number.

---

## R9 — Serving the driver's header figures

**Decision**: One new endpoint, `GET /drivers/me/summary`, returning the rating aggregate, the
day's completed count, and the duty state together.

**Rationale**: The three figures render on one screen at one moment; three calls to paint one
header is wasteful, and each is a trivial read (two fields off the driver's own `User` document,
one indexed count). Scoping it to `me` rather than `/:id` means no identifier to authorise and
no way to request another driver's figures — FR-034 is satisfied structurally.

Duty state is derived, not stored as a single flag: "ready for work" is
`isActive && isOnline && isAvailable && !activeOrderId`, the same predicate
`DispatchService.findCandidates` already filters on. Computing it in one place and returning it
keeps the app from re-deriving dispatch semantics client-side.

**Alternatives considered**:
- *Extend `GET /users/:id`.* That endpoint is shared with the client persona and spec 006's
  profile work; loading driver-only aggregates onto it couples two personas' payloads.
- *Three endpoints.* Three round trips for one header.

---

## R10 — Repairing `NotificationType` (debt #5)

**Decision**: Correct the app's `NotificationType` enum to the backend's actual wire values, as
a prerequisite for the driver reacting to a new assignment.

**Rationale**: The app's enum and the backend's share **no values at all**:

| App (`notification_type.dart`) | Backend (`notification-type.enum.ts`) |
|---|---|
| `FINAL_PRICE_READY` | `ORDER_APPROVED_FINAL_PRICE` |
| `DELIVERY_COMPLETED` | `ORDER_STATUS_CHANGED` |
| `NO_ELIGIBLE_DRIVER` | `NO_DRIVER_AVAILABLE` |
| — | `ORDER_ASSIGNED`, `OTP_ISSUED`, `ORDER_ROUTED_TO_TRANSPORT`, … |

Every live notification therefore degrades to `unknown`. `ORDER_ASSIGNED` — the one signal that
already reaches a driver's user room, emitted by `DispatchService.assignDriver` — is not in the
app's enum at all, so the app cannot branch on it. FR-002's "a new assignment appears without a
manual restart" needs it.

This is a shared enum, so correcting it touches the client persona's notification rendering too:
today those notifications render as generic entries, and afterwards they render correctly. That
is a fix, but it is a **shared-surface change** and must land with both personas verified.

---

## R11 — Driving the delivery detail from real status

**Decision**: Delete the local `_OrderMockState` enum and drive the detail screen from the
order's real `OrderStatus`, mapping the platform's stages onto the three visual phases the
design already draws.

**Rationale**: `delivery_detail_screen.dart` holds `enum _OrderMockState { assigned,
outForDelivery, completed }`, advanced by `_cycleMockState()` wired to an app-bar button. The
mapping onto real statuses is direct: `IN_TRANSIT` → out for delivery, `UNLOADING` → out for
delivery (unloading sub-phase), `DELIVERED` → completed, `CANCELLED` → cancelled. FR-025 forbids
any interaction changing the displayed stage, so `_cycleMockState` and its trigger are removed
outright rather than left behind a flag.

Nine `onPressed: () {}` / `onTap: () {}` handlers across the driver delivery screens are inert.
FR-027 forbids controls that do nothing, so each is either wired (call, navigate, arrive,
request code) or removed.

---

## Follow-ups recorded, deliberately not done here

- **`TrackingSocket` handler-queueing** (R2) would retire debt #6 for every listener at once,
  but changes shared realtime infrastructure both personas depend on.
- **Folding `delivery/` into `orders/`** (R4) is CLAUDE.md §3's agreed end state.
- **Rating takedown / moderation** — the spec records this as a knowingly accepted risk; a
  takedown path is the first thing to add if it proves unacceptable.
- **Admin visibility of driver ratings** — no surface exists until the web dashboard (spec 003)
  is built; settle it there.
