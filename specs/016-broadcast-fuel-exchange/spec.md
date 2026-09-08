# Feature Specification: Broadcast Fuel Exchange Offers

**Feature Branch**: `016-broadcast-fuel-exchange`

**Created**: 2026-09-06

**Status**: Draft

**Input**: User description: "Broadcast fuel exchange offers: a fuel company administrator raises ONE exchange offer from the inter-company fuel exchange screen and it reaches every other fuel company on the platform at once, instead of naming a single recipient company. Rebuild the create form to the approved Figma design."

## Context

The platform already lets a fuel company administrator raise a fuel exchange request **to one named counterparty** (feature 014, Story 12). That capability is built, tested and live: the raiser picks a company, states grade, quantity, unit price, delivery time and delivery place; the named company sees it as incoming and accepts, declines, or lets the raiser withdraw it.

This feature **replaces that model with a market**. An administrator with fuel to move states their terms once, without naming anyone; every eligible fuel company sees the offer and may answer it **with a price**; the raiser reviews the answers and awards the offer to one company.

Three consequences make this a feature rather than a refactor:

1. **Ownership stops being a pair.** Every guarantee in feature 014 — who may read a request, which side is "incoming", who may accept it, whose contact details are disclosed — is derived from a record owned by exactly two companies. An offer addressed to everyone has no second party until the raiser awards it.
2. **Price moves from the offer to the answer.** The raiser no longer sets a price. Each responding company proposes one, and the agreed price is whichever proposal is awarded. Acceptance therefore becomes a two-step act — propose, then award — where it used to be one.
3. **The approved design captures destination detail the platform has never stored.** The Figma form asks for city, district, a geographic location link and free-text notes. Feature 014 deliberately **deleted** those same inputs from this screen because nothing persisted them; a version that shows them without storing them would restore exactly the mock this screen was rebuilt to remove.

Feature 014's rule that an accepted exchange **creates no delivery, order or transport assignment** is unchanged and still binds. The platform records agreed terms and outcomes; the two companies arrange fulfilment between themselves.

## Clarifications

### Session 2026-09-06

- **Q: Does an offer state a unit price?** → **A: No — each responding company proposes a price with its answer.** The raiser states grade, quantity, delivery time and destination; price is what the market answers with. The agreed price is the awarded proposal's price (FR-005a, FR-011a).
- **Q: What becomes of an offer for other companies when one answers?** → **A: Proposals accumulate and the raiser awards one.** An answer does not close the offer; the raiser reviews the proposals and picks a single winner, at which point the offer is resolved for everyone (FR-014, FR-014a).
- **Q: Do directed requests survive alongside broadcast?** → **A: No — broadcast replaces them, and existing records are migrated.** A directed request becomes an offer that already carries one proposal and its outcome. Migration runs per environment before the change deploys there (FR-039, FR-039a, FR-040).

### Session 2026-09-06 (post-analysis)

Two requirements were amended after the cross-artifact analysis found the spec text contradicting its own implementable design:

- **FR-006 / FR-007 rewritten.** The original FR-006 said an offer is visible to eligible companies "and to no other company or role", which read together with FR-007 made *grade* a confidentiality boundary. It cannot be one: enforcing it structurally requires the viewer's price list inside every scoped query, and freezing it at raise time breaks FR-006a outright. The boundary is now stated as **company type and audience**, with grade as a relevance rule governing the incoming list and the right to answer. FR-006b makes the migrated-record audience explicit in the same place.
- **FR-021 split, FR-021a added.** "Nothing about declines beyond that they occurred" could not be reconciled with the spec's own edge case requiring the raiser to distinguish "no answers yet" from "everybody said no". The raiser now sees two separate counts and no declining company's identity.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Raise one offer to the whole market (Priority: P1)

A fuel company administrator has fuel to supply. They open the fuel exchange screen, state the grade, quantity, delivery time and destination, and send. The offer reaches every other fuel company on the platform that could act on it, without the administrator naming anyone and without stating a price.

**Why this priority**: This is the feature. Nothing else in this specification has meaning until an offer can exist without a named recipient, and the addressing change is the one that invalidates the existing ownership model — so it lands first and alone.

**Independent Test**: With three fuel companies on the platform, company A raises one offer. Companies B and C each see it in their incoming list; company A sees exactly one outgoing offer, not two. No other company type sees anything.

**Acceptance Scenarios**:

1. **Given** an administrator of fuel company A, and companies B and C also on the platform, **When** A raises an offer with valid terms, **Then** the offer is recorded once, appears as outgoing to A and as incoming to B and C, and A is never asked to choose a recipient or to state a price.
2. **Given** the same offer, **When** an administrator of transport company T, a station owner, or a driver opens any screen, **Then** the offer is not visible to them anywhere.
3. **Given** company A is the only fuel company selling the named grade, **When** A attempts to raise an offer, **Then** the platform refuses and states that no company is eligible to receive it.
4. **Given** an administrator submits an offer with a quantity of zero or a delivery time in the past, **When** they send it, **Then** the platform refuses and states which term is invalid.

---

### User Story 2 - Answer an offer with a price (Priority: P2)

An administrator at a company that received an offer opens it, sees the terms and the destination, and answers — either proposing a unit price at which it will supply, or declining. It cannot see whether anyone else has answered, or at what price.

**Why this priority**: An offer nobody can answer delivers no value. It is testable on its own once P1 exists, and it is the half of the exchange that carries the commercial content.

**Independent Test**: Companies B and C each propose a different price against A's offer; neither can see the other's proposal or that it exists; A sees both.

**Acceptance Scenarios**:

1. **Given** an open offer from A visible to B and C, **When** B proposes a price, **Then** the proposal is recorded against the offer with its currency, and the offer stays open to C.
2. **Given** B has proposed, **When** C opens the same offer, **Then** C sees no indication that B answered, how many companies answered, or at what price.
3. **Given** B has proposed, **When** B attempts to propose again, **Then** the platform refuses and states B has already answered.
4. **Given** an open offer, **When** C declines it, **Then** it leaves C's incoming list, the offer remains open to every other company, and C cannot answer it again.
5. **Given** an administrator proposes a price of zero or less, **When** they submit, **Then** the platform refuses and states the price is invalid.

---

### User Story 3 - Review the answers and award the offer (Priority: P3)

The raising administrator sees every proposal against their offer, each with its price, total and the proposing company, and awards the offer to one of them. That single act creates the agreement, discloses each side to the other, and closes the offer for everybody else.

**Why this priority**: This is where an offer becomes an agreement. It depends on P2 existing to have anything to review, but it is independently demonstrable and it carries the feature's hardest correctness rule — that an offer is awarded exactly once.

**Independent Test**: A reviews B's and C's proposals, awards B, and confirms the agreement exists between A and B alone, that C is told the offer closed without learning who won, and that a second award attempt is refused.

**Acceptance Scenarios**:

1. **Given** proposals from B and C, **When** A opens the offer, **Then** A sees each proposal's company, unit price with currency and resulting total, and may award exactly one.
2. **Given** A awards B, **Then** the offer is resolved, A and B can each see the other's contact details and the agreed terms including the awarded price, and no further proposal or award is possible.
3. **Given** A awarded B, **When** A attempts to award C, **Then** the platform refuses and states the offer is already resolved.
4. **Given** two administrators of company A award two different proposals at the same instant, **Then** exactly one award stands and the other attempt is refused as already resolved.
5. **Given** A awarded B, **When** C looks at the offer, **Then** C is told the offer closed and was awarded elsewhere, without learning which company won or at what price.
6. **Given** an awarded offer, **When** either party opens it, **Then** no delivery, order or transport assignment exists anywhere on the platform as a result.

---

### User Story 4 - Withdraw and track your own offers (Priority: P4)

The raising administrator sees their outgoing offers and how many answers each has drawn, and can withdraw an offer that has not been awarded.

**Why this priority**: Recoverability from a mistaken or stale offer. Valuable but not blocking — an offer with wrong terms can be left unawarded without it.

**Independent Test**: A raises an offer, withdraws it, and confirms it disappears from every other company's incoming list and can no longer be answered or awarded.

**Acceptance Scenarios**:

1. **Given** an unawarded offer raised by A, **When** A withdraws it, **Then** it stops being visible as incoming to every company, no company can answer it, and any company that already proposed is told it was withdrawn.
2. **Given** an offer A has already awarded, **When** A attempts to withdraw it, **Then** the platform refuses and states it is already resolved.
3. **Given** administrators may filter, **When** one selects incoming, outgoing or both, **Then** only offers matching that direction are listed, with direction determined by whether their own company raised it.

---

### User Story 5 - State where the fuel is going (Priority: P5)

The administrator records the destination in the detail the approved design asks for — city, district, a geographic location link and free-text notes — and every company that sees the offer sees that detail.

**Why this priority**: Destination detail is what lets a receiving company price an offer sensibly, and it is the half of the approved design the platform cannot render today. It is separable: an offer carrying only a city is still answerable.

**Independent Test**: A raises an offer with city, district, location link and notes; B opens it and sees all four exactly as entered, with no text interpreted as markup.

**Acceptance Scenarios**:

1. **Given** the create form, **When** the administrator selects a city, **Then** the choices come from the platform's own established city vocabulary rather than free text.
2. **Given** an offer carrying a location link and notes, **When** any receiving company opens it, **Then** both are shown, and any characters that could be interpreted as markup are shown as literal text.
3. **Given** an administrator leaves district, location link and notes empty, **When** they send, **Then** the offer is accepted — these are optional detail, not required terms.

---

### User Story 6 - See the state of exchange at a glance (Priority: P6)

The screen shows three counts alongside the create form: offers awaiting this company's answer, this company's own offers still open, and offers awarded this month.

**Why this priority**: Orientation, not capability. Every number it shows is also derivable by reading the list.

**Independent Test**: With a known set of offers across three companies, each of the three counts matches a hand count, and the awarded count includes only the current calendar month.

**Acceptance Scenarios**:

1. **Given** offers in several states, **When** an administrator opens the screen, **Then** each count reflects every offer in that state, not only those on the visible page of the list.
2. **Given** an offer awarded in the previous calendar month, **When** the administrator views the counts, **Then** it is excluded from the awarded-this-month figure.

---

### Edge Cases

- A company is suspended or removed from the platform while one of its offers is open, or while holding a proposal against someone else's — the offer must stop being answerable, and companies already party to an award must not lose the record.
- A company joins the platform after an offer was raised — FR-006a settles whether the offer reaches it.
- An administrator raises the identical offer twice by double-submitting — the platform must not create two offers from one intent.
- Two administrators of the raising company award different proposals simultaneously — exactly one award stands (US3 scenario 4).
- A company proposes at the same instant the raiser withdraws the offer — the outcome must be one of the two, stated, never a proposal recorded against a withdrawn offer.
- The raising company's own administrator opens the incoming list — their own offer must never appear there, and the raiser must never be able to propose against it.
- An offer draws no proposals at all and its delivery time passes.
- Every company that received an offer declines it — the raiser must be able to tell "no answers yet" from "everybody said no" without learning who declined (FR-021).
- The dashboard is opened in English rather than Arabic — every label, state and refusal introduced here must be translated.

## Requirements *(mandatory)*

### Functional Requirements

#### Raising an offer

- **FR-001**: A fuel company administrator MUST be able to raise an exchange offer without naming a recipient company.
- **FR-002**: An offer MUST state the fuel grade, the quantity with its unit, and the delivery time.
- **FR-003**: An offer MUST record which company and which administrator raised it, and when.
- **FR-004**: An offer with a quantity of zero or less, or a delivery time in the past, MUST be refused with the reason stated.
- **FR-005**: The platform MUST refuse an offer when no other fuel company is eligible to receive it, and state that as the reason.
- **FR-005a**: An offer MUST NOT carry a unit price. Price is proposed by each responding company (FR-011a); the agreed price is that of the awarded proposal (FR-014).

#### Who an offer reaches

- **FR-006**: A market offer MUST be readable by every fuel company on the platform other than the raising company, and by no other company type and no other role. The confidentiality boundary is **company type and audience** — an offer put to the market is not confidential between any two of its participants.
- **FR-006a**: Who may see and answer an offer MUST be evaluated when a company acts, not frozen at the moment the offer was raised — so a fuel company onboarded while an offer is open can see and answer it.
- **FR-006b**: A migrated directed offer MUST be readable only by its two original parties, and by no other fuel company (see FR-039a).
- **FR-007**: A fuel grade a company does not sell is a **relevance** rule, not a confidentiality rule. An offer naming such a grade MUST NOT appear in that company's incoming list and MUST NOT be answerable by it; it MUST NOT prevent the offer reaching companies that do sell the grade; and reading it directly MUST be permitted, since it discloses nothing beyond terms already published to the market.
- **FR-008**: A company MUST see an offer as incoming when another company raised it, and as outgoing when its own company raised it; direction MUST be determined per viewer at the time of reading and never stored per company.
- **FR-009**: The raising company MUST NOT see its own offer as incoming, and MUST NOT be able to answer it.
- **FR-010**: An offer raised by a company that is later suspended MUST NOT be answerable or awardable, and MUST remain readable to any company already party to its award.

#### Answering an offer

- **FR-011**: A company an offer reaches MUST be able to answer it while it is open, either by proposing to supply it or by declining.
- **FR-011a**: A proposal MUST state a unit price with its currency, and MUST be refused if that price is zero or less.
- **FR-011b**: A responding company MUST NOT be able to see any other company's proposal, its price, or that any other company has answered.
- **FR-011c**: A company MUST answer an offer at most once; a second answer MUST be refused, stating the company has already answered. A decline is final for that company.
- **FR-012**: Answering MUST NOT resolve the offer. An offer stays open to every other eligible company until it is awarded or withdrawn.
- **FR-013**: A company declining an offer MUST remove it from that company's own incoming list without affecting any other company's ability to answer it.

#### Awarding an offer

- **FR-014**: The raising company MUST be able to review every proposal against its own offer — each with the proposing company, the unit price with currency and the resulting total — and award the offer to exactly one of them.
- **FR-014a**: An offer MUST be awarded exactly once. A second award attempt MUST be refused as already resolved, stating so, including when two attempts are made simultaneously.
- **FR-014b**: Awarding MUST close the offer: no further proposal, decline, award or withdrawal is possible afterwards.
- **FR-014c**: An awarded offer MUST identify which company supplies and which receives, and MUST record the agreed unit price, quantity, total and currency as at the moment of award.
- **FR-015**: Every company that proposed and was not awarded MUST be told the offer closed, without learning which company was awarded it or at what price.
- **FR-016**: The raising company MUST be able to withdraw an offer that has not been awarded; a withdrawn offer MUST stop reaching every company, MUST NOT be answerable or awardable afterwards, and every company that had proposed MUST be told it was withdrawn.
- **FR-017**: An awarded offer MUST NOT create a delivery, an order, or a transport assignment on the platform. The delivery time and destination on an offer are terms of an agreement between two companies, not instructions the platform acts on.
- **FR-018**: One submission MUST produce at most one offer, and one answer MUST produce at most one proposal, even if submitted more than once in quick succession.

#### Disclosure and isolation

- **FR-019**: Before an offer is awarded, it MUST NOT disclose contact details of the raising company beyond the company's own name.
- **FR-019a**: On award, and only then, the raising company and the awarded company MUST each be able to see the other's contact details.
- **FR-020**: A proposing company's identity and price MUST be disclosed to the raising company only, and only once that company has proposed.
- **FR-021**: A company MUST NOT be able to discover which other companies an offer reached, which of them answered, which declined, or at what prices.
- **FR-021a**: The raising company MUST see, against its **own** offers only, the content of every proposal, a count of proposals, and a **separate count of declines**. It MUST NOT see the identity of any declining company. The two counts are separate so the raiser can tell "no answers yet" from "everybody said no", which is the whole of what it may learn about a decline.
- **FR-022**: A refusal to read an offer or a proposal a company is not party to MUST NOT reveal whether it exists.
- **FR-023**: The platform operator MUST be able to see every offer, its proposals and its award for oversight, without being able to raise, answer or award one.

#### Destination and notes

- **FR-024**: An offer MUST be able to carry a city drawn from the platform's established city vocabulary, a district, a geographic location link, and free-text notes.
- **FR-025**: District, location link and notes MUST be optional; an offer without them MUST be accepted.
- **FR-026**: Every one of these values MUST be shown to each company the offer reaches, exactly as entered.
- **FR-027**: Text entered by any company MUST NOT be rendered as markup on any screen.
- **FR-028**: A geographic location link MUST be recognisable as a link and MUST NOT be presented as a location the platform has verified.

#### Awareness

- **FR-029**: A company MUST be told that an offer is waiting for its answer without having to open the exchange screen to discover it.
- **FR-030**: A raising company MUST be told when its offer draws a proposal.
- **FR-030a**: A proposing company MUST be told when the offer it answered is awarded to it, awarded elsewhere, or withdrawn.
- **FR-031**: Being told about an offer MUST NOT disclose anything a company is not entitled to see under FR-019 to FR-022.

#### The screen

- **FR-032**: The create form MUST match the approved design: one always-visible panel carrying delivery time, fuel grade, a quantity control with increment and decrement, city, district, location link, notes, and a summary row, with send and cancel actions. It MUST NOT ask for a recipient company or a price.
- **FR-032a**: The summary row on the create form MUST state the quantity and grade being offered. It MUST NOT show a monetary total, because no price exists until a company proposes one. Totals appear against each proposal (FR-014) and on an awarded offer (FR-014c).
- **FR-033**: The three summary counts — offers awaiting this company's answer, this company's own open offers, and offers awarded in the current calendar month — MUST be shown together with the create form and MUST count every matching offer, not only those on the loaded page of the list.
- **FR-034**: The administrator MUST be able to list offers as incoming, outgoing, or both.
- **FR-035**: Every screen introduced or rebuilt here MUST distinguish loading, empty and error states, and an error state MUST offer a retry that does not require a page reload.
- **FR-036**: Every screen introduced or rebuilt here MUST be fully bilingual, Arabic by default with right-to-left layout, and English.
- **FR-037**: Every monetary amount MUST state its currency and every quantity its unit.
- **FR-038**: Grades, offer states and answer outcomes MUST be presented from a single defined vocabulary, never free text typed into a screen.

#### Replacing the directed model

- **FR-039**: Every exchange request raised under the previous directed model MUST be migrated into an offer carrying exactly one proposal — the original recipient's — with its original terms, price, outcome and timestamps preserved and readable by both original parties.
- **FR-039a**: A migrated record MUST remain visible **only to its two original parties**, whatever its state. A directed request that was never answered MUST NOT become visible to the wider market, and MUST remain answerable only by its original recipient.
- **FR-039b**: The migration MUST run against each environment before this change is deployed there, and the platform MUST behave correctly if it is run twice.
- **FR-040**: Raising a new directed request to one named company MUST no longer be possible. No screen may offer it, and the recipient selector MUST be removed from the create form.

### Key Entities

- **Exchange Offer**: Terms one fuel company puts to the market — grade, quantity, delivery time, destination, optional notes, the raising company and administrator, when it was raised, and its state (open, awarded, withdrawn). Carries no price.
- **Proposal**: One company's answer to one offer — the proposing company, a unit price with its currency, or a decline, and when it was made. An offer has at most one proposal per company and as many proposals as companies that answered.
- **Award**: The raiser's selection of exactly one proposal, which creates the agreement between those two companies and fixes the agreed price, quantity, total and currency at that moment.
- **Fuel Company**: Already exists. Supplies the roster an offer reaches and the grades each company sells, which together decide eligibility.
- **Destination**: A city from the platform's established vocabulary, an optional district, an optional geographic link — held as terms of an offer, never as a place the platform routes to.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator can put an offer in front of every eligible company on the platform in a single submission, in under 60 seconds, without choosing a recipient.
- **SC-002**: With three fuel companies on the platform, one submission produces exactly one offer, visible to exactly the two eligible companies that did not raise it.
- **SC-003**: No company can read, answer, award or count an offer or proposal it is not entitled to see, in every case tested — including when the platform operator's own view of the same screen looks correct.
- **SC-004**: A company that proposes against an offer can learn nothing about any other company's proposal, price, or participation, in 100% of attempts.
- **SC-005**: When two award attempts are made against the same offer simultaneously, exactly one stands and the other is refused as already resolved, in 100% of attempts.
- **SC-006**: A company learns that an offer awaits its answer, and a raiser learns that a proposal has arrived, without either opening the exchange screen.
- **SC-007**: A company whose proposal was not awarded is told the offer closed, and cannot determine the winner or the winning price by any route on the platform.
- **SC-008**: An offer's destination, as read by a receiving company, matches what the raiser entered field for field, with no field silently dropped.
- **SC-009**: No delivery, order or transport assignment exists on the platform as a result of any awarded offer.
- **SC-010**: After migration, every exchange request raised under the directed model is readable by both of its original parties with identical terms and outcome, and is visible to no third company — verified against a set that includes an unanswered request.
- **SC-011**: Every state, refusal and label on the rebuilt screens reads correctly in both Arabic right-to-left and English, with no untranslated text.
- **SC-012**: The three summary counts match a hand count of the underlying offers, including when the list is longer than one page.

## Assumptions

- **Only fuel companies exchange fuel.** Transport companies, station owners, clients and drivers are not participants; the existing role and company-type vocabulary is reused unchanged.
- **"Every company we have" means every fuel company on the platform except the raiser**, narrowed by the grade rule in FR-007. It does not mean companies outside the platform, and it does not mean the platform operator.
- **The raiser is the supplier.** An offer puts fuel on the market and proposals bid to take it; the awarded company is the receiver. The reverse direction — asking the market to supply — is not introduced here.
- **Proposals are blind and single-round.** A company proposes once, sees nothing of its competitors, and cannot revise. Counter-offers and negotiation are out of scope.
- **The raiser is under no obligation to award.** An offer may be left unawarded or withdrawn, and no proposal binds anyone until an award.
- **The city vocabulary already exists.** The platform maintains a bounded list of regions and governorates used by companies, stations and warehouses; the design's city field is bound to it rather than to new free text. The design's second field — a neighbourhood — has no equivalent vocabulary and is treated as free text.
- **The design's second location label means a neighbourhood, not the platform's administrative region.** The platform already uses that same Arabic word for its 13 administrative regions. The screens must not let the two meanings collide in one form.
- **Currency is the platform's single existing currency**; this feature introduces no second currency and no conversion.
- **Nothing about fulfilment is in scope.** No transport, driver, delivery, invoice or litre balance moves as a result of an offer, awarded or otherwise.
- **No new notification channel is assumed.** FR-029, FR-030 and FR-030a are satisfied by the platform's existing means of telling an administrator something has happened; this feature adds no provider. Note that the existing exchange screens raise no notification of any kind today, so this is new behaviour rather than a reuse.
- **Offers do not expire on their own.** A delivery time that has passed makes an offer stale, not automatically closed.
- **Both mobile applications are untouched** and must be verifiably unaffected.
- **Feature 014's Story 12 is superseded.** Its requirements FR-078 to FR-086b describe the directed model this feature replaces; FR-086a alone survives verbatim, restated here as FR-017.

## Out of Scope

- Fulfilment of an awarded offer in any form — transport, delivery, proof, invoicing or balance movement.
- Negotiation: counter-offers, revised proposals, message threads, or amending an offer's terms after it is raised.
- Awarding one offer to several companies in parts, or any partial quantity.
- Asking the market to supply fuel, as opposed to offering it.
- Any mobile application surface.
- Reputation, ratings, or a company's history as a counterparty.
- Stock or inventory concepts of any kind.
- Automatic matching, recommendation or ranking of proposals.

## Dependencies

- The existing fuel company roster and the grades each company sells, which together decide who an offer reaches.
- The existing region and governorate vocabulary, which backs the city field.
- The existing means of telling an administrator that something needs their attention.
- The existing exchange request records, which must be migrated before this change deploys to any environment (FR-039b).
- The web dashboard's fuel exchange screens, which this feature rebuilds; the mobile applications are not involved.
