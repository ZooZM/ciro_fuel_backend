# Specification Quality Checklist: Fuel Company Admin Dashboard — Live Platform Integration

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-03
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

**Iteration 1 (2026-09-03)** — one item failed: three [NEEDS CLARIFICATION] markers stood at
FR-054, FR-055 and FR-056, all scope decisions with no defaultable answer. Presented as Q1–Q3.

**Iteration 2 (2026-09-03)** — all items pass. The three answers (build all six absent
capabilities; keep counts and totals but drop trend figures; include the operator surface) were
integrated, which restructured the spec substantially rather than merely replacing three sentences:

- 5 new user stories (P9–P13) covering commission and cashback, platform account settlement, litre
  balances, fuel exchange, and operator oversight.
- Requirements grew from 56 to 99, success criteria from 12 to 16, stories from 8 to 13.
- A new **Out of Scope** section, and a widened Dependencies section separating "connect what
  exists" from "build what does not".

Structure verified mechanically: 99 requirements numbered FR-001…FR-099 with no gaps or
duplicates, 16 success criteria, 13 stories, zero clarification markers.

### Judgment calls recorded rather than guessed

Three points where the screens as built could not simply be transcribed into requirements:

1. **Commission authority.** The commission and cashback controls appear identically on the fuel
   company's and the platform operator's invoices screen — the same screen serves both — which
   would let a fuel company edit the rate the platform charges *it*. FR-056 resolves this to
   operator-sets / company-reads. Recorded in Assumptions with the alternative reading stated, since
   it is a business decision, not a technical one.
2. **Operator scope boundary.** Answer B ("in scope") was given to a question about *shared*
   components, but the operator's routes also cover drivers, transport companies, platform orders
   and Aramco invoices — effectively the rest of the dashboard. Scope is bounded to the operator's
   fuel-company oversight plus genuinely shared components; the boundary is stated explicitly in
   Assumptions and Out of Scope so it is visible rather than silently assumed.
3. **Litre balance vs. supplier reconciliation.** Originally specified as a figure the fuel company
   states by hand, on the grounds that supplier reconciliation was deferred. **Overturned during
   clarification** — see below.

**Iteration 3 (2026-09-03, `/speckit-clarify`)** — five questions asked and integrated; all items
still pass. Requirements grew 99 → 122, success criteria 16 → 20. Two answers changed the design
rather than filling a gap:

- **Supplier-invoice reconciliation is in scope**, reversing this checklist's own iteration-2 note
  and the deferral made when the loading stage was built. The litre balance is not hand-stated: it
  is the shortfall between the ordered quantity and what the supplier invoice says was actually
  supplied, and later orders draw it down automatically. The deferral had rested on the platform
  having no authoritative delivered volume — the uploaded invoice is exactly that, which dissolves
  the reason for deferring. Confirmed against the real invoice supplied by the user and against the
  screen that renders it, which uses the same figures (31,501.10 L supplied of 33,000 L ordered).
  This reaches into order placement, making it the only part of the feature that changes what a
  station owner *does* rather than only what they see.
- **Quantity extraction is assistive, never authoritative.** The platform reads what it can from the
  document and the administrator confirms or corrects it; nothing moves until they do, and both the
  extracted and the confirmed value are retained so a systematic misread is discoverable. The
  feature is correct at zero extraction accuracy. Worth noting for planning: the standard tax-invoice
  QR code carries seller, tax registration, timestamp and totals but **not** line quantities, so
  there is no cheap structured path to this number.

The other three answers (exchange creates no delivery; both payment methods offline and
hand-confirmed; ceiling set per company by the operator with a platform default and a 90% warning)
narrowed scope or replaced vague wording with testable thresholds.

### Standing risk (not a checklist failure)

Answer C to Q1 makes this a platform feature, not a dashboard integration. Stories 9–12 introduce
four business domains that exist nowhere today — a commission and cashback model with accrual and
enforcement, a settlement ledger with documents and confirmation, a litre-balance ledger, and an
inter-company fuel exchange. Each is plausibly its own feature. The priority order is set so the
delivery-chain work (P1–P8) completes and ships value before any of them begins; `/speckit-plan`
should be expected to recommend splitting P9–P13 out, and that recommendation should be taken
seriously rather than treated as scope reduction.
