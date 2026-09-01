# Specification Quality Checklist: Production Hardening & Horizontal Readiness

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-30
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

**Validation performed**: 2026-08-30, two iterations.

**Iteration 1 findings, all corrected in the spec:**

1. *Implementation detail leaked into requirements.* Draft FRs named specific mechanisms
   (a health-check library, a cross-instance message adapter, a connection-pool option name).
   Rewritten as observable properties — "an unauthenticated caller receives an affirmative
   response", "a client connected to one instance receives an event emitted by another". Mechanism
   selection is deferred to `/speckit-plan`.
2. *Success criteria were partly technical.* Draft SCs cited response-time budgets in milliseconds
   and a queue-depth metric. Replaced with outcomes measurable from outside the system: deploys
   without severed requests, retrieval of an order's full history in under a minute, zero
   cross-client rate-limit interference.
3. *Two requirements were untestable as written.* "Logs should be useful" and "storage should be
   durable" became FR-032 (retrievable by order identifier, complete and ordered) and FR-036/FR-037
   (survives destruction of the receiving machine; any instance can serve any document).

**Iteration 2 findings, all corrected:**

4. *A third single-instance constraint was missing.* In-memory rate-limit counters were verified
   present in the code but absent from the draft. Added as FR-061, folded into Story 9, and recorded
   in *Verified Current State*.
5. *Story 4 conflated two gaps.* Proxy-aware limiting and request attribution were one requirement;
   split into FR-021–FR-024 and FR-025 respectively, because nothing records an origin today at all
   — attribution is a new capability, not a by-product of the proxy fix.

**Deliberate deviation from "no implementation details":**

The *Verified Current State* section names concrete code-level findings — where the schedulers live,
which service holds the realtime server, which field the upload response carries. This is retained
deliberately. The section is evidence, not requirement: it records what was read in the code so a
reviewer can check the claims rather than trust them, and so `/speckit-plan` inherits the three
corrections (marked ⚠) rather than rediscovering them. The Requirements and Success Criteria
sections themselves name no framework, library, product or API. This matches the precedent set by
earlier specs in this repository.

**Clarification session 2026-08-30 — 9 questions asked and answered, all integrated.** Re-validated
after the session; all 16 checklist items still pass. The spec grew from 68 to 96 functional
requirements and from 16 to 18 success criteria. Three of the nine answers changed requirements that
were already written rather than filling gaps:

- **Q4 added a mobile-only failure mode nobody had named.** A client that forwards its
  `Authorization` header across the cross-origin redirect to the object store presents two competing
  credentials and is refused. Browsers strip the header; mobile HTTP clients may not. Captured as
  FR-038c–e, including the contingency that a client-side fix would be the one permitted exception to
  FR-067's no-client-change rule.
- **Q8 corrected a guarantee the mechanism cannot deliver.** FR-056 originally required sweeps to run
  "exactly once"; a distributed lease is at-most-once, since a pause outlasting the TTL still permits
  a concurrent run. Amended to state the achievable guarantee and to require idempotency alongside it,
  so acceptance tests are not written against an unattainable property. **The same error was found in
  FR-062** during the consistency pass and corrected the same way — the queue is at-least-once, which
  is precisely what feature 011's double-escalation fix exists to absorb.
- **Q7 resolved a correlated-failure trap in FR-002 as originally written.** "Every dependency
  required to serve a request" would have made a Redis blip take every instance out of rotation
  simultaneously. Narrowed to the database alone, with Redis reported but not disqualifying —
  which in turn made stalled sweeps silent, requiring FR-058a's alert.

**One answer was partly corrected rather than recorded as given.** Q8 proposed keying the
runtime-registered schedule by delivery ID as a queue job. Verified against
`stop-detection.service.ts:87-95`: that schedule is a fleet-wide sweep registered dynamically only so
its interval stays configurable, with no per-entity key available. The per-delivery job with a
deterministic identifier is `StopEscalationQueueService`, which already runs on the shared queue and
was never a single-instance constraint. Recorded as FR-057/FR-057a.

**Open items for `/speckit-plan` — not blocking this spec:**

- ~~The deployment target is undecided~~ — **resolved by Q1/Q3/Q5/Q6.** Unmanaged VMs running the
  existing Compose stack behind nginx, with managed object storage, secret store and log collection
  from the same cloud project.
- ~~Constitutional question on Story 6~~ — **resolved by Q3.** The constitution binds *local* uploads;
  after Story 6 uploads are not local, so it no longer binds them, and the name is retained as the
  object key prefix regardless. The plan must still record this reading explicitly in its
  Constitution Check, and note that the retained prefix is convention rather than enforcement.
- **Still open: the stored file metadata's path field.** `FileRecord` carries a filesystem path that
  reaches the upload responses. FR-038 freezes upload payloads while FR-036 removes the filesystem,
  so the plan must decide deliberately what that field becomes — an object key, or a retained-but-
  meaningless value — rather than letting it change by accident.
- **Still open: the p99 sweep duration is unmeasured.** FR-056b sets the lease expiry above it, so
  the plan needs a measurement or a defensible starting value plus the renewal path.
- **Still open: log volume and cost.** FR-035 makes verbosity load-bearing now that collection is
  billed; the plan should state the production default and confirm the tracking stream is excluded.

**Assumptions still standing after the clarification session** (each with stated reasoning in the
spec's *Assumptions* section): no migration of existing documents (platform is pre-production);
30-second default drain deadline; redundancy made possible rather than mandatory; Redis remains a
single shared instance rather than a cluster. The assumption that documents keep flowing through the
platform's own download route was **overturned** by Q3/Q4 and replaced.
