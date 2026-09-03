# Research: Driver App Backend Completion & Cross-Device Delivery Continuity

**Feature**: 013 | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

Twelve decisions. **R1, R2, R7 and R10 each overturn something the spec, the clarification session, or
an obvious reading of the codebase assumed.** R1 inverts the implementation order; R2 removes the cost
objection to the enforcement the spec asks for; R7 deletes a requirement's premise; R10 corrects a
requirement that is too absolute to satisfy.

---

## R1 — Slice 0 is the socket handler registry, alone, before anything else

**Decision**: The first slice fixes `TrackingSocket` so that interest registered before a connection
exists is honoured once it does — and lands **alone, with both personas' suites green**, before any
other work in this feature begins.

**Rationale**: Every `on*` method on `mobile_app/lib/core/realtime/tracking_socket.dart` is
`_socket?.on(...)`. Before `connect()` resolves, `_socket` is null and **registration is a silent
no-op** — it does not throw, does not warn, and leaves the caller believing it subscribed. This is
mobile `CLAUDE.md` debt #6, and it is why `NotificationsCubit` — an eager singleton that registers from
its constructor — has never received a single push, for either persona, since it was written.

Specs 006 and 007 worked around it twice, by hand: `SessionRevocationListener` and `DeliveryListener`
are both external classes that exist so `attach()` can be called *after* `await connect()`. Both carry
comments explaining the trap. That is per-class discipline, not a fix — the next class to register a
handler from a constructor fails the same silent way.

The ordering argument is what makes this Slice 0 rather than a task inside Story 3:

- Story 3's notification screen depends on live delivery (FR-028). Built before the fix, it must adopt
  the external-listener workaround, then be rewritten when the fix lands. Built after, it registers
  directly and the workaround never exists.
- The failure mode is **silent**. A notification screen that fetches on open but never receives a push
  looks correct in every test that does not specifically drive a push, and looks correct in casual use.
  This is the same class of defect as spec 012's Redis socket adapter, which never attached and whose
  failure was invisible to all 53 single-instance suites.
- It touches the **client** persona, which this feature is otherwise scoped away from (FR-042). This
  repo's rule for shared-ground changes — spec 007's Slice 0, spec 005's OTP extraction — is that they
  land alone with the existing suites green, so a client regression is attributable to one commit.

**Alternatives considered**:
- *Keep the per-cubit external-listener pattern, add a third one for notifications.* Rejected: it is
  three workarounds for one defect, and it leaves the trap armed for the fourth.
- *Make `connect()` throw when handlers are registered too early.* Rejected: it converts a silent bug
  into a crash at the one moment (app startup) where a crash is least recoverable, and it still
  requires every caller to be reordered.
- *Fold the fix into Story 3.* Rejected for the ordering reasons above — and because a client-visible
  change buried inside a driver story is exactly the diff a reviewer cannot attribute.

**Shape**: `TrackingSocket` keeps a registry of `(event, handler)` pairs. `on*` records into the
registry and attaches immediately if a socket already exists; `connect()` attaches the whole registry
to the newly created socket. Note that `connect()` **creates a new `io.Socket` every call** while
`reauthenticate()` reuses the existing one — so the registry is also what makes handlers survive a
sign-out/sign-in cycle, which today only works because the DI stream listener happens to rebuild the
listener objects each time.

---

## R2 — Enforcing displacement on an open socket costs nothing, because the read is already there

**Decision**: Two mechanisms, both required, neither sufficient alone:

1. **The platform force-closes the displaced device's connections** at the moment of displacement,
   rather than emitting `session:revoked` and leaving the socket open (FR-017).
2. **Every location frame re-checks the session generation** against the stamped value from the
   handshake, and a mismatch is refused (FR-014/FR-016).

**Rationale**: `WsJwtGuard` does not verify anything. Its own docstring says so: it "just confirms the
middleware already populated `socket.data.user`". The real verification runs **once**, in the namespace
middleware, at handshake. Nothing re-checks afterwards. So a displaced device with a live socket keeps
writing the authoritative position of that truck — which feeds stop detection's `lastMovedAt`, dispatch
proximity via `$geoNear`, and the customer's map.

Today the only thing stopping it is that a cooperating app obeys the `session:revoked` push. The cases
that motivate a device switch — a dead battery, a crash, a phone in a drawer — are precisely the cases
where the app does not cooperate.

**The finding that removes the obvious objection to (2)**: a per-frame session check sounds expensive —
location frames arrive every few seconds per driver, and a database read per frame is the kind of thing
that gets designed around with a Redis cache. **It is already happening.** `TrackingGateway.locationUpdate`
runs `this.userModel.findById(client.data.user.userId)` on **every** frame, unconditionally, before the
abuse-ceiling early return. The driver document it loads carries `sessionGeneration`. Comparing it to
the socket's stamped `sgen` is a field comparison on a document already in hand — **zero additional
I/O**. A Redis-cached generation would add a dependency, add a degradation path that spec 012's
Clarification Q7 would then have to answer for, and be *slower* than the read that already runs.

**Why (1) is still needed**: a refused frame is still a frame — the displaced device keeps a connection,
keeps retrying, and keeps consuming a socket slot. FR-017 requires the connection to end. Cross-instance
reach is already solved: spec 012 attached the Redis socket adapter, so disconnecting every socket in
the `user:{userId}` room reaches devices connected to any instance, the same way `emitToUser` already
does.

**Why (2) is still needed**: a disconnect is a network operation that can be lost, and the Redis adapter
is a dependency spec 012's Q7 explicitly allows to degrade. Enforcement that depends on successful
delivery of a disconnect is enforcement that fails open during exactly the incident that makes it matter.
(2) is the guarantee; (1) is the tidy-up.

**Alternatives considered**:
- *Re-verify the JWT per frame.* Rejected: signature verification per frame is real CPU, and the JWT
  cannot tell you the *current* generation anyway — only the one it was minted with.
- *Cache the generation in Redis, check per frame.* Rejected: strictly worse than reading a document
  already being read, and it adds a graceful-degradation question with no upside.
- *Rely on access-token expiry.* Rejected: it bounds the window but does not close it, and the bound is
  the token lifetime — long enough for a truck to cross a city.

**Ordering correction this forces**: `locationUpdate` currently calls `presenceService.touch()`
**before** loading the driver document. `touch` writes `isOnline: true, lastSeenAt: now`. A displaced
device touching presence keeps a dead device presenting as online and dispatchable. The driver load and
the generation check must therefore move **above** the touch.

---

## R3 — `AuthenticatedUser` gains `sgen`, sourced from the handshake, never re-read

**Decision**: `AuthenticatedUser` carries the `sgen` the presented token was minted with.
`authenticateSocket` already has it — it verifies the payload and currently discards the field.

**Rationale**: The comparison in R2 needs two numbers: what the connection claimed at handshake, and
what the account holds now. The second is on the document already loaded; the first is thrown away
today. Stamping it on the socket at handshake is the only correct source — re-reading it later would
compare the account against itself and always agree.

`sgen` is optional on `JwtPayload` (tokens minted before spec 006 have none) and both sides already
normalise absent to `0`. That normalisation must be preserved here or every pre-spec-006 token becomes
a mismatch.

**Alternatives considered**: *A separate map of socket id → generation.* Rejected: `socket.data.user`
is where the handshake's conclusions already live, and a parallel structure would need its own cleanup
on disconnect.

---

## R4 — The driver's app reads stops from the delivery; it does not need a new endpoint

**Decision**: The mobile `Order` entity gains the stop-event collection. No platform change is required
to surface an outstanding stop question on a replacement device.

**Rationale**: `OrdersController.toRoleScopedShape` deletes `stopEvents` **only** for the `CLIENT`. A
`DRIVER` already receives the full array from `GET /orders/:id`. The gap is entirely on the device:
`mobile_app/lib/shared/entities/order.dart` has no stop field of any kind — a grep for "stop" in that
file returns nothing.

So the driver's only route to a stop question has ever been the device alert raised at the instant
`DeliveryListener` saw `DRIVER_STOP_DETECTED` on the socket. Miss the socket frame — app killed, phone
switched, permission refused — and the question is unreachable, while the silence escalates to the
transporter as though the driver ignored it.

**Which stop is "outstanding"** must be derived exactly as the platform derives it, or the two disagree
about a delivery in a way no test on either side would catch. The platform's `unblockedStopFilter` is
`resolvedAt == null OR suppressedUntil > now`. The driver's screen shows a question for a stop with
`resolvedAt == null` **and** `reasonGivenAt == null` — the answerable subset. A declared stop arrives
already resolved and never qualifies, which is correct and is why the check must be on both fields
rather than on `reason`.

**Alternatives considered**:
- *A dedicated "my outstanding stops" endpoint.* Rejected: the data is already in the response the
  screen fetches anyway; a second call would be a second source of truth to keep consistent.
- *Persist the alert locally and restore it.* Rejected outright: it is device-local state, which is the
  very thing this story exists to remove, and it cannot help a device that never received the alert.

---

## R5 — The blocked-driver report is a third stop origin, unresolved and immediately escalated

**Decision**: `StopOrigin` gains `BLOCKED`. A blocked-driver report is written as a stop event with:

| Field | Value | Why |
|---|---|---|
| `origin` | `BLOCKED` | Distinguishable from `DETECTED` and `DECLARED` (FR-039a) |
| `reason` / `reasonText` | the driver's stated reason | Reuses `StopReason`; `OTHER` carries free text |
| `reasonGivenAt` | now | The driver said why at creation — nobody needs to ask |
| `resolvedAt` | **null** | It is an open problem awaiting the transporter |
| `suppressedUntil` | **unset** | FR-039b — this must not silence anything |
| `escalatedAt` | now | The transporter is told immediately, and the record says so |

No escalation job is scheduled. The transporter is notified in the same operation.

**Rationale — and this is the correction the clarification session already recorded, stated
mechanically**: the obvious reading of "reuse the stop machinery" is to call the existing declare path.
That would be wrong in three compounding ways. `declareStop` writes `resolvedAt: now` and
`suppressedUntil: now + duration`, and notifies nobody — the transporter is reached *only* by
`StopEscalationProcessor`, and only for a `DETECTED` stop that went unanswered past its window. A
"cannot reach" filed as a declaration would therefore: tell no one, mark itself already handled, and
**switch off detection for the duration** — so the stalled truck it describes would never raise the
alert that would otherwise have reached the transporter. The driver presses a button asking for help
and becomes *less* visible than if they had pressed nothing.

Writing it unresolved instead makes the existing machinery do the right thing for free. The
one-open-stop invariant already prevents a duplicate `DETECTED` stop being raised alongside it, which is
correct — the transporter has been told; a second event would be noise, and that is suppression of a
*duplicate*, not suppression of the *alert*. And `PATCH /orders/:id/stops/:stopId/resolve` already
exists, already admits `TRANSPORT_COMPANY_ADMIN` only, and already drives the dashboard's resolve
mutation — so the close-out path is built.

**`StopReason` is reused unchanged.** Three of its seven values (`ROAD_CLOSURE`, `ACCIDENT`,
`VEHICLE_PROBLEM`) describe being blocked directly; `OTHER` covers the rest. The driver's UI offers the
applicable subset; the wire vocabulary stays single, so the dashboard renders what the driver picked
with no new mapping. Adding blocked-specific reason values would fork a vocabulary whose whole design
note says both surfaces must know the same values.

**Alternatives considered**:
- *A new `DeliveryProblem` collection.* Rejected: a parallel place for "why is this delivery not
  progressing", which the transporter would have to watch separately from stops.
- *Reuse `DECLARED` with a flag.* Rejected: the flag would have to override suppression, escalation and
  resolution semantics — at which point it is a third origin wearing a disguise.
- *Set `resolvedAt` and rely on the notification alone.* Rejected: the dashboard's open-stop treatment
  is how a transporter sees an outstanding problem; a pre-resolved stop appears nowhere.

---

## R6 — Mark-all-read is one platform operation, not a client loop

**Decision**: A new endpoint marks every unread notification read for the calling user in one
conditional bulk write.

**Rationale**: The platform has `PATCH /notifications/:id/read` and nothing bulk. The client-loop
alternative issues N requests against an API that spec 012 put behind proxy-aware rate limiting, is not
atomic (a partial failure leaves the badge disagreeing with the list, which FR-026 forbids), and
flickers the badge downward N times. The server-side form is one `updateMany` filtered by recipient and
unread — idempotent by construction, since its own effect falsifies its filter, exactly like
`PresenceService.markSilentDriversOffline`.

**Alternatives considered**: *Client loop* — rejected above. *Mark-read-on-render* — rejected: it
destroys unread state the driver has not actually read, and FR-025 ties reading to opening.

---

## R7 — The driver's notification filters cannot exist, because only two types reach a driver

**Decision**: The driver's notification list ships with **no category filter**. The mock's three tabs
(All / Orders / System) are removed rather than wired.

**Rationale**: FR-029 forbids offering a filter nothing can ever match. Auditing every
`notificationsService.notify` call site in the backend, a `DRIVER` is the recipient of exactly **two**
notification types:

| Type | Sent by | Recipient |
|---|---|---|
| `ORDER_ASSIGNED` | `dispatch.service.ts:420` | `result.driverId` |
| `DRIVER_STOP_DETECTED` | `stop-detection.service.ts:215` | `driver._id` |

Every other type in the enum is addressed to a client (`ORDER_APPROVED_FINAL_PRICE`, `OTP_ISSUED`,
`PAYMENT_TIMEOUT`, `ORDER_STATUS_CHANGED`) or to an admin (`ORDER_ROUTED_TO_TRANSPORT`,
`NO_DRIVER_AVAILABLE`, `SUPPORT_REQUEST_RAISED`, `ORDER_STOP_UNRESOLVED`,
`PAYMENT_RECONCILIATION_REQUIRED`).

Both driver-reachable types are order-related. So **"System" can never match anything**, and "Orders" is
identical to "All" — three tabs describing one list. The mock encoded a notification centre the platform
cannot fill, in the same way feature 009's `MapTrackingCard` legend encoded a four-way breakdown no
endpoint produced, and it is removed on the same precedent.

**Consequence worth stating plainly**: the driver's notification list will be sparse — assignments and
stop questions. That is honest. Note in particular that `ORDER_STATUS_CHANGED` goes to the *client*; the
driver learns of status changes through the `order:status` socket push into `user:{driverId}` (spec
007), which is not a `Notification` document and therefore correctly does not appear in this list.

**Alternatives considered**:
- *Keep the tabs and let two be empty.* Rejected by FR-029, and it reproduces the defect in a new form:
  a driver tapping "System" sees an empty state and concludes the app is broken.
- *Widen the platform to send drivers more notification types.* Rejected as scope: which events a driver
  should be notified about is a product decision with its own consequences, not a side effect of
  connecting a screen.

### R7a — the client's own screen already solved this, and its answer is better than "no filter"

Found while sizing Story 3. `notifications_screen.dart` — the **client's** list, already live — carries
this comment:

> All / unread — the one real, server-applied filter (`?unread=true`). The design's order/invoice/system
> chips predate the real `AppNotification` shape, which carries no such category, so they've been
> dropped rather than sorted against data that doesn't distinguish them (every `NotificationType` the
> app models today is order-related).

So the identical mock chips were already deleted on the client side, for the identical reason, and
replaced with an **All / Unread** filter that *is* backed by the API (`GET /notifications?unread=true`).

**Amended decision**: the driver's list drops the three fabricated category tabs and offers the same
All / Unread filter the client screen already offers. This is strictly better than offering nothing —
"show me what I haven't read" is a real thing a driver wants and a real thing the platform supports —
and it means the two personas' lists behave the same way for the same reason, rather than this feature
inventing a third answer to a question already settled.

**Two further consequences for Story 3, both shrinking it:**

- `NotificationsCubit` already implements `load()`, `refresh()`, `loadMore()` with cursor pagination and
  `unreadCount`. **FR-032 (progressive loading) needs no new capability** — only a screen that calls
  `loadMore()`.
- The client screen is a working reference for structure, per-type presentation and empty/error states.
  The driver screen is a re-skin against the same cubit, not a new stack. Reproducing any part of the
  client's data path here would be debt #2's mistake in a new place.

---

## R8 — Driver identity reuses `ProfileCubit`; nothing new is built

**Decision**: `DriverProfileScreen`'s profile card resolves the existing `ProfileCubit`, exactly as
`DriverProfileDetailsScreen` already does.

**Rationale**: `driver_profile_screen.dart:264-273` renders the translation keys
`driver_mock_profile.driver_name_mohamed` and `driver_mock_profile.station_alhamd` — a fabricated
identity and a *station*, which is a `CLIENT` concept a driver does not have. Spec 006 fixed exactly
this on the sibling screen and left this one, which is reachable from the driver's `/driver/more` tab.
`ProfileCubit` is registered `registerFactoryParam` keyed by user id and already exposes loading, loaded
and failure states, so FR-035 (state it, never substitute a placeholder) needs no new capability.

The mock translation keys are deleted with the code that reads them, so nothing can quietly re-adopt
them.

---

## R9 — The untracked-delivery indicator has a state field and no renderer

**Decision**: `DeliveryActive.streaming` is rendered on the delivery screen as an explicit
"this delivery is not being tracked" condition.

**Rationale**: `DeliveryCubit.load()` already calls `_locationStream.start()`, which returns `false` when
location permission is refused, and already carries the result into `DeliveryState.active(order,
streaming: streaming)`. A grep for `streaming` across the whole app finds **one** hit — the field's own
declaration in `delivery_state.dart:21`. Nothing reads it.

So a driver who refuses location permission today sees a completely normal delivery screen while the
platform receives nothing, the customer's map freezes, and stop detection eventually raises a stall for
a truck that may be moving perfectly well. FR-011 is a renderer for a value that has been computed and
discarded since spec 007.

---

## R10 — FR-042a is too absolute: the dashboard must change, and must change or break

**Decision**: Amend FR-042a. Dashboard behaviour is unchanged **except** for presenting the new blocked
report, which is a required part of FR-039a rather than an optional extra.

**Rationale**: `web_dashboard/src/constants/stop-events.ts` mirrors the backend's `StopOrigin` as a const
map with two members, and its own header comment states the failure mode precisely: a value invented on
one side "does not fail loudly — it renders as a missing translation key next to a real stop on a real
delivery." Introducing `BLOCKED` without touching the dashboard produces exactly that, on the surface
the transporter is supposed to read the report from.

FR-039a also requires the transporter to be able to *distinguish* a blocked report from a detected and a
declared stop. A notification alone does not satisfy that — `StopAlertCard.tsx` is where a stop is read
and resolved.

The change is small and additive: a third member in the const map, a translation key, and a distinct
treatment on the card. `useResolveStop` needs nothing — the resolve endpoint and mutation already work
for any stop.

**This is the same shape of correction as FR-042's**, and is recorded the same way: a scope boundary
stated absolutely in the spec turns out to have one necessary exception, and naming it is better than
discovering it mid-implementation and widening silently.

---

## R11 — FR-021 is already satisfied; the task is a test, not an implementation

**Decision**: No new audit machinery. Verify the existing trail covers a device switch.

**Rationale**: `AuthService.login` already writes both a `REVOKED` row with cause
`SIGNED_IN_ELSEWHERE` and a `SIGNED_IN` row, in one transaction, on every sign-in — with the generation
in force after the event on each. An administrator investigating a tracking gap can therefore already
see that the driver's session was displaced and when. `SessionEventType` and `SessionRevocationCause`
need no new values.

The risk here is the opposite of the usual one: writing a device-switch audit would duplicate a trail
that already exists, and two records of one event that can disagree is worse than one.

---

## R12 — Slice order, and which slices must land alone

**Decision**:

| Slice | Content | Lands alone? | Why here |
|---|---|---|---|
| **0** | R1's socket handler registry | **Yes** | Silent when wrong; touches the client; Story 3 is built differently before and after it |
| **1** | US2 — server-side displacement enforcement | Backend only | Independently testable, no client change, and invisible when wrong (see below) |
| **2** | US1 — stop events on the delivery, continuity, the untracked indicator | No | Supplies the mobile stop plumbing Slice 4 needs |
| **3** | US3 — the driver's notification centre | No | Depends on Slice 0 |
| **4** | US5a — the blocked-driver report | No | Backend + mobile + dashboard; needs Slice 2's stop plumbing |
| **5** | US4 + US5b — identity, dead controls, the navigation view | No | Smallest, no dependencies, safe to finish on |

**The trap in Slice 1**: like spec 012's Redis adapter, it passes every single-device test whether or not
it works. A test that signs in on device B and then has device A report *the same position* proves
nothing — the frame would be rejected by the displacement threshold anyway. The test must have the
displaced device report from a **different location** and assert the truck's recorded position is
unchanged, and must separately assert `lastMovedAt` did not advance. Without both, Slice 1 is unverified
no matter how many tests it has.

**Alternatives considered**: *Priority order from the spec (US1 → US2 → US3 → US4 → US5).* Rejected:
it puts the notification screen before the fix that makes its pushes work, and the blocked report before
the mobile stop plumbing it builds on.
