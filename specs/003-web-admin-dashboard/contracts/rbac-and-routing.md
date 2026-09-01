# Contract: RBAC, Routing & the Security Foundation

This is the security spine requested in the original task: the **route map**, the
**`<ProtectedRoute />`** guard, and the **centralized Axios interceptor** with single-flight
silent refresh. Reference implementations below are the binding contract for
[/speckit-implement]; they show intent and edge-case handling, not final styling.

## Route map

> **Spec 004 update**: `COMPANY_ADMIN` split into two dashboard personas —
> `FUEL_COMPANY_ADMIN` (pricing, clients, order approval/routing, transporter onboarding,
> invoice/credit administration — the direct successor of every pre-004 `COMPANY_ADMIN`) and
> `TRANSPORT_COMPANY_ADMIN` (owns a driver fleet, picks up orders routed to it, settles
> deferred invoices). `CIRO` (`SUPER_ADMIN`) is unchanged. The backend's tenant isolation for
> orders/invoices is now the multi-party plugin (plan.md §1) rather than a single `companyId`
> filter — the dashboard never encodes that scoping itself, it only reads whatever each
> `GET` endpoint already returns for the signed-in role.

| Path | Guard | Persona |
|------|-------|---------|
| `/login` | public (redirects to role home if already authed) | — |
| `/403`, `/404` | public | — |
| `/` | authed | redirect → role home (`/orders` for `FUEL_COMPANY_ADMIN`/`TRANSPORT_COMPANY_ADMIN`, `/companies` for `SUPER_ADMIN`) |
| `/companies`, `/companies/new`, `/companies/:id` | `allow={[SUPER_ADMIN]}` | CIRO — onboards Fuel Companies |
| `/transporters`, `/transporters/new`, `/transporters/:id` | `allow={[FUEL_COMPANY_ADMIN]}` | Fuel Admin — creates Transportation Companies under their own company and assigns each its served regions (`PUT /companies/:id/regions`) |
| `/orders`, `/orders/:id` | `allow={[FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN]}` | Fuel Admin approves/rejects/routes; Transport Admin sees only orders routed to their own company and assigns a driver from there — the same route, scoped server-side by role (multi-party plugin), never by a client-side filter |
| `/clients` | `allow={[FUEL_COMPANY_ADMIN]}` | Fuel Admin — clients belong to the Fuel Company, never the transporter (FR-004a); also where a client's credit limit is set (`PUT /users/:id/credit-limit`) |
| `/drivers` | `allow={[TRANSPORT_COMPANY_ADMIN]}` | Transport Admin — the driver fleet belongs exclusively to the transporter |
| `/invoices`, `/invoices/:id` | `allow={[FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN]}` | Fuel Admin sees every invoice they issued (any method) and settles CREDIT ones; Transport Admin sees and settles only DEFERRED invoices routed to them |
| `/settings` (profile + fuel prices) | `allow={[FUEL_COMPANY_ADMIN]}` | Fuel Admin — fuel prices are set at the Fuel Company level |
| `/settings` (profile only) | `allow={[TRANSPORT_COMPANY_ADMIN]}` | Transport Admin — no pricing surface |

A role hitting a path it isn't `allow`-listed for → `/403` **before** the route element (and its
data hooks) render (FR-004, SC-001). Unauthenticated → `/login` with return location (FR-005).

## `<ProtectedRoute />` (reference implementation)

```tsx
// routing/ProtectedRoute.tsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Role } from '@/constants/roles';
import { useSession } from '@/stores/session.store';

interface ProtectedRouteProps {
  allow: readonly Role[];
}

export function ProtectedRoute({ allow }: ProtectedRouteProps) {
  const location = useLocation();
  const { status, user } = useSession();

  if (status === 'booting') return <FullscreenSpinner />;      // silent refresh in flight

  if (status !== 'authenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!allow.includes(user.role)) {
    return <Navigate to="/403" replace />;                     // wrong role → no data fetched
  }

  return <Outlet />;
}
```

- The guard renders **nothing role-specific** until `status !== 'booting'`, so no protected
  query fires during bootstrap.
- `allow` is a typed `Role[]` from the enum — no magic strings (Constitution I).
- Nav items and in-page actions are additionally wrapped by `<RoleGate allow={[...]}>` to hide
  out-of-role affordances (defense in depth; still a UX layer over server authz).

## Centralized Axios interceptor (reference implementation)

```ts
// lib/auth/token-store.ts — in-memory only, never persisted
let accessToken: string | null = null;
export const tokenStore = {
  get: () => accessToken,
  set: (t: string | null) => { accessToken = t; },
};
```

```ts
// lib/api/api.client.ts
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { tokenStore } from '@/lib/auth/token-store';
import { apiRoutes } from '@/constants/api-routes';
import { toApiError } from './api-error';

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true, // send the httpOnly refresh cookie
});

apiClient.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Single-flight refresh: concurrent 401s share ONE /auth/refresh call.
let refreshPromise: Promise<string> | null = null;

async function runRefresh(): Promise<string> {
  const bare = axios.create({ baseURL: apiClient.defaults.baseURL, withCredentials: true });
  const { data } = await bare.post(apiRoutes.auth.refresh); // cookie -> new access token
  tokenStore.set(data.accessToken);
  return data.accessToken as string;
}

apiClient.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    const status = error.response?.status;

    // 403 / 404 are authorization boundaries — never refresh (FR-010).
    if (status !== 401 || !original || original._retry) {
      return Promise.reject(toApiError(error));
    }

    original._retry = true;
    try {
      refreshPromise ??= runRefresh().finally(() => { refreshPromise = null; });
      const newToken = await refreshPromise;
      original.headers = { ...original.headers, Authorization: `Bearer ${newToken}` };
      return apiClient(original); // replay the original request
    } catch (refreshErr) {
      onSessionExpired(); // clears Zustand session + redirects to /login (FR-009)
      return Promise.reject(toApiError(refreshErr as AxiosError));
    }
  },
);
```

**Guarantees this satisfies**

- FR-006 — token injected automatically on every request.
- FR-007 — expired access token triggers a transparent refresh + replay (no visible re-login).
- FR-008 — `refreshPromise` singleton ⇒ N concurrent 401s ⇒ exactly one `/auth/refresh`
  (SC-004, no refresh storm).
- FR-009 — refresh failure ⇒ `onSessionExpired()` clears session, redirects, drops protected
  data (SC-005).
- FR-010 — `403`/`404` bypass refresh entirely (access boundary vs auth failure).
- `_retry` flag ⇒ no infinite refresh loop on a persistently failing request.

## Bootstrap (silent refresh on app load — FR-011)

```ts
// features/auth/bootstrap-session.ts (called once in providers before routing renders)
export async function bootstrapSession(): Promise<void> {
  session.setStatus('booting');
  try {
    const token = await runRefresh();          // httpOnly cookie -> access token
    tokenStore.set(token);
    const { data: user } = await apiClient.get(apiRoutes.auth.me);
    if (!DASHBOARD_LOGIN_ROLES.includes(user.role)) { await logout(); return; }
    session.setSession(user, token);           // status -> 'authenticated'
  } catch {
    session.clearSession();                     // status -> 'anonymous'
  }
}
```

## XSS / injection guardrails (FR-017, SC-008)

- No `dangerouslySetInnerHTML` on tenant/user-supplied content; all such values render as text.
- Any unavoidable HTML rendering (none planned in v1) must pass through a sanitizer allowlist.
- Access token never placed in the DOM, URL, or logs; refresh token unreachable from JS.
