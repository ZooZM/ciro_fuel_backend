# Research: Driver Availability & Assignment Escalation

## R1 — Showing every driver without losing `$geoNear`'s nearest-first ordering

**Decision**: Split the candidate query in two and merge the results in the service layer, rather
than trying to make one aggregation pipeline do both jobs.
1. A `$geoNear` stage matching only `{ role: DRIVER, isActive: true }` (dropping
   `isOnline`/`isAvailable`/`activeOrderId` from the match) returns every active driver **who has
   ever recorded a location**, nearest-first, exactly as today's query already orders them.
2. A separate plain `find({ role: DRIVER, isActive: true, location: { $exists: false } })` catches
   drivers who have **never** connected and so have no `location` field at all — `$geoNear`
   silently omits any document missing the field it sorts by (the same behavior that already makes
   an un-located driver invisible to dispatch today; the codebase's own comment on `location:update`
   already documents this).
3. Each result is annotated with an `eligibility` classification (`ELIGIBLE` / `BUSY` / `OFFLINE`)
   computed from `isOnline`/`isAvailable`/`activeOrderId` in application code, then the two lists
   are concatenated — eligible-and-nearest first, then the rest — never re-filtered back down.

**Rationale**: Removing the filter from the query alone is not sufficient — it would still silently
drop every driver who has never come online even once (a newly-hired driver, for instance), which
is a worse regression than the one being fixed (spec FR-001's "every driver," not "every driver who
has ever had a GPS fix"). Splitting the query is the smallest change that actually satisfies "every
driver," and it keeps the existing, already-tested nearest-first ordering for the drivers it always
worked for.

**Alternatives considered**:
- *Single aggregation with `$geoNear` restricted to nothing and a `$sort` afterward* — rejected;
  `$geoNear` MUST be the first stage in a pipeline and MUST have a query that can use the geospatial
  index, so a driver with no `location` can never appear in its output no matter how the query is
  relaxed.
- *Add a placeholder/default location to every driver at creation* — rejected; fabricating a
  location the platform doesn't actually have contradicts this codebase's own established
  discipline against showing invented data (feature 009's whole "no fabricated values" thread), and
  a fabricated point would misorder the nearest-first ranking for everyone else.

## R2 — What "acknowledged" is, concretely

**Decision**: A new, purpose-built signal — not a reuse of `Notification.readAt`. The driver app
calls a new endpoint (`POST /orders/:id/acknowledge-assignment`) when the driver's existing
active-delivery screen (feature 007) first renders the newly-assigned order; this sets
`assignmentAcknowledgedAt` directly on the `Order`.

**Rationale**: `Notification.readAt` is set by the existing generic `PATCH /notifications/:id/read`,
called whenever a driver opens their notifications list — for *any* notification type. Treating
that as "acknowledged this specific assignment" would violate FR-017 (no inferring acknowledgment
from unrelated activity): a driver could mark every notification read without ever having looked at
the delivery itself. A dedicated endpoint tied to the screen that actually shows the assignment is
the only signal that means what the spec requires it to mean.

**Alternatives considered**:
- *Infer acknowledgment from the driver's socket reconnecting / going online* — rejected outright
  by FR-017 and by Clarification Q1's own reasoning (a connected device is not the same as a driver
  who has seen this assignment).
- *Reuse `Notification.readAt` with a new `NotificationType`-specific meaning* — rejected; would
  require every other notification-list interaction to somehow exclude assignment notifications
  from generic "mark all read" behavior, adding special-casing to a generic mechanism instead of
  adding one small, explicit field where the assignment state already lives.

## R3 — Durable, cancellable escalation timer

**Decision**: A new `assignment-escalation` BullMQ queue, following `payments/queues/`'s exact
shape: `AssignmentEscalationQueueService.schedule(orderId, delayMinutes)` /
`.cancel(orderId)`, with `jobId = orderId` as the idempotency key (rescheduling or cancelling
targets the same job slot, exactly as `PaymentTimeoutQueueService` already does for payment
timeouts). A `@Processor`-based `AssignmentEscalationProcessor` re-reads the order before acting.

**Rationale**: This is the platform's own existing, proven answer to "durable job that outlives a
process restart, and needs a delay" (Redis-backed BullMQ, already required infrastructure for
payment timeouts) — reusing it satisfies FR-012a for free and adds zero new operational
dependencies. Re-reading the order inside the processor (rather than trusting the job payload) is
the same defensive pattern `PaymentTimeoutProcessor` already uses to handle "the state changed
while this job was waiting," which is exactly FR-014a's requirement.

**Alternatives considered**:
- *A Mongo-document-based scheduler with a polling cron (`@Interval`)* — rejected; the codebase
  already has zero of these for delayed one-shot work, BullMQ already exists and is already required
  infrastructure, and introducing a second scheduling mechanism for the same kind of problem is
  exactly the sort of complexity the constitution's "simpler alternative" framing warns against.
- *setTimeout in process memory* — rejected outright; does not survive a restart, which directly
  fails FR-012a/SC-006.

## R4 — Rate-capping escalation SMS sends

**Decision**: Configure the escalation queue's BullMQ `Worker` with its built-in `limiter: { max,
duration }` option (a per-time-window cap on jobs processed), rather than building a bespoke
throttle. A job that becomes "due" while the limiter is saturated simply waits longer in the queue
before its processor runs — it is never removed or dropped.

**Rationale**: BullMQ already provides exactly this capability natively once a queue exists at all
(R3 already puts one in place) — no additional library, and "queued, delayed, never dropped" (FR-013a)
is the limiter's literal designed behavior, not something to be built on top of it.

**Alternatives considered**:
- *The hand-rolled Redis `incr`/`expire` counter `password-reset.service.ts` uses* — rejected for
  this use; that pattern is built to *refuse* a request once a cap is hit (a 429), which is wrong
  here — an escalation must still eventually fire, never be refused outright.
- *A dedicated rate-limiting package (`bottleneck`, `p-queue`)* — rejected; not installed anywhere
  in the codebase, and would duplicate a capability BullMQ (already a hard dependency) already has.

## R5 — Where the "assigned an ineligible driver" reason lives

**Decision**: Two new fields on `Order`, snapshotted once inside the same `assignDriver`
transaction that already snapshots `driverSummary`: `assignedWhileIneligible?: boolean` and
`assignedWhileIneligibleReason?: string`.

**Rationale**: Mirrors the codebase's own existing precedent for exactly this shape of fact —
`manualOverride`/`overrideReason` on the same `Order` document, from the vehicle-verification
override feature — rather than inventing a differently-shaped audit mechanism for what is
conceptually the same kind of event ("an administrator knowingly overrode the normal eligible path,
here is why").

**Alternatives considered**:
- *A generic append-only "assignment events" sub-collection* — rejected as over-engineering for a
  single boolean-plus-reason fact that already has a proven, simpler precedent in this exact
  codebase.

## R6 — Configuration keys

**Decision**: Two new environment-backed settings, added via the existing three-file pattern
(`configuration.ts` + `validation.ts`, consumed via `ConfigService`) that
`PAYMENT_DEADLINE_MINUTES`/`WAREHOUSE_GEOFENCE_RADIUS_METERS` already establish:
- `ASSIGNMENT_ACK_WINDOW_MINUTES` (default: a low single-digit number — planning-level default,
  per spec Assumptions; not a product decision the spec itself fixes)
- `ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT` (`{max, durationSeconds}` shape) for the BullMQ worker
  `limiter` option (R4)

**Rationale**: Consistent with every other tunable this codebase already exposes — no new
configuration mechanism introduced for two more numbers.
