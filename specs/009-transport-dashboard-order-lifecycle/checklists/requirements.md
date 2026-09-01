# Specification Quality Checklist: Transport Admin Dashboard — Live Order Lifecycle

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-26
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

## Validation Notes

**Iteration 1** — issues found and corrected before the spec was finalized:

- *Implementation leakage*: an earlier draft named the dispatch endpoints, the socket event
  names, the polling library and the `LOADING` enum value directly. Rewritten in domain language
  ("the drivers eligible to take it", "the loading stage between assignment and transit",
  "without a manual reload"). The mechanism choice — polling versus a live connection — is now
  recorded as an open implementation decision in Assumptions rather than fixed in a requirement.
- *Unmeasurable freshness*: "updates in real time" replaced with bounded intervals (SC-003:
  15 seconds for stage changes; SC-004: 60 seconds for truck position).
- *Untestable walkthrough*: Story 3 originally said "test the lifecycle". Now requires a written
  procedure with named starting data, per-step observable evidence, and a second-tester
  reproduction criterion (FR-025–FR-030, SC-010).

**Deliberate scope decisions** (recorded rather than raised as clarifications):

- The fuel company administrator's approve/route steps are performed through whatever surface is
  available, since that dashboard is out of scope — the walkthrough must not be blocked on it.
- Fleet management (Story 4) is P2, not P1, because the walkthrough can run against seeded
  vehicles. This keeps the assignment break — the actual blocker — as the first thing fixed.
- Story 1 and Story 2 are both P1 because assignment without visibility cannot be verified, and
  Story 3 is P1 because it is what the user asked for; Stories 1 and 2 are its prerequisites.

## Clarification Session 2026-08-26

Eight questions asked and answered; the spec grew from 49 to 76 requirements and from 12 to 23
success criteria. Resolved: update mechanism and cost constraint · cross-repo ownership ·
walkthrough form · fuel-company step · notification vocabulary · pagination and overview counts ·
language scope · fleet scope.

**Two premises were checked against the code and found stale**, both originating in the project's
context notes:

- The vehicle-verification and loading work is described there as planned-but-unbuilt. It is
  built — on the platform *and* in the mobile application (card reader, verification screen and
  use case, loading stage all present). The dashboard is the only surface behind.
- The notification vocabularies are described as sharing no values. They are identical, value for
  value, with a deliberate fallback. The clarification answer was given on the false premise; the
  requirement was rewritten from "repair it" to "confirm it during the walkthrough, and repair any
  divergence found" rather than leaving the spec commissioning finished work.

**Scope grew materially** at Q8: the full card-pairing and credential lifecycle now ships, because
the hardware to test it is available. This added nine requirements and five success criteria
covering two distinct input paths (a reader presenting as a keyboard; a device reading the card
directly), the discrimination between scanned and hand-typed input, and the containment of stray
card reads.

## Cross-Artifact Analysis 2026-08-26 (`/speckit-analyze`, two passes)

Ran after `/speckit-tasks`. Found and fully remediated:

- **Two CRITICAL** — `token-store.ts`'s comment claimed in-memory tokens while the code used
  `localStorage` (Principle II); the refresh-token deviation in Complexity Tracking covered
  transport but never storage. Fixed: FR-077/FR-078 added, T010a/T010b inserted before T010,
  `plan.md` and `research.md` updated.
- **Systematic stale FR citations** (~40 instances across tasks.md and all three contracts files)
  from the clarification session's mid-document insertions — Story 5/6 and Access-and-integrity
  shifted by 9, but every citation still resolved to *some* valid FR, so no automated link check
  would have caught it. Re-mapped line by line against current spec numbering, not by blind
  find-replace, since several old numbers remained valid FRs for unrelated requirements.
- **One live parallel-write conflict** (F3) — three `[P]`-marked tasks (T070/T096/T109) all
  edited the same file; the dependency table permits their stories to run concurrently. All three
  now serial with a cross-reference.
- **Four uncovered timing success criteria** (SC-002, SC-003, SC-004, SC-019) — added explicit
  measurement tasks (T042a, T057a, T057b, T087a).
- Two smaller coverage gaps (SC-023, FR-038's repair contingency) and one ambiguous citation
  (rating absence, now FR-077) — all resolved.

Second analysis pass, run before remediation, found nothing further: 0 placeholders, 0 vague
adjectives, 0 genuine duplication (three high-overlap FR pairs are deliberate parallel structure).

**Final state**: 78 FRs (was 76) · 23 SCs, 100% cited (was 78%) · 132 tasks (was 124) · 0 dangling
references in any artifact · 0 duplicate task IDs.

## Notes

- All items pass. Spec, plan and tasks are ready for `/speckit-implement`.
- Sequencing remains the main structural risk: 78 requirements spanning two repositories, with
  several changes that each want to land alone. This is tracked in tasks.md's Dependencies
  section, not here.
