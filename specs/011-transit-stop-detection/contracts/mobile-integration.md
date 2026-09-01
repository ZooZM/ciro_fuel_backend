# Mobile Integration: In-Transit Stop Detection & Driver Check-In

This is the surface with genuinely **new capability** in this feature — everything else extends
existing flows.

## 1. Device-level alerting (the new capability, FR-004a/SC-010)

**The gap**: the app has no local-notification package. Today a `notification:new` socket event
updates in-app state and appears on the notifications list — which a driver holding a steering wheel
will never see. Without closing this, Story 3's escalation fires on nearly every stop, including
from drivers who would gladly have answered.

**What makes a purely local alert sufficient**: the location foreground service (Android) /
background location updates (iOS) that FR-018 depends on already keep the app process — and its
socket — alive for the whole delivery. The event genuinely arrives. Only the *surfacing* is missing.
No push provider is needed, and none is added.

**Shape**: a `NotificationPresenter` seam in `lib/core/notifications/`, matching the existing
`NfcReader` / `PositionReader` / `MapNavigator` seams — an abstract interface plus a
`flutter_local_notifications`-backed implementation registered in DI. The cubit layer depends on the
interface only, so "did we raise an alert for this notification type" is assertable in tests without
a device or a plugin.

```dart
abstract interface class NotificationPresenter {
  Future<void> initialize();            // channel setup (Android) + permission request (iOS)
  Future<bool> ensurePermission();
  Future<void> present({ required String title, required String body, required String payload });
  Stream<String> get taps;              // payload of a tapped alert — routes to the reason prompt
}
```

**Platform specifics that must be handled, not assumed**:
- **Android 13+** requires the runtime `POST_NOTIFICATIONS` permission. The manifest already declares
  it; the runtime request does not exist yet and must be added.
- **Android** requires an explicit notification **channel** with high importance, created at init —
  a notification posted without one is silently dropped on modern Android, which is exactly the kind
  of failure that passes review and fails in the field.
- **iOS** requires `UNUserNotificationCenter` authorization (alert + sound). `Info.plist` already
  carries the background-location keys; notification authorization is separate and is not yet
  requested anywhere.
- **Permission refusal is a real state.** A driver who denies notifications cannot be prompted —
  the platform-side escalation (Story 3) is what covers that case, and the app must not pretend the
  alert was delivered.

## 2. Where the alert is raised

The app already listens to `notification:new` (`DeliveryListener` / `NotificationsCubit`). This
feature adds: on a notification of type `DRIVER_STOP_DETECTED`, call
`NotificationPresenter.present(...)` with the stop's `orderId`/`stopId` as payload. Tapping it opens
the reason prompt for that specific stop.

Handler attachment follows the rule spec 007 established and this codebase has been bitten by
before (`mobile_app/CLAUDE.md` debt #6): attach **after** `trackingSocket.connect()` resolves, never
in a constructor — a handler registered before the socket exists is a silent no-op.

## 3. Answering a prompt

A new screen/sheet showing the fixed `StopReason` list as one-tap choices, plus a free-text field
revealed only for `OTHER`. Submits to `POST /orders/:id/stops/:stopId/reason`
(contracts/rest-api-delta.md §2). SC-003 (a common reason in under 15 seconds, no typing) is a
design constraint on this screen, not a stretch goal: the reason list is the primary control, not
hidden behind a dropdown.

## 4. Declaring a stop proactively

An action available on the active-delivery screen while `IN_TRANSIT`: the same reason list plus a
duration picker, submitting to `POST /orders/:id/stops/declare`. Offered only in `IN_TRANSIT` —
declaring a stop during loading or unloading is meaningless (FR-002).

## 5. Clean Architecture placement

Following the existing `features/delivery/` layering exactly: two new use cases
(`DeclareStop`, `SubmitStopReason`) → repository interface → remote data source, each mirroring
`MarkArrived`'s shape; registered in `lib/core/di/injector.dart` alongside the other delivery use
cases. The `NotificationPresenter` is core infrastructure, not a delivery-feature concern, hence
`lib/core/notifications/`.

## 6. Not touched

- The location stream itself. `LocationStreamService` and `LocationEmitGate` are unchanged — this
  feature reads the consequences of what they already send. FR-018 is a **verify-it-still-holds**
  requirement here, not new work: Android foreground service + wake lock and iOS
  `allowBackgroundLocationUpdates` with `automotiveNavigation` are already configured.
- The customer-facing app surfaces. A client never sees stop events at all
  (contracts/rest-api-delta.md §4).
