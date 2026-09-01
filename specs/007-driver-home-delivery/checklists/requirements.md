# Specification Quality Checklist: Driver Home & Active Delivery

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-24
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

**Iteration 1 findings (resolved in place before this checklist was written):**

- *No implementation details*: the first draft named concrete classes and file paths
  (`DeliveryCubit`, `delivery_remote_data_source.dart`, endpoint routes) throughout the
  requirements. These were moved out of the FRs and into the Context section as plain-language
  descriptions of the current state ("the component that fetches the driver's active job is
  never asked to fetch anything"), so requirements stay stakeholder-readable while the
  reconnaissance that motivated them is preserved for planning.
- *Success criteria technology-agnostic*: an early SC referred to the paginated response
  envelope; replaced with SC-001's user-facing timing and SC-002's "traces to a platform
  record" measure.
- *Testable and unambiguous*: FR-015 originally read "the app must not fake progress", which is
  not directly testable; restated as the platform's response being the only thing that may
  change the displayed stage, which is checkable by interacting with the screen offline.

**Iteration 2 — clarifications resolved (2026-08-24), all items now pass:**

- **Question 1 (duty state)** answered: *read-only, derived from the driver's real platform
  state.* FR-035 states the requirement, FR-036 explicitly forbids offering the driver a
  control to change it, and the out-of-scope list records that an on/off-duty control remains a
  candidate for a later feature. No new platform capability needed.

- **Question 2 (header figures)** answered: *keep both and build the platform capability behind
  them.* This was the scope-bearing answer, and it changed the shape of the feature:

  - A driver rating now needs somewhere to live (FR-029) and something to display, including an
    explicit not-yet-rated state that is not a score (FR-031).
  - **A rating capability implies a way to create ratings.** The only party who experiences the
    driver is the customer, so a customer-facing post-delivery rating prompt became necessary —
    added as **User Story 6** (FR-037–FR-042). Without it, ratings could never exist and every
    driver would permanently read "not yet rated", making US5's display inert.
  - That required moving a scope boundary: the original "no client-facing screen" exclusion is
    now qualified to permit exactly this one prompt, and the change is recorded in Out of Scope
    rather than left implicit.
  - The unanswered sub-questions of the rating domain (who rates, when, moderation, effect on
    dispatch) were resolved as documented **assumptions** rather than new clarification markers,
    with the two consequential ones — *rating does not influence dispatch* and *ratings are not
    moderated or appealable* — stated explicitly in Out of Scope so they are decisions on the
    record rather than omissions. These are the most likely items to revisit in
    `/speckit-clarify`.

**Verified after iteration 2**: FR-001–FR-045 contiguous with no gaps or duplicates;
SC-001–SC-011; six independently testable user stories; no class names, file paths, endpoints
or framework references anywhere in the Requirements section.

**Note on effort vs. priority**: US5 and US6 are correctly P3 — neither blocks a driver from
doing their job — but together they carry the majority of *new* platform capability in this
feature, while P1/P2 are largely connecting an app to platform behaviour that already exists.
Worth weighing when sequencing, since the MVP (US1) is by far the cheapest large win.

---

## Clarification session 2026-08-24 (5 of 5 questions used)

All five answers are logged in the spec's `## Clarifications` section and integrated into the
relevant requirements. Three of them changed the feature's shape rather than merely filling a
blank:

- **Q2 reversed a requirement.** FR-041 originally forbade a rating being attributable to an
  individual customer. The existing design contradicted it outright — it renders the score and
  a written review on that specific completed delivery's detail. FR-041 now states the
  opposite, deliberately, with the reasoning recorded.
- **Q5 uncovered a gap in both the spec and the platform.** US1's acceptance scenario referred
  to "that delivery's customer", but the platform records a driver summary for the customer's
  benefit and keeps no mirror — a driver has no customer name or phone at all, which also left
  the design's call button with nothing to dial. Added as FR-003a/FR-003b and FR-027a/FR-027b.
- **Q1 widened an accepted risk.** Admitting free-text reviews, with moderation still out of
  scope, means an unfair or abusive review is permanent *and* (after Q2) traceable to a named
  customer. Both risks are now recorded together in Assumptions so the compound tradeoff stays
  visible rather than being split across two bullets that each look tolerable alone.

**Deferred — quota reached, all judged low-impact or better suited to planning:**

- Whether a delivery completed by an administrator override counts toward the driver's daily
  count. Flagged explicitly in the spec's Edge Cases as needing a decision; affects one number
  in one header.
- Whether a transport-company or fuel-company administrator can see a driver's rating. No
  surface exists to show it (the web dashboard, spec 003, is unbuilt), so this can be settled
  when that dashboard is specified without reworking anything here.
- Observability of rating submissions (audit trail). Spec 006 established a session-event audit
  pattern; whether ratings warrant equivalent treatment is a planning-stage judgement.
