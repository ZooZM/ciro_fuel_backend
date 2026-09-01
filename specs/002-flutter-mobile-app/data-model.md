# Phase 1 Data Model: Client & Driver Mobile Application

Client-side domain entities (framework-free, in `lib/shared/entities` and each feature's `domain/entities`) plus the Cubit state shapes. All types are `freezed`-immutable; all meaningful literals are enums (Principle I). The app mirrors backend data read-only — no local persistence beyond the secure session (Principle V / research R7).

## Enums (`lib/shared/enums`)

```dart
enum UserRole { superAdmin, companyAdmin, client, driver }        // maps to backend SUPER_ADMIN…

enum OrderStatus {                                                // 7 sequential + 2 terminal
  pendingApproval, approved, assignedToDriver, pendingPayment,
  inTransit, unloading, delivered, rejected, cancelled,
}

enum OtpPurpose { arrival, delivery }

enum NotificationType { finalPriceReady, paymentTimeout, noEligibleDriver, deliveryCompleted }

enum FuelType { diesel, gasoline91, gasoline95 }                  // mirror backend fuel catalog
```

`OrderStatus`, `UserRole`, `OtpPurpose`, `NotificationType` each expose `fromWire(String)` / `toWire()` mappers — the only place backend string values live.

## Entities

### Session (`core` / auth domain)
| Field | Type | Notes |
|-------|------|-------|
| accessToken | String | secure storage; injected as Bearer |
| refreshToken | String | secure storage; used by single-flight refresh |
| user | AuthUser | derived identity |

Persisted encrypted; cleared on unrecoverable refresh (FR-006). Not JSON-logged.

### AuthUser (`shared/entities`)
| Field | Type | Notes |
|-------|------|-------|
| id | String | |
| role | UserRole | selects CLIENT vs DRIVER experience (FR-026) |
| companyId | String | tenant scope; derived from JWT, never client-set (Principle II) |
| fullName | String | |

### Order (`shared/entities`)
| Field | Type | Notes |
|-------|------|-------|
| id | String | |
| status | OrderStatus | authoritative from backend only (R7) |
| fuelType | FuelType | |
| quantityLiters | int | |
| estimatedPrice | Money? | pre-approval estimate returned on create (`POST /orders`) |
| finalPrice | Money? | null until COMPANY_ADMIN approves; drives payment amount (FR-010) |
| paymentReference | String? | gateway reference for the native SDK, if surfaced by backend `GET /orders/:id` (open dependency — see plan) |
| paymentWindowEndsAt | DateTime? | drives countdown; backend timestamp (Assumptions) |
| assignedDriverId | String? | |
| destination | GeoPoint | delivery location |
| lastKnownLocation | LocationSample? | latest `order:location` |
| statusChangedAt | DateTime | reconciliation key (R7) |

**Validation (client-side, pre-submit only; backend re-validates):** `quantityLiters > 0`; `fuelType` in catalog. Server is authoritative — client validation is UX, never a security control.

**Client view of the state machine (read-only, for enabling actions — see `contracts/ui-state-contract.md`):**
`pendingApproval → approved → assignedToDriver → pendingPayment → inTransit → unloading → delivered`, plus `pendingPayment → approved` (payment lapse), `pendingApproval → rejected`, and `→ cancelled`. The client renders these; it never commits them.

### LocationSample (`tracking` domain)
| Field | Type | Notes |
|-------|------|-------|
| lat | double | |
| lng | double | |
| recordedAt | DateTime | driver device time |
| receivedAt | DateTime? | server stamp; drives staleness (FR-021) |

`isStale(now)` ⇒ `now - (receivedAt ?? recordedAt) > kLocationStaleWindow` (named constant, no magic number).

### OtpChallenge (`delivery` / orders domain)
| Field | Type | Notes |
|-------|------|-------|
| orderId | String | |
| purpose | OtpPurpose | arrival / delivery |
| code | String? | **CLIENT side only** — populated from `order:otp` push or `GET /orders/:id/otp/current` pull; on DRIVER build this is always null and never rendered (FR-012/017, SC-008) |
| expiresAt | DateTime | |

Never serialized into logs/analytics on any build.

### AppNotification (`notifications` domain)
| Field | Type | Notes |
|-------|------|-------|
| id | String | |
| type | NotificationType | |
| orderId | String? | deep-links to order detail |
| createdAt | DateTime | |

### Money / GeoPoint (value objects)
`Money { int amountMinor; String currency }` · `GeoPoint { double lat; double lng }`.

## Cubit state shapes (Presentation / MVVM)

Each is a `freezed` union with exhaustive `when`. States never carry raw `DioException` — only typed `Failure`.

| Cubit | States |
|-------|--------|
| SessionCubit | `unknown` · `authenticated(AuthUser)` · `unauthenticated(reason?)` |
| AuthCubit | `idle` · `submitting` · `success` · `failure(Failure)` |
| OrdersCubit (CLIENT list) | `loading` · `loaded(List<Order>)` · `failure(Failure)` |
| OrderDetailCubit | `loading` · `loaded(Order, {OtpChallenge? active})` · `failure(Failure)` |
| PaymentCubit | `idle` · `initiating` · `awaitingConfirmation` · `confirmed` · `windowExpired` · `failure(Failure)` — `confirmed` set only from backend `inTransit` (R3/R7) |
| DeliveryCubit (DRIVER) | `noActiveOrder` · `active(Order, {streaming:bool})` · `failure(Failure)` |
| OtpVerifyCubit | `idle` · `verifying` · `advanced(OrderStatus)` · `rejected` · `throttled(retryAfter)` |
| TrackingCubit | `disconnected` · `connecting` · `watching(LocationSample?, {stale:bool})` · `notTrackable` · `failure(Failure)` |
| NotificationsCubit | `list(List<AppNotification>)` |

## Relationships

- `Session 1—1 AuthUser`; `AuthUser.role` gates the router (FR-026).
- `AuthUser 1—* Order` (scoped by `companyId`).
- `Order 1—* LocationSample` (stream, only latest retained) and `1—* OtpChallenge` (arrival, delivery).
- `AppNotification *—1 Order` (optional).
