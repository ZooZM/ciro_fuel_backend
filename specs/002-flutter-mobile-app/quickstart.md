# Quickstart: Client & Driver Mobile Application

Run and verify the Flutter app against the running NestJS backend (feature `001`).

## Prerequisites

- Flutter 3.24+ (stable), Dart 3.5+ — `flutter doctor` clean for iOS and/or Android.
- The backend running and reachable (see `specs/001-fuel-delivery-platform/quickstart.md`), with a replica-set MongoDB and Redis up.
- A Google Maps API key (Android + iOS).
- Seed accounts: one CLIENT and one DRIVER in the same company, plus a truck linked to the driver.

## Setup

```bash
cd mobile_app
flutter pub get
dart run build_runner build --delete-conflicting-outputs   # freezed / json_serializable
```

## Configuration (no secrets committed)

Pass config via `--dart-define` (consumed by `lib/core/config/env.dart`):

```bash
flutter run \
  --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1 \
  --dart-define=WS_BASE_URL=http://10.0.2.2:3000 \
  --dart-define=GOOGLE_MAPS_API_KEY=... 
```

- Android emulator reaches host via `10.0.2.2`; iOS simulator via `localhost`.
- The Maps key also goes in `AndroidManifest.xml` / `AppDelegate` per `google_maps_flutter` setup.

## Verify — US1 (auth & silent refresh)

1. Sign in as CLIENT → lands on `/client`. Kill and reopen the app → still signed in (session restored). ✅ SC-001.
2. Shorten backend access-token TTL (or wait for expiry), perform any authenticated action → it succeeds with no visible error; observe exactly one `POST /auth/refresh` in the backend log. ✅ SC-002, FR-004/005.
3. Revoke the refresh token server-side → next action routes to `/login` once (no retry storm). ✅ FR-006.

## Verify — US2 (client order → payment → tracking)

1. Create an order (fuel type + quantity) → appears as `pendingApproval`.
2. As COMPANY_ADMIN (backend/web), set final price + approve → app shows price and payment-window countdown.
3. Pay via the native gateway; leave payment to the webhook → order flips to `inTransit` **only** after backend state changes (not asserted locally). ✅ R3/R7.
4. With the driver streaming, watch the marker move on the Google Map within ≤ 10 s of each update. ✅ SC-003.
5. On arrival, the arrival code appears **only** on the CLIENT screen. ✅ FR-012.

## Verify — US3 (driver delivery execution)

1. Sign in as DRIVER with an assigned in-transit order → job shown; location stream starts (foreground-service notification on Android).
2. Move the device (or mock location) — confirm `location:update` emits only past **> 50 m or ≥ 3 min**, not per second. ✅ SC-004.
3. Background the app mid-trip → stream continues; foreground again → uninterrupted. ✅ FR-024.
4. Enter the CLIENT's arrival code → advances to `unloading`; a wrong code is rejected; 6 wrong attempts → throttled with cooldown. ✅ FR-016/017.
5. Enter the delivery code → `delivered`; stream stops; driver freed.

## Verify — US4 (resilience & notifications)

1. Toggle airplane mode briefly during tracking → socket auto-reconnects within ~15 s and updates resume. ✅ SC-007.
2. Stop the driver heartbeat → watcher marks the position **stale** rather than fresh. ✅ FR-021.
3. Trigger a notifiable backend event (e.g., payment timeout) → correct persona receives an in-app `notification:new`. ✅ FR-022.

## Tests

```bash
flutter test                              # unit (interceptor single-flight, Failure map, OTP/state guards) + widget + bloc_test
flutter test integration_test             # US2 and US3 end-to-end against a test backend
```
