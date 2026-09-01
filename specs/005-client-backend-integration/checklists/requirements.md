# Specification Quality Checklist: Client Mobile App — Backend Integration

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-15
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

**Status: 16/16 passing. Complete.**

## Notes

### Validation history

**Iteration 1** — three items failed and were fixed:

1. *No implementation details* — the Context section named specific classes, files and endpoint
   paths. Rewritten in capability terms (`MockOrderState` is retained only as a named artefact
   slated for removal in FR-002, since its removal is itself a requirement).
2. *Success criteria are technology-agnostic* — an early SC-004 specified a response-time budget
   for a network call. Restated as a user-facing time-to-usable measure.
3. *Requirements are testable* — several requirements said data "should come from the backend"
   without stating the observable outcome. Each now names what a tester compares against the
   platform record.

**Iteration 2** — three clarifications resolved by the user as D1/D2/D3 and folded in:

- **D1 (extend the backend)** — FR-046 rewritten from a conditional into a mandate; FR-046a/b/c
  added to enumerate the capabilities the platform gains and to require ownership-isolation tests
  on each. The spec-004 permissions assumption was reworded, since D1 genuinely extends the client
  role rather than staying inside it.
- **D2 (multi-location, company-registered)** — Story 8 rewritten so the client selects but never
  creates; FR-036a–d added, including the negative requirement that the app show no
  create/rename/remove control, and the requirement that withdrawn locations stay readable on
  historical orders.
- **D3 (itemised pricing)** — Story 2 gained a breakdown scenario (scenarios renumbered);
  FR-011a–e added, including reconciliation to the total and agreement across quote, receipt and
  invoice. SC-008a/b added to make D2 and D3 measurable.

The former "Outstanding Clarifications" section became "Resolved Decisions", which also records
three consequent dependencies surfaced by the answers.

**Iteration 3** — `/speckit-clarify` session 2026-08-15, five questions asked and answered. All
five were integrated into the spec; the checklist status is unchanged (still 16/16) because each
answer resolved a Partial category rather than fixing a defect.

- **Fee and tax rules** — per fuel company: flat delivery fee, percentage service fee, configurable
  tax rate. FR-011f–j added, including FR-011i (an order retains the figures in force when priced,
  so a later config change cannot rewrite history) and FR-011j (an unconfigured company fails
  loudly rather than quoting zero). New *Pricing Configuration* entity.
- **Phone verification** — SMS one-time code to the new number, reusing the existing handover-code
  OTP mechanism. FR-035a–g added, covering throttling, the number staying unchanged until the code
  is submitted, duplicate-number refusal, send-failure visibility, and never returning the code to
  the app. Two edge cases added.
- **Support routing** — to the client's own fuel company admins over the existing notification
  mechanism, two states only. FR-038a–c and FR-039a–b added. FR-039b deliberately keeps the phone
  and messaging channels prominent, because no one can read submitted requests until feature 003
  ships.
- **List pagination** — cursor-based across orders, invoices, payments and notifications.
  FR-048–048g added, including stability under concurrent inserts (048c), platform-side filtering
  rather than filtering only loaded pages (048d), and old outstanding invoices staying reachable
  (048f) so nothing counting against credit can hide. Three edge cases and SC-004a/b added.
- **Terminology** — "station" confirmed canonical; the spec was normalised to the backend's
  existing name rather than renaming the schema. Entity note records the direction of the word (a
  station receives fuel, it does not dispense it) since that is the reading that made it ambiguous.

### Carried into planning

Not spec defects — decisions that belong to `/speckit-plan`, recorded so they are not lost:

1. **An SMS provider must be chosen and provisioned.** The feature's only new third-party
   dependency, and the only item with procurement lead time. Needs credentials per environment and
   a stance on provider outage (FR-035f).
2. **Two capabilities wait on the web dashboard (feature 003), which has no code yet.** Registering
   stations, and reading/acknowledging support requests, both need a fuel company administration
   surface. Fine during development; not acceptable at launch.
3. **Each fuel company needs its pricing configuration populated** before its clients can be
   quoted, since FR-011j blocks pricing without it.
4. **Existing orders predate the itemised breakdown.** Whether they are back-filled or shown as a
   total alone needs deciding.
