# Contract: Backend Integration

The dashboard consumes the feature-001 REST API at `VITE_API_BASE_URL` (`/api/v1`). All calls
go through the centralized Axios client; feature code never touches Axios directly. Requests
send `Authorization: Bearer <accessToken>` (injected) and `withCredentials: true` (for the
refresh cookie).

## Auth contract (with required backend adjustment)

| Method | Path | Body | Response | Dashboard use |
|--------|------|------|----------|---------------|
| POST | `/auth/login` | `{ email, password }` | `{ accessToken, user }` **+ `Set-Cookie: refreshToken (httpOnly; Secure; SameSite=Strict)`** | login form |
| POST | `/auth/refresh` | — (refresh cookie sent automatically) | `{ accessToken }` **+ rotated refresh cookie** | silent refresh on load + on 401 |
| GET | `/auth/me` | — | `SessionUser` | bootstrap / rehydrate |
| POST | `/auth/logout` | — | 204 + clears refresh cookie | logout |

> **⚠️ Prerequisite backend change (R1)**: feature-001 currently returns `refreshToken` in the
> response **body**. For this dashboard the `AuthModule` MUST issue/read the refresh token as an
> `httpOnly; Secure; SameSite=Strict` cookie (access token stays in the body), and expose
> `/auth/logout` to clear it. Until then, the login persona flow is blocked on this change.
> This is owned by feature 001, not this feature.

Only `SUPER_ADMIN` and `COMPANY_ADMIN` may sign in here (FR-001); a `CLIENT`/`DRIVER` login is
rejected client-side after `/auth/me` returns their role (and the app signs them straight out).

## Endpoints consumed by persona

### SUPER_ADMIN

| Method | Path | Purpose (FR) |
|--------|------|--------------|
| POST | `/companies` | Onboard company + initial admin, atomic multipart (FR-015a) |
| GET | `/companies` | List all tenants, paginated (FR-015) |
| GET | `/companies/:id` | Company detail |
| PATCH | `/companies/:id/status` | Activate / suspend (FR-015) |
| GET | `/files/:id` | Stream commercial-register file |
| GET | `/orders?...` | Cross-tenant order visibility (FR-003) |

### COMPANY_ADMIN

| Method | Path | Purpose (FR) |
|--------|------|--------------|
| GET | `/orders?status=&from=&to=&page=` | Company orders, **polled** (FR-012 / FR-012a) |
| GET | `/orders/:id` | Order detail + statusHistory, polled |
| PATCH | `/orders/:id/approve` | Approve, optional `finalPrice` (FR-013) |
| PATCH | `/orders/:id/reject` | Reject with reason (FR-013) |
| PATCH | `/orders/:id/cancel` | Cancel per role rules |
| PATCH | `/orders/:id/force-complete` | Audited override (reason required) |
| POST | `/dispatch/orders/:id` | Manual re-dispatch after `NO_ELIGIBLE_DRIVER` |
| GET | `/users?role=&isActive=&page=` | List drivers / clients (FR-014) |
| POST | `/users` | Create driver (`truck`) or client (`stationLocation`) (FR-014) |
| PATCH | `/users/:id` | Update (role/companyId immutable) |
| PATCH | `/users/:id/activate` · `/deactivate` | Toggle active (FR-014) |
| PATCH | `/users/:id/truck` | Update truck fuelTypes/capacity |
| GET | `/companies/:id/fuel-prices` | Read base prices (FR-014b) |
| PUT | `/companies/:id/fuel-prices` | Set base prices `[{fuelType, basePricePerLiter}]` (FR-014b) |
| GET/PATCH | `/companies/:id`, `/companies/:id` profile | View/edit own company profile (FR-014a) |
| GET | `/notifications?unread=` · PATCH `/notifications/:id/read` | Notifications |

## Status-code handling (interceptor policy — Constitution III)

| Code | Meaning | Dashboard behavior |
|------|---------|--------------------|
| `400` | Validation | Field errors from details array; non-technical summary |
| `401` | Missing/invalid/expired JWT; suspended company | **Silent single-flight refresh** → replay; on refresh failure → clear session + redirect `/login` (FR-007/008/009) |
| `403` | Role not permitted (same tenant) | Access boundary — **no refresh**; route/action denied (FR-010) |
| `404` | Not found **or** cross-tenant | Generic not-found; never reveal existence (FR-002) |
| `409` | Invalid transition / driver booked | Non-technical error + refetch row to show true state (FR-016) |
| `422` | Wrong OTP | N/A to dashboard (driver-only routes not called here) |
| `429` | Throttled | Backoff + user message |

## Polling contract (FR-012a)

- Active-order list & order detail: `refetchInterval` default **15s**, `refetchIntervalInBackground: false`
  (pause when tab hidden). Interval sourced from a named constant, not inline (Constitution I).
- Mutations (`approve`/`reject`/`cancel`/`force-complete`) invalidate the affected order
  query keys so the confirmed backend state appears immediately.

## Security invariants

- Access token: `Authorization` header only, never a URL param, never logged.
- `withCredentials: true` on all calls so the httpOnly refresh cookie flows.
- No tenant/user free-text is ever rendered as HTML (FR-017).
- Client role checks are UX only; the server is the authorization source of truth.
