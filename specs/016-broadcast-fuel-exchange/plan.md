# Implementation Plan: Broadcast Fuel Exchange Offers

**Branch**: `016-broadcast-fuel-exchange` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/016-broadcast-fuel-exchange/spec.md`

## Summary

A fuel company administrator raises one offer — grade, quantity, delivery time, destination, **no price** — and it reaches every fuel company on the platform. Each recipient answers blind with a proposed unit price or declines; the raiser reviews the proposals and awards exactly one, which creates the agreement, discloses each side to the other, and closes the offer for everybody else. The directed request model built by feature 014 is replaced, and its existing records are migrated into offers that keep their original two-company audience.

The technical shape follows from three properties of the spec, none of which is a UI concern:

1. **An open offer has one owner and N readers, and the N is not a stored list.** The platform's three isolation mechanisms express one owner (`tenant-scope`), one owner plus role-narrowed viewers (`multi-party-scope`), and exactly two owners (`party-set-scope`). A market offer is a fourth shape. Research R1 amends `party-set-scope` rather than adding a fourth plugin, because after migration that plugin has exactly one consumer and the two shapes differ by one boolean.
2. **Blindness (FR-011b) is a storage decision, not a rendering one.** Proposals live in their own collection, never embedded on the offer — an embedded array travels with every read of its parent, and this codebase has already shipped that exact leak once (spec 008's `findMine` verification trail).
3. **The award is the race (FR-014a, Constitution V).** One conditional update on the offer decides the winner; `modifiedCount` is the arbiter, exactly as feature 011's escalation stamp and feature 009's assignment collision taught.

**Slice 0 lands the isolation change, both schemas and the migration alone**, before any endpoint or screen. Its failure mode is silent — a wrong scope rule shows every screen looking correct while a competitor reads a rival's price — and the platform operator's own bypass hides it from the one view most likely to be checked.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`) on Node.js — backend; TypeScript 5.x + React 18 — dashboard

**Primary Dependencies**: NestJS, Mongoose, class-validator, BullMQ (unused by this feature), Jest + supertest; dashboard: Vite, TanStack Query, react-i18next, Tailwind, Vitest, Playwright

**Storage**: MongoDB (replica set — transactions required for the award), two new collections plus one migrated

**Testing**: `npm run test` (unit), `npm run test:e2e` (`MongoMemoryReplSet` + Redis), dashboard `vitest run`, Playwright journeys

**Target Platform**: Existing GCE + Docker Compose deployment (feature 012); no new infrastructure

**Project Type**: Two repositories — this backend and the web dashboard at `E:\zeyad\web_dashboard_ciro_fuel`. No mobile change.

**Performance Goals**: Offer listing and the summary counts page in one round trip each; notification fan-out on raise is bounded by the number of fuel companies on the platform (tens, not thousands)

**Constraints**: A responder must never receive another company's proposal in any payload; a migrated directed request must never widen its audience; the mobile applications must be bit-for-bit unaffected

**Scale/Scope**: 2 new collections, ~8 endpoints, 1 migration script, 1 rebuilt dashboard screen plus one new panel, ~6 user stories

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes recorded.*

| Principle | Verdict | Evidence |
|---|---|---|
| **I. Strict Typing & No Magic Values** | PASS | New enums: `ExchangeOfferState`, `ProposalOutcome`, four `NotificationType` values, three new `ErrorCode` values. City is `GovernorateCode`, already an enum. No literal state or grade strings on either side. |
| **II. Tenant Isolation & Security-First** | PASS (with a recorded interpretation) | The amended `party-set-scope.plugin.ts` filters every offer read structurally; `ExchangeProposal` gets its own registered rule. Neither service adds a hand-written company filter. **Interpretation recorded in R2**: grade eligibility is a *relevance* filter applied in listing queries, not a confidentiality boundary — the confidentiality boundaries are company type, the legacy audience, and proposal ownership. Cross-boundary refusals stay 404-shaped (FR-022). |
| **III. Centralized Error Handling** | PASS | All refusals are typed `ErrorCode`s thrown as Nest exceptions through the existing global filter. No new error shape. |
| **IV. Clean Architecture & UI/Logic Decoupling** | PASS | Backend keeps module/service/controller/DTO separation. Dashboard: fetching lives in `hooks/useFuelExchange.ts`, components stay presentational, functional components only. |
| **V. Transactional Integrity for State Changes** | PASS | The award is a `ClientSession` transaction whose correctness rests on a conditional update (`{ state: OPEN }`) plus a unique index on `(offerId, proposingCompanyId)` — DB-enforced, not application-ordered (R4). |
| **Backend constraints** | PASS | `server.ts` untouched; no local uploads, so `sys_storge` does not apply; scoping stays inside the global plugin mechanism. |
| **Web constraints** | PASS | Functional components and hooks only; RBAC rendering over server-side authorization, never instead of it. |

**Post-Phase-1 re-check**: unchanged. The one departure is recorded in Complexity Tracking below; it reduces mechanism count rather than adding to it.

## Project Structure

### Documentation (this feature)

```text
specs/016-broadcast-fuel-exchange/
├── plan.md              # This file
├── research.md          # Phase 0 — 12 decisions
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── rest-api-delta.md
│   ├── isolation-contract.md
│   └── dashboard-integration.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — created by /speckit-tasks, NOT here
```

### Source Code

```text
# Backend — e:\zeyad\ciro_fuel_backend
src/
├── common/
│   ├── enums/
│   │   ├── exchange-offer-state.enum.ts      # NEW
│   │   ├── proposal-outcome.enum.ts          # NEW
│   │   ├── error-code.enum.ts                # +3 values
│   │   └── notification-type.enum.ts         # +4 values
│   ├── plugins/
│   │   ├── party-set-scope.plugin.ts         # AMENDED (R1) — openToMarket clause
│   │   ├── party-set.marker.ts               # unchanged
│   │   └── proposal-scope.plugin.ts          # NEW (R3) — proposal visibility
│   └── utils/
│       └── mongo-error.util.ts               # NEW — `isDuplicateKeyError`, today
│                                             # duplicated locally in two services
├── modules/fuel-exchange/
│   ├── schemas/
│   │   ├── exchange-offer.schema.ts          # NEW
│   │   ├── exchange-proposal.schema.ts       # NEW
│   │   └── exchange-request.schema.ts        # RETAINED read-only until migration verified
│   ├── dto/                                  # create-offer, propose, award, list
│   ├── fuel-exchange.service.ts              # REWRITTEN
│   ├── fuel-exchange.controller.ts           # REWRITTEN
│   └── fuel-exchange.module.ts
└── modules/companies/
    └── companies.controller.ts               # `GET /companies/exchange-partners` REMOVED (FR-040)

scripts/
└── migrate-exchange-requests-to-offers.ts    # NEW — idempotent, pre-deploy, per environment

test/
├── unit/            # offer-state, proposal-blindness, award-race, migration-mapping
└── e2e/             # exchange-offer-isolation, exchange-offer-lifecycle,
                     # exchange-proposal-blindness, exchange-migration

# Dashboard — E:\zeyad\web_dashboard_ciro_fuel
src/petrol_company/fuel_exchange/
├── api/fuel-exchange.api.ts                  # REWRITTEN
├── hooks/useFuelExchange.ts                  # REWRITTEN
└── components/
    ├── NewOfferForm.tsx                      # REPLACES NewFuelRequestForm.tsx
    ├── OfferProposalsPanel.tsx               # NEW — review + award
    ├── ProposeDialog.tsx                     # NEW — responder's price
    ├── FuelExchangePage.tsx                  # rebuilt to the Figma layout
    ├── FuelExchangeStats.tsx                 # retained, fed by the summary endpoint
    ├── FuelExchangeListItem.tsx              # rebuilt for offer states
    └── FuelExchangeDetailPage.tsx            # rebuilt
```

**Structure Decision**: Two existing repositories, no new project. The backend keeps its module layout; the dashboard keeps its feature-folder layout under `src/petrol_company/fuel_exchange/`. The one structural addition is a second scope plugin for proposals, justified in R3 and in `contracts/isolation-contract.md`.

## Implementation Phases

| Slice | Story | Contents | Lands |
|---|---|---|---|
| **Slice 0** | — | Isolation amendment, `ExchangeOffer` + `ExchangeProposal` schemas, `proposal-scope` plugin, migration script, and the three-company isolation e2e suite. **No endpoint, no screen.** | **Alone.** Gate: the isolation suite must pass, including the case where a non-party company reads by id and the case of a migrated unanswered request. |
| Slice 1 | US1 | Raise an offer: `POST /fuel-exchange/offers`, eligibility refusal, listing with direction. | After Slice 0 |
| Slice 2 | US2 | Propose / decline, blind. Includes the negative blindness suite asserting on raw payloads. | After Slice 1 |
| Slice 3 | US3 | Review + award, the transaction, the race test, disclosure on award, closure notices. | After Slice 2 |
| Slice 4 | US4 | Withdraw, outgoing tracking. | Parallel with Slice 5 |
| Slice 5 | US5 | Destination fields end to end. | Parallel with Slice 4 |
| Slice 6 | US6 | `GET /fuel-exchange/offers/summary` + the three cards. | Last |
| Slice 7 | — | Dashboard rebuild to the Figma layout, bilingual strings, Playwright journeys. | Follows the endpoints it consumes |

**Amended by the 2026-09-06 analysis pass**: the notification fan-out needs an explicit cross-tenant recipient lookup (research R6 — the obvious precedent is tenant-scoped and would notify the raiser's own administrators), FR-010's suspended-raiser rule gained a mechanism (research R13), and FR-006/FR-007/FR-021 were amended in the spec so the requirement text matches the design it governs.

**Pre-deploy gates** (not tasks a session can close): the migration script must run against each target environment *before* this code deploys there (FR-039b), and the mobile `flutter test` suite must run to confirm the four new `NotificationType` values do not break spec 007's enum parity guard — the mobile repository is not present on this machine, exactly as in feature 015.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Amending the shipped `party-set-scope.plugin.ts` instead of leaving it untouched and adding a fourth isolation mechanism | A market offer is one owner plus an unbounded audience; a migrated directed offer is two owners. Both are the same collection, and after migration `ExchangeRequest` has no live consumer, so the plugin serves exactly one schema either way. Amending keeps the platform at three mechanisms. | A fourth plugin would mean four global mechanisms whose combined behaviour nobody can hold in their head, with two of them differing by a single boolean and both registered against the same collection family. The isolation contract's own "Scope" section argues that narrowness, not proliferation, is what keeps these auditable. |
| A second scope rule for `ExchangeProposal` | Proposal visibility is neither the offer's rule nor a tenant-equality rule: a proposal is readable by its author **or** by the company that raised the offer it answers. That disjunction is the mechanism FR-011b rests on. | Reusing `multi-party-scope` would force one `fuelCompanyId` owner and role-narrow the rest — a proposing company and a raising company hold the same role, so role cannot discriminate them. Enforcing it in the service instead is precisely what Principle II forbids. |
