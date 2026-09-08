# Research: Broadcast Fuel Exchange Offers

**Feature**: 016-broadcast-fuel-exchange | **Date**: 2026-09-06

Twelve decisions. R1, R2, R3, R5 and R8 each overturn something the spec, the approved design, or the existing code assumed.

---

## R1 — Isolation: amend `party-set-scope`, do not add a fourth mechanism

**Decision**: `ExchangeOffer` carries `partyCompanyIds` (as today) **plus** `openToMarket: boolean`. The plugin's injected filter for a `FUEL_COMPANY_ADMIN` becomes:

```
{ $or: [ { partyCompanyIds: actingCompanyId }, { openToMarket: true } ] }
```

Its `pre('save')` validation splits on the same flag: `openToMarket: true` requires **exactly one** party (the raiser, who must be the acting company); `openToMarket: false` requires **exactly two**, including the acting company — the rule shipped today, unchanged, which is what migrated records rely on.

**Rationale**: The platform has three global isolation mechanisms and each exists because no earlier one could express a shape: one owner (`tenant-scope`), one owner plus role-narrowed viewers (`multi-party-scope`), exactly two owners (`party-set-scope`). A market offer is one owner plus an unbounded audience — genuinely a fourth shape, but it differs from the third by one boolean, lives in the same collection as the migrated records that need the third, and after migration `party-set-scope` has no other consumer. Amending keeps the count at three.

**Alternatives considered**:
- *A fourth plugin.* Four global mechanisms, two of them registered against the same collection family and differing by one flag. The isolation contract's own argument for narrowness cuts against this.
- *Materialise `eligibleCompanyIds` at raise time.* Directly violates FR-006a: a company onboarded while an offer is open would never see it, silently and permanently.
- *Drop the plugin and filter in the service.* Principle II forbids it in as many words.

**Consequence to test**: the migrated-unanswered-request case. `openToMarket: false` is the only thing standing between a private directed request and the whole market on deploy day (FR-039a).

---

## R2 — Grade eligibility is a relevance filter, not a confidentiality boundary

**Decision**: The isolation layer admits any `FUEL_COMPANY_ADMIN` to a market offer. Whether the acting company **sells the grade** is applied by `FuelExchangeService` as a filter on *listing* queries (FR-007) and as a guard on *proposing* (`EXCHANGE_GRADE_NOT_SOLD`). A company that does not sell the grade and fetches a market offer by id receives it, and cannot act on it.

**Status**: FR-006 and FR-007 were **amended after the analysis pass** to state this directly, so this is no longer an interpretation the code carries alone — the spec now names company type and audience as the boundary, and grade as a relevance rule.

**Rationale**: FR-006 originally read "visible to every fuel company that is eligible … and to no other company or role". Two readings were available; only one is implementable. Making grade part of the injected filter requires the acting company's sold grades inside every scoped query — a `Company` read per request, or a frozen list that breaks FR-006a. And the boundary grade would be protecting is not a confidentiality boundary at all: an offer is deliberately published to the market, so a fuel company learning that diesel is on offer learns nothing it was not entitled to learn. The real boundaries — company type, the legacy two-company audience, and proposal ownership — all remain structural.

**Alternatives considered**:
- *Async `pre` hook resolving grades per query with a memoised cache.* Workable (Mongoose middleware may return a promise), but it puts an I/O dependency inside the isolation path for a rule that is not an isolation rule, and a cache miss during a Mongo interruption would decide visibility.
- *Refuse the read by id.* Would make an offer's existence depend on the reader's price list, and FR-022 then requires that refusal to be indistinguishable from absence — a 404 for a record that is deliberately public.

**Recorded as an interpretation of FR-006/FR-007, not a deviation from them.** It is the first thing `/speckit-analyze` should re-examine.

---

## R3 — Proposals are their own collection, never embedded on the offer

**Decision**: `ExchangeProposal` is a separate collection with its own registered scope rule:

```
{ $or: [ { proposingCompanyId: acting }, { offerRaisedByCompanyId: acting } ] }
```

`offerRaisedByCompanyId` is denormalised onto the proposal so the filter needs no join — a scope filter that requires a lookup is a scope filter that will be bypassed.

**Rationale**: FR-011b says a responder must not learn that anyone else answered. An embedded array travels with **every** read of its parent document, so blindness would then depend on a projection at every call site that ever loads an offer — and this codebase has already shipped that exact defect: spec 008's `OrdersController.findMine` leaked the full verification trail because the strip lived at one endpoint instead of a shared one. Feature 011 embedded `StopEvent` for the opposite reason (embedding *prevented* a cross-order query). Here the requirement is inverted, so the shape inverts with it.

**Alternatives considered**:
- *Embedded array with a shared projection helper.* One forgotten call site is a competitor's price. The failure is silent and the data is commercially sensitive.
- *Embedded, with prices encrypted.* Solves nothing — the raiser must read them, so the key is on the same server.

---

## R4 — The award is one conditional update inside a transaction

**Decision**: Awarding runs in a `ClientSession` transaction: a conditional `updateOne({ _id, state: OPEN }, { state: AWARDED, awardedProposalId, agreedUnitPrice, agreedTotal, currency, resolvedAt, resolvedBy })`, then the winning proposal's outcome stamp, then the losing proposals' `NOT_SELECTED` stamp. `modifiedCount === 0` on the first update means somebody else won: `409 EXCHANGE_ALREADY_RESOLVED`. Separately, a **unique index on `(offerId, proposingCompanyId)`** enforces one proposal per company (FR-011c, FR-018).

**Rationale**: Constitution V requires concurrency safety at the data layer. Feature 009 learned this the expensive way — two concurrent assignments both passed their own read-time filter under snapshot isolation and collided only at commit, surfacing as a 500 rather than a 409. A read-then-write award has the identical shape. Feature 011's escalation stamp is the working precedent: fold the guard into the same conditional write that performs the change, and let `modifiedCount` decide.

**Alternatives considered**: an application-level lock (no durability across instances — feature 012 made multi-instance real); optimistic versioning (equivalent, but a second concept where a state predicate already exists).

---

## R5 — Migration must not widen an audience, and must run before the code

**Decision**: `scripts/migrate-exchange-requests-to-offers.ts` converts each `ExchangeRequest` into one `ExchangeOffer` with `openToMarket: false`, `partyCompanyIds` unchanged, plus one `ExchangeProposal` from the original recipient. Idempotent via a unique sparse index on `migratedFromRequestId`. State mapping:

| `ExchangeRequestState` | Offer state | Proposal outcome |
|---|---|---|
| `AWAITING_RESPONSE` | `OPEN` (audience-restricted) | none — the recipient may still answer |
| `ACCEPTED` | `AWARDED` | `AWARDED`, price copied to `agreedUnitPrice` |
| `DECLINED` | `CLOSED_NO_AWARD` | `DECLINED` |
| `WITHDRAWN` | `WITHDRAWN` | none |

The original collection is **retained, read-only, not dropped**, until the migration is verified in that environment.

**Rationale**: This is the feature's one irreversible step. A naive conversion — every request becomes a market offer — would publish every historical private request, including unanswered ones, to every fuel company the moment the code deploys. `openToMarket: false` is what prevents it and is asserted by SC-010. Running order matters for the same reason feature 015's phone normalisation had to precede its index build: the new read path exists only after deploy, so the data must already be in the new shape.

**Alternatives considered**: a dual-read compatibility layer (two live read paths through an isolation boundary — the thing most likely to disagree); leaving old records unmigrated behind the old endpoints (FR-040 removes those endpoints, so the records would become unreachable).

---

## R6 — Notifications: four new types, fan-out bounded by company count

**Decision**: Add `EXCHANGE_OFFER_AVAILABLE`, `EXCHANGE_PROPOSAL_RECEIVED`, `EXCHANGE_OFFER_AWARDED`, `EXCHANGE_OFFER_CLOSED` to `NotificationType`, delivered through the existing notification path (document + socket emit). Raising an offer fans out to the administrators of every eligible fuel company; awarding notifies the winner and, separately, each non-winner with a payload that names **no** company and **no** price (FR-015, FR-031).

**Rationale**: FR-029/030/030a are new behaviour, not a reuse — the shipped exchange module emits no notification of any kind, which is why the current screen only tells a company something arrived if the administrator happens to open it.

**The recipient lookup is the trap, and it is silent.** `NotificationsService.notify` addresses exactly **one `recipientUserId`**, so the caller resolves the recipients itself. The obvious precedent — `SupportService.notifyFuelCompanyAdmins` — resolves them with `usersService.findAll({ role: FUEL_COMPANY_ADMIN, isActive: true })`, and that call is **tenant-scoped**: it returns the *acting* company's administrators. Copied faithfully here, raising an offer would notify the raiser's own administrators and no recipient company would ever be told, while every test asserting "a notification was created" passed. This feature therefore needs an explicit cross-tenant resolution inside `runUnscoped` — a deliberate isolation bypass, written and reviewed as one — and each notification must be stamped with the **recipient's** `companyId`, which `notify` accepts explicitly and preserves under `runUnscoped` for exactly this reason.

**Fan-out size**: bounded by *companies × administrators per company*, not by company count alone — twenty companies with three administrators each is sixty documents and sixty socket emits inside the raise request. At the platform's present scale that stays inline, as `SupportService` already does with `Promise.all`; it is the multiplier, not the company count, that would decide otherwise.

**Every recipient is an administrator, so every one of these notifications is a dashboard notification.** The dashboard is admin-only and the mobile applications have no admin persona — a `FUEL_COMPANY_ADMIN` never signs in on a handset. No mobile surface renders these types, and none should be designed for.

**Gate**: spec 007 nevertheless pins the Flutter `NotificationType` enum to the backend's wire values with a parity test, and that test asserts on the enum rather than on what the app displays — so an admin-only addition can still break it. The four additions are additive, but the mobile repository is not on this machine: `flutter test` MUST run before deploy, the same unresolvable-here gate feature 015 recorded.

---

## R7 — Price lives on the proposal; the agreed figures are frozen at award

**Decision**: `ExchangeOffer` carries no price. `ExchangeProposal` carries `unitPrice` + `currency` (`DEFAULT_CURRENCY`). On award, the offer stores `agreedUnitPrice`, `agreedTotal`, `agreedQuantityLitres` and `currency` as at that moment.

**Rationale**: FR-014c. Recomputing a total from a live proposal after the fact means an agreement whose figures can move if anything upstream is ever edited; feature 005 froze pricing config onto orders for the same reason. Freezing also gives the detail screen one number to render rather than a computation it could round differently from the backend.

---

## R8 — The design's second location field is a neighbourhood, and must not be labelled المنطقة

**Decision**: City binds to the existing `GovernorateCode` enum (the Figma's جدة is a governorate). The second field is free text, labelled **الحي** in Arabic and *Neighbourhood* in English — deliberately **not** the Figma's المنطقة. `locationUrl` is validated server-side to `http`/`https` only; `notes` is length-capped. All four render as text.

**Rationale**: The platform already uses المنطقة for its 13 administrative regions (`RegionCode`), in routing, the station form and transporter assignment. A form where المدينة means a governorate and المنطقة means a neighbourhood puts two meanings of one word in one panel, and the value the user picks would not be the value the rest of the platform means by it. This is a deliberate deviation from the approved design's label, and the only one.

**Also decided**: these four fields are *new persistence*, not the mock's return. Feature 014's T232 deleted the identical inputs because nothing stored them; FR-024 supplies the storage, which is what makes re-adding them legitimate.

---

## R9 — The summary counts need a real endpoint

**Decision**: Add `GET /fuel-exchange/offers/summary` returning the three counts. The dashboard's current cards count the loaded page of two list queries.

**Rationale**: FR-033 requires counts over every matching offer, and the shipped component's own comment concedes it counts a page because "no aggregate endpoint" exists. Feature 009 hit this exactly once before and added `GET /orders/summary`; this is that precedent, not a new pattern. "Awarded this month" additionally cannot be derived from a page at all.

---

## R10 — `GET /companies/exchange-partners` is removed with the selector

**Decision**: Delete the endpoint and its service method along with the recipient selector (FR-040).

**Rationale**: It exists solely to populate the selector this feature removes — its own comment says it is "the only way a fuel company can discover a fuel-exchange counterparty". Leaving it is a live route that enumerates other companies for a capability that no longer exists.

---

## R11 — Slice 0 is the isolation change alone

**Decision**: Isolation amendment, both schemas, the proposal plugin, the migration script and a three-company isolation e2e suite land with no endpoint and no screen, behind a review gate.

**Rationale**: Feature 014's T217 established the pattern and stated why: a wrong scope rule on this collection family fails silently, every single-company test passes, and `SUPER_ADMIN`'s bypass makes the operator's own screen look correct throughout. This feature widens the blast radius — the shape now includes an unbounded audience and a second collection holding commercially sensitive prices — so the gate applies with more force, not less. **The suite needs a three-company fixture**; the existing exchange fixture has two.

---

## R13 — A suspended raiser is resolved at action time, never stamped on the offer

**Decision**: An offer whose raising company is suspended is excluded from every other company's incoming list and cannot be answered (FR-010); it stays readable to anyone already party to its award. Suspension is resolved **at action time** from `Company.status`, never denormalised onto the offer. The listing resolves it with one cheap query for the suspended fuel company ids and a `raisedByCompanyId: { $nin: … }` clause — not a `$lookup`, which would sit inside a keyset-paginated query.

**Rationale**: The platform *does* enforce suspension, but only against the suspended company's own people: `UsersService._loadActiveUser` re-checks `COMPANY_SUSPENDED` on every authenticated request. That blocks a suspended company's administrators from acting — and does nothing to stop *other* companies answering an offer the suspended company raised. Left alone, such an offer stays open indefinitely, keeps drawing proposals, and can never be awarded, because the only party entitled to award it cannot sign in. FR-010 has no existing mechanism behind it.

A stamped flag was rejected because `status` flips both ways: a company reinstated after suspension would leave every one of its offers permanently marked, with nothing to unmark them.

---

## R12 — Blindness is proven by asserting on payloads, not on screens

**Decision**: The blindness suite asserts on raw response bodies — that a responder's offer read, offer list and any detail payload contain no proposal array, no rival price, no proposal count and no rival company name — and does the same for the notification payloads of FR-015.

**Rationale**: FR-011b is a property of what a company can obtain, not of what a page draws. A dashboard test proves only that one component chose not to render a field it was handed. Feature 008's leak was invisible for the same reason: the data was in the response the whole time.
