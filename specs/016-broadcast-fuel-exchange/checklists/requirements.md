# Specification Quality Checklist: Broadcast Fuel Exchange Offers

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-06
**Updated**: 2026-09-06 (after clarification session)
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

All items pass. Three clarifications were resolved in the 2026-09-06 session and are recorded in the
spec's own *Clarifications* section: price is proposed by responders rather than set by the raiser;
proposals accumulate and the raiser awards one; broadcast replaces the directed model and existing
records are migrated.

Two questions from the original request were resolved as informed defaults rather than asked, and are
recorded in the spec:

- **The grade rule under broadcast (FR-007)** — an offer simply does not appear to a company that does
  not sell the grade, and the raiser is refused only when **no** company is eligible (FR-005), rather
  than refused per company as the directed model does.
- **Contact disclosure under broadcast (FR-019, FR-019a, FR-020)** — nothing beyond a company name is
  disclosed until award; a proposer's identity and price reach the raiser alone, and the two sides see
  each other's details only once the offer is awarded.

**Updated after the 2026-09-06 cross-artifact analysis.** Eleven findings were raised and all eleven
resolved; four changed behaviour rather than wording. Two requirements were amended in this spec
(FR-006/FR-007 and FR-021, recorded in *Clarifications*), two research decisions were corrected
(R6's recipient lookup) or added (R13, the suspended raiser), and eleven tasks were inserted with
letter-suffixed ids so the gate at T026 and the ids cited in the dependency graph stayed stable.

Four requirements deserve the implementer's attention early, because each is a place where a
plausible implementation would be wrong:

- **FR-029/FR-030's fan-out** cannot follow the obvious precedent. `SupportService`'s recipient
  lookup is tenant-scoped and returns the *acting* company's administrators, so a faithful copy
  notifies the raiser's own staff and tells no recipient company anything — while every assertion
  that "a notification exists" still passes. T036 requires an explicit `runUnscoped` resolution and
  T036b is the assertion that distinguishes the two outcomes.

- **FR-039a** is the migration's real constraint. Converting an unanswered directed request into a
  broadcast offer would expose a private request to every fuel company on deploy day. A migrated
  record must keep its original two-company audience whatever its state.
- **FR-011b and FR-021** make blindness a property of the data available to a responder, not of what
  a screen chooses to render. Any listing that carries proposal counts or prices to a responder
  breaks it invisibly.
- **FR-014a**'s simultaneous-award case is the same class of race feature 009 hit on concurrent
  assignment, where the collision surfaced only at commit. It needs a real guard, not a read-then-write.
