# Mobile Integration Contract: NFC Truck Verification & Warehouse Loading

**Feature**: 008-nfc-truck-loading | **Phase**: 1

What the Flutter app must do, and — as importantly — what it must **not** contain. Several
requirements here are absences, which is why each names the test that guards it.

---

## 1. NFC enters through a port, not a package

**Constitution IV**: the domain layer stays framework-independent. `nfc_manager` must never be
imported outside `core/nfc/`.

```
lib/core/nfc/
├── nfc_reader.dart              # abstract port — domain-safe
└── nfc_manager_reader.dart      # concrete adapter, the ONLY nfc_manager import
```

```dart
/// Reads the identifier of a 13.56 MHz card. Never parses NDEF, never writes.
/// The identifier is opaque — the app compares nothing and decides nothing;
/// the platform resolves it (FR-022).
abstract interface class NfcReader {
  /// False when the device has no NFC hardware or it is switched off.
  /// Drives whether the QR fallback is presented as the primary path (FR-036a).
  Future<bool> isAvailable();

  /// Resolves with the tag identifier, or a failure. Never throws to the caller.
  Future<Either<Failure, String>> readTagId();

  Future<void> stopSession();
}
```

Registered in `injector.dart` as a lazy singleton, mirroring how `PhoneDialer` isolates
`url_launcher` and `SmsSender` isolates its transport.

**Platform reality** (research R5): Android reads identifiers freely. iOS needs a paid-account
entitlement, shows a system sheet per scan, and cannot reliably read MIFARE Classic at all. So
`isAvailable()` returning `false` is a **normal, expected state on iOS**, not an error — the QR path
is what makes the feature work there.

**Manifest/entitlement work**
- Android: `<uses-permission android:name="android.permission.NFC"/>` plus
  `<uses-feature android:name="android.hardware.nfc" android:required="false"/>` — `required="false"`
  so devices without the hardware can still install and use the QR path.
- iOS: `com.apple.developer.nfc.readersession.formats` entitlement +
  `NFCReaderUsageDescription` in `Info.plist`.

---

## 2. QR: live camera only — an absence to be enforced

**FR-036i/j**: a code may only be presented through the app's own live camera preview.

Use the existing `MobileScanner` widget with its `onDetect` callback — the same component
`driver_scan_screen.dart` already uses for the customer handover code. It has no image-analysis
entry point, so the widget itself cannot be fed a stored image.

**What must not exist anywhere in the verification flow:**
- any `image_picker` call
- any gallery or file-picker path
- any share/intent handler that accepts an image
- any "upload a photo of the code" affordance

> ⚠️ `image_picker` **is already a dependency** (profile pictures use it). This is therefore a real
> discipline, not an impossibility — which is exactly why it needs a guarding test rather than a
> comment.

**Guarding test**: a static assertion that no file under the verification flow imports
`image_picker`, in the same spirit as spec 007's audit for forbidden OTP-endpoint calls.

---

## 3. Verification cubit

```
features/delivery/presentation/cubit/vehicle_verification_cubit.dart
features/delivery/presentation/cubit/vehicle_verification_state.dart   # freezed
```

```dart
sealed class VehicleVerificationState {
  const factory VehicleVerificationState.idle({required bool nfcAvailable}) = …;
  const factory VehicleVerificationState.reading() = …;        // NFC session / camera open
  const factory VehicleVerificationState.submitting() = …;     // platform deciding
  const factory VehicleVerificationState.verified(OrderStatus newStatus) = …;
  const factory VehicleVerificationState.mismatch() = …;       // VEHICLE_MISMATCH — retryable
  const factory VehicleVerificationState.notAtWarehouse({double? distanceMeters}) = …;
  const factory VehicleVerificationState.locationUnavailable() = …;
  const factory VehicleVerificationState.throttled({Duration? retryAfter}) = …;
  const factory VehicleVerificationState.failure(Failure failure) = …;
}
```

**Registration**: `registerFactoryParam<VehicleVerificationCubit, String, void>` keyed by orderId —
same lifecycle as `OtpVerifyCubit`, which this sits beside.

**Rules**
- The cubit **never** decides whether a credential matches (FR-022). It submits and reflects.
- It never holds a credential in state — the value exists only as a method parameter, exactly as
  `OtpVerifyCubit` handles OTP codes (FR-042).
- No offline queue, no retry buffer, no persistence of an attempt (FR-021a). A failed submit is a
  failed attempt; the driver retries with signal.
- Every submit carries a **one-shot position fix** taken at the moment of the read, via a
  `PositionReader` seam (`core/location/`) in the same shape as `NfcReader` — no `geolocator`
  import near the cubit, and a test substitutes the interface. Distinct from
  `LocationStreamService`, which pushes a throttled *stream* for the customer's map; the geofence
  is never evaluated against that (FR-030c).
- A device that cannot produce a fix does **not** short-circuit locally. The request goes out
  without one and the platform decides whether this stage needed it — guessing the stage in order
  to refuse early would re-introduce exactly the client-side judgement R7 removed.

---

## 4. Distinguishable refusals

FR-037 and SC-010 require a driver to tell the causes apart without contacting support. These are
**codes**, never message strings:

| Cause | Signal | Copy direction |
|---|---|---|
| Not verified yet | order still `ASSIGNED_TO_DRIVER`, no attempt made | "Tap the card on your truck to start" |
| Wrong vehicle | `VEHICLE_MISMATCH` (403) | "That isn't the vehicle assigned to this delivery" |
| Not at the depot yet | `NOT_AT_WAREHOUSE` (403) | "You're 4.3 km from the loading depot — tap again when you arrive" |
| Location unavailable | `LOCATION_REQUIRED` (400) | "Location is off, so loading can't be verified — turn it on and try again" |
| Platform unreachable | `NetworkFailure` | "Couldn't reach the platform — nothing has changed" |

The last must make clear **nothing was recorded** (FR-021) — a driver who thinks a failed attempt
counted will not retry.

Rows three and four are the two that must never be worded like row two. Each sends the driver to a
different remedy — drive further, change a phone setting, or find the right truck — and a driver
told "wrong vehicle" while standing beside the right one will go looking for a problem that isn't
there. `distanceMeters` rides on the `NOT_AT_WAREHOUSE` body so the copy can carry a number;
below 100 m it is dropped, since that is inside GPS's own error bar.

---

## 5. `OrderStatus.loading` — the compile-error surface

Adding `loading` to the Dart enum makes every exhaustive switch a **compile error** until handled.
That is the cheapest way to find them, and the reason FR-046c is achievable at all.

| File | Member | Treatment |
|---|---|---|
| `order_presentation.dart` | `statusLabel` | new key `order_status.loading` |
| | `statusColor` | groups with `inTransit` (blue — moving) |
| | `flowStep` | `OrderFlowStep.loading` — the timeline step that already exists by that name |
| | `statusProgress` | between `assignedToDriver` (0.5) and `inTransit` (0.75) → **0.62** |
| | `cardKindFor` | `OrderCardKind.inTransit` — the customer sees an active delivery |
| | `isTrackable` | **false** — the driver is heading to a depot, not to the customer |
| `OrderFilter.inDelivery` | | add `loading` alongside `inTransit`/`unloading` |
| driver "In progress" tab | | add `loading` |

**`isTrackable` is the subtle one.** It currently returns true only for `inTransit`, and the client's
tracking map plots the driver's position against *their own station*. During loading the truck is
driving to a warehouse — plotting that as progress toward the customer would be actively misleading,
so loading is deliberately not trackable.

---

## 6. Driver screens

### Active delivery (`driver_home_screen.dart`, `delivery_detail_screen.dart`)

- **`ASSIGNED_TO_DRIVER`** — the delivery is present but not started. Primary action: *Verify
  vehicle*. Every later action unavailable (FR-020).
- **`LOADING`** — destination is the **warehouse**, from `warehouseSummary`, with a *Navigate to the
  depot* action that hands the coordinates to the platform's own maps app via a `MapNavigator` seam
  (`core/utils/`, same shape as `PhoneDialer`) — the address alone is something to read, not
  somewhere to go, and the driver must physically arrive before the loading verification will pass
  its geofence (FR-027/FR-030a). Navigation is always by coordinate, never by searching the depot's
  name. Actions: *Verify vehicle* (loading stage), then *Confirm loading complete*.
- **`IN_TRANSIT`** onward — unchanged from spec 007.

**Tank details** (FR-033a/b): the assigned tank's code and material are shown from assignment
onward, not only after loading. Reads `tankSummary` off the order — no separate fetch.

### Verification screen

Presents whichever methods are available:
- `nfcAvailable == true` → tap-card primary, scan-code secondary.
- `nfcAvailable == false` → scan-code only, with a plain explanation rather than a broken button.

**No numeric input exists anywhere in the loading flow** (FR-028). The confirm action is a button,
not a form. Guarded by a widget test asserting no `TextField` in that flow (SC-005a).

---

## 7. New error codes

Added to `core/network/error_codes.dart` **and** `_knownCodes` in `error_interceptor.dart` — a code
absent from `_knownCodes` is discarded and arrives as a generic failure, which would collapse
FR-037's three causes into one.

```dart
static const String vehicleMismatch      = 'VEHICLE_MISMATCH';
static const String vehicleNotVerified   = 'VEHICLE_NOT_VERIFIED';
static const String truckUnavailable     = 'TRUCK_UNAVAILABLE';
static const String tankUnavailable      = 'TANK_UNAVAILABLE';
static const String noWarehouseForGrade  = 'NO_WAREHOUSE_FOR_GRADE';
```

---

## 8. Realtime

No new socket events. A verification or loading confirmation transitions the order, which already
emits `order:status` — including to `user:{driverId}`, the dual-emit spec 007 added because a driver
cannot join the order room. `DeliveryListener` already reloads the active delivery on that event, so
a stage change reaches the driver's screen with no new wiring.

---

## 9. Localisation

New keys under `driver_verification.*` and `order_status.loading`, in **both** `en.json` and
`ar.json`. Arabic is the default locale and RTL is the default direction, so the verification screen
and the tank-details row join the RTL sweep (spec FR-043's sibling practice from spec 006/007, where
that sweep found two real overflow bugs).

---

## 10. What must NOT appear in the app

A checklist, because each is a requirement expressed as an absence:

| Forbidden | Requirement | Guard |
|---|---|---|
| Any quantity/volume input in the loading flow | FR-028 | widget test: no `TextField` in that flow |
| Any image-derived QR path | FR-036i/j | static test: no `image_picker` import under the verification flow |
| Displaying a card identifier or QR token | FR-042 | code review + no field in the mobile `Order` entity to hold one |
| Client-side match decisions | FR-022 | the cubit has no comparison logic; it submits and reflects |
| Offline queue or retry buffer for attempts | FR-021a | no persistence in the cubit; test asserts a failed submit leaves state unchanged |
