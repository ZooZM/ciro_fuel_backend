# Client Contract — Backend Integration (REST + WebSocket)

How the Flutter app consumes feature `001`'s contracts. The app introduces no endpoints; it is a strict consumer. Base REST URL `/api/v1`; all authenticated requests carry `Authorization: Bearer <accessToken>`.

## Auth & token lifecycle

| Client action | Backend call | Client responsibility |
|---------------|--------------|-----------------------|
| Sign in | `POST /auth/login` `{ phone, password }` → `{ accessToken, refreshToken, user }` | `phone` is E.164 (e.g. `+9665XXXXXXX`); store both tokens in secure storage; hydrate `SessionCubit` from `user` (FR-001) |
| Silent refresh | `POST /auth/refresh` `{ refreshToken }` → `{ accessToken, refreshToken }` | Triggered only by a `401`; **single-flight** (one in-flight refresh; concurrent 401s await it, then replay once) (FR-004/005) |
| Restore session | none | On launch, load tokens from secure storage; `GET /auth/me` to validate/hydrate (FR-002) |
| Sign out / unrecoverable refresh | none | Clear secure storage; route to login exactly once (FR-006) |

**Refresh rules**: a dedicated refresh-only Dio (no auth interceptor) prevents recursion; the login and refresh requests carry `extra['skipAuth']=true`; a replayed request carries `extra['retried']=true` and is never refreshed twice.

## REST endpoints consumed (by user story)

All paths verified against `specs/001-fuel-delivery-platform/contracts/rest-api.md`.

| Story | Method + path | Purpose |
|-------|---------------|---------|
| US1 | `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me` | session |
| US2 | `POST /orders` `{ fuelType, quantityLiters, deliveryLocation? }` → 201 `{ status: PENDING_APPROVAL, estimatedPrice }` | create order (FR-008) |
| US2 | `GET /orders` (CLIENT→own; filters `status`,`from`,`to`,page), `GET /orders/:id` (incl. `statusHistory`) | list + detail with status/finalPrice (FR-009/010) |
| US2 | `GET /orders/:id/otp/current` (CLIENT owner) → `{ purpose, otp, expiresAt }` | the ONLY REST place plaintext OTP appears; complements the `order:otp` socket push (FR-012) |
| US2 | `PATCH /orders/:id/cancel` (CLIENT while PENDING_APPROVAL / APPROVED / PENDING_PAYMENT) | cancel, or **decline the final price** in PENDING_PAYMENT (FR-009) |
| US2 | `POST /orders/:id/redispatch` (CLIENT after a payment timeout; blocked once `paymentTimeoutCount ≥ 2` → admin-only) | client-triggered re-dispatch (FR-015a) |
| US2 | **Payment: no backend call** — the native SDK initiates using the order `id` + `finalPrice`; confirmation is observed **only** via webhook-driven `order:status → inTransit` / `GET /orders/:id` (R3/R7). There is no `POST /orders/:id/pay`. |
| US3 | `GET /orders?status=…` (DRIVER auto-scoped to assigned), `GET /orders/:id` (driver DTO **never** includes `otps`) | driver's active job (FR-013) |
| US3 | `POST /orders/:id/arrive` (DRIVER, from IN_TRANSIT; idempotent) | generate ARRIVAL OTP; response has NO otp (FR-016) |
| US3 | `POST /orders/:id/verify-arrival` `{ otp }` (5/15min) | → `unloading`; 422 wrong, 429 throttled (FR-016/017) |
| US3 | `POST /orders/:id/request-delivery-otp` (DRIVER, from UNLOADING) | generate DELIVERY OTP; response has NO otp (FR-016) |
| US3 | `POST /orders/:id/verify-delivery` `{ otp }` (5/15min) | → `delivered`, driver released (FR-016) |
| US4 | `GET /notifications?unread=`, `PATCH /notifications/:id/read` | in-app notification list + mark read (FR-022) |

**Payment reference dependency**: the native SDK needs the payable amount (`finalPrice`) and a gateway order reference. `finalPrice` is on the order; if the gateway requires a backend-issued reference token, it must be surfaced on the `GET /orders/:id` payload by feature `001` (open dependency — see plan Assumptions).

**Company scope invariant**: the app derives `companyId` only from the decoded JWT / `user`; it MUST NOT place a client-chosen `companyId` in any request body or query (backend auto-scopes and returns 404 cross-tenant).

## Error → Failure mapping (single `ErrorInterceptor`, Principle III)

| HTTP / condition | `Failure` | UI behavior |
|------------------|-----------|-------------|
| 401 (after refresh fails) | `AuthFailure` | clear session → login (once) |
| 403 | `AuthFailure(forbidden)` | "not permitted" |
| 404 | `NotFoundFailure` | uniform "not found" — **never** distinguishes cross-tenant vs absent (FR-023) |
| 409 | `ValidationFailure(conflict)` | e.g., illegal transition / raced |
| 422 | `ValidationFailure` | wrong OTP / invalid input |
| 429 | `ThrottledFailure(retryAfter)` | show cooldown (FR-017) |
| timeout / socket / offline | `NetworkFailure` | retry affordance |
| 5xx / unknown | `ServerFailure` | generic message; internal detail never surfaced |

Repositories return `Either<Failure, T>`; Cubits map `Failure` → state. Raw `DioException` never escapes the data layer.

## WebSocket — `/tracking` namespace (Socket.io 4)

**Handshake**: `io('<wsBase>/tracking', { transports:['websocket'], autoConnect:false, auth:{ token: <accessToken> } })` then `connect()`. `connect_error` `UNAUTHORIZED` ⇒ attempt one refresh, update `auth.token`, reconnect; still failing ⇒ `AuthFailure`.

**Reconnection**: infinite attempts, 1 s base delay (FR-020, SC-007). After a silent REST refresh, update `socket.auth = { token }` and cycle the connection (handshake context is fixed at connect).

### Client → Server
| Event | Emitted by | Payload | Ack handling |
|-------|-----------|---------|--------------|
| `order:watch` | CLIENT/watcher | `{ orderId }` | `{ok:true}` → `watching`; `NOT_FOUND`→`notTrackable`/notfound (indistinguishable); `FORBIDDEN_ROLE`→auth; `NOT_TRACKABLE`→`notTrackable` |
| `order:unwatch` | CLIENT/watcher | `{ orderId }` | leave room on navigate-away |
| `location:update` | DRIVER | `{ lat, lng, recordedAt(ISO) }` | emit only when > 50 m OR ≥ 3 min since last accepted (client gate); handle `{accepted:false, reason:BELOW_THRESHOLD}` (no UI error), `NO_ACTIVE_ORDER` |

### Server → Client
| Event | Consumer | Payload | Effect |
|-------|----------|---------|--------|
| `order:location` | TrackingCubit | `{ orderId, lat, lng, recordedAt, receivedAt }` | move marker; recompute staleness (FR-019/021) |
| `order:status` | OrderDetail / Delivery / Payment | `{ orderId, from, to, at }` | authoritative transition (R7); `to:inTransit` confirms payment |
| `order:otp` | CLIENT OrderDetail **only** | `{ orderId, purpose, otp, expiresAt }` | push code to CLIENT; **never on driver build**; REST `GET /orders/:id/otp/current` is the pull-based fallback (FR-012, SC-008) |
| `notification:new` | NotificationsCubit | `{ id, type, orderId, payload }` | in-app notification (FR-022) |

## Security invariants (client)

- OTP `otp` values are held only in CLIENT-side state, never written to logs, crash reports, or analytics; the driver build has no code field.
- `companyId` is taken only from the decoded JWT / `user`; the app never sends a client-chosen tenant.
- Cross-tenant and nonexistent resources are rendered identically ("not found").
