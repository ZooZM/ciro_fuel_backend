# REST API Contract

Base URL: `/api/v1`. All routes require `Authorization: Bearer <JWT>` unless marked **[public]**. All responses JSON. Errors use a uniform envelope `{ statusCode, message, error }`. Cross-tenant access to an existing resource returns **404** (never 403). Rate limiting: global 100 req/min per IP; stricter buckets noted inline.

JWT payload: `{ sub: userId, role, companyId? }` — `companyId` absent only for SUPER_ADMIN.

## Auth (`/auth`)

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| POST | `/auth/login` **[public]** (10/min) | — | `{ email, password }` | `{ accessToken, refreshToken, user: {id, role, companyId, fullName} }` |
| POST | `/auth/refresh` **[public]** | — | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| GET | `/auth/me` | any | — | current user profile |

`401` on bad credentials or suspended company / deactivated account (same message — no enumeration).

## Companies (`/companies`) — SUPER_ADMIN unless noted

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/companies` | SUPER_ADMIN | multipart: company fields + `commercialRegister` file + initial admin `{email, fullName, phone, password}` (FR-018) |
| GET | `/companies` | SUPER_ADMIN | paginated list |
| GET | `/companies/:id` | SUPER_ADMIN, own COMPANY_ADMIN | |
| PATCH | `/companies/:id/status` | SUPER_ADMIN | `{ status: ACTIVE\|SUSPENDED }` |
| GET | `/companies/:id/fuel-prices` | own COMPANY_ADMIN, own CLIENT | price list for estimates |
| PUT | `/companies/:id/fuel-prices` | own COMPANY_ADMIN | `[{ fuelType, basePricePerLiter }]` (FR-008a) |

## Users (`/users`) — company-scoped automatically

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/users` | COMPANY_ADMIN, SUPER_ADMIN | create CLIENT (`stationLocation` required) or DRIVER (`truck{plateNumber, maxCapacityLiters, fuelTypes[]}` required — capabilities denormalized onto the driver doc, R8) (FR-019) |
| GET | `/users?role=&isActive=&page=` | COMPANY_ADMIN, SUPER_ADMIN | tenant-filtered list |
| GET | `/users/:id` | COMPANY_ADMIN, SUPER_ADMIN; self | |
| PATCH | `/users/:id` | COMPANY_ADMIN, SUPER_ADMIN; self (limited fields) | role & companyId immutable |
| PATCH | `/users/:id/activate` / `/deactivate` | COMPANY_ADMIN, SUPER_ADMIN | deactivation of a driver on active delivery: allowed, blocks NEW assignments only (edge case) |
| PATCH | `/users/:id/truck` | COMPANY_ADMIN | update truck (`plateNumber`, `maxCapacityLiters`, `fuelTypes[]`) — rewrites the denormalized subdoc atomically |

## Orders (`/orders`)

| Method | Path | Roles | Body / Notes |
|--------|------|-------|--------------|
| POST | `/orders` | CLIENT | `{ fuelType, quantityLiters, deliveryLocation? }` → 201 with `status: PENDING_APPROVAL`, `estimatedPrice` (FR-007/008a) |
| GET | `/orders` | any (scoped: CLIENT→own, DRIVER→assigned, ADMIN→company, SUPER_ADMIN→all) | filters: `status`, `from`, `to`, pagination |
| GET | `/orders/:id` | as above | includes `statusHistory`; driver DTO **never** includes `otps` |
| PATCH | `/orders/:id/approve` | COMPANY_ADMIN | `{ finalPrice? }` — omitted ⇒ finalPrice = estimatedPrice; → `APPROVED`, notifies client, triggers auto-dispatch (FR-008/008b) |
| PATCH | `/orders/:id/reject` | COMPANY_ADMIN | `{ reason }` → `REJECTED` |
| PATCH | `/orders/:id/cancel` | CLIENT (while `PENDING_APPROVAL` or `APPROVED` — pre-assignment; also while `PENDING_PAYMENT` = declining the Final Price), COMPANY_ADMIN (until `IN_TRANSIT`) | → `CANCELLED`; transactionally releases driver + removes timeout job if assigned (FR-009) |
| POST | `/orders/:id/redispatch` | COMPANY_ADMIN, CLIENT (CLIENT blocked once `paymentTimeoutCount ≥ 2` — admin-only thereafter, FR-015a) | only from `APPROVED` after a payment timeout; delegates to the same `DispatchService.assignDriver` as `/dispatch/orders/:id` (identical validation) |
| GET | `/orders/:id/otp/current` | CLIENT (order owner) | `{ purpose, otp, expiresAt }` — the ONLY place plaintext OTP appears (FR-021/022) |
| POST | `/orders/:id/arrive` | DRIVER (assigned) | order must be `IN_TRANSIT`; generates ARRIVAL OTP — idempotent while an unused, unexpired OTP exists; if the active OTP has EXPIRED, issues a fresh record with attempts reset (same rule for `request-delivery-otp`); response contains NO otp |
| POST | `/orders/:id/verify-arrival` (5/15min) | DRIVER (assigned) | `{ otp }` → on match: `UNLOADING`; 422 wrong otp; 429 throttled (FR-021/023) |
| POST | `/orders/:id/request-delivery-otp` | DRIVER (assigned) | order must be `UNLOADING`; generates DELIVERY OTP; response contains NO otp |
| POST | `/orders/:id/verify-delivery` (5/15min) | DRIVER (assigned) | `{ otp }` → on match (txn): `DELIVERED`, driver released (FR-022) |
| PATCH | `/orders/:id/force-complete` | COMPANY_ADMIN | `{ reason }` (required, 5–500 chars); order must be `IN_TRANSIT` or `UNLOADING` → (txn) `DELIVERED`, driver released, active OTPs invalidated, statusHistory entry stamped `{manualOverride: true, overrideReason}` (FR-025). 409 from any other state; DRIVER/CLIENT ⇒ 403 |

Invalid state transition on any route ⇒ `409 { message: "Invalid transition <from> → <to>" }`.

## Dispatch (`/dispatch`) — internal trigger surface

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/dispatch/orders/:id` | COMPANY_ADMIN (manual retry after `NO_ELIGIBLE_DRIVER`, FR-013), system-internal | runs candidate query + transactional assignment (FR-011/012); 200 `{driverId, distanceMeters}` or 200 `{assigned: false, reason: NO_ELIGIBLE_DRIVER}` + admin notification. Distinct precondition from `/orders/:id/redispatch` (post-payment-timeout, client-accessible); both delegate to the same `DispatchService.assignDriver` |

## Files (`/files`)

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/files` | any authenticated | multipart `file` + `{ purpose }`; MIME allowlist, ≤ 10 MB; stored under `sys_storge/{companyId}/` (FR-020) |
| GET | `/files/:id` | same-company roles per purpose; SUPER_ADMIN | streams file; 404 cross-tenant |

## Notifications (`/notifications`)

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/notifications?unread=` | any | own notifications only |
| PATCH | `/notifications/:id/read` | any | own only |

## Status codes summary

- `400` validation failure (class-validator details array)
- `401` missing/invalid/expired JWT; suspended company
- `403` role not permitted for route (same tenant)
- `404` not found OR cross-tenant (indistinguishable by design, FR-002)
- `409` invalid state transition; driver already booked
- `422` wrong OTP
- `429` throttled
