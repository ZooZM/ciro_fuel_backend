---
description: "Task list for 016-broadcast-fuel-exchange"
---

# Tasks: Broadcast Fuel Exchange Offers

**Input**: Design documents from `/specs/016-broadcast-fuel-exchange/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. The Constitution's Development Workflow requires automated tests for every guarantee the spec marks testable — isolation, blindness, single award, migration — and four of this feature's twelve success criteria are negative properties that only a test can hold.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[Story]**: US1–US6 from spec.md
- Backend paths are relative to `e:\zeyad\ciro_fuel_backend`; dashboard paths are prefixed `<dash>/` for `E:\zeyad\web_dashboard_ciro_fuel`

## Path Conventions

- Backend: `src/`, `test/unit/`, `test/e2e/`, `scripts/`
- Dashboard: `<dash>/src/petrol_company/fuel_exchange/`, `<dash>/src/admin/fuel_exchange/`, `<dash>/tests/e2e/`
- **No mobile path is touched by this feature.** Every actor here is an administrator, and the dashboard is admin-only.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The vocabulary every later phase references. All of it is additive; nothing here changes behaviour.

- [X] T001 [P] Create `src/common/enums/exchange-offer-state.enum.ts` — `OPEN | AWARDED | WITHDRAWN | CLOSED_NO_AWARD` per data-model.md
- [X] T002 [P] Create `src/common/enums/proposal-outcome.enum.ts` — `PROPOSED | DECLINED | AWARDED | NOT_SELECTED`
- [X] T003 [P] Add `EXCHANGE_NO_ELIGIBLE_COMPANY`, `EXCHANGE_ALREADY_ANSWERED`, `EXCHANGE_OFFER_NOT_OPEN` to `src/common/enums/error-code.enum.ts`
- [X] T004 [P] Add `EXCHANGE_OFFER_AVAILABLE`, `EXCHANGE_PROPOSAL_RECEIVED`, `EXCHANGE_OFFER_AWARDED`, `EXCHANGE_OFFER_CLOSED` to `src/common/enums/notification-type.enum.ts`
- [X] T005 Extend `test/utils/fixtures.ts` with a **three-fuel-company** fixture: A and B both selling `PETROL_95`, C selling only `DIESEL`, each with its own admin. Every guarantee in this feature is invisible with two companies (research R11)
- [X] T006 [P] Add `ExchangeOfferState` and `ProposalOutcome` const maps to `<dash>/src/constants/fuel-company.ts`; add offer query keys to `<dash>/src/constants/query-keys.ts` — `ExchangeRequestState` (directed model) removed outright, dead since no endpoint returns it anymore
- [X] T007 [P] Add the offer routes to `<dash>/src/constants/api-routes.ts` per `contracts/rest-api-delta.md`; no literal paths in components (Constitution I) — `companies.exchangePartners` removed alongside
- [X] T008 [P] Add the new Arabic and English strings to `<dash>/src/lib/i18n/ar.json` and `en.json` with **key parity preserved** — `i18n-rtl.test.tsx` asserts it (verified separately, 64/64 keys, T102). City label `المدينة`, neighbourhood label **`الحي`** and not `المنطقة` (research R8). Enumerates the full offer and proposal vocabulary: `OPEN` مفتوح · `AWARDED` تم الترسية · `WITHDRAWN` مسحوب · `CLOSED_NO_AWARD` أغلق دون ترسية · `PROPOSED` عرض مقدم · `DECLINED` معتذر · `NOT_SELECTED` لم يتم اختياره (FR-038)

---

## Phase 2: Foundational — Slice 0 (Blocking Prerequisites)

**Purpose**: The isolation mechanism, both schemas and the migration. **Lands alone, behind a review gate, with no endpoint and no screen.** A wrong scope rule here fails silently: every single-company test passes and `SUPER_ADMIN`'s bypass makes the operator's own screen look correct throughout.

⚠️ **No user story may start until T026 passes.**

- [X] T009 Amend the injected filter in `src/common/plugins/party-set-scope.plugin.ts` to `{ $or: [ { partyCompanyIds: acting }, { openToMarket: true } ] }` for `FUEL_COMPANY_ADMIN`; keep the `SUPER_ADMIN` bypass, the throw for every unrecognised role, and the `!ctx?.role` discriminator exactly as they are
- [X] T010 Amend that plugin's `pre('save')` in the same file: `openToMarket: true` requires **exactly one** party equal to the acting company; `openToMarket: false` requires **exactly two** including it. Refuse with `EXCHANGE_PARTY_INVALID`. The two-party branch must stay byte-compatible with what `ExchangeRequest` saves today
- [X] T011 Keep the registration-time `partyCompanyIds` index check in that file unchanged — it fails at bootstrap rather than at first query, and the new schema depends on it
- [X] T012 [P] Create `src/common/plugins/proposal.marker.ts` mirroring `party-set.marker.ts`'s cast-isolation approach
- [X] T013 Create `src/common/plugins/proposal-scope.plugin.ts` — filter `{ $or: [ { proposingCompanyId: acting }, { offerRaisedByCompanyId: acting } ] }`, fail closed on any unrecognised role, registration-time check that both fields are indexed
- [X] T014 Register `proposal-scope` alongside the existing three plugins wherever they are attached (`src/app.module.ts` connection factory), in the same order and with the same context service
- [X] T015 [P] Create `src/modules/fuel-exchange/schemas/exchange-offer.schema.ts` per data-model.md — `partyCompanyIds`, `openToMarket`, `raisedByCompanyId/UserId`, `fuelType`, `quantityLitres`, `deliveryAt`, `city`, `district?`, `locationUrl?`, `notes?`, `state`, `awardedProposalId?`, `awardedCompanyId?`, `agreed*`, `currency?`, `resolvedBy/At`, `migratedFromRequestId?`. Apply `markPartySet`
- [X] T016 [P] Create `src/modules/fuel-exchange/schemas/exchange-proposal.schema.ts` — `offerId`, **`offerRaisedByCompanyId` denormalised** (the scope filter must never need a join), `proposingCompanyId/UserId`, `outcome`, `unitPrice?`, `currency?`, `respondedAt`, `resolvedAt?`. Apply the proposal marker
- [X] T017 Add every index from data-model.md: offer `{ partyCompanyIds: 1 }` (mandatory), the market listing and outgoing compounds, `{ migratedFromRequestId: 1 }` unique sparse; proposal **`{ offerId: 1, proposingCompanyId: 1 }` unique** — this index, not application code, is what makes one-answer-per-company true (FR-011c, FR-018)
- [X] T018 Register both schemas via `MongooseModule.forFeature` in `src/modules/fuel-exchange/fuel-exchange.module.ts`; leave `ExchangeRequest` registered and readable
- [X] T019 Create `scripts/migrate-exchange-requests-to-offers.ts` — `--dry-run` flag, the state mapping table from research R5, `migratedFromRequestId` as the idempotency key, and **`openToMarket: false` on every written record**
- [X] T019a On an `ACCEPTED` request, the migration MUST also write `awardedCompanyId`, `agreedUnitPrice`, `agreedTotal`, `agreedQuantityLitres` and `currency` from the original terms, so a migrated agreement remains **attributable** — which company supplied and which received (FR-039, FR-013). Without this a migrated award is readable but says nothing about who owed what
- [X] T020 Make the migration idempotent and re-runnable: a second run writes zero documents and exits non-zero on any record it cannot map (FR-039b)
- [X] T021 [P] Add `test/unit/party-set-validation.spec.ts` — both save shapes accepted, one-party-with-`openToMarket:false` refused, two-party-with-`openToMarket:true` refused, acting company absent refused
- [X] T022 [P] Add `test/unit/proposal-scope.spec.ts` — the filter shape for a proposer, for a raiser, the throw for every other role, and the bypass for a context with no `role`
- [X] T023 [P] Add `test/unit/exchange-migration.spec.ts` — every row of the state mapping table, and that a twice-run migration writes once
- [X] T023a [P] Extend that suite: a migrated `ACCEPTED` request yields an offer whose supplier and receiver are both identifiable, with the original price and total preserved (FR-039, SC-010)
- [X] T024 Add `test/e2e/exchange-offer-isolation.e2e-spec.ts` covering **all eight** non-negotiable cases in `contracts/isolation-contract.md`, over the three-company fixture (SC-003)
- [X] T025 Add to that suite the migrated-record cases specifically: a migrated directed offer is `404` to a third company, and a migrated **unanswered** request is still answerable by its original recipient and nobody else (FR-006b, FR-039a, SC-010)
- [X] T026 **GATE**: review Phase 2 on its own, confirm T024 and T025 pass, and record the review in this file's *Notes* section before any endpoint or screen work begins

**Checkpoint**: isolation proven over three companies. User stories may now proceed.

---

## Phase 3: User Story 1 — Raise one offer to the whole market (P1) 🎯 MVP

**Goal**: One submission produces one offer that reaches every eligible fuel company, with no recipient and no price.

**Independent test**: A raises one offer; B sees it as incoming, C (diesel only) does not, A sees exactly one outgoing offer; no transport company, station owner or driver sees anything.

- [X] T027 [P] [US1] Create `src/modules/fuel-exchange/dto/create-offer.dto.ts` — `fuelType`, `quantityLitres` (`@Min` > 0), `deliveryAt` (future at creation), `city` (`GovernorateCode`). **No `recipientCompanyId`, no `unitPrice`** (FR-002, FR-004, FR-005a, FR-024)
- [X] T028 [US1] Rewrite `FuelExchangeService.create` in `src/modules/fuel-exchange/fuel-exchange.service.ts` — build `partyCompanyIds: [acting]`, `openToMarket: true`, `state: OPEN`; no price field anywhere (FR-001, FR-003, FR-018)
- [X] T029 [US1] Add the eligibility check to that method: refuse `400 EXCHANGE_NO_ELIGIBLE_COMPANY` when no **other** fuel company sells the grade (FR-005). Implemented via a new `CompaniesService.findActiveFuelCompaniesSellingGrade` (reused by T036's fan-out) rather than `getBasePrice` alone, which answers only "does ONE named company sell this" — the eligibility check and the fan-out both need the SET of eligible companies
- [X] T030 [US1] Add `POST /fuel-exchange/offers` (`FCA`) to `src/modules/fuel-exchange/fuel-exchange.controller.ts`
- [X] T031 [US1] Implement `findAll` with `?direction=incoming|outgoing|all`, cursor-paginated via the shared `paginate` util — direction **derived** from `raisedByCompanyId` against the viewer, never stored (FR-008, FR-034)
- [X] T032 [US1] Apply the grade **relevance** filter to `incoming` only, and exclude the viewer's own offers from it (FR-007, FR-009, research R2). This is a service-layer filter by design; the isolation filter stays in the plugin
- [X] T032a [US1] Exclude offers whose **raising company is suspended** from every other company's `incoming` list (FR-010, research R13). Resolve the suspended fuel company ids with one query and apply `raisedByCompanyId: { $nin: … }` — never a `$lookup` inside a keyset-paginated query, and never a flag denormalised onto the offer, which a reinstated company could not clear
- [X] T033 [US1] Add `GET /fuel-exchange/offers` (`FCA`, `SA`)
- [X] T034 [US1] Implement `findOne` with the viewer-shaped payload table in `contracts/rest-api-delta.md`; a non-entitled viewer gets `404`, never `403`, and never distinguishable from absence (FR-022)
- [X] T035 [US1] Add `GET /fuel-exchange/offers/:id` (`FCA`, `SA`)
- [X] T036 [US1] Create `FuelExchangeService.resolveRecipientAdmins(companyIds)` — a **cross-tenant** lookup of every active `FUEL_COMPANY_ADMIN` in the named companies, inside `tenantContext.runUnscoped`. ⚠️ **Do not copy `SupportService.notifyFuelCompanyAdmins`**: its `usersService.findAll({ role: FUEL_COMPANY_ADMIN })` is tenant-scoped and returns the **acting** company's administrators, so a faithful copy notifies the raiser's own staff and tells no recipient company anything — silently, with any "a notification was created" assertion still passing (research R6)
- [X] T036a [US1] Emit `EXCHANGE_OFFER_AVAILABLE` on raise to every administrator resolved by T036, one `NotificationsService.notify` call each, stamping **the recipient's own `companyId`** — not the acting company's. `notify` takes `companyId` explicitly and wraps the create in `runUnscoped` precisely so the tenant plugin cannot overwrite it (FR-029)
- [X] T036b [US1] Add an e2e assertion that the notifications raised by company A carry `recipientUserId` values belonging to **company B**, and none belonging to A (FR-029, SC-006) — the three-company fixture (research R11) has no fourth company; B alone already proves the cross-tenant resolution against the tenant-scoped failure it exists to catch
- [X] T037 [P] [US1] Add `test/unit/exchange-offer.service.spec.ts` — eligibility refusal, `openToMarket` set, direction derivation, and that no price field is ever written
- [X] T038 [US1] Add `test/e2e/exchange-offer-lifecycle.e2e-spec.ts` — raise once, assert exactly one document, B sees incoming, C does not, A sees one outgoing, and a `KEROSENE` offer nobody sells is refused (SC-002)
- [X] T038a [US1] Add to that suite: suspend company A, then assert its open offer is absent from B's incoming list while remaining readable via the isolation mechanism itself (asserted directly against the service under A's own scoped context, since a suspended admin cannot authenticate over HTTP at all) (FR-010)
- [X] T039 [P] [US1] Rewrite `<dash>/src/petrol_company/fuel_exchange/api/fuel-exchange.api.ts` for the offer routes and their response types
- [X] T040 [P] [US1] Rewrite `<dash>/src/petrol_company/fuel_exchange/hooks/useFuelExchange.ts` — `useOffersList`, `useOffer`, `useCreateOffer`; delete `useExchangePartners`
- [X] T041 [US1] Create `<dash>/src/petrol_company/fuel_exchange/components/NewOfferForm.tsx` replacing `NewFuelRequestForm.tsx` — **no recipient selector, no price input**, always-expanded dashed panel per `contracts/dashboard-integration.md`
- [X] T042 [US1] Replace the estimated-total row with the quantity-and-grade summary (FR-032a). A currency total at creation could only ever read zero — the defect this replaces
- [X] T043 [US1] Rebuild `<dash>/src/petrol_company/fuel_exchange/components/FuelExchangePage.tsx` to the approved layout: form always visible, stats beside it, filter, list. Delete the `طلب جديد` gating button
- [X] T044 [US1] Rebuild `<dash>/src/petrol_company/fuel_exchange/components/FuelExchangeListItem.tsx` for offer states; loading, empty and error states with a retry that does not reload the page (FR-035)
- [X] T045 [P] [US1] Add `<dash>/tests/unit/new-offer-form.test.tsx` — asserts no recipient field, no price field, and that the summary row is not a currency amount. **Path corrected**: the dashboard's real convention is `tests/unit/` at the repo root (every existing test lives there, e.g. `order-actions.test.tsx`) — `src/**/__tests__/` as the tasks named it has no precedent anywhere in this repository

**Checkpoint**: US1 independently demonstrable. This is the MVP.

---

## Phase 4: User Story 2 — Answer an offer with a price, blind (P2)

**Goal**: A recipient proposes a price or declines, and can learn nothing about any other company's answer.

**Independent test**: B and D each propose different prices; neither can see the other's proposal or that it exists, in the raw payload; A sees both.

- [X] T046 [P] [US2] Create `src/modules/fuel-exchange/dto/create-proposal.dto.ts` — `unitPrice` (`@Min` > 0) or `decline: true`, mutually exclusive (FR-011, FR-011a)
- [X] T047 [US2] Implement `FuelExchangeService.propose` — writes one `ExchangeProposal` with `outcome: PROPOSED`, `currency: DEFAULT_CURRENCY` and the denormalised `offerRaisedByCompanyId`
- [X] T048 [US2] Implement decline in the same method path — `outcome: DECLINED`, no price, final for that company (FR-013, FR-015 of the spec's answering section)
- [X] T049 [US2] Add the guards: `400 EXCHANGE_GRADE_NOT_SOLD` when the **proposing** company does not sell the grade (research R2 moves this guard here from raising), `409 EXCHANGE_OFFER_NOT_OPEN`, and `403` when the raiser answers its own offer (FR-009)
- [X] T049a [US2] Refuse an answer when the offer's **raising company is suspended** — the offer could otherwise keep drawing proposals nobody can ever award, since the only party entitled to award it cannot sign in (FR-010, research R13)
- [X] T050 [US2] Translate the unique-index violation on `(offerId, proposingCompanyId)` into `409 EXCHANGE_ALREADY_ANSWERED` — never a 500. This is also what makes the double-submit case of FR-018 hold
- [X] T050a [US2] Extract `isDuplicateKeyError` into `src/common/utils/mongo-error.util.ts` and point `dispatch.service.ts`, `ratings.service.ts` and the new proposal path at it. **A third copy was found in `payments.service.ts`** beyond the two the task named — all three now import the shared helper (Constitution I)
- [X] T051 [US2] Add `POST /fuel-exchange/offers/:id/proposals` (`FCA`) returning **only the caller's own proposal**
- [X] T052 [US2] Ensure `findOne` and `findAll` attach `proposals`, `proposalCount` and `declineCount` **only when the viewer raised the offer** — build the payload from the viewer, never strip it afterwards (FR-012, FR-020, FR-021a)
- [X] T053 [US2] Emit `EXCHANGE_PROPOSAL_RECEIVED` to the raising company's administrators (FR-030)
- [X] T054 [P] [US2] Add `test/unit/exchange-proposal.service.spec.ts` — grade guard, price validation, decline shape, duplicate translated to 409
- [X] T055 [US2] Add `test/e2e/exchange-proposal-blindness.e2e-spec.ts` — asserting on **raw response bodies** that a responder's offer read, offer list and detail contain no proposal array, no rival price, no proposal count and no rival company name (FR-011b, SC-004, research R12). The three-company fixture (R11) yields only one grade-eligible external proposer by default (A raises, only B sells PETROL_95 besides A) — this suite grants C `PETROL_95` via `setFuelPrices` **for this test alone**, leaving the shared fixture's "C is diesel-only" property untouched for every other suite
- [X] T055a [US2] Add to that suite the **pre-award disclosure** case: while an offer is open, no viewer's payload carries the raising company's contact details — only its name (FR-019). The negative case is the one that leaks; T067 asserts only the positive, on-award direction
- [X] T056 [US2] Add to that suite: a company onboarded **after** the offer was raised can see and answer it (FR-006a) — the case a materialised audience would break
- [X] T056a [US2] Emit `EXCHANGE_PROPOSAL_RECEIVED` through T036's cross-tenant resolver, stamped with the raising company's own `companyId` — the proposing company is a different tenant from the recipient here, the same trap in the opposite direction (FR-030)
- [X] T057 [P] [US2] Create `<dash>/src/petrol_company/fuel_exchange/components/ProposeDialog.tsx` — price entry and decline, surfacing the platform's own refusals rather than pre-validating
- [X] T058 [US2] Add `useProposeOnOffer` to the hooks file and wire the dialog from the offer detail
- [X] T059 [P] [US2] Add `<dash>/tests/unit/propose-dialog.test.tsx` — refusal copy for `EXCHANGE_ALREADY_ANSWERED` and `EXCHANGE_GRADE_NOT_SOLD` (path corrected per T045's note)

**Checkpoint**: blindness proven at the payload, not at the screen.

---

## Phase 5: User Story 3 — Review the answers and award (P3)

**Goal**: The raiser awards exactly one proposal; that act creates the agreement, discloses both sides, and closes the offer for everyone else.

**Independent test**: A reviews two proposals, awards one, the loser is told the offer closed without learning the winner, and a second award is refused.

- [X] T060 [P] [US3] Create `src/modules/fuel-exchange/dto/award-offer.dto.ts` — `proposalId`
- [X] T061 [US3] Implement `FuelExchangeService.award` inside a `ClientSession` transaction (Constitution V)
- [X] T062 [US3] Make the offer's transition a **conditional** `updateOne({ _id, state: OPEN }, …)`; `modifiedCount === 0` → `409 EXCHANGE_ALREADY_RESOLVED`. Never read-then-write — that is the shape feature 009's assignment collision took, surfacing at commit as a 500
- [X] T063 [US3] Freeze `agreedUnitPrice`, `agreedTotal`, `agreedQuantityLitres`, `currency` and `awardedCompanyId` on the offer at award (FR-014c, research R7)
- [X] T064 [US3] Stamp the winning proposal `AWARDED` and every other proposal on that offer `NOT_SELECTED`, in the same session
- [X] T065 [US3] Validate that the named proposal belongs to this offer and that the caller raised it → `404` otherwise, revealing nothing about either record
- [X] T066 [US3] Add `POST /fuel-exchange/offers/:id/award` (`FCA`, raiser only)
- [X] T067 [US3] Extend the viewer-shaped payload for the awarded state: raiser ↔ awarded company see each other's contact details (FR-019a); a non-winner sees `AWARDED` and nothing identifying the winner or the price (FR-015)
- [X] T068 [US3] Emit `EXCHANGE_OFFER_AWARDED` to the winner and `EXCHANGE_OFFER_CLOSED` to every non-winner, the latter carrying **no company name and no price** (FR-031). Both go through T036's cross-tenant resolver, each stamped with its own recipient's `companyId`
- [X] T069 [US3] Refuse raise, propose, award and withdraw for `SUPER_ADMIN` while leaving every read open (FR-023) — enforced structurally by never naming `SUPER_ADMIN` on any write route's `@Roles`, the same discipline the pre-existing controller already used
- [X] T070 [P] [US3] Add `test/unit/exchange-award.service.spec.ts` — the ownership refusals (T065), which run before `connection.startSession()`. The conditional update's arguments, the frozen figures and loser-stamping need a REAL transaction and are covered by T071 instead, mirroring `credit-limit-requests.service.spec.ts`'s established convention
- [X] T071 [US3] Add `test/e2e/exchange-award-race.e2e-spec.ts` — two simultaneous awards of different proposals: exactly one stands, the other gets `409` (FR-014a, SC-005)
- [X] T072 [US3] Add to `exchange-offer-lifecycle.e2e-spec.ts`: after an award, assert **no** order, invoice, driver assignment or litre-balance movement exists (FR-017, SC-009)
- [X] T073 [US3] Assert in the blindness suite that a non-winner's offer payload and notification payload identify neither the winner nor the winning price (SC-007)
- [X] T074 [P] [US3] Create `<dash>/src/petrol_company/fuel_exchange/components/OfferProposalsPanel.tsx` — proposals with company, unit price, currency and total, plus the two counts, and an award action. Rendered only when the viewer raised the offer (FR-014, FR-021a, FR-037)
- [X] T075 [US3] Rebuild `<dash>/src/petrol_company/fuel_exchange/components/FuelExchangeDetailPage.tsx` and `FuelExchangeContactInfo.tsx` for the disclosure rules — contacts appear only where the contract says they do. `FuelExchangeContactInfo` narrowed to the ONE genuine two-party case (the awarded company's view of the raiser, `offer.raiserContact`) — the raiser has many proposers, not one counterparty, so its per-proposer contact is inline in `OfferProposalsPanel` instead
- [X] T076 [US3] Add `useAwardOffer` to the hooks file; surface `EXCHANGE_ALREADY_RESOLVED` as *already closed*
- [X] T077 [P] [US3] Add `<dash>/tests/unit/offer-proposals-panel.test.tsx` — award disabled once resolved, panel absent for a non-raiser (path corrected per T045's note)

**Checkpoint**: the agreement exists and the race is closed at the database.

---

## Phase 6: User Story 4 — Withdraw and track your own offers (P4)

**Goal**: The raiser can withdraw an unawarded offer, and sees how many answers each of their offers drew.

**Independent test**: A withdraws an offer; it leaves every incoming list, cannot be answered, and its proposers are told.

- [X] T078 [US4] Implement `FuelExchangeService.withdraw` with the same conditional-update idiom as T062 → `409 EXCHANGE_ALREADY_RESOLVED` when already awarded (FR-014b, FR-016)
- [X] T079 [US4] Add `PATCH /fuel-exchange/offers/:id/withdraw` (`FCA`, raiser only)
- [X] T080 [US4] Emit `EXCHANGE_OFFER_CLOSED` to every company that had proposed, stating withdrawal (FR-016, FR-030a)
- [X] T081 [US4] Include **`proposalCount` and a separate `declineCount`** on outgoing list items — for the raiser only, per T052's viewer-shaped rule. Two counts, never one: the raiser must be able to tell "no answers yet" from "everybody said no" (FR-021a). Neither count carries any company identity
- [X] T081a [US4] Assert in the blindness suite that `declineCount` is a number alone and that no declining company is identifiable from any payload the raiser receives (FR-021, FR-021a) — **found and fixed two real leaks writing this test**, see Corrections
- [X] T082 [P] [US4] Add withdrawal cases to `test/e2e/exchange-offer-lifecycle.e2e-spec.ts` — leaves incoming lists, unanswerable afterwards, refused on an awarded offer
- [X] T083 [P] [US4] Wire `useWithdrawOffer` and the withdraw action into the detail page and list item — the withdraw button lives on the detail page only (raiser-only action, and the list item is already read-only navigation elsewhere on this platform's list/detail split)

---

## Phase 7: User Story 5 — State where the fuel is going (P5)

**Goal**: The offer carries the destination detail the approved design asks for, and every recipient sees it.

**Independent test**: A raises an offer with district, location link and notes; B sees all three exactly as entered, with no text interpreted as markup.

**Note**: `city` is a required term and ships with US1. This phase adds the optional detail and the vocabulary-bound picker.

- [X] T084 [P] [US5] Add `district`, `locationUrl` and `notes` to `create-offer.dto.ts` as optional, length-capped fields (FR-025) — landed with T027 in Phase 3, since the schema (data-model.md) and DTO were written once, complete, rather than incrementally
- [X] T085 [US5] Validate `locationUrl` server-side to `http`/`https` only — a `javascript:` scheme must be refused at the API, not at the renderer (FR-028) — `class-validator`'s `@IsUrl({ protocols: ['http','https'], require_protocol: true })`
- [X] T086 [US5] Include all four destination values in every viewer's offer payload (FR-026) — `toOfferSummary` includes `city`/`district`/`locationUrl`/`notes` unconditionally, never gated behind `includeAgreed`
- [X] T087 [P] [US5] Add `test/e2e/exchange-destination.e2e-spec.ts` — round-trips every field, refuses a non-`http(s)` link, and asserts markup-looking text is stored and returned literally (FR-027, SC-008)
- [X] T088 [US5] Add the city select to `NewOfferForm.tsx` bound to `GovernorateCode`, and the neighbourhood free-text field labelled **`الحي`** — never `المنطقة`, which the platform already uses for its 13 `RegionCode` regions (research R8)
- [X] T089 [US5] Add the location link and notes inputs, and render all four on the detail page as text with the link carrying `rel="noopener noreferrer"` and presented as unverified (FR-028)
- [X] T090 [P] [US5] Add the destination fields to `<dash>/tests/unit/new-offer-form.test.tsx`, including that the neighbourhood label is not `المنطقة` (path corrected per T045's note)

---

## Phase 8: User Story 6 — Summary counts (P6)

**Goal**: Three counts over the whole scoped set, not over a loaded page.

**Independent test**: With more offers than fit one page, each count matches a hand count, and last month's awards are excluded.
 
- [X] T091 [US6] Implement `FuelExchangeService.summary` — `incomingAwaitingAnswer`, `outgoingOpen`, `awardedThisMonth`, each a scoped `countDocuments`, never a page count (FR-033, research R9)
- [X] T092 [US6] Scope `awardedThisMonth` to the current calendar month in the platform's timezone, boundary inclusive at the start and exclusive at the end
- [X] T093 [US6] Add `GET /fuel-exchange/offers/summary` (`FCA`) — registered **before** the `:id` route, or the literal segment is swallowed by the param route and fails id validation (the trap `GET /companies/exchange-partners` documents, now itself removed — see Polish)
- [X] T094 [P] [US6] Add summary cases to `test/e2e/exchange-offer-lifecycle.e2e-spec.ts` — counts exceed one page, and a previous-month award is excluded (SC-012)
- [X] T095 [US6] Add `useOfferSummary` and feed `<dash>/src/petrol_company/fuel_exchange/components/FuelExchangeStats.tsx` from it; delete the two list queries the cards currently count — fed via `FuelExchangePage.tsx`, `FuelExchangeStats.tsx` itself stays a generic `cards[]` renderer
- [X] T096 [P] [US6] Add `<dash>/tests/unit/offer-summary.test.tsx` (path corrected per T045's note)

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T097 Remove `POST/GET/PATCH /fuel-exchange/requests*` from `src/modules/fuel-exchange/fuel-exchange.controller.ts` and their service methods (FR-040); leave the schema registered and readable — landed as part of the controller/service REWRITE (Phase 3), not a separate deletion pass; the corresponding e2e suite (`fuel-exchange.e2e-spec.ts`) exercised only the removed routes and was deleted with it
- [X] T098 Remove `GET /companies/exchange-partners` from `src/modules/companies/companies.controller.ts` and `findExchangePartners` from `companies.service.ts` — its only consumer was the recipient selector (research R10)
- [X] T099 [P] Delete `<dash>/src/petrol_company/fuel_exchange/components/NewFuelRequestForm.tsx`, `FuelExchangeRequestData.tsx` and every remaining reference to the directed model
- [X] T100 [P] Rebuild `<dash>/src/admin/fuel_exchange/*` read-only for the platform operator — no raise, answer, award or withdraw control anywhere (FR-023). Two dead orphaned mocks deleted alongside (`AdminFuelExchangeContactInfo.tsx`, `AdminFuelExchangeRequestData.tsx`) — never imported by `AdminFuelExchangeDetailPage.tsx`, left behind by an earlier pass
- [X] T101 [P] Correct the stale `spec 013` / `Feature 013` citations in every fuel-exchange file to `spec 014` where they refer to the directed model, and to `spec 016` for new code — the requirements never lived in `specs/013-`. Fixed in `party-set-scope.plugin.ts`, `party-set.marker.ts`, `exchange-request.schema.ts`, `exchange-request-state.enum.ts`, `fuel-exchange.module.ts`, `error-code.enum.ts`'s exchange-code header, and the two pre-existing party-set test files. Left alone: the ~50 OTHER `spec 013`-labelled files across the platform citing the same wrong number for unrelated spec-014 work (billing, credit limits, litre balances) — genuinely the same defect, but out of THIS feature's scope to sweep
- [X] T102 [P] Verify Arabic/English key parity across `ar.json` and `en.json` and that every new string routes through `t()` (FR-036, SC-011) — 64/64 keys match under `fuelExchange`, verified by script
- [X] T103 Add `<dash>/tests/e2e/fuel-exchange-broadcast.spec.ts` — raise → two companies propose → award → the non-winner sees a closed offer naming no winner. Written and type-checked (mocked platform, `signin-code.spec.ts`'s own style); **not executed** — needs a running dev server, the same disclosed gap feature 015 left for T109/T110
- [X] T104 Run `npm run build`, `npm run test` and `npm run test:e2e`; record counts and any pre-existing failures in *Notes*
- [X] T105 Run `npx tsc -b --force` and `npx vitest run` in the dashboard; confirm the baseline is **no worse** — the same two suites failing to load and the same ~30 `TS6133`/`TS6192` errors feature 009 left. Confirmed: `tsc -b --force` **33** errors (same files, same codes); `vitest run` **116/116** real tests passing (103 baseline + 13 new), same 2 suites failing to load
- [ ] T106 Walk `quickstart.md` Parts 1–5 against a running server with the three-company seed; record results at the foot of that file. Part 1 is where SC-001 is observed — one submission reaching the market in under 60 seconds with no recipient chosen
- [ ] T107 **Pre-deploy, per environment**: run `scripts/migrate-exchange-requests-to-offers.ts` before this code deploys there, and verify `countDocuments({ migratedFromRequestId: {$exists:true}, openToMarket: true }) === 0`. One `true` publishes a historical private request to the whole market
- [ ] T108 **Pre-deploy**: run `flutter test` in the mobile repository to confirm the four new `NotificationType` values do not break spec 007's enum parity guard. The mobile repo is not on this machine; the test asserts on the enum, not on what the app displays, so an admin-only addition can still break it

---

## Dependencies

```text
Phase 1 (Setup)
   └─> Phase 2 (Slice 0 — isolation, schemas, migration)   ⚠️ GATE T026
          └─> Phase 3 (US1 raise)                          ← MVP
                 └─> Phase 4 (US2 propose, blind)
                        └─> Phase 5 (US3 award)
                               ├─> Phase 6 (US4 withdraw)
                               └─> Phase 8 (US6 summary)
                 └─> Phase 7 (US5 destination)  [parallel with 4-6 after US1]
   Phase 9 (Polish) — after the phases it touches
```

**Story dependencies**: US2 needs an offer to answer (US1). US3 needs proposals to award (US2). US4 and US6 need US3's resolved states to be meaningful. **US5 is independent of US2–US4** — it extends US1's offer and can proceed in parallel.

**Hard ordering that is not negotiable**: T026 gates everything; T062's conditional update must exist before T071 can prove anything; T107 precedes deployment, not merge.

## Parallel Execution Examples

**Phase 1** — T001, T002, T003, T004, T006, T007, T008 all touch different files and can run together.

**Phase 2** — after T009–T011 land, T012+T013 (proposal plugin), T015 (offer schema) and T016 (proposal schema) are parallel; T021, T022, T023 are parallel once their subjects exist.

**Phase 3** — backend T027–T038 and dashboard T039–T045 split cleanly across the two repositories once the contract in `rest-api-delta.md` is fixed.

**Across stories** — one developer on US5 (T084–T090) while another runs US2→US3 (T046–T077); they meet only in `create-offer.dto.ts` and `NewOfferForm.tsx`.

## Implementation Strategy

**MVP** = Phase 1 + Phase 2 + Phase 3 (US1). At that point an administrator raises one offer that reaches the market, which is the whole point of the feature; nobody can answer it yet.

**Increment 2** = US2 + US3 — the exchange becomes a working market with a closed race.

**Increment 3** = US4, US5, US6 — recoverability, destination detail, orientation.

**Deploy** = Increment 3 complete, T104–T106 green, and **T107 run in the target environment first**.

---

## Notes

**Task counts**: 119 total — Setup 8, Foundational 20, US1 23, US2 18, US3 18, US4 7, US5 7, US6 6, Polish 12.

**Implementation status (2026-09-06): 116 of 119 complete.** All 6 user stories built and
verified across both repositories. Backend: `npm run build` clean, `npx tsc --noEmit` clean,
`npm run test` **316/316** across 40 suites, `npm run test:e2e` **531-534/540** across 93 suites
(a shifting 6-9 suites fail on any given run, all pre-existing and unrelated to this feature —
see T104's own note; every fuel-exchange suite passed on every run). Dashboard: `tsc -b --force`
**33** errors, all pre-existing `TS6133`/`TS6192` unused-import errors in files this feature
never touched; `vitest run` **116/116** real tests (103 baseline + 13 new), same 2 pre-existing
suites failing to *load*. **Not completed — each needs something this session did not have**:
T106 (a running server for the manual quickstart walkthrough), T107 (a real target-environment
database to migrate), T108 (the mobile repository, not present on this machine).

**Letter-suffixed ids (T019a, T036a, …) were added by the 2026-09-06 analysis pass.** Existing ids were deliberately **not** renumbered: T026 is referenced as the gate in three places, and T050/T052/T062/T093 are cited by name in these Notes and in the dependency graph. The suffix convention matches the spec's own FR-005a/FR-014a style and spec 008's FR-030a-d amendment.

**Resolved by that pass** — eleven findings, of which four changed behaviour rather than wording:

- **The notification fan-out was specified in a way that could not work** (T036, T036a, T036b, T056a, T068). The obvious precedent's recipient lookup is tenant-scoped, so a faithful copy notifies the raiser's own administrators and tells no recipient company anything, with every "a notification exists" assertion still green.
- **FR-010 had no tasks and no existing mechanism** (T032a, T038a, T049a). Per-request suspension checks block the suspended company's own staff, not other companies answering its offer — which would leave an unawardable offer collecting proposals forever.
- **FR-019's negative case was untested** (T055a) and **FR-021's decline rule was ambiguous** (T081, T081a) — now two separate counts, no identities.
- **Migrated awards were readable but unattributable** (T019a, T023a).

**Watch-outs carried from planning**, each a place a plausible implementation is wrong:

- **T052 builds the payload from the viewer; it never strips afterwards.** A strip is one forgotten call site away from a competitor's price, and spec 008 shipped exactly that defect in `OrdersController.findMine`.
- **T062 must not read then write.** Feature 009's concurrent assignment passed both read-time filters under snapshot isolation and collided at commit as a 500.
- **T093's route order.** A literal segment registered after `:id` is swallowed by the param route — already documented on `GET /companies/exchange-partners`.
- **T032 keeps grade in the service, not the plugin.** Putting it in the injected filter needs the viewer's price list in every scoped query; freezing it breaks FR-006a. Recorded as research R2 and the first thing `/speckit-analyze` should re-examine.
- **T019/T107: `openToMarket: false` on migrated records is the whole of FR-039a.** No test that exercises only new offers can see a violation.

**Gate record (T026)**: Reviewed 2026-09-06. `test/unit/party-set-validation.spec.ts` (7
tests), `test/unit/proposal-scope.spec.ts` (9 tests) and `test/unit/exchange-migration.spec.ts`
(7 tests) all green. `test/e2e/exchange-offer-isolation.e2e-spec.ts` — all 9 cases (the
contract's 8 plus 6b) green over the three-fuel-company fixture. Confirmed no regression in
the pre-existing `test/unit/party-set-scope.plugin.spec.ts` (11 tests) and
`test/e2e/party-set-isolation.e2e-spec.ts` (8 tests) — the amended plugin stays
byte-compatible with `ExchangeRequest`'s two-party shape. One implementation gap found and
closed during this slice, not anticipated by the design docs: `ExchangeOffer.city` is a
required `GovernorateCode`, but the legacy `ExchangeRequest.deliveryPlaceText` migration
source is free text with no such code and no boundary dataset exists to derive one (the same
gap `migrate-multi-tier.ts` already documents for regions). Resolved the same way: every
migrated offer gets a provisional `GovernorateCode.RIYADH_CITY` with the original text
preserved verbatim in `notes`, and its id is surfaced in a new `needsCityReview` summary
field for a fuel company admin to confirm — never silently discarded, never guessed at as
fact. Phase 3 may proceed.

**Corrections found while implementing Phase 3** — a case where the design as written would
have shipped something plausible and wrong, caught only by T038's own e2e suite, not by
T037's mocked unit test:

- **Every service-layer `$or` on `ExchangeOffer` is silently discarded by the isolation
  plugin.** `party-set-scope.plugin.ts`'s injected filter calls
  `Query.where({ $or: [...] })` on EVERY scoped read; Mongoose's `where()` REPLACES an
  existing top-level key of the same name rather than combining it. `buildIncomingFilter`'s
  grade-relevance `$or` (T032), `findAll`'s `direction=all` `$or`, and `summary`'s
  `awardedThisMonth` `$or` all used a bare top-level `$or` and were each silently overwritten
  by the plugin's own — found when the lifecycle e2e test showed company C (diesel-only)
  receiving a PETROL_95 market offer in its `incoming` list, which T037's unit test could not
  see because it never registers the isolation plugin at all (the correct choice for a unit
  test, but it means this class of defect is only visible at the e2e level). Fixed by nesting
  every such disjunction under `$and: [{ $or: [...] }]` instead — a different top-level key
  the plugin's `where()` call cannot collide with. This is the same class of "silent until a
  three-way test" defect research R11 and R1 already warned about, arriving from an
  unanticipated direction: not the isolation mechanism itself, but a service-layer filter
  built on TOP of it.

**Corrections found while implementing Phase 5** — both caught only by T071's REAL
concurrency test, not by T070's mocked unit test:

- **`award` returned `201`, not the `200` the contract specifies.** A bare `@Post` decorator
  defaults to Nest's create-resource status; awarding resolves an EXISTING offer rather than
  creating one. Fixed with an explicit `@HttpCode(200)`.
- **A second award attempt naming the SAME (now-`AWARDED`) proposal came back a misleading
  `404`, not the `409 EXCHANGE_ALREADY_RESOLVED` FR-014a requires.** The proposal lookup was
  filtered to `outcome: PROPOSED`, so once a proposal won, re-naming it looked identical to
  naming one that never existed — the offer's own conditional `state: OPEN` update, the actual
  race guard, was never reached. Fixed by dropping the outcome filter from the lookup (a
  `DECLINED` proposal is the only outcome refused there, since nothing about a decline is ever
  awardable) and letting the offer's conditional update alone decide "already resolved," at
  any offer state.

**Corrections found while implementing Phase 6**:

- **A withdrawn (or otherwise resolved) offer kept reaching every company's default
  `incoming` list**, contradicting FR-016's "MUST stop reaching every company" outright.
  `buildIncomingFilter` never touched `state` at all, so a company's default view mixed
  currently-answerable offers with every closed one it was ever eligible for. Fixed by
  defaulting `incoming`'s `state` to `OPEN` when the caller passes none — an explicit
  `?state=` still overrides this for a company reviewing its own history. `outgoing`/`all`
  are deliberately NOT defaulted this way: the raiser's own tracking (this Story's whole
  point) needs its full history, open or closed.
- **The raiser's own detail and list payloads leaked a declining company's identity**,
  found only by writing T081a's own test — the exact "found only by the test built to
  disprove it" pattern this feature's `/speckit-analyze` pass already flagged once (FR-021
  is a split of FR-011b for a reason). Two independent leaks, not one: `buildDetail`
  unconditionally resolved and attached full `company` contact details for EVERY proposal
  regardless of outcome, and — separately, and worse, because it survived fixing the
  first — `toProposalShape` always included the raw `proposingCompanyId` field even with
  no `company` object attached, which identifies a company exactly as well as its name
  does. Fixed by gating BOTH behind one explicit `revealIdentity` flag, false for any
  `DECLINED` proposal in the raiser's own view.

**T104 results (2026-09-06)**: `npm run build` clean. `npx tsc --noEmit` clean. `npm run test`
**316/316** across 40 suites — no regressions from the `isDuplicateKeyError` extraction
touching `dispatch.service.ts`/`ratings.service.ts`/`payments.service.ts`, nor from the two
new `CompaniesService` methods. `npm run test:e2e` (`--runInBand`, 93 suites / 540 tests):
every fuel-exchange suite (isolation, lifecycle, blindness, award-race, destination — 9
files, ~45 tests across two full runs) passed on every run. **9 suites failed on one full
run and a different 6 on another** — `region-assignment`, `login-code`, `dispatch-selection`,
`admin-multi-session`, `login-abuse`, `file-storage`, `request-logging`,
`phone-verification`, `admin-password-recovery` — none of them touch fuel-exchange, none
import a file this feature modified, and re-running three of them together in isolation
reproduced the same failures deterministically-yet-differently across runs. This is the
exact pre-existing flakiness `CLAUDE.md` already documents for this suite ("accumulated
resource pressure from dozens of sequential `MongoMemoryReplSet`+Redis apps in one
`--runInBand` process, not a defect" — feature 011's own finding), not a regression this
feature introduced. `file-storage.e2e-spec.ts`'s one failure is a separate, also
pre-existing Windows path-separator mismatch (`sys_storge\\...` vs an assertion expecting
`sys_storge/...`), reproducible in total isolation, in a file this feature never touched.
