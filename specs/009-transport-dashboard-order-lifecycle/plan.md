# Implementation Plan: Transport Admin Dashboard — Live Order Lifecycle

**Branch**: `009-transport-dashboard-order-lifecycle` | **Date**: 2026-08-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-transport-dashboard-order-lifecycle/spec.md`

## Summary

Connect the transportation company administrator's web dashboard to the live platform, and prove
one order travels the whole chain — customer, fuel company, transporter, driver, back to customer —
with each participant watching the same delivery change state on their own screen.

The specification was written believing the transport screens were mock-ups awaiting live data.
Research found something more fundamental: **no transportation administrator can sign in to the
dashboard at all**. Its role vocabulary predates the platform's role split, so a genuine
transporter's token is discarded at boot, and every transport screen has only ever been viewed
through a demonstration bypass that fabricates a session with the literal token `'dummy-token'`.

That reorders the work. The plan begins by making a real session possible, then completes the
stage vocabulary the dashboard is missing four values of, and only then wires the transporter's
own actions — the candidate list and the driver/truck/tank assignment that are absent from the
dashboard's address list, which instead holds three actions the role is forbidden to perform.

The platform itself is essentially complete. Verification, loading, dispatch, fleet, tracking and
notifications are all built and current — including on the mobile side, contrary to the project's
context notes. **One** platform addition is required: a summary endpoint for the overview counts,
which cursor pagination cannot yield. Everything else is dashboard work.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`) both sides · Node.js (platform) · React 18 (dashboard)

**Primary Dependencies**: Platform — NestJS, Mongoose, Socket.io. Dashboard — Vite, React Router v6,
TanStack Query, Zustand, Tailwind, shadcn/ui, axios, react-i18next, socket.io-client *(to be added)*

**Storage**: MongoDB. No schema changes; the summary endpoint reads through scoped counts.

**Testing**: Platform — Jest (unit + e2e, 122/166 green today). Dashboard — Vitest, Playwright
(configured, `tests/` present). Mobile — Flutter test (348 green, two known non-green).

**Target Platform**: Modern evergreen browsers. Card pairing additionally assumes an operator
machine with a reader attached, or a browser able to read cards directly.

**Project Type**: Web application across two repositories — NestJS platform (`ciro_fuel`) and
React dashboard (`web_dashboard`), plus a Flutter mobile client (`mobile_app`) that participates
in the walkthrough but is not modified.

**Performance Goals**: Stage change visible within 15s (SC-003) · truck position within 60s
(SC-004) · assignment completed in under 60s of operator time (SC-002) · card paired in under 30s
(SC-019).

**Constraints**: **Server cost is the governing constraint.** Refresh at the longest interval that
meets each bound; no background refresh on an unwatched screen; one live connection per session;
one request to open the overview. Bilingual Arabic/English with correct layout in both directions
on every screen added or rebuilt.

**Scale/Scope**: 76 functional requirements · 23 success criteria · 6 user stories · 8 sequenced
slices · ~20 dashboard screens touched · 1 new platform endpoint.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Assessment | Verdict |
|---|---|---|
| **I. Strict Typing & No Magic Values** | The feature's central act is *removing* magic values: a role vocabulary missing the platform's two real admin roles, and a stage vocabulary missing four of twelve. Both become complete named constants; stage rendering is driven from an exhaustive mapping so an unknown value is visible rather than blank. Dashboard uses the `as const` object pattern already established (runtime `enum` is forbidden by `erasableSyntaxOnly`). | **PASS** |
| **II. Tenant Isolation & Security-First** | Isolation is inherited structurally throughout. Candidate lists, orders, fleet and the new summary counts all pass through the multi-party plugin, which scopes `countDocuments` alongside reads — so the overview's figures carry `fuelCompanyId` + `transportCompanyId` with no hand-written filter. Cross-company access stays indistinguishable from absent. The handover code is never sent to this surface. Card identifiers are never logged. **One deviation** — the refresh token's transport, not its storage — is recorded in Complexity Tracking. Slice 0 additionally corrects a pre-existing defect: `token-store.ts` writes the access token to `localStorage` despite its own comment claiming otherwise; the rewrite makes both tokens genuinely in-memory only. | **PASS with recorded deviation** |
| **III. Centralized Error Handling** | The dashboard's existing `toApiError` envelope and `apiClient` interceptor are the single funnel; new API surfaces route through them unchanged. The 403/404 access-boundary rule already implemented is preserved. Loading, empty and failed remain three visibly distinct states (FR-055). | **PASS** |
| **IV. Clean Architecture & UI/Logic Decoupling** | Follows the dashboard's established `api/` → `hooks/` → `components/` split per feature folder, functional components only. The live-position connection is confined to a hook; no component touches a socket directly. Platform work stays within controller/service/DTO separation. | **PASS** |
| **V. Transactional Integrity** | Assignment is the archetypal race and is already transactional on the platform, with the vehicle-commitment guards enforced at the data layer. This feature adds no new state-changing operation — the one new endpoint is read-only. Concurrent assignment resolves to exactly one winner (FR-008, SC-008) by the platform's existing conditional update, which the dashboard surfaces rather than re-implements. | **PASS** |

**Gate result: PASS.** One deviation recorded and justified below.

## Project Structure

### Documentation (this feature)

```text
specs/009-transport-dashboard-order-lifecycle/
├── plan.md                        # This file
├── spec.md                        # 76 FRs, 23 SCs, 8 clarifications
├── research.md                    # Phase 0 — 8 decisions
├── data-model.md                  # Phase 1
├── quickstart.md                  # Phase 1 — the walkthrough's starting data
├── contracts/
│   ├── rest-api-delta.md          # The one new endpoint + the corrected client contract
│   ├── realtime-contract.md       # Events, rooms, and what this surface may join
│   └── dashboard-integration.md   # Screen-by-screen wiring contract
├── checklists/requirements.md     # Passing
└── tasks.md                       # Phase 2 — NOT created by /speckit-plan
```

### Source Code

**Platform** — `/Volumes/Zeyad/Documents/work/Ciro/ciro_fuel`

```text
src/modules/orders/
├── orders.controller.ts           # + GET /orders/summary
├── orders.service.ts              # + scoped counts for the summary
└── dto/order-summary.dto.ts       # NEW — response shape
test/
└── order-lifecycle.e2e-spec.ts    # NEW — full lifecycle, every stage
```

Everything else on the platform is consumed as-is: `dispatch/`, `trucks/`, `tanks/`,
`warehouses/`, `tracking/`, `notifications/`, `ratings/`.

**Dashboard** — `/Volumes/Zeyad/Documents/work/Ciro/web_dashboard`

```text
src/
├── constants/
│   ├── roles.ts                   # REWRITE — the platform's five roles
│   ├── order-status.ts            # + AWAITING_ROUTING, ROUTED_TO_TRANSPORT,
│   │                              #   ASSIGNED_TO_DRIVER, LOADING
│   ├── api-routes.ts              # + dispatch candidates/assign, trucks, tanks,
│   │                              #   override, reassign, summary; − stale dispatch.trigger
│   ├── polling.ts                 # intervals per surface, cost-derived
│   └── query-keys.ts              # + candidates, trucks, tanks, summary
├── auth/
│   ├── bootstrap-session.ts       # REWRITE — real session, bypass deleted
│   └── components/RoleSelectionPage.tsx   # DELETED
├── lib/realtime/                  # NEW — one connection, confined to a hook
│   ├── tracking-socket.ts
│   └── use-order-position.ts
├── app/router.tsx                 # role guards re-derived per surface
└── transport_company/
    ├── orders/{api,hooks,components}       # assignment, detail, list
    ├── tracking/{api,hooks,components}     # live position, trackability states
    ├── trucks/{api,hooks,components}       # fleet + card pairing + credential
    ├── drivers/{api,hooks,components}      # fleet drivers
    └── dashboard/{api,hooks,components}    # overview from the summary endpoint
tests/e2e/                         # Playwright — assignment + tracking
```

**Mobile** — `/Volumes/Zeyad/Documents/work/Ciro/mobile_app`: **not modified.** It participates in
the walkthrough as it stands.

**Structure Decision**: Two repositories, one specification. The dashboard keeps its established
per-feature `api/` → `hooks/` → `components/` layering (Principle IV) and its existing screen
layouts; this feature replaces what is behind them. The dashboard repository gets a matching
branch and a pointer file back to this specification, and no specification of its own.

## Implementation Slices

Ordered by dependency. **Slices 0 and 1 land alone with the suites green** — they are the two
whose failure mode is silent rather than visible.

### Slice 0 — A real session (lands alone)

The precondition for everything. Role vocabulary replaced with the platform's five roles; route
guards re-derived from the role that owns each surface; genuine credential login establishing the
session through `/auth/me`; the `'dummy-token'` bypass and `RoleSelectionPage` deleted; the
refresh contract made consistent with what the platform actually serves.

Also corrects two guards this feature does not otherwise touch — a driver admitted to the
transporter's screens, a customer admitted to a fuel company's — which is why it lands alone.

*Verifies*: a real transport administrator signs in and reaches `/transport`; every other role is
refused it. FR-059, FR-064.

### Slice 1 — The vocabulary of a delivery (lands alone)

The four missing stages added; stage rendering driven from an exhaustive mapping with a visible
unknown; the paged-response shape corrected from `{ items, total, page }` to the platform's
`{ items, nextCursor }`.

*Verifies*: every stage the platform can report is named correctly wherever a stage appears.
FR-010, FR-011, FR-056. Foundation for SC-006.

### Slice 2 — Assignment

The transporter's own actions, absent today. Candidate list with suggested truck; sequential
driver → truck → tank selection; capacity and grade refusals surfaced with the failing rule named;
the already-assigned refusal correcting the view. The three forbidden fuel-company actions removed
from this surface.

*Verifies*: FR-001–FR-009, FR-061. SC-002, SC-007, SC-008. **The chain is unbroken from here.**

### Slice 3 — Progress and tracking

Stage history with timestamps and verification provenance; the tracking screen's live position
over the one permitted connection; not-trackable and stale states reported from the platform's own
refusal rather than judged locally.

*Verifies*: FR-012–FR-024. SC-003, SC-004, SC-013, SC-014.

### Slice 4 — The fleet

Trucks and tanks with capacity and permitted grades; **card pairing across both input paths**;
the credential's issue/rotate/revoke lifecycle; driver management; pairing state visible per truck
before assignment.

*Verifies*: FR-039–FR-053. SC-019, SC-020, SC-021, SC-022.

### Slice 5 — Stalled deliveries

Verification override with recorded reason, presented as overridden and never as verified;
vehicle reassignment releasing the previous vehicle.

*Verifies*: FR-054–FR-058 range for Story 5. SC-012.

### Slice 6 — The overview

The platform's new summary endpoint; the dashboard home reading it; every fabricated figure on
every wired transport screen gone.

*Verifies*: FR-050–FR-055, FR-057, FR-058. SC-005, SC-011, SC-015.

### Slice 7 — Proof

The written walkthrough (begun at slice 2, grown with each slice, never written from memory); its
seed data; the platform's full-lifecycle test; Playwright coverage of assignment and tracking.

*Verifies*: FR-025–FR-038. SC-001, SC-010, SC-016, SC-017, SC-018, SC-023.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Refresh token carried in the request body rather than an httpOnly cookie** (Principle II — a token reachable by script is weaker than one that is not) | The dashboard is written expecting a cookie the platform never issues: `api.client.ts` sends `withCredentials` with an empty body while `AuthController.refresh` reads `RefreshTokenDto` from the body. Silent refresh cannot work today, so FR-073 is unimplementable until the two agree. Matching the platform's actual contract makes the dashboard work within this feature's provable scope. **Storage is not part of this deviation and carries no exception**: the refresh token passes through the login response and the refresh call and is held only in memory for the life of that exchange — never written to `localStorage`, `sessionStorage`, or any script-readable location (FR-078). `token-store.ts`'s existing `localStorage` use for the *access* token is a pre-existing defect this feature corrects while it is already rewriting that file (Slice 0), not a pattern the refresh token inherits. | Changing the platform to issue an httpOnly cookie would alter the refresh path for **both Flutter clients**, which work today and are not otherwise touched here. A regression there strands real drivers mid-delivery, and this feature has no mobile test coverage to catch it. The cookie design remains correct and is the natural next feature — it is deferred, not abandoned. |

**Scope note, not a violation**: this feature spans two repositories with no shared branch or tag,
so nothing mechanically enforces that the halves agree. The walkthrough is the only thing that
proves it, which is why it is a P1 deliverable (FR-025) rather than a closing formality.

## Phase Status

- [x] **Phase 0** — research complete, 8 decisions, no unknowns remaining → [research.md](./research.md)
- [x] **Phase 1** — design and contracts → [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)
- [x] Constitution re-check after design — **PASS**, one recorded deviation, unchanged
- [ ] **Phase 2** — `/speckit-tasks` (not produced by this command)
