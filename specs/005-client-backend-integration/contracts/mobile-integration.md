# Mobile Integration Contract — Feature 005

**Feature**: `005-client-backend-integration` | **Date**: 2026-08-15

What each client screen must consume, and what must be deleted. The binding rule throughout: the
data layer already exists (research R9) — this is a **mounting** exercise, not a rewrite. Any task
that reimplements a repository, use case or cubit that is already registered in
`lib/core/di/injector.dart` has misread the codebase.

Paths are relative to `mobile_app/`.

---

## Screen-by-screen wiring

| Screen | File | Today | Must consume |
|---|---|---|---|
| Orders list | `lib/features/orders/presentation/view/orders_list_screen.dart` | Hardcoded `_MockOrder` array | `OrdersCubit` (exists), paginated |
| Order detail | `.../view/order_detail_screen.dart` | `MockOrderState` enum | `OrderDetailCubit` (exists) |
| Track order | `.../view/track_order_screen.dart` | Static | `TrackingCubit` (exists) + `OrderDetailCubit` |
| Create order | `.../view/create_order_screen.dart` | Fixed grades, stations, price | `POST /orders/quote`, `GET /stations`, `GET /companies/:id/fuel-prices` |
| Invoice payment | `.../view/invoice_payment_screen.dart` | `MockOrderState.paid` | `PaymentCubit` (exists) |
| Invoices | `lib/features/invoices/presentation/view/client_invoices_screen.dart` | Static | `FinanceCubit` (exists), paginated |
| Payments | `lib/features/payments/presentation/view/client_payments_screen.dart` | Hardcoded `'ORD-2024-256'` | **New** `PaymentsCubit` → `GET /payments` |
| Credit limit | `lib/features/more/presentation/view/client_credit_limit_screen.dart` | Static | **New** `CreditCubit` → `GET /users/me/credit` |
| Stations | `lib/features/stations/presentation/view/client_stations_screen.dart` | Fully hardcoded | **New** `StationsCubit` → `GET /stations` |
| Profile | `lib/features/profile/presentation/view/profile_screen.dart` | Static | **New** `ProfileCubit` → `GET/PATCH /users/:id` |
| Change phone | `.../view/change_phone_screen.dart` | Static | **New** `PhoneVerificationCubit` |
| Verify phone | `.../view/verify_phone_screen.dart` | Static | `PhoneVerificationCubit` |
| Support | `lib/features/support/presentation/view/support_screen.dart` | Static topics | **New** `SupportCubit` → `POST/GET /support/requests` |
| Home | `lib/features/home/presentation/view/client_home_screen.dart` | Mostly live | Fix badge count, "change station", "contact driver" |
| Notifications | `lib/features/notifications/presentation/view/notifications_screen.dart` | Static | `NotificationsCubit` (exists), paginated |

Six screens need a new cubit. Nine need an existing one mounted.

---

## Deletions

These are requirements (FR-002), not cleanup:

- `lib/features/orders/presentation/constants/order_mock_data.dart` — delete.
- `lib/features/orders/presentation/widgets/order_detail/mock_order_state.dart` — delete, along
  with the `MockOrderState` re-export at `order_detail_screen.dart:22` and the `state.extra`
  branch in `app_router.dart:158–160`.
- `kFavouriteStations` and `kStationOptions` in
  `.../widgets/create_order/create_order_data.dart` — delete.
- `kOrderCounterQuantities` / `kOrderQuantities` — replace with platform-supplied capacities
  (FR-017).
- `lib/features/auth/presentation/view/role_selection_mock_screen.dart` — verify it is unreachable
  in a release build; remove its route if it is not.

A build-time check that no `mock` identifier is reachable from a client route is the only reliable
way to hold FR-002 over time. Grep in CI is sufficient and cheap.

---

## Status card selection

`MockOrderState` does **not** map one-to-one onto `OrderStatus` (research R9). `deferred` is a
payment method; `failedPayment` is a status plus an event. Replace it with a pure function:

```dart
OrderCardKind cardKindFor(OrderStatus status, PaymentMethod method)
```

Implemented as an exhaustive `switch` over `OrderStatus`, consulting `method` only where the
status genuinely does not disambiguate (`pendingPayment` under DEFERRED/CREDIT never shows a pay
action). Dart's exhaustiveness checking makes a missed status a compile error rather than a blank
card — which is the reason to write it as one switch rather than a chain of `if`s.

---

## Pagination in cubit state

Every paginated list changes shape. Using orders as the pattern:

```dart
OrdersLoaded(
  List<Order> orders,
  String? nextCursor,      // null == end of list
  bool isLoadingMore,
  bool loadMoreFailed,     // distinct from the initial-load failure state
)
```

`loadMoreFailed` is separate from `OrdersLoadFailure` on purpose: FR-048e requires a failed page
to leave already-loaded pages on screen with a retry, which a single failure state cannot express.

Cubit gains `loadMore()` (no-op when `nextCursor` is null or a load is in flight) and `refresh()`
(discards the cursor, refetches page one — FR-048g).

Filter changes go through the cubit and reset the cursor. **The app must never filter a loaded
list client-side** (FR-048d) — a filter applied to 40 loaded rows silently means "matches among
what I happen to hold".

This invalidates the existing `orders_state.dart` Freezed file and its cubit tests. Both are
updated, not deleted.

---

## Caching (FR-047)

`get_it` registers list cubits as factories, so navigation refetches. Register `OrdersCubit`,
`FinanceCubit`, `NotificationsCubit` and `StationsCubit` as lazy singletons scoped to the client
shell, reset on sign-out. That satisfies FR-047 without introducing a cache layer — nothing here
needs one.

Sign-out must reset them. A singleton cubit holding the previous user's orders across an account
switch is a data-leak bug that no test will catch unless one is written for it.

---

## New data-layer components

Following the existing Clean Architecture layout exactly (`data/datasources`,
`data/repositories`, `domain/repositories`, `domain/usecases`, `presentation/cubit`):

- `features/stations/` — full stack, new
- `features/payments/` — data + domain, new (presentation exists)
- `features/support/` — data + domain, new (presentation exists)
- `features/profile/` — data + domain, new (presentation exists)
- `features/orders/` — add quote datasource + use case to the existing stack

Domain layers stay framework-independent behind abstract interfaces (Principle IV). All network
access goes through repositories with structured error parsing — including the new error codes in
§10 of the REST delta, each of which needs a typed failure and a translated message in both
`ar` and `en`.

---

## Error handling

`QUOTE_STALE` is the one error with real UX: the response carries the new breakdown, and the app
must show it and ask the client to confirm again — never silently adopt either figure.

`PRICING_NOT_CONFIGURED`, `PHONE_IN_USE`, `SMS_SEND_FAILED` and `LAST_STATION` each need an
Arabic and English message. They route through the existing `error_interceptor.dart`; no new
error path is introduced (Principle III).

**403/404 must not trigger a token refresh.** `auth_interceptor.dart` already implements
single-flight refresh on 401 only — verify this holds for the new endpoints rather than assuming
it (FR-043).

---

## Localisation

Every new string goes in `assets/translations/{ar,en}.json` with a key in
`lib/core/localization/translation_keys.dart` — no literal in a widget (Principle I). Arabic is
the default and RTL must be verified on each newly connected screen (FR-044), including
platform-supplied text such as station names and support topics.

Currency follows the existing `NumberFormatting.currency` helper, which already handles
per-locale numerals (FR-029).
