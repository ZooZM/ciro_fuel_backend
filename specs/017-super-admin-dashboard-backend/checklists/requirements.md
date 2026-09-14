# Specification Quality Checklist: Platform Operator (Super Admin) Dashboard — Backend Integration

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-12
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

**Iteration 1 findings (all corrected in the spec):**

1. **Implementation detail leak** — several FRs named HTTP verbs and route paths
   (`GET /companies?type=FUEL`, `PATCH /orders/:id/force-complete`). Rewritten as capability
   statements ("listing companies MUST accept a company-type filter"). Route-level design belongs in
   `contracts/rest-api-delta.md` at plan time, not here.
2. **Implementation detail leak** — role names were written as code identifiers (`SUPER_ADMIN`,
   `FUEL_COMPANY_ADMIN`) in the requirements. Replaced with the business terms the Overview already
   establishes ("the platform operator", "a fuel company administrator"). The identifiers survive
   only in the Overview, where they are glossary, and in the Input line, which is verbatim user text.
3. **Unmeasurable success criterion** — an earlier SC read "the dashboard feels trustworthy".
   Replaced by SC-001 and SC-007, which are both verifiable by reconciliation.
4. **Untestable requirement** — an earlier FR said the overview "SHOULD be fast". Removed; no
   performance bound was stated by the user and inventing one would be a fabricated target.
5. **Unbounded edge case** — "what if there are too many announcements" had no decidable outcome.
   Replaced with the two concrete announcement edge cases (suspended company, deactivated
   administrator) that do have decidable outcomes, plus FR-053/FR-054/FR-055 which bound the fan-out.

**Resolved by clarification (asked before the spec was written, not marked in it):**

- **Transport company creation by the operator** — the operator's onboarding form names no parent
  fuel company, but the platform requires one. Resolved: transport companies may exist with no
  parent (FR-029 to FR-032). This is the widest-reaching decision in the feature and is recorded in
  Risks with its full blast radius, because it changes a structural invariant that four existing
  access paths depend on.
- **Cashback payout** — no outbound money movement exists anywhere on the platform. Resolved: build
  it, mirroring the existing inbound record-then-confirm shape (FR-064 to FR-073).
- **Driver oversight scope** — the mock puts every driver's live position and trip history in front
  of the operator. Resolved: roster and fleet facts only (FR-043 to FR-045), holding the boundary
  spec 011 drew.

**Iteration 2 — `/speckit-clarify` session 2026-09-12 (3 questions, all premises verified against
the code before asking):**

1. **Unparented transport companies were not a legal state.** The spec had specified them as a wide
   but ordinary change. Verification found `multi-party-scope.plugin.ts` *throws* an isolation
   violation for a transport administrator with no parent — that id is the role's tenant key — and
   `findServingTransporters` filters on it, so such a company would never be routed an order,
   silently. Resolved by requiring the operator to name the parent. FR-029–FR-032 rewritten, Story 4
   scenarios 2–5 rewritten, SC-006 rewritten, the Company entity corrected, the first Risk replaced,
   and the platform-level transporter recorded in Out of Scope so a later reader does not read
   FR-029 as an oversight.
2. **The driver roster's truck column had no backing field.** Spec 008 deleted the embedded driver
   truck; `Truck` carries no driver reference, and a driver is bound to a truck only for one order.
   Resolved as "most recently operated, derived from the delivery record", which required narrowing
   the driver-surveillance exclusion. FR-039 amended; FR-039a/FR-039b and FR-044a added, the last
   stating explicitly what must *not* travel with the derivation and that it must not be widened
   later.
3. **Order state bucketing was unspecified** across three requirements that each depend on it.
   Resolved with six buckets including a distinct "needs attention" for orders no transporter serves,
   and rejected counted apart from cancelled. FR-023a–FR-023d added, FR-006 and FR-016 amended,
   Story 3 scenarios 2a–2c added, and the corresponding Assumption replaced.

**Verified sound during this session (previously open, now closed without a question):**

- **FR-022's per-order commission is derivable.** `accrueCommission` writes a movement carrying
  `sourceInvoiceId`, and the invoice collection makes `orderId` unique — exactly one invoice per
  order. Note for planning: commission accrues at *settlement*, so an unsettled order genuinely has
  none, and FR-022/FR-024 already require the element be absent there rather than zero.
- **FR-058/FR-059 are satisfiable.** `User.activeSessions` exists (feature 015), so session count and
  last sign-in are real reads, not new bookkeeping.

**Carried into planning as open design questions (not spec-level ambiguities):**

- Whether the platform overview is one capability or several is a design decision; the spec states
  what must be answerable, not how many round trips answer it.
- Whether the announcement record is its own collection or a notification variant is a data-model
  decision for `data-model.md`.
- How the most-recently-operated truck is derived efficiently across a whole roster (FR-039a) is a
  performance question for planning — the naive shape is one lookup per driver.

## Notes

- All checklist items pass after the clarification session. Spec is ready for `/speckit-plan`.
- **The Slice 0 recommendation is withdrawn.** It was predicated on the optional-parent change, which
  clarification removed. With the isolation key and the routing query both now explicitly untouched
  (FR-032), this feature has no structurally invisible change to gate — the closest candidate is the
  company type filter (Story 2), which is small, and whose failure mode is visible the moment a
  seeded platform is listed.
- Highest residual risk is now the platform overview (Story 1): it is the first cross-company
  aggregate on a platform where every existing count is company-scoped, and an aggregate that
  accidentally inherits that scoping yields a plausible, smaller, wrong number with no error.
