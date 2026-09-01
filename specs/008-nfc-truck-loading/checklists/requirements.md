# Specification Quality Checklist: NFC Truck Verification & Warehouse Loading

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-24
**Last validated**: 2026-08-24 (post-`/speckit-clarify`)
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

**Status: PASS** — 5 user stories, 97 functional requirements, 27 success criteria, 12 resolved
clarifications, 0 open. No dangling requirement cross-references.

## Notes

### `/speckit-specify` — implementation detail stripped from the source description

The input was written in implementation terms. Query and schema mechanics (`$geoNear`, `$lookup`,
embedded subdocuments, the `Truck` schema path) were removed; what survives is the outcome they
serve, recorded as an assumption. The "13.56 MHz USB RFID reader" became a behavioural requirement
(FR-006) with the HID-keyboard mechanism as an assumption, so the spec is not bound to one reader
model. The card identifier is treated as an opaque string compared for equality.

### `/speckit-clarify` — 8 questions asked, 8 answered, several reshaping the feature

Three were resolved during `/speckit-specify`; a further eight during clarification. Five changed
the feature's shape materially:

1. **Order lifecycle** → one new stage, `LOADING`. `ASSIGNED_TO_DRIVER` stops auto-advancing and
   `IN_TRANSIT` narrows to "loaded and travelling". Added FR-046a–e, including FR-046c which
   requires every stage-displaying surface to account for it — this is a breaking change across
   the backend and both apps, so it is stated as a requirement rather than left to discovery.
2. **Cutover** → clean cut, no migration. The platform is pre-production with only test data, so
   the embedded per-driver truck is deleted rather than promoted. This *removed* scope: the
   original FR-043 ("pre-existing deliveries must remain completable") and SC-012 were replaced
   with cutover requirements, and a whole class of dual-source complexity disappeared.
3. **Offline verification** → strictly online **plus** an operator override. Verification is never
   queued or device-decided (FR-021a); an operator may advance a stage as an explicitly recorded
   attestation (FR-047a–g). FR-047d was added unprompted because the combination creates an
   honesty hazard: a customer must not be told a vehicle was *verified* when the stage was in fact
   *overridden*.
4. **Tractor/trailer split** → `Truck` (tractor, carries the card) and `Tank` (trailer, carries
   code, material, capacity and permitted grades) became separate entities, with driver → truck →
   tank selection and last-used-truck pre-fill. Added FR-048a–g, FR-009a–f, FR-016a, FR-033a–b.
5. **Volume capture** → **removed entirely from the driver flow.** The driver enters no number at
   any point; the authoritative volume is an Aramco invoice reconciled asynchronously elsewhere.
   This voided the original FR-028/FR-029 and, in turn, made US6 unbuildable.

### Scope removed during clarification

- **US6 (client litre balance) and Aramco invoice reconciliation were cut from this spec.** Once
  volume left the delivery flow, nothing within this feature could move a balance — loading
  confirms with no volume and the delivery completes with none. Shipping the balance here would
  have meant a screen that could only ever display zero. Both become their own feature, which
  carries its own open questions: who uploads the invoice, what happens when it contradicts the
  order, who approves a correction, what if it never arrives.
- The first clarification's answer (the litre balance) is **retained in the Clarifications log with
  an explicit supersession note** rather than deleted, so the reasoning chain stays legible. The
  durable half of that answer — the issued invoice is never rewritten — survives as FR-034.

### A constraint that dissolved rather than being solved

The original reconnaissance flagged the single-pass `$geoNear` candidate query as the feature's
architectural landmine: capacity and fuel grades were denormalised onto the driver record because
`$near` cannot follow a `$lookup`, so separating vehicles from drivers appeared to break it.

Two clarification answers removed the problem instead of solving it. Capability moved to the
**tank**, and selection became **sequential** (driver → truck → tank). The driver list therefore no
longer filters on vehicle capability at all — it ranks by proximity and availability only, which a
single pass handles natively. Recorded in Assumptions so planning does not re-derive a workaround
for a constraint that no longer applies.

### Decisions taken as documented assumptions rather than clarifications

- *Trucks as a pool vs. 1:1 with drivers* — settled by the requested flow itself.
- *Whether a mismatched verification is overridable by the driver* — no; operator reassignment
  (FR-015) or operator override (FR-047) are the remedies, both leaving a trail.
- *How the USB reader delivers an identifier* — HID keyboard behaviour; any focused field works.
- *Whether material determines permitted grades* — no; material is recorded fact, grades are
  explicit per tank (FR-048g), so a business rule that varies by operator is not frozen into the
  data model.

### Residual gaps, deliberately left to planning

- **Bulk warehouse upload format** (FR-035a) — the requirement states the capability; the file
  shape is a planning concern.
- **How "last operated truck" is derived** (FR-009b) — stored on the driver or computed from
  delivery history is an implementation trade-off, not a specification one.
- **The tank is assigned but never verified.** Stated as an assumption and an edge case rather
  than a gap: the card is on the tractor, so a swapped trailer is undetectable by the platform.
  Showing the driver the tank's code and material (FR-033a) makes it visible to a person instead.

### Carried into planning

- **FR-046c is the widest blast radius in this feature** — a new lifecycle stage that the backend,
  the client app and the driver app must all recognise. Sequence it before anything that depends
  on the stage existing.
- **The cutover (FR-043a) is a flag day** and should land as its own step, distinct from the
  feature work built on top of it.
