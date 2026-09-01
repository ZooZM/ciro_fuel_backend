# Realtime Contract: In-Transit Stop Detection & Driver Check-In

## Unchanged: the location stream itself

`location:update` (device → server) and `order:location` (server → order room) are **not modified**.
The device sends what it always sent; the tracking map receives what it always received. This
feature only adds bookkeeping alongside the server's existing accepted-fix handling.

## Server-side addition to `location:update` handling

Inside `tracking.gateway.ts`'s existing accepted-fix branch — the one that already writes
`location`/`locationUpdatedAt` — add: if the new fix is farther than
`STOP_DETECTION_MOVEMENT_METERS` from `lastMovedLocation`, also write `lastMovedAt` and
`lastMovedLocation`.

Two properties this must preserve:

1. **A heartbeat from a parked truck advances `lastSeenAt` but never `lastMovedAt`.** This is the
   whole basis of FR-017 — presence and movement become separately observable, so "reporting the
   same position" and "reporting nothing" are distinguishable by construction.
2. **Displacement is measured against `lastMovedLocation`, not `location`.** Measuring against
   `location` (which every accepted fix updates) would let a parked truck drift past the threshold in
   sub-threshold increments and read as moving. The existing `haversineDistanceMeters` helper already
   in this file does the arithmetic.

This is a field write on a document the handler is already updating — no extra round-trip.

## Notifications (existing transport, new types)

Both new notification types ride the existing `NotificationsService.notify` path — a stored
`Notification` document plus a `notification:new` emit to the `user:{id}` room. No new socket event
is introduced.

| Type | Room | Payload | Consumer |
|---|---|---|---|
| `DRIVER_STOP_DETECTED` | `user:{driverId}` | `orderId`, `stopId` | Driver app raises a **device-level** alert (contracts/mobile-integration.md §1); tapping opens the reason prompt for that stop |
| `ORDER_STOP_UNRESOLVED` | `user:{adminId}` | `orderId`, `stopId` | Transport admin's in-app notifications; the order detail's `StopAlertCard` is the substantive surface |

**Why the driver's notification reaches a backgrounded app at all**: the location foreground service
(Android) / background location updates (iOS) keep the process — and therefore the socket — alive
for the duration of a delivery. The socket event genuinely arrives; what the app previously lacked
was any way to *surface* it. That gap is what `NotificationPresenter` closes, and it is why no push
provider is required here.

**What this does not survive**: a driver who force-quits the app, or an OS that reclaims the process
anyway. In that case no alert is raised, the driver never answers, and the response-window
escalation reaches the transporter instead — which is the designed fallback, not a failure of it.

## Transport admin: no live connection added

The transport dashboard learns about stop events through the order detail's existing background
refresh (contracts/dashboard-integration.md §3), not a socket subscription. Feature 009's
constraint stands: one live connection per session, reserved for the truck's position.
