# Quickstart: Web Admin Dashboard

How to scaffold, run, and verify the dashboard. Assumes the feature-001 backend is running and
reachable (with the R1 refresh-cookie adjustment applied — see
[contracts/backend-integration.md](./contracts/backend-integration.md)).

## Prerequisites

- Node 20 LTS, pnpm (or npm)
- Backend `/api/v1` reachable; CORS allows the dashboard origin with credentials
  (`Access-Control-Allow-Credentials: true`), and the refresh token is issued as an
  `httpOnly; Secure; SameSite=Strict` cookie

## Scaffold

```bash
# from repo root
pnpm create vite@latest web_dashboard -- --template react-ts
cd web_dashboard
pnpm add @tanstack/react-query axios react-router-dom zustand \
         react-i18next i18next react-hook-form zod @hookform/resolvers \
         @tanstack/react-table
pnpm add -D tailwindcss postcss autoprefixer vitest @testing-library/react \
            @testing-library/jest-dom msw playwright @playwright/test
npx tailwindcss init -p
npx shadcn@latest init          # generates components.json + components/ui
```

Set `tsconfig.json` → `"strict": true` and a `@/*` path alias to `src/*`.

## Configure

```bash
cp .env.example .env
# .env
VITE_API_BASE_URL=http://localhost:3000/api/v1
```

- Tailwind: enable logical-property utilities; add the shadcn theme tokens; configure a
  direction-aware plugin so `ms/me/ps/pe/start/end` mirror under `dir="rtl"`.
- `src/main.tsx`: mount `<App/>` inside `providers.tsx` (QueryClientProvider, I18nextProvider,
  Radix `DirectionProvider`, RouterProvider) and call `bootstrapSession()` before routing.

## Run

```bash
pnpm dev         # Vite dev server
pnpm test        # Vitest unit/integration (MSW-backed)
pnpm test:e2e    # Playwright E2E
pnpm build       # type-check + production build
```

## Verify (maps to Success Criteria)

1. **RBAC deep-link (SC-001)** — Sign in as `COMPANY_ADMIN`, open `/companies` directly →
   redirected to `/403`, and confirm **no** `GET /companies` request fired (Network tab).
2. **Tenant isolation (SC-002)** — As `COMPANY_ADMIN`, confirm order/user lists contain only
   your company; a direct `/orders/:id` for another tenant → generic not-found.
3. **Session persistence (SC-003)** — Sign in, reload → still authenticated on your role home
   (silent refresh restored the access token; nothing in `localStorage`/`sessionStorage`).
4. **Silent single-flight refresh (SC-004)** — Expire the access token, trigger several
   concurrent protected calls → exactly one `POST /auth/refresh`, all calls succeed, no visible
   re-login.
5. **Secure logout on revocation (SC-005)** — Invalidate the refresh cookie, trigger a
   protected call → session cleared, redirected to `/login`, no protected data left on screen
   (< 2s).
6. **Approve flow (SC-006)** — As `COMPANY_ADMIN`, from the workspace approve a
   `PENDING_APPROVAL` order (set `finalPrice`) in < 60s; row reflects backend-confirmed
   `APPROVED`.
7. **Onboarding (SC-007)** — As `SUPER_ADMIN`, onboard a company + initial admin in one form
   in < 90s; confirm the new admin can sign in.
8. **RTL/i18n (SC-009)** — Toggle AR↔EN → entire layout flips direction, no untranslated
   strings, no mirrored-icon/alignment defects.
9. **XSS (SC-008)** — Create a company/user with a `<script>`-laden name → rendered as inert
   text, never executed.

## Definition of done (v1)

- All nine checks above pass in E2E.
- `pnpm build` clean under `strict`; no root-level barrel-only `index.ts`.
- No access/refresh token in any web storage; access token only in memory + `Authorization`.
- Every user-facing string localized (AR/EN); lint passes the no-hard-coded-string rule.
