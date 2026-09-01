---
description: "Task list for Web Admin Dashboard (Super Admin & Company Admin)"
---

# Tasks: Web Admin Dashboard (Super Admin & Company Admin)

**Input**: Design documents from `/specs/003-web-admin-dashboard/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: INCLUDED — the project constitution (Development Workflow & Quality Gates) requires
automated tests for security-critical guarantees (RBAC route-guarding, tenant isolation,
single-flight refresh, secure logout). Test tasks are scoped to those guarantees, not blanket coverage.

**Organization**: Tasks grouped by user story. All three stories are P1; they are sequenced by
dependency — US3 (secure session) enables US1/US2. MVP = Foundational + US3 + US1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1 = Company Admin ops · US2 = Super Admin governance · US3 = Secure session
- All paths are under the `web_dashboard/` root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold the standalone `web_dashboard/` React 18 + Vite + TS project.

- [X] T001 Scaffold Vite React-TS app at `web_dashboard/` (entry `web_dashboard/src/main.tsx`) per plan.md structure
- [X] T002 Install runtime deps (react-router-dom, @tanstack/react-query, @tanstack/react-table, axios, zustand, react-i18next, i18next, react-hook-form, zod, @hookform/resolvers) in `web_dashboard/package.json`
- [X] T003 [P] Enable `strict: true` and `@/*`→`src/*` path alias in `web_dashboard/tsconfig.json`
- [X] T004 [P] Configure Tailwind + init `shadcn/ui` (`components.json`) with RTL logical-property utilities in `web_dashboard/tailwind.config.ts`
- [X] T005 [P] Configure test tooling (Vitest + React Testing Library + MSW + Playwright) in `web_dashboard/vitest.config.ts` and `web_dashboard/playwright.config.ts`
- [X] T006 [P] Add `web_dashboard/.env.example` with `VITE_API_BASE_URL`
- [X] T007 [P] Add ESLint rules: no hard-coded display strings under `features/**` & `components/**`, and fail on root-level barrel-only `index.ts` in `web_dashboard/.eslintrc.cjs`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared cross-cutting infrastructure every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T008 [P] Define enums/constants (Role, DASHBOARD_LOGIN_ROLES, OrderStatus, CompanyStatus, FuelType, Language, Direction) in `web_dashboard/src/constants/roles.ts` and `web_dashboard/src/constants/order-status.ts`
- [X] T009 [P] Define centralized endpoint path builders in `web_dashboard/src/constants/api-routes.ts` (no magic strings)
- [X] T010 [P] Define typed query-key factory in `web_dashboard/src/constants/query-keys.ts`
- [X] T011 [P] Implement typed `ApiError` normalizer from the `{statusCode,message,error}` envelope in `web_dashboard/src/lib/api/api-error.ts`
- [X] T012 [P] Implement in-memory (non-persisted) access-token holder in `web_dashboard/src/lib/auth/token-store.ts`
- [X] T013 Create centralized Axios instance (`baseURL`, `withCredentials: true`) + request interceptor injecting `Authorization` from token-store, exposing a settable `onUnauthorized` hook, in `web_dashboard/src/lib/api/api.client.ts` (depends on T009, T011, T012)
- [X] T014 [P] Implement Zustand session store (`user`, `accessToken` mirror, `status`, `setSession`, `clearSession`) in `web_dashboard/src/stores/session.store.ts`
- [X] T015 [P] Configure `QueryClient` with global `onError` and default staleTime in `web_dashboard/src/app/query-client.ts`
- [X] T016 [P] Initialize react-i18next (AR default + EN bundles) in `web_dashboard/src/lib/i18n/i18n.ts`, `web_dashboard/src/lib/i18n/ar.json`, `web_dashboard/src/lib/i18n/en.json`
- [X] T017 [P] Implement direction helper syncing `<html dir lang>` + Radix `DirectionProvider` in `web_dashboard/src/lib/rtl/direction.ts`
- [X] T018 [P] Add base shadcn/ui primitives (button, input, select, dialog, table, form, toast) under `web_dashboard/src/components/ui/`
- [X] T019 Implement `<ProtectedRoute allow={Role[]}>` (booting spinner, anon→/login with return location, wrong-role→/403; guards before render) in `web_dashboard/src/routing/ProtectedRoute.tsx` (depends on T014)
- [X] T020 [P] Implement `<RoleGate>` conditional-render helper and `Forbidden`/`NotFound` pages in `web_dashboard/src/routing/`
- [X] T021 Build role-aware `AppShell` (Sidebar, Topbar with an explicit sign-out control [FR-018], `LangSwitcher`) in `web_dashboard/src/components/layout/` (depends on T016, T017, T020)
- [X] T022 Assemble providers (QueryClientProvider, I18nextProvider, DirectionProvider, RouterProvider) in `web_dashboard/src/app/providers.tsx` and route skeleton in `web_dashboard/src/app/router.tsx` (depends on T015, T016, T019, T021)
- [X] T023 Wire `web_dashboard/src/main.tsx` + `web_dashboard/src/App.tsx` to mount providers with a top-level error boundary (depends on T022)

**Checkpoint**: Foundation ready — app boots, routes render behind guards, AR/EN + RTL toggles work.

---

## Phase 3: User Story 3 - Secure, Persistent, Auto-Refreshing Session (Priority: P1) 🎯 MVP enabler

**Goal**: Sign-in for the two admin personas with in-memory access token, single-flight silent
refresh on 401, restart persistence via bootstrap refresh, and secure logout on revocation.

**Independent Test**: Sign in; reload → still authenticated (nothing in web storage); expire the
token and fire concurrent calls → exactly one `/auth/refresh`, no visible re-login; revoke → cleared + redirected.

> **⚠️ EXTERNAL DEPENDENCY GATE (blocks live US3 E2E — research.md R1)**: Before T026 can pass
> against a real backend, feature 001 MUST issue the refresh token as an `httpOnly; Secure;
> SameSite=Strict` cookie and expose `/auth/logout`, with CORS allowing this origin's credentials.
> Verify/track this in feature 001 first. MSW-mocked tests (T024, T025) and all implementation
> tasks below are NOT blocked and may proceed in parallel.

### Tests for User Story 3 ⚠️ (write first, ensure they FAIL)

- [X] T024 [P] [US3] Unit test: single-flight refresh (N concurrent 401s ⇒ one `/auth/refresh`, all replayed; 403/404 bypass refresh) with MSW in `web_dashboard/tests/unit/api-client.refresh.test.ts`
- [X] T025 [P] [US3] Unit test: `<ProtectedRoute>` states (booting/anonymous/wrong-role/allowed) in `web_dashboard/tests/unit/protected-route.test.tsx`
- [X] T026 [P] [US3] E2E: login → reload persistence → logout, and revoked-cookie ⇒ redirect + no protected data, in `web_dashboard/tests/e2e/session.spec.ts`

### Implementation for User Story 3

- [X] T027 [US3] Implement auth API services (login, refresh, me, logout) in `web_dashboard/src/features/auth/api/auth.api.ts` (depends on T013)
- [X] T028 [US3] Implement single-flight refresh response interceptor (module `refreshPromise`, `_retry` flag, 403/404 pass-through) and wire `onUnauthorized`/`onSessionExpired` in `web_dashboard/src/lib/api/api.client.ts` (depends on T027)
- [X] T029 [US3] Implement `bootstrapSession()` (silent refresh on load, fetch `/auth/me`, reject non-`DASHBOARD_LOGIN_ROLES`) in `web_dashboard/src/features/auth/bootstrap-session.ts` (depends on T027, T014)
- [X] T030 [P] [US3] Implement `useLogin` / `useLogout` hooks (set/clear session, redirect) in `web_dashboard/src/features/auth/hooks/`
- [X] T031 [US3] Build Login page + form (react-hook-form + zod, localized errors) in `web_dashboard/src/features/auth/components/LoginPage.tsx` (depends on T030)
- [X] T032 [US3] Wire `bootstrapSession()` into providers so routing waits on `status !== 'booting'` in `web_dashboard/src/app/providers.tsx` (depends on T029)

**Checkpoint**: Both personas can sign in, sessions survive reload, refresh is silent & single-flight, logout/revocation is clean.

---

## Phase 4: User Story 1 - Company Admin Manages Their Tenant Operations (Priority: P1) 🎯 MVP core

**Goal**: A Company Admin works in a tenant-scoped workspace: review/approve/reject orders (with
final price), manage drivers & clients, and set company profile + base fuel prices — with polling
keeping order views current and no cross-tenant data reachable.

**Independent Test**: As COMPANY_ADMIN, lists show only own company; approve a PENDING_APPROVAL
order (set finalPrice) reflects backend-confirmed APPROVED; a SUPER_ADMIN deep-link → /403 with no fetch.

### Tests for User Story 1 ⚠️

- [X] T033 [P] [US1] E2E: wrong-role deep-link guard (/companies as COMPANY_ADMIN ⇒ /403, no `GET /companies`) + tenant-scoped lists, in `web_dashboard/tests/e2e/company-admin-rbac.spec.ts`
- [X] T034 [P] [US1] Integration test: approve/reject order mutations reflect backend state + invalidate queries (MSW) in `web_dashboard/tests/unit/orders.mutations.test.tsx`

### Implementation for User Story 1

- [X] T035 [P] [US1] Define orders types/DTOs (Order, OrderStatusEvent, Approve/Reject inputs) in `web_dashboard/src/features/orders/types.ts`
- [X] T036 [P] [US1] Implement orders API services (list, detail, approve, reject, cancel, force-complete, redispatch) in `web_dashboard/src/features/orders/api/orders.api.ts` (depends on T013)
- [X] T037 [US1] Implement orders query/mutation hooks with `refetchInterval` polling (named constant) + key invalidation in `web_dashboard/src/features/orders/hooks/` (depends on T036, T010)
- [X] T038 [US1] Build Orders list + detail views (status, prices, statusHistory incl. override flag) in `web_dashboard/src/features/orders/components/` (depends on T037)
- [X] T039 [US1] Build Approve (finalPrice), Reject (reason), Cancel, and audited Force-Complete dialogs in `web_dashboard/src/features/orders/components/` (depends on T038)
- [X] T040 [P] [US1] Implement drivers feature (types, api, hooks, list, create-with-truck form, activate/deactivate, truck update) in `web_dashboard/src/features/drivers/` (depends on T013)
- [X] T041 [P] [US1] Implement clients feature (types, api, hooks, list, create-with-stationLocation form, activate/deactivate) in `web_dashboard/src/features/clients/` (depends on T013)
- [X] T042 [P] [US1] Implement settings feature (company profile view/edit + base fuel-price editor `[{fuelType, basePricePerLiter}]`) in `web_dashboard/src/features/settings/` (depends on T013)
- [X] T043 [US1] Add Company-Admin nav entries + guarded routes (`/orders`, `/drivers`, `/clients`, `/settings`) to `web_dashboard/src/app/router.tsx` and Sidebar (depends on T019, T038, T040, T041, T042)

**Checkpoint**: Company Admin workspace fully functional and independently testable.

---

## Phase 5: User Story 2 - Super Admin Administers the Platform Across All Tenants (Priority: P1)

**Goal**: A Super Admin lists all tenants, onboards a company + its initial Company Admin
atomically (surfacing credentials), suspends/activates tenants, and views cross-tenant orders —
all unreachable by Company Admins.

**Independent Test**: As SUPER_ADMIN, onboard a company+admin in one flow (new admin can sign in),
suspend a company; a COMPANY_ADMIN token cannot load any /companies route.

### Tests for User Story 2 ⚠️

- [X] T044 [P] [US2] E2E: onboarding creates company+admin (admin can log in) and suspend reflects status; COMPANY_ADMIN blocked from /companies, in `web_dashboard/tests/e2e/super-admin.spec.ts`

### Implementation for User Story 2

- [X] T045 [P] [US2] Define companies types/DTOs (Company, OnboardCompanyInput, FuelPrice) in `web_dashboard/src/features/companies/types.ts`
- [X] T046 [P] [US2] Implement companies API services (list, detail, onboard multipart `POST /companies`, status PATCH, file stream) in `web_dashboard/src/features/companies/api/companies.api.ts` (depends on T013)
- [X] T047 [US2] Implement companies query/mutation hooks (list, onboard, suspend/activate) with key invalidation in `web_dashboard/src/features/companies/hooks/` (depends on T046)
- [X] T048 [US2] Build Companies list + detail views (status, commercial-register file) in `web_dashboard/src/features/companies/components/` (depends on T047)
- [X] T049 [US2] Build Onboarding form (company fields + commercialRegister file + initial admin; validation; credentials/confirmation surface) in `web_dashboard/src/features/companies/components/OnboardCompany.tsx` (depends on T047)
- [X] T050 [P] [US2] Build cross-tenant read-only Orders view for Super Admin (reuses orders hooks, all-tenant scope) in `web_dashboard/src/features/companies/components/PlatformOrders.tsx` (depends on T037)
- [X] T051 [US2] Add Super-Admin nav entries + guarded routes (`/companies`, `/companies/new`, `/companies/:id`) to `web_dashboard/src/app/router.tsx` and Sidebar (depends on T019, T048, T049)

**Checkpoint**: Both personas fully functional and independently testable; hard isolation verified.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T052 [P] Standardize empty/loading/error states and localized toasts across features per ui-state-contract.md
- [X] T053 [P] Unit test: AR↔EN language switch flips direction with no untranslated keys in `web_dashboard/tests/unit/i18n-rtl.test.tsx`
- [X] T054 Security hardening pass: assert no access/refresh token in web storage/URL/logs; no `dangerouslySetInnerHTML` on tenant/user content (FR-017/SC-008)
- [X] T055 [P] Accessibility + RTL audit across all screens (keyboard nav, focus order, screen-reader labels, mirrored controls); satisfies SC-010 with an automated a11y check reporting 0 critical violations in RTL and LTR
- [ ] T056 Run quickstart.md validation checks 1–9 and record results
- [X] T057 [P] Add `web_dashboard/README.md` (scaffold, env, run, test) and finalize `.env.example`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: depends on Setup — **blocks all user stories**.
- **US3 (Phase 3)**: depends on Foundational — enables authenticated flows for US1/US2.
- **US1 (Phase 4)** and **US2 (Phase 5)**: depend on Foundational; require US3 for live auth but each is independently testable (auth can be stubbed in tests).
- **Polish (Phase 6)**: depends on all targeted stories complete.

### User Story Dependencies

- **US3 (P1)**: independent; sequenced first as the session enabler.
- **US1 (P1)**: independent business value; consumes the guarded shell + auth from Foundational/US3.
- **US2 (P1)**: independent; can be built in parallel with US1 by a second developer after US3.

### Within Each User Story

- Tests written first and failing → types → api services → hooks → components → routing/nav wiring.

### Parallel Opportunities

- Setup: T003–T007 in parallel.
- Foundational: T008–T012, T014–T018, T020 in parallel; then T013 → T019 → T021 → T022 → T023.
- US3 tests T024–T026 in parallel; US1 T035/T036 and T040/T041/T042 in parallel; US2 T045/T046 and T050 in parallel.
- After US3, US1 and US2 can proceed on separate tracks.

---

## Parallel Example: User Story 1

```bash
# Tests together:
Task: "E2E wrong-role guard + tenant scope in web_dashboard/tests/e2e/company-admin-rbac.spec.ts"
Task: "Integration approve/reject mutations in web_dashboard/tests/unit/orders.mutations.test.tsx"

# Independent feature slices together:
Task: "Drivers feature in web_dashboard/src/features/drivers/"
Task: "Clients feature in web_dashboard/src/features/clients/"
Task: "Settings feature in web_dashboard/src/features/settings/"
```

---

## Implementation Strategy

### MVP First

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US3 (secure session) → 4. Phase 4 US1 (Company Admin ops).
5. **STOP & VALIDATE**: sign in as Company Admin, approve an order, confirm isolation + polling. Demo.

### Incremental Delivery

- Foundational + US3 → auth shell demoable.
- + US1 → revenue-critical Company Admin MVP.
- + US2 → Super Admin platform governance.
- Phase 6 hardens security, RTL/a11y, and runs quickstart validation.

### Parallel Team Strategy

- Whole team lands Setup + Foundational + US3 together.
- Then Developer A → US1, Developer B → US2 in parallel; integrate independently.

---

## Notes

- [P] = different files, no incomplete dependency. [Story] label maps each task to US1/US2/US3.
- ⚠️ Prerequisite (feature 001): backend must issue the refresh token as an `httpOnly; Secure;
  SameSite=Strict` cookie and expose `/auth/logout` (research.md R1) before US3 E2E can pass live.
- Backend is the source of truth for every transition — no local lifecycle assertion (FR-016).
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
