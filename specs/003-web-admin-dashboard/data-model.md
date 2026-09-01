# Phase 1 Data Model: Web Admin Dashboard (client-side view models & session state)

The dashboard owns **no persistent domain data** — the feature-001 backend is the source of
truth. This document defines the **TypeScript view models** (DTOs the UI consumes), the
**session/auth state**, and the **enums/constants** that replace magic values (Constitution I).
All shapes are `strict`-typed; nothing crosses a module boundary as `any`.

## Enums & constants (no magic values)

```ts
// constants/roles.ts
// Spec 004: COMPANY_ADMIN split into FUEL_COMPANY_ADMIN and
// TRANSPORT_COMPANY_ADMIN — see contracts/rbac-and-routing.md's route map.
export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  FUEL_COMPANY_ADMIN = 'FUEL_COMPANY_ADMIN',
  TRANSPORT_COMPANY_ADMIN = 'TRANSPORT_COMPANY_ADMIN',
  CLIENT = 'CLIENT',   // not a dashboard login persona; referenced in user lists
  DRIVER = 'DRIVER',   // not a dashboard login persona; referenced in user lists
}
export const DASHBOARD_LOGIN_ROLES = [
  Role.SUPER_ADMIN,
  Role.FUEL_COMPANY_ADMIN,
  Role.TRANSPORT_COMPANY_ADMIN,
] as const;

// constants/order-status.ts — mirrors backend lifecycle (display only; no local transitions)
export enum OrderStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  IN_TRANSIT = 'IN_TRANSIT',
  UNLOADING = 'UNLOADING',
  DELIVERED = 'DELIVERED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum CompanyStatus { ACTIVE = 'ACTIVE', SUSPENDED = 'SUSPENDED' }
export enum FuelType { OCTANE_91 = '91', OCTANE_95 = '95', OCTANE_98 = '98', DIESEL = 'DIESEL' }
export type Language = 'ar' | 'en';
export type Direction = 'rtl' | 'ltr';
```

## Session & auth state (Zustand + in-memory token)

**SessionUser** — the signed-in principal, decoded from `/auth/me` (or login response).

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | user id (`sub`) |
| `role` | `Role` | drives every RBAC decision; only SUPER_ADMIN / FUEL_COMPANY_ADMIN / TRANSPORT_COMPANY_ADMIN reach this app |
| `companyId` | `string \| null` | `null` for SUPER_ADMIN; set for FUEL_COMPANY_ADMIN (their Fuel Company) or TRANSPORT_COMPANY_ADMIN (their own Transportation Company — the backend, not the dashboard, resolves the parent Fuel Company for scoping) |
| `fullName` | `string` | display |
| `email` | `string` | display |

**SessionState** (Zustand store)

| Field | Type | Notes |
|-------|------|-------|
| `user` | `SessionUser \| null` | `null` when signed out |
| `accessToken` | `string \| null` | **in-memory only**; mirror of the module token holder |
| `status` | `'booting' \| 'authenticated' \| 'anonymous'` | `booting` during silent-refresh on load |
| `setSession(user, token)` | action | on login / successful refresh |
| `clearSession()` | action | on logout / refresh failure / revocation |

- Refresh token is **never** in this store — it lives only in the httpOnly cookie.
- `status: 'booting'` gates route rendering until the app-load silent refresh resolves.

## View models (DTOs consumed from the backend)

### Company

| Field | Type | Source / Notes |
|-------|------|----------------|
| `id` | `string` | |
| `name` | `string` | rendered as text (no HTML) — FR-017 |
| `status` | `CompanyStatus` | ACTIVE / SUSPENDED |
| `commercialRegisterFileId` | `string` | streamed via `GET /files/:id` |
| `createdAt` | `string (ISO)` | locale-formatted via `Intl` |

**OnboardCompanyInput** (SUPER_ADMIN, multipart → `POST /companies`)

| Field | Type | Validation (zod) |
|-------|------|------------------|
| `name` | `string` | required, 2–120 |
| `commercialRegister` | `File` | required; MIME allowlist; ≤10 MB |
| `admin.email` | `string` | required, email |
| `admin.fullName` | `string` | required, 2–120 |
| `admin.phone` | `string` | required, phone |
| `admin.password` | `string` | required, policy-compliant |

→ response includes the created initial `COMPANY_ADMIN`; UI surfaces confirmation/credentials (FR-015a).

### FuelPrice (company settings)

| Field | Type | Notes |
|-------|------|-------|
| `fuelType` | `FuelType` | 91 / 95 / 98 / Diesel |
| `basePricePerLiter` | `number` | > 0; edited by COMPANY_ADMIN |

- Read: `GET /companies/:id/fuel-prices` · Write: `PUT /companies/:id/fuel-prices` (full list, FR-014b).

### Order (read-only lifecycle; approve/reject/cancel actions)

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | |
| `status` | `OrderStatus` | display only — **never** locally transitioned (FR-016) |
| `fuelType` | `FuelType` | |
| `quantityLiters` | `number` | |
| `estimatedPrice` | `number` | shown on PENDING_APPROVAL |
| `finalPrice` | `number \| null` | set on approve |
| `clientName` | `string` | text render |
| `driverName` | `string \| null` | assigned driver, if any |
| `statusHistory` | `OrderStatusEvent[]` | includes `manualOverride` flag when force-completed |
| `createdAt` | `string (ISO)` | |

**OrderStatusEvent**: `{ status: OrderStatus; at: string; manualOverride?: boolean; overrideReason?: string }`.

- The driver-facing OTP fields are **never** present in dashboard DTOs (backend omits them).

**ApproveOrderInput**: `{ finalPrice?: number }` → `PATCH /orders/:id/approve` (omit ⇒ finalPrice = estimatedPrice).
**RejectOrderInput**: `{ reason: string }` (required) → `PATCH /orders/:id/reject`.

### User (Driver / Client managed by COMPANY_ADMIN)

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | |
| `role` | `Role.DRIVER \| Role.CLIENT` | |
| `fullName` | `string` | |
| `email` | `string` | |
| `phone` | `string` | |
| `isActive` | `boolean` | activate/deactivate |
| `stationLocation` | `GeoPoint?` | CLIENT only |
| `truck` | `Truck?` | DRIVER only |

**Truck**: `{ plateNumber: string; maxCapacityLiters: number; fuelTypes: FuelType[] }`.
**GeoPoint**: `{ lat: number; lng: number; address?: string }`.

- Create: `POST /users` · Update: `PATCH /users/:id` (`role`, `companyId` immutable) ·
  Activate/Deactivate: `PATCH /users/:id/activate|deactivate` · Truck: `PATCH /users/:id/truck`.

### Notification

`{ id: string; message: string; read: boolean; createdAt: string }` — `GET /notifications`,
`PATCH /notifications/:id/read`.

### ApiError (uniform typed error)

`{ statusCode: number; message: string; error: string }` — normalized from every failed
response by the interceptor (Constitution III). `404`/cross-tenant renders as generic
not-found (no existence disclosure).

## State transitions (client perspective)

The dashboard **initiates** transitions via backend actions and reflects the server-confirmed
result; it never computes the next state locally.

- `PENDING_APPROVAL --approve--> APPROVED` (COMPANY_ADMIN, optional `finalPrice`)
- `PENDING_APPROVAL --reject--> REJECTED` (COMPANY_ADMIN, `reason`)
- `PENDING_APPROVAL | APPROVED | (PENDING_PAYMENT) --cancel--> CANCELLED` (per role rules)
- `IN_TRANSIT | UNLOADING --force-complete--> DELIVERED` (COMPANY_ADMIN, audited override)

All other transitions (payment, arrival/delivery OTP, dispatch) are driven by mobile/webhooks;
the dashboard only **observes** them via polling. A `409 Invalid transition` from the backend
is surfaced as a non-technical error and the row refetches to show the true state.

## Validation rules (client-side, mirrored from backend for UX only)

- Server authorization is authoritative; client validation is a UX convenience, never a gate.
- `finalPrice > 0`; `basePricePerLiter > 0`; reject/override `reason` length 5–500.
- Onboarding file: MIME allowlist + ≤10 MB (mirrors backend `POST /files`).
- All free-text fields render as text nodes (React escaping); no `dangerouslySetInnerHTML`
  for tenant/user content (FR-017 / SC-008).
