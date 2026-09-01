# Research: In-Transit Stop Detection & Driver Check-In

## R1 — How a stop is detected (the central decision)

**Decision**: A **periodic sweep** (`@Cron`, mirroring `PresenceService.sweepOfflineDrivers`) over
in-transit orders, backed by a `lastMovedAt` timestamp maintained on the driver's `User` record.
`tracking.gateway.ts` updates `lastMovedAt`/`lastMovedLocation` **only** when an accepted fix is
farther than the movement threshold from the last recorded movement — a heartbeat from a parked
truck advances `lastSeenAt` (presence) but deliberately not `lastMovedAt`. The sweep then asks one
indexed question: *which in-transit orders have a driver whose `lastMovedAt` is older than the stop
window and no unresolved stop event?*

**Rationale**: The obvious alternative — a per-order BullMQ delayed job, rescheduled on each
movement, exactly as feature 010's escalation works — **does not survive contact with the numbers**.
A truck at 60 km/h crosses the 50 m movement threshold roughly every 3 seconds, so every moving
driver would generate a job cancel-plus-add against Redis every 3 seconds for the entire journey.
That is thrash proportional to *movement*, to detect *absence of movement*. The sweep inverts this:
cost is proportional to the number of concurrent deliveries (tens) and independent of how fast
anyone is driving, and a moving driver costs one extra field write on fixes the gateway is already
persisting.

This also gives FR-017 for free: `lastSeenAt` (any signal) and `lastMovedAt` (meaningful movement)
are separate fields, so "reporting the same position" and "reporting nothing" are distinguishable
by construction rather than by inference.

**Alternatives considered**:
- *Per-order BullMQ job rescheduled on movement* — rejected on the thrash argument above. It is the
  right shape for the **response-window escalation** (R3), where the timer genuinely starts once and
  is cancelled once, and it is used there.
- *Client-side detection on the driver's device* — rejected: the device is exactly the thing whose
  silence we cannot distinguish from a stop, so it cannot be the arbiter of its own stillness. A
  driver who force-quits the app would simply never report being stopped.
- *Detect inside the socket's `location:update` handler* — rejected: the handler only runs when a
  fix arrives, so a driver whose device goes quiet at the moment they stop would never be evaluated
  at all. Detection must be driven by the clock, not by the driver's own traffic.

## R2 — What counts as "not moving"

**Decision**: Reuse the platform's existing 50 m displacement threshold
(`AppDistances.locationDisplacementMeters` on the device, `tracking.displacementThresholdMeters` on
the server) as the movement threshold, exposed as its own config key defaulting to that same value.

**Rationale**: This is already the number the platform uses to decide whether a driver's position
has changed enough to be worth recording — the tracking stream discards smaller deltas as noise. If
this feature picked a different number, the platform could simultaneously consider a driver "moving"
for tracking and "stopped" for alerting, which is indefensible when an administrator asks why. It
also solves FR-003/SC-007 (GPS drift) without new logic: drift below 50 m never advanced the
position record before and does not advance `lastMovedAt` now.

**Alternatives considered**:
- *A tighter threshold (e.g. 10 m) specific to stop detection* — rejected; the device never sends
  those fixes in the first place (the client-side gate drops them), so the server would be reasoning
  about data it does not receive.
- *Speed-based detection (`Position.speed` from the GPS)* — rejected; instantaneous speed is noisy
  when stationary, is not currently transmitted over the socket contract, and would need its own
  smoothing — all to answer a question two timestamps already answer.

## R3 — The response window and its escalation

**Decision**: A BullMQ delayed job per raised stop, `jobId = stopEventId`, scheduled when the stop
is raised and cancelled the moment the driver answers — the exact shape of feature 010's
`AssignmentEscalationQueueService`, including a processor that re-reads the order before acting.

**Rationale**: Unlike detection (R1), this timer starts once per stop and is cancelled once, so
there is no thrash; and it needs to survive a restart, which is precisely what feature 010 already
established this pattern for. Reusing it means the durability guarantee comes for free and there is
one scheduling idiom in the codebase, not two.

**Alternatives considered**:
- *Fold the escalation into the same sweep* (raise the alert when `stopRaisedAt` is older than the
  response window) — genuinely viable and one fewer moving part. Rejected narrowly because the sweep
  would then own two different policies with two different clocks, and because the BullMQ path
  cancels precisely on the driver's answer rather than waiting up to a full sweep interval to notice
  it. Worth revisiting if the queue ever proves to be the more troublesome half.

## R4 — Reaching a driver whose app is backgrounded

**Decision**: Add `flutter_local_notifications` and put it behind a `NotificationPresenter` seam in
`lib/core/notifications/`, shaped like the existing `NfcReader`/`PositionReader`/`MapNavigator`
seams. The server emits an ordinary notification to the `user:{driverId}` room (the existing
`notification:new` path, with a new `NotificationType`); the app, already alive in the background
because the location foreground service keeps it so, receives that socket event and raises a
device-level alert.

**Rationale**: This is the only remaining gap between "the platform knows the driver stopped" and
"the driver knows the platform is asking." The app has **no** local-notification package today, so
the current notification path terminates on an in-app list screen a driving driver will never look
at. Crucially, no push provider is needed *because the app is already running* — the foreground
service that FR-018 depends on is what makes a purely local alert sufficient. The seam keeps the
plugin out of the cubit layer and makes the "did we raise an alert" assertion testable without a
real device.

**Alternatives considered**:
- *A real push provider (FCM/APNs)* — rejected for this feature, and deliberately: it is a larger,
  separate concern (credentials, per-platform setup, token lifecycle, a server-side provider
  integration) that this feature does not need, precisely because the app is already awake. It
  remains the right answer for notifications that must reach a driver whose app is *not* running,
  which is a different problem.
- *SMS to the driver* — rejected as the primary channel: it costs per stop, cannot carry a
  structured reason picker, and would arrive even when the driver is looking at the app.

## R5 — Where stop events live

**Decision**: An embedded array `Order.stopEvents`, mirroring `Order.verifications` exactly.

**Rationale**: A stop event is meaningless apart from its delivery, is always read with it, and is
bounded per order (a handful over one journey). `Order.verifications` set this precedent for
per-order event trails, and `Order` already carries the multi-party scoping plugin — so isolation
comes for free rather than needing a new plugin registration. It also structurally enforces the
spec's anti-surveillance boundary: **there is no per-driver stop collection to query**, so a
per-driver stop history cannot be built by accident.

**Alternatives considered**:
- *A standalone `StopEvent` collection* — rejected. It would need its own scoping, and it would make
  "every stop this driver has ever had" a natural query — the exact capability the spec's safety
  framing rules out. The harder thing to build should be the thing we do not want.

## R6 — Concurrency between the sweep and a driver's declaration

**Decision**: Raising a stop is a conditional update guarded on there being no unresolved stop event
for that order (`$not: { $elemMatch: { resolvedAt: null } }`), so the sweep and a driver declaring a
stop at the same instant cannot both create one. FR-016's "at most one unresolved stop per delivery"
is therefore enforced at the write, not by a prior read.

**Rationale**: This is the same discipline the platform already applies to every other
"exactly-one" guarantee (the conditional `findOneAndUpdate` in `assignDriver`, the unique
`activeOrderId` index) — and the same class of bug feature 009 found the hard way, where two
transactions each passed their own read-then-write check.

## R7 — Configuration keys

**Decision**: Four new environment-backed settings via the established three-file pattern
(`configuration.ts` + `validation.ts` + `.env.example`):
`STOP_DETECTION_WINDOW_MINUTES` (default 10, per the spec and the original mock's own wording),
`STOP_DETECTION_MOVEMENT_METERS` (default 50, matching R2),
`STOP_RESPONSE_WINDOW_MINUTES` (default shorter than the stop window — see spec Assumptions), and
`STOP_DETECTION_SWEEP_SECONDS` (default 60, matching `PresenceService`'s own cadence).

**Rationale**: Consistent with every other tunable the platform exposes; the sweep interval in
particular needs to be overridable so tests do not wait a real minute.
