# Mobile Integration Contract — Feature 013

**Root**: `mobile_app/` · **Personas**: `DRIVER` (scope) and `CLIENT` (must not regress, except pushes)

Read `mobile_app/CLAUDE.md` §1 (where code goes) and §6 (conventions) first. This document covers only
what this feature changes.

---

## 1. `core/realtime/tracking_socket.dart` — the handler registry (Slice 0, lands alone)

### The defect

```dart
void onStatus(void Function(Map<String, dynamic>) handler) =>
    _socket?.on(SocketEvents.orderStatus, ...);   // _socket is null before connect()
```

Every `on*` is null-safe. Registering before `connect()` resolves **succeeds silently and subscribes to
nothing**. This is mobile debt #6 and the reason no notification push has ever reached either persona.

`connect()` also constructs a **new** `io.Socket` on every call, so handlers bound to a previous socket
are orphaned; `reauthenticate()` reuses the existing object, so it does not have this problem. Today the
sign-out/sign-in path only works because the DI stream listener happens to rebuild the listener objects
each time.

### The fix

`TrackingSocket` holds `List<(String event, Function handler)>`.

- `on*` appends to the registry, and attaches immediately if `_socket != null`.
- `connect()` attaches the entire registry to the socket it creates.
- `dispose()` clears both.

### What this retires

`SessionRevocationListener` and `DeliveryListener` exist *because* of this defect — both are external
classes whose only reason for being is that `attach()` can be called after `await connect()`. Their
`attach()`-after-connect discipline is no longer load-bearing.

**Do not delete them in Slice 0.** They are correct either way, their comments are the record of why the
pattern existed, and deleting them mixes a refactor into the one slice that must be attributable. Slice
0's diff is `tracking_socket.dart` plus its test.

### Exit criteria

- A test registers a handler **before** `connect()` and proves it fires after.
- A test proves handlers survive a `connect()` → `dispose()` → `connect()` cycle.
- `flutter test` at its documented count, with **exactly** the two known non-green tests
  (`login_screen_golden_test` pixel diff, `auth_session_test` `skip: true`) and no third.

---

## 2. `shared/` — stop events

### New: `shared/enums/stop_origin.dart`

`detected` · `declared` · `blocked`, with `fromWire`/`toWire` in that one file (no-magic-values rule).

### New: `shared/entities/stop_event.dart` (freezed + json_serializable)

Fields per `data-model.md` §4. Two carry meaning through **absence** and must stay nullable:
`reasonGivenAt` (absent ⇔ unanswered) and `resolvedAt` (absent ⇔ unresolved). Do not default either.

### Changed: `shared/entities/order.dart`

```dart
@Default(<StopEvent>[]) List<StopEvent> stopEvents,
```

**The default is required for the client persona, not for tidiness.** `toRoleScopedShape` deletes
`stopEvents` entirely from a `CLIENT`'s response, and both personas share this one entity and one
parsing path. A non-nullable field without a default makes every client order fail to parse — a
client-persona regression introduced by a driver feature, which is precisely what FR-042 forbids.

Run `dart run build_runner build` after touching either file. Never edit `*.freezed.dart` / `*.g.dart`.

---

## 3. `features/delivery/` — continuity (Slice 2)

### The outstanding-stop derivation

```dart
StopEvent? get outstandingStop => stopEvents
    .where((s) => s.resolvedAt == null && s.reasonGivenAt == null)
    .firstOrNull;
```

**Both clauses.** `resolvedAt == null` alone re-asks a stop the driver already answered;
`reasonGivenAt == null` alone re-asks one an administrator already closed. A `DECLARED` stop arrives
with both set and correctly never qualifies.

This mirrors the platform's own `unblockedStopFilter` rather than approximating it. A disagreement
between the two is invisible from either side — the app asks about a stop the platform considers
closed, or stays silent on one whose escalation timer is running.

### Where it renders

`delivery_detail_screen.dart` shows the outstanding question and opens the existing
`showStopReasonSheet(context, orderId:, stopId:)`. The sheet is unchanged — `StopAlertRouter` already
opens it from a notification tap, and this is a second entry point to the same sheet, not a second
sheet.

### The untracked indicator

`DeliveryActive.streaming` is computed by `DeliveryCubit.load()` and read by **nothing** — a grep across
`lib/` finds only its declaration. Render it: when `false`, the delivery screen states that the delivery
is not being tracked and what to do about it (FR-011).

---

## 4. `features/delivery/presentation/view/driver_notifications_screen.dart` — rewritten (Slice 3)

Currently a `StatelessWidget` with hardcoded rows (`ORD-2024-256`, "5 mins ago") and no cubit.

- Consume the app-wide `NotificationsCubit` already provided in `app.dart` — the same one the driver's
  own nav-bar badge reads. Do **not** add a second notifications stack; that is debt #2's mistake.
- **Use the client's own `notifications_screen.dart` as the working reference.** It already renders this
  cubit with per-type presentation, distinct loading/empty/error states, and `loadMore()` on scroll. The
  driver screen is a re-skin against the same cubit, not a new stack.
- Reuse `features/notifications/presentation/constants/notification_presentation.dart` for per-type
  presentation; add the new blocked type there rather than branching in the widget.
- **Delete the three category tabs** (All / Orders / System) and their translation keys. Only
  `ORDER_ASSIGNED` and `DRIVER_STOP_DETECTED` reach a driver, both order-related — "System" can never
  match and "Orders" equals "All" (research R7).
- **Offer All / Unread instead** — `GET /notifications?unread=true`, already supported by the repository
  and already offered on the client screen, which deleted the identical mock chips for the identical
  reason (research R7a). The two personas then filter the same way rather than this feature inventing a
  third answer.
- Wire "mark all read" to the new endpoint (`rest-api-delta.md` §2).
- **FR-032 needs no new capability**: `NotificationsCubit` already implements cursor pagination via
  `loadMore()`. The screen just has to call it.
- Loading / empty / failure states are distinct and stated; no sample content in any of them.

The client's `NotificationsScreen` is **not** touched. Both now receive live pushes as a consequence of
Slice 0.

---

## 5. `features/delivery/presentation/widgets/driver_navigation_bottom_sheet.dart` — the report (Slice 4)

`onPressed: () {}` at the "I cannot reach" button becomes a reason picker followed by
`POST /orders/:id/stops/blocked` through a use case and the delivery repository — never a direct
datasource call from the widget (Constitution IV).

Offer the applicable subset of `StopReason` (`ROAD_CLOSURE`, `ACCIDENT`, `VEHICLE_PROBLEM`, `OTHER`)
rather than all seven; the wire vocabulary is unchanged, so the dashboard renders what the driver picked
with no new mapping (research R5).

`409 STOP_ALREADY_OPEN` is a **stated outcome, not a crash**: the delivery already carries an open stop,
and the driver is told so.

---

## 6. `features/profile/presentation/view/driver_profile_screen.dart` — identity (Slice 5)

Lines 264 and 273 render `driver_mock_profile.driver_name_mohamed` and
`driver_mock_profile.station_alhamd` — a fabricated name and a **station**, which is a `CLIENT` concept.

Resolve `ProfileCubit` via `getIt<ProfileCubit>(param1: userId)..load()`, exactly as
`DriverProfileDetailsScreen` (spec 006) already does on the sibling screen. Its loading / loaded /
failure states satisfy FR-035 with no new capability.

**Delete both mock translation keys from `assets/translations/` and `translation_keys.dart`**, so
nothing can quietly re-adopt them.

Also in this slice: the inert `onTap: () {}` on the about entry (show the real running version), the
`// TODO: Update to driver terms` on the terms entry, the inert map controls in
`driver_navigation_screen.dart` (and its live-map pretence), and `SupportCallButton(onTap: () {})` —
which is on a **shared** screen, so verify the client's own support screen with it.

---

## 7. Testing

`flutter test` — headless, scripted Dio adapters, mocked sockets. Register feature DI through
`test/support/orders_test_di.dart`; reset in `tearDown`.

| Slice | Must prove |
|---|---|
| 0 | A handler registered before `connect()` fires after it; handlers survive a reconnect cycle |
| 2 | `outstandingStop` is null for declared, answered and resolved stops, and non-null only for the answerable one; a client order with **no** `stopEvents` key parses |
| 2 | `streaming: false` renders the untracked state |
| 3 | The list renders from the cubit; unknown types render neutrally; no fabricated row survives anywhere in the widget tree |
| 4 | A `409` renders as a stated message, not a failure screen |
| 5 | Two drivers in succession — none of the first's details survive |

**Baseline discipline**: exactly two known non-green tests, and the count must still be exactly two.
Confirm it rather than assuming — `mobile_app/CLAUDE.md` §7 records that an earlier count of three was
wrong.
