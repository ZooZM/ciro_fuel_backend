# Implementation Plan: Web Admin Dashboard (Super Admin & Company Admin)

**Branch**: `003-web-admin-dashboard` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-web-admin-dashboard/spec.md`

## Summary

A React 18 + Vite + TypeScript web dashboard that serves two hard-isolated personas —
`SUPER_ADMIN` (platform owner, cross-tenant governance) and `COMPANY_ADMIN` (single-tenant
operations) — over the existing feature-001 NestJS backend (`/api/v1`). The dashboard is a
**management surface** (orders, companies, drivers, clients, settings), not a live-tracking
map: order views stay current via TanStack Query `refetchInterval` polling rather than the
Socket.io `/tracking` namespace.

Security is the spine of the design: a centralized Axios client injects the in-memory access
token and runs a **single-flight silent refresh** against `/auth/refresh` on `401`, with the
long-lived refresh token confined to an `httpOnly; Secure; SameSite=Strict` cookie so a
script-injection flaw cannot exfiltrate it. A `<ProtectedRoute />` wrapper guards every route
by role *before* any out-of-scope data is fetched, treating `401` (re-auth) and `403`/`404`
(access boundary) as distinct outcomes. The UI is bilingual **Arabic/English with full RTL**
(default Arabic) via `react-i18next` and Tailwind logical properties. Feature-Based
Architecture keeps each domain (`auth`, `orders`, `companies`, `drivers`, `clients`,
`settings`) self-contained. The backend remains the sole source of truth for every order and
tenant transition.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`), React 18, Node 20 LTS (build/tooling only)

**Primary Dependencies**: Vite 5 · React Router v6 · TanStack Query v5 (server state,
polling) · Zustand v4 (session/UI client state) · Axios (centralized client + interceptors) ·
Tailwind CSS 3 + `shadcn/ui` (Radix primitives) · `react-i18next` + `i18next` (i18n/RTL) ·
`react-hook-form` + `zod` (typed forms/validation) · `@tanstack/react-table` (data grids)

**Storage**: None client-side beyond volatile in-memory state (Zustand) for the access token
and UI state; **no** access/refresh token in `localStorage`/`sessionStorage`. Refresh token
lives only in an `httpOnly` cookie set by the backend. Language preference persists in
`localStorage` (non-sensitive).

**Testing**: Vitest + React Testing Library (unit/hooks/components) · MSW (Mock Service
Worker) for API contract tests and interceptor/refresh flows · Playwright (E2E: RBAC route
guards, login→refresh→logout, RTL switch)

**Target Platform**: Evergreen desktop browsers (Chrome/Edge/Firefox/Safari, last 2
versions), desktop-first responsive down to tablet

**Project Type**: Web application (SPA frontend consuming the existing feature-001 REST API)

**Performance Goals**: First meaningful view < 2.5s on a warm cache over broadband; route
transitions < 200ms; active-order list poll interval 15s (configurable) without UI jank

**Constraints**: Access token never written to JS-readable storage; RBAC enforced before
out-of-scope fetch; every user-facing string localizable (AR/EN) with correct RTL/LTR
mirroring; backend is the sole source of truth for state transitions (no local assertion);
uniform typed error handling (Constitution III)

**Scale/Scope**: ~6 feature areas, ~18–22 screens/dialogs, 2 personas; single company's
operational volume per Company-Admin session, all tenants for Super Admin (server-paginated)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| **I. Strict Typing & No Magic Values** | `tsconfig` `strict: true`; all roles/statuses/routes/query-keys/error-codes as enums/`as const` maps, never inline literals | ✅ PASS — `src/constants/` + typed `Role`, `OrderStatus`, `queryKeys`, `apiRoutes`; DTOs typed end-to-end |
| **II. Tenant Isolation & Security-First** | Client RBAC is a UX layer over server authz; access token not JS-persistable; auth before any data access; cross-tenant → 404 handled as not-found | ✅ PASS — `<ProtectedRoute />` gates pre-fetch; access token in-memory; refresh in httpOnly cookie; server remains authority |
| **III. Centralized Error Handling** | Single error path; uniform typed shape; no leaking internals/tenant existence | ✅ PASS — one Axios response interceptor + a `QueryClient` `onError`/error boundary; typed `ApiError` from the `{statusCode,message,error}` envelope |
| **IV. Clean Architecture & UI/Logic Decoupling** | Functional components + hooks only (no class components); fetching/state separated from UI via custom hooks; feature-based encapsulation | ✅ PASS — each feature: `api/` (services) · `hooks/` (queries/mutations) · `components/` · `types.ts`; UI never calls Axios directly |
| **V. Transactional Integrity for State Changes** | Client never asserts a transition locally; relies on backend-confirmed result; atomic ops (company+admin, force-complete) owned server-side | ✅ PASS — mutations reflect server response and invalidate queries; no optimistic lifecycle assertions on money/dispatch-bearing transitions |

**Platform-specific (Web Dashboard) constraints**: strictly typed functional components/hooks
only ✅ · state & fetching separated from UI via custom hooks ✅ · RBAC by conditional
render/route-guard as a UX layer over server authz ✅.

**Result**: PASS — no violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/003-web-admin-dashboard/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (client view models & session state)
├── quickstart.md        # Phase 1 output (scaffold + run + verify)
├── contracts/           # Phase 1 output
│   ├── backend-integration.md   # Endpoints consumed + auth/refresh contract
│   ├── rbac-and-routing.md      # Route map, guards, ProtectedRoute + interceptor reference impl
│   └── ui-state-contract.md     # Session store, query-key registry, error/loading states
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

A dedicated `web_dashboard/` root, never mixed with the NestJS backend or the Flutter app.

```text
web_dashboard/
├── index.html
├── vite.config.ts
├── tsconfig.json                 # strict: true
├── tailwind.config.ts            # RTL via logical properties; shadcn theme tokens
├── .env.example                  # VITE_API_BASE_URL
├── components.json               # shadcn/ui config
└── src/
    ├── main.tsx                  # entry (required); providers: QueryClient, Router, i18n, Dir
    ├── App.tsx                   # <RouterProvider/> + global boundaries
    ├── app/
    │   ├── router.tsx            # route tree (public / super-admin / company-admin)
    │   ├── providers.tsx         # QueryClientProvider, I18nextProvider, Theme/Dir provider
    │   └── query-client.ts       # QueryClient + global onError, default staleTime
    ├── constants/
    │   ├── roles.ts              # enum Role { SUPER_ADMIN, COMPANY_ADMIN, ... }
    │   ├── order-status.ts       # OrderStatus enum (mirrors backend lifecycle)
    │   ├── api-routes.ts         # centralized endpoint path builders (no magic strings)
    │   └── query-keys.ts         # typed query-key factory
    ├── lib/
    │   ├── api/
    │   │   ├── api.client.ts     # centralized Axios instance + interceptors (silent refresh)
    │   │   └── api-error.ts      # typed ApiError from {statusCode,message,error}
    │   ├── auth/
    │   │   └── token-store.ts    # in-memory access-token holder (module-scoped, non-persisted)
    │   ├── i18n/
    │   │   ├── i18n.ts           # react-i18next init (AR default, EN)
    │   │   ├── ar.json
    │   │   └── en.json
    │   └── rtl/direction.ts      # dir() helper, <html dir/lang> sync
    ├── components/
    │   ├── ui/                   # shadcn/ui primitives (button, dialog, table, ...)
    │   └── layout/               # AppShell, Sidebar (role-aware nav), Topbar, LangSwitcher
    ├── routing/
    │   ├── ProtectedRoute.tsx    # auth + role guard (pre-fetch)
    │   ├── RoleGate.tsx          # conditional render by role (nav/actions)
    │   └── Forbidden.tsx / NotFound.tsx
    ├── stores/
    │   └── session.store.ts      # Zustand: user, role, companyId, setSession/clear
    └── features/
        ├── auth/                 # login, useLogin, useLogout, bootstrapSession (silent refresh on load)
        ├── orders/              # list/detail, approve/reject, polling hooks
        ├── companies/           # SUPER_ADMIN: list, onboard (company+first admin), suspend
        ├── drivers/             # COMPANY_ADMIN: CRUD + truck (fuelTypes, capacity)
        ├── clients/             # COMPANY_ADMIN: CRUD (stationLocation)
        └── settings/            # COMPANY_ADMIN: company profile + base fuel prices
tests/
├── unit/                        # hooks, guards, interceptor (Vitest + RTL + MSW)
└── e2e/                         # Playwright: RBAC deep-links, refresh flow, RTL switch
```

**Structure Decision**: Feature-Based Architecture under a standalone `web_dashboard/` root.
Cross-cutting concerns (Axios client, i18n, token store, session store, routing guards) live
in `lib/`, `stores/`, and `routing/`; every business domain is a self-contained folder under
`features/` owning its `api/`, `hooks/`, `components/`, and `types.ts`. No barrel `index.ts`
files are added purely for re-export. `src/main.tsx` is the sole entry point.

## Complexity Tracking

> No Constitution violations — section intentionally empty.
