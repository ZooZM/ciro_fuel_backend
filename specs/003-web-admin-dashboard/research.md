# Phase 0 Research: Web Admin Dashboard

All five clarification decisions were resolved during `/speckit-clarify`; no `NEEDS
CLARIFICATION` markers remain. This document records the technology and pattern decisions and
the one **backend contract adjustment** the dashboard depends on.

## R1 — Session token strategy (access in memory, refresh in httpOnly cookie)

- **Decision**: Access token held only in a module-scoped in-memory holder (mirrored into the
  Zustand session store for React reactivity, never persisted). Refresh token delivered by the
  backend exclusively as an `httpOnly; Secure; SameSite=Strict` cookie. On app load, a silent
  `POST /auth/refresh` (cookie sent automatically) rehydrates the access token; on failure the
  user is routed to login.
- **Rationale**: Strongest XSS posture for a financial-adjacent B2B tool (Constitution II) —
  the long-lived credential is unreachable from JS, and the short-lived access token dies with
  the tab. Satisfies FR-011/FR-011a (restart persistence *without* JS-readable storage).
- **Alternatives rejected**: tokens in `localStorage` (JS-readable, XSS-exfiltratable);
  refresh token in `localStorage` (same weakness for the higher-value credential).
- **⚠️ Backend dependency (contract change)**: The feature-001 contract currently returns
  `{ accessToken, refreshToken }` in the **body** of `/auth/login` and `/auth/refresh`. To
  honor this decision the backend `AuthModule` MUST instead **set the refresh token as an
  `httpOnly; Secure; SameSite=Strict` cookie** and read it from the cookie on `/auth/refresh`
  (access token still returned in the body). Axios must send credentials
  (`withCredentials: true`). Tracked as an integration prerequisite in
  [contracts/backend-integration.md](./contracts/backend-integration.md).

## R2 — Single-flight silent refresh in the Axios interceptor

- **Decision**: One response interceptor catches `401`. A module-level `refreshPromise`
  singleton ensures concurrent 401s trigger **exactly one** `/auth/refresh`; all failed
  requests await that promise and are replayed with the new access token. A per-request
  `_retry` flag prevents infinite loops. `403`/`404` are **not** treated as auth failures (no
  refresh) — they surface as access-boundary errors.
- **Rationale**: FR-007/FR-008 (silent, single renewal under concurrency) and FR-010
  (auth-vs-authorization distinction). Prevents refresh storms (SC-004).
- **Alternatives rejected**: refreshing per-request (storm, races); refreshing on a timer
  (guesses expiry, still needs 401 fallback).

## R3 — Route-level RBAC with pre-fetch guarding

- **Decision**: `<ProtectedRoute allow={[Role...]} />` wraps route subtrees. It checks
  authenticated session + role **before** rendering the element (and therefore before its
  data hooks fire). Unauthenticated → redirect to `/login` preserving `location` for
  post-login return; authenticated but wrong role → `/403`. Navigation and in-page actions are
  additionally gated by `<RoleGate>` / conditional render.
- **Rationale**: FR-004/FR-005 and SC-001 — no out-of-scope data is requested or rendered for
  a wrong-role deep link. Client guard is a UX layer over server authz (Constitution II).
- **Alternatives rejected**: guarding inside each page (data hook may fire before the check);
  guarding only in the API layer (leaks the existence of the view/UX).

## R4 — Server state via TanStack Query with polling; client state via Zustand

- **Decision**: TanStack Query owns all server data (caching, dedupe, background refetch);
  active-order lists and order detail use `refetchInterval` (default 15s, pausing when the tab
  is hidden). Zustand owns only session (user/role/companyId, access token mirror) and light
  UI state. A typed query-key factory (`constants/query-keys.ts`) drives cache invalidation.
- **Rationale**: FR-012a near-real-time without Socket.io in v1; clean separation of server
  vs client state (Constitution IV). Mutations invalidate keys so lifecycle changes reflect
  the backend-confirmed state (FR-016).
- **Alternatives rejected**: Socket.io `/tracking` for the dashboard (adds a stateful gateway
  dependency out of v1 scope); Redux (heavier than needed for this session/UI state).

## R5 — Internationalization & RTL (Arabic default + English)

- **Decision**: `react-i18next` with `ar` (default) and `en` resource bundles; all strings
  keyed (no hard-coded display text, FR-022). Direction is derived from the active language
  and applied to `<html dir lang>`; Tailwind uses **logical properties** (`ms-*`/`me-*`,
  `text-start`/`text-end`, `ps-*`/`pe-*`) plus `tailwindcss-rtl`-style utilities so a single
  class set mirrors correctly. shadcn/Radix primitives inherit direction from a `DirectionProvider`.
  Locale-aware dates/numbers/currency via `Intl`. Language choice persists in `localStorage`.
- **Rationale**: FR-021/FR-022 and SC-009 — full RTL/LTR mirroring, no untranslated strings,
  built in from day 1 (non-negotiable for the Saudi market).
- **Alternatives rejected**: physical-direction CSS with per-locale overrides (double the CSS,
  drift-prone); English-only-now (retrofitting RTL later is costly, explicitly rejected in Q1).

## R6 — UI toolkit: Tailwind + shadcn/ui

- **Decision**: Tailwind CSS for styling; `shadcn/ui` (Radix-based, copy-in components) for
  accessible B2B primitives (dialogs, tables, forms, toasts). `@tanstack/react-table` powers
  data grids (server pagination/sorting). Forms via `react-hook-form` + `zod` resolvers with
  typed schemas.
- **Rationale**: Accessible, themeable, RTL-friendly, no vendor lock (components are owned in
  `components/ui/`). Zod schemas double as runtime validation and inferred TS types
  (Constitution I).
- **Alternatives rejected**: MUI/AntD (heavier, harder RTL theming, less ownership);
  hand-rolled components (accessibility cost).

## R7 — Centralized, typed error handling

- **Decision**: A single Axios response interceptor normalizes the backend
  `{ statusCode, message, error }` envelope into a typed `ApiError`; the `QueryClient` global
  `onError` and a top-level React error boundary render uniform, non-technical messages
  (FR-019). `404`/cross-tenant is surfaced as a generic not-found (never reveals existence).
- **Rationale**: Constitution III; FR-019 and the 404-not-403 isolation rule.
- **Alternatives rejected**: per-call `try/catch` (inconsistent shapes, swallowed errors —
  prohibited by the constitution).

## R8 — Super-Admin onboarding (company + first admin) is a single backend call

- **Decision**: The onboarding form (multipart: company fields + `commercialRegister` file +
  initial admin `{email, fullName, phone, password}`) posts once to `POST /companies`; the
  backend creates company + initial `COMPANY_ADMIN` atomically (Mongoose transaction) and
  returns the created admin. The dashboard surfaces the initial credentials/confirmation.
- **Rationale**: FR-015a and Q5 — atomicity and credential delivery are owned server-side
  (Constitution V); the client just composes the request and reflects the result.
- **Alternatives rejected**: two sequential client calls (company then admin) — non-atomic,
  can strand a tenant with no admin.

## Resolved unknowns

| Item | Resolution |
|------|-----------|
| Language/RTL | AR default + EN, full RTL via i18next + Tailwind logical props (R5) |
| Token storage | access in-memory, refresh httpOnly cookie (R1) |
| Live updates | TanStack Query polling, no Socket.io v1 (R4) |
| Settings scope | company profile + base fuel prices under `features/settings` (plan) |
| Onboarding | single atomic `POST /companies` (R8) |
| Refresh contract | **backend must move refresh token to httpOnly cookie** (R1 dependency) |

No open `NEEDS CLARIFICATION` items remain.
