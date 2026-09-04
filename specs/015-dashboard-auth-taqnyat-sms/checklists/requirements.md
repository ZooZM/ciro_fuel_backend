# Specification Quality Checklist: Web Dashboard Authentication & Taqnyat SMS Provider

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-03
**Updated**: 2026-09-03 (after `/speckit-clarify` — 5 questions asked and answered)
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

### Resolved by clarification (Session 2026-09-03)

1. **Login method** → passwordless phone + SMS one-time code (new platform endpoints), keeping the
   dashboard's designed phone → verify UX. Replaced the draft's email+password-only FR-001, which
   contradicted the dashboard as built.
2. **Coexistence** → email+password sign-in and SMS password recovery are both preserved, not
   replaced. Became US6 and US7.
3. **Abuse controls** → strict: password-reset-grade hardening *plus* a temporary per-number block
   and a CAPTCHA/proof-of-work challenge. Large enough to warrant its own user story (US3) and its
   own FR block (FR-021–FR-031).
4. **Code length** → 6 digits everywhere; the dashboard's 4-box code entry is a defect to correct,
   not a design to honour.
5. **Concurrent sessions** → administrators may hold up to a configured number (default 3), oldest
   evicted beyond it. This is the largest structural consequence of the session: the platform's
   single account-level session counter cannot express it, so per-session identity and revocation
   are new (US4, FR-032–FR-042). DRIVER/CLIENT behaviour is explicitly frozen.

### Settled without a question

- **Env-var naming** — the platform's existing setting names are retained; the deployment's values
  map onto them (Assumptions / FR-009). Confirmed with the user before drafting.
- **Cross-repo scope** — full-stack (platform + dashboard at `E:\zeyad\web_dashboard_ciro_fuel`), and
  this feature supersedes the per-role auth slices in features 009 and 014. Confirmed with the user.
- **Renewal-credential transport** — the draft's open assumption (httpOnly cookie vs body) is now
  closed by inspection: the dashboard already stores a body-returned renewal credential and its
  single-flight renewal already works. Moving to a cookie would change both mobile clients' renewal
  path, so it is explicitly out of scope.

### Resolved by `/speckit-analyze` (2026-09-03)

One CRITICAL, four HIGH and six MEDIUM findings, all fixed. The ones worth remembering:

- **CRITICAL — logout could not name the session it closed.** `data-model.md` §4 asserted
  `AuthenticatedUser` must *not* carry `sid` ("nothing downstream of authentication addresses a
  session"). `AuthController.logout` takes exactly that object and, under FR-035, must close one
  specific session. The stated rationale was inverted, not merely imprecise, and FR-035 was
  unimplementable. Fixed in `data-model.md` §4, `contracts/rest-api-delta.md` §5, and task T023a.
- **HIGH — `refresh` would have killed every admin session.** No artifact said the renewed pair must
  carry the *presented* `sid`. A `sid` generated inside `issueTokenPair` is absent from
  `activeSessions`, so every admin session would die one access-token lifetime after sign-in, with a
  symptom (periodic forced re-login) that looks nothing like the cause. Fixed by T028a and asserted
  by T015b's 20-renewal test.
- **HIGH — the phone index would have failed the production boot.** Mongoose `autoIndex` is not
  disabled here, so the extended index builds automatically at startup — before anyone could run the
  placeholder normalisation on that environment. A green local check protected nothing. Fixed by
  T041a making normalisation a per-environment pre-deploy step.
- **HIGH — SC-006 promised something the plan explicitly declined.** It required responses to differ
  by "less than a measurable timing margin" while `plan.md` said no constant-time guarantee is
  claimed. Reworded to status+body identity with the timing limit stated openly.
- **HIGH — the Phase 5 checkpoint invited deploying an unhardened public code endpoint.** Reworded to
  a review point, never a release gate.
- **MEDIUM ×6** — FR-037's company-suspension half, FR-026's self-expiring block, SC-015's burst test,
  FR-010/SC-019's provider-swap diff, FR-071/FR-073's recovery regressions, and eight dashboard FRs
  asserted already-satisfied but never verified. Each now has a task.

FR coverage went from 66/74 to **74/74**. Task count 114 → 125.

### Carried into planning, deliberately unresolved here

- **Which challenge mechanism** satisfies FR-023 (third-party CAPTCHA vs self-hosted proof-of-work)
  is a planning decision, not a requirements one. Flagged in Assumptions.
- **How per-session identity is represented** (FR-034) is left to `/speckit-plan`; the spec states
  only the observable guarantees. Expect it to be the highest-risk area of the plan, since the
  existing single-counter model is load-bearing for driver session displacement, password reset,
  deactivation, and company suspension — all of which must keep working unchanged.
