# Implementation Plan: Fuel Company Admin Dashboard — Live Platform Integration

**Branch**: `013-fuel-company-dashboard` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-fuel-company-dashboard/spec.md`

## Summary

Connect the fuel company administrator's web dashboard to the live platform, and build the business
capabilities four of its screens were drawn against but which exist nowhere in the platform.

The work divides at a natural seam, and the plan is built around that seam:

- **Slices 0–8 connect what exists.** The dashboard's 81 fuel company files render hardcoded sample
  data; the platform already answers almost all of it. Two things the spec called platform additions
  turn out to be a decorator change (R2) and a controller route (R5).
- **Slices 9–13 build what does not exist.** Commission and cashback with accrual and enforcement, a
  settlement ledger, supplier-invoice reconciliation with litre balances, inter-company fuel
  exchange, and the operator's oversight of all of it.

Nothing is verifiable until Slice 0 lands, because no fuel company administrator can sign in to this
dashboard at all — the role vocabulary predates the platform's split of the combined administrator
role, and the only way any fuel company screen has ever been viewed is a demo picker issuing a
placeholder credential. The prior feature recorded this as fixed; it is not (R1).

The design risk is concentrated in one place. **Neither of the platform's two isolation plugins can
express a record owned by two fuel companies, and a fuel exchange request is exactly that** — and it
fails silently, as an empty list, on the recipient's side only, while the platform operator sees
everything correctly (R3). That decides the slice order: exchange goes last, behind a third isolation
mechanism designed and reviewed on its own.

## Technical Context

**Language/Version**: TypeScript 5.x with `strict` (backend NestJS, dashboard React 18 + Vite)

**Primary Dependencies**: Backend — NestJS, Mongoose, BullMQ, Socket.io, Joi. Dashboard — React 18,
TanStack Query, Zustand, React Router v6, Tailwind + shadcn/ui, react-i18next, Axios.

**Storage**: MongoDB (replica set; transactions available). Documents via `FilesService` behind the
abstract storage port added in feature 012 — GCS in production, local `sys_storge` in dev and e2e.

**Testing**: Backend — Jest unit + e2e (`test/jest-e2e.json`, `--runInBand`, `MongoMemoryReplSet`).
Dashboard — Vitest + Playwright.

**Target Platform**: Linux server (Docker Compose on GCE behind nginx); dashboard is a browser SPA.

**Project Type**: Web application — existing NestJS backend plus a separate dashboard repository.

**Performance Goals**: Screen freshness per FR-049 at the longest interval meeting each screen's
need; no requests while a tab is hidden (FR-050). No new latency targets beyond the platform's.

**Constraints**: No change to either Flutter client except the two client-facing additions the spec
names (litre balance visibility, credit-limit-request outcome) and the order-creation draw-down
(R9). Backend entry stays `server.ts`; local uploads stay under `sys_storge`.

**Scale/Scope**: 13 user stories, 122 functional requirements, 20 success criteria. Two
repositories. ~13 dashboard screen groups; 5 new backend domains; 4 new collections plus one embedded
sub-document.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes recorded.*

| Principle | Assessment | Evidence |
|---|---|---|
| **I — Strict typing, no magic values** | **PASS** | FR-097 requires roles, stages, grades, movement kinds and request states as named constants. R1 found the concrete failure this prevents: `FUEL_COMPANY_ADMIN` exists as an inline string in five dashboard files while the constant does not exist, which is why the type system never caught the missing role. |
| **II — Tenant isolation & security-first** | **PASS, with a recorded second mechanism** | FR-099 requires every new record scoped by the platform's existing automatic means. R6 assigns markers per collection. R3 finds that fuel exchange cannot use either existing plugin and requires a third — recorded in Complexity Tracking, following the precedent by which the multi-party plugin was itself added rather than replacing the tenant plugin. Hand-written filters are rejected outright by this principle. |
| **III — Centralized error handling** | **PASS** | No new error path. Refusals surface the platform's own reason (FR-019); new refusals (ceiling exceeded, grade mismatch, already-resolved) are typed error codes through the existing global filter, not ad-hoc shapes. |
| **IV — Clean architecture & UI/logic decoupling** | **PASS** | Dashboard: typed function components, fetching in hooks, one `api/` module per domain — the shape `transport_company/` already uses across 11 modules. Backend: module/service/controller/DTO separation. R8's extraction port is an abstract interface behind DI, mirroring how `FilesModule` hides its storage driver. |
| **V — Transactional integrity** | **PASS** | Commission accrual joins the *existing* approval transaction (R4) — a partial write is impossible by construction. Litre draw-down is a conditional update inside order creation (R9), guaranteed at the data layer, not by application ordering. Balance movement is idempotent per order (FR-073e). |

**Platform-specific constraints**: `server.ts` untouched. `sys_storge` remains the local driver's
root; supplier invoices and payment documents go through `FilesService`, so the constraint binds them
exactly as it binds existing uploads. Dashboard: no class components; RBAC rendered conditionally as
a UX layer over server-side authorization, never as a replacement — which is the whole of Slice 0.

**Gate result: PASS on both evaluations.** One entry in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/013-fuel-company-dashboard/
├── plan.md              # This file
├── spec.md              # 13 stories, 122 FRs, 20 SCs, 8 clarifications
├── research.md          # 12 decisions (R3 is the keystone)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── checklists/
│   └── requirements.md
├── contracts/           # Phase 1
│   ├── rest-api-delta.md
│   ├── dashboard-integration.md
│   └── isolation-contract.md
└── tasks.md             # /speckit-tasks — NOT created here
```

### Source Code

```text
# Platform repository (this repo)
src/
├── common/plugins/
│   ├── party-set-scope.plugin.ts        # NEW (R3) — two-company records
│   └── party-set.marker.ts              # NEW
├── modules/
│   ├── orders/                          # summary role (R2); supplier invoice sub-doc (R7);
│   │                                    # balance draw-down in create (R9)
│   ├── stations/                        # fuel-company listing (R5)
│   ├── users/                           # credit limit requests
│   ├── invoices/                        # commission accrual hook (R4)
│   ├── billing/                         # NEW — commission terms, cashback, balances, ceiling
│   ├── platform-account/                # NEW — ledger, payments, confirmation
│   ├── litre-balances/                  # NEW — balances + movements
│   └── fuel-exchange/                   # NEW — two-party requests (needs party-set plugin)
└── test/e2e/                            # new suites per slice, incl. two-company exchange

# Dashboard repository (E:/zeyad/web_dashboard_ciro_fuel)
src/
├── constants/roles.ts                   # Slice 0 — the platform's five roles
├── app/router.tsx                       # Slice 0 — guards re-derived per surface
├── auth/                                # Slice 0 — demo picker + placeholder paths DELETED
├── lib/api/api.client.ts                # canonical; src/api/apiClient.ts DELETED
├── stores/session.store.ts              # canonical; src/store/sessionStore.ts DELETED
├── petrol_company/<domain>/api/*.api.ts # NEW per domain — the transport_company shape
├── petrol_company/<domain>/hooks/*.ts   # NEW — fetching/state out of components
└── admin/                               # Slice 13 — operator's fuel-company oversight
```

**Structure Decision**: Two repositories, one spec (R12). The dashboard receives a
`SPEC-POINTER.md` for this feature and no `specs/013-…` directory, matching the arrangement recorded
for feature 009. Backend work stays inside the existing module layout; each new domain is its own
NestJS module rather than an extension of `orders` or `invoices`, so that the four new domains can be
split into their own features later (see Complexity Tracking) without unpicking a shared module.

## Slice Order

Each slice is independently testable and independently mergeable. The line after Slice 8 is a
deliberate cut point.

| # | Slice | Story | Notes |
|---|---|---|---|
| 0 | Session, roles, guards, duplicate infra | US1 | **Alone. Blocks everything.** (R1) |
| 1 | Stage vocabulary, cursor pagination, shared query config | — | Silent when wrong; lands before screens |
| 2 | Orders: list, detail, approve/reject/route/redispatch/force-complete | US2 | |
| 3 | Station owners, stations, credit limits, limit requests | US3 | Station listing is a route (R5) |
| 4 | Transporters | US4 | |
| 5 | Fuel prices and delivery pricing | US5 | |
| 6 | Invoices and settlement | US6 | Testable right after Slice 2 (R4) |
| 7 | Dashboard home and real counts | US7 | Summary is a decorator change (R2) |
| 8 | Notifications, support inbox, profile | US8 | Support has backend, no screen today |
| — | **— natural feature boundary —** | | Everything above ships value on its own |
| 9 | Commission terms, cashback, accrual, ceiling | US9 | Accrual joins existing transaction (R4, R10) |
| 10 | Platform account ledger, payment, confirmation | US10 | Needs the audit decision first |
| 11 | Supplier invoice, litre balances, draw-down | US11 | Extraction is a null port first (R8); touches client order creation (R9) |
| 12 | Party-set isolation, **then** fuel exchange | US12 | Isolation reviewed alone before the domain (R3) |
| 13 | Operator oversight of fuel companies | US13 | Shared components must be finished first |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **A third global isolation plugin** (`party-set-scope.plugin.ts`), alongside the existing tenant and multi-party plugins | A fuel exchange request is owned by **two** fuel companies, both of which must read it. Both existing plugins filter by equality with one company id and force that id on create, so the recipient's list is silently, permanently empty (R3). Principle II forbids solving this with hand-written per-feature filters. | *Two mirrored documents* — makes FR-082's "exactly one outcome" a consistency problem rather than a conditional update. *Widening the multi-party plugin* — that plugin guards orders and invoices, the two collections where a leak is worst; changing its filter shape to serve a new domain risks all of it. A separate marker keeps the blast radius at the new collection, exactly as spec 004 accepted a second plugin rather than generalising the first. |

### Recommendation: split slices 9–13 into their own features

**This is a recommendation, not a scope reduction — the plan covers all 13 stories as specified.**

Slices 9–13 introduce four business domains that exist nowhere on the platform: a commission and
cashback model with accrual and enforcement, a settlement ledger with documents and confirmation, a
supplier-invoice and litre-balance ledger that reaches into client order creation, and an
inter-company exchange domain that needs a new isolation mechanism. Each is comparable in size to a
past feature in this repository.

Three reasons the cut after Slice 8 is the right one:

1. **Slices 0–8 deliver the stated goal on their own.** "Link the fuel company dashboard to the live
   platform" is complete at Slice 8. Everything after it is new business capability that happens to
   have been drawn on the same screens.
2. **The two halves have different risk profiles.** Slices 0–8 are integration against a platform
   that already works, and their failures are visible. Slices 9–13 are money movement, financial
   balances and a new isolation mechanism, where R3 shows the failures are invisible.
3. **Slice 11 changes client behaviour.** The litre draw-down reaches into order creation, which both
   Flutter clients use. That deserves its own review, not a place at the end of a dashboard feature.

If the split is taken, the natural shape is: **013** = slices 0–8; **014** = commission, cashback and
settlement (9–10); **015** = supplier invoices and litre balances (11); **016** = fuel exchange,
including the party-set isolation mechanism (12); with Slice 13's operator screens folded into
whichever feature owns the components they share.

### Open decision to take before Slice 10

**Audit of commission accrual and payment confirmation.** Deferred when the clarification quota was
reached. Litre balances and extraction carry attribution (FR-073a-iv, FR-075a); movements of money
between a company and the platform currently do not. Decide before Slice 10 begins, not after — a
ledger that cannot say who confirmed a payment is very hard to retrofit once it holds real balances.
