# Feature Specification: Driver Home & Active Delivery

**Feature Branch**: `007-driver-home-delivery`

**Created**: 2026-08-24

**Status**: Draft

**Input**: User description: "Driver home & active delivery. Make the DRIVER's home screen and delivery list show the driver's real assigned work, and make the delivery flow they already have actually function end to end."

## Context

Spec 006 gave the driver a real *session* — their own identity, a mandatory lock, real sign-out,
prompt revocation. What it did not touch is the thing a driver actually opens the app to do:
**see the job they have been assigned, and complete it**.

Today none of that works. Every driver-facing operational screen is a static mock-up, and the
delivery machinery behind them — which exists, is registered, and is unit-tested — is never
invoked. The gap is not "some polish is missing"; it is that a driver cannot see a real
delivery or complete one at all.

Verified state of the driver's operational surface:

- The home screen renders fixed sample rows and two fabricated figures (a `4.8` rating and a
  `5` orders-today counter). It reads no live data of any kind.
- The component that fetches the driver's active job is never asked to fetch anything, so the
  app permanently believes the driver has no work.
- Because of that, the handover screen the driver would use to confirm a delivery always
  refuses with "no active order", regardless of what the driver scans or types.
- Separately, the two steps that *send the customer their handover code* are never performed
  by the app at all. Even with everything else working, the customer would have no code to
  show, so a delivery could never be completed.
- The driver's order list shows sample rows filed under billing vocabulary — "Deferred",
  "Paid", "Failed" — which describe invoices, not deliveries.
- The delivery detail screen advances its progress indicator when the driver taps a button,
  independently of what the delivery is actually doing.

The platform side is already complete **for the delivery work itself**: the order service scopes
a driver's list to their own assignments, and every step of the handover has a working endpoint.
That part of this feature is almost entirely about connecting an app that shows fiction to a
platform that already holds the truth — with one addition: the platform records contact details
about the *driver* for the customer's benefit, but keeps no mirror, so a driver currently has no
way to identify or reach the customer they are delivering to. That mirror is added here.

The two figures in the home header are the exception. A driver rating and a completed-today
count have no platform representation at all, and are being built here (resolved at the
specification stage, 2026-08-24) rather than removed. The rating in particular is a new capability rather
than a new display: it needs somewhere to store ratings, and it needs the customer — the only
party who actually experiences the driver — to be able to submit one. That makes it the single
part of this feature that reaches into the customer's experience — as a rating control on the
customer's existing order detail, not as a new screen or an interrupting prompt.

## Clarifications

### Session 2026-08-24

- Q: What does a customer actually submit when rating a driver — a score only, a score plus a written review, a score plus fixed-choice tags, or thumbs up/down? → A: **B — a 1–5 score plus an optional short written review.** Matches the existing design, which already renders both a numeric score and a review line on the driver's completed-delivery screen.
- Q: The design shows a customer's score and written review on that specific completed delivery's detail, which makes it attributable to that customer — but FR-041 as drafted forbade exactly that. Which holds? → A: **A — per-delivery feedback is visible to the driver.** FR-041 is replaced. Anonymity would be illusory (the driver met that customer in person) and an aggregate alone gives a driver nothing to act on.
- Q: What exactly are the driver's delivery-list categories, given FR-020 only said "for example"? → A: **A — All · In progress · Completed · Cancelled.** "In progress" spans in-transit and unloading together; splitting them would produce tabs that are empty or hold a single delivery.
- Q: Where does the customer actually submit a rating? → A: **A — on the customer's own order detail, for an order that has been delivered.** No new route, no interruption, and symmetric with where the driver sees the same feedback. No automatic post-delivery prompt is shown.
- Q: The driver has no customer name or phone today (the platform snapshots a driver summary for the customer, but no mirror), yet the design has a call button and assumes a call is possible. What does the driver get? → A: **B — contact name and phone, snapshotted onto the delivery at assignment**, mirroring the existing driver summary. This is new platform capability in the delivery path.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A driver sees the job they have been assigned (Priority: P1) 🎯 MVP

A driver opens the app and immediately sees the delivery they are currently carrying: which
customer, which fuel, how much, where it is going, and how far away it is. If they have no
assignment, the app says so plainly rather than showing someone else's sample delivery.

**Why this priority**: This is the app's entire reason to exist for a driver. Everything else
in this feature depends on the app knowing which delivery is in progress. A driver who cannot
see their assignment cannot begin work, and today every driver sees the same four invented
rows regardless of what they were actually given.

**Independent Test**: Assign a real order to driver A and none to driver B. Open the app as
each. A sees their own delivery with values matching the record; B sees an explicit "no active
delivery" state. Neither sees sample data.

**Acceptance Scenarios**:

1. **Given** a driver with a delivery in progress, **When** they open the home screen, **Then**
   the active delivery card shows that delivery's customer, fuel type, quantity, destination
   and estimated arrival, all matching the platform's record.
2. **Given** a driver with no assignment, **When** they open the home screen, **Then** an
   explicit "no active delivery" state is shown — never a blank card and never sample values.
3. **Given** the delivery data cannot be loaded, **When** the driver opens the home screen,
   **Then** a retryable error is shown, and no fabricated or last-known values are presented
   as current.
4. **Given** driver A signs out and driver B signs in, **When** B's first frame renders,
   **Then** no value belonging to A appears at any point.
5. **Given** a driver's delivery is completed or cancelled by the platform, **When** that
   change occurs, **Then** the home screen stops showing it as active without the driver
   needing to reopen the app.

---

### User Story 2 - A driver completes a delivery end to end (Priority: P1)

A driver arrives at the customer's site, tells the app they have arrived, the customer receives
a code, the driver enters that code to confirm arrival, unloads, requests the delivery code,
the customer receives it, and the driver enters it to close the delivery out.

**Why this priority**: This is the revenue-completing action of the whole platform, and it is
currently impossible. Two separate breaks make it so: the app never asks the platform to send
the customer a code, and the handover screen refuses every code because it does not believe
a delivery is in progress. Fixing either alone still leaves the delivery uncompletable.

**Independent Test**: Take a real order through the full field sequence against a live backend,
reading the customer's codes from the customer's own device. The delivery reaches a completed
state on the platform, and the driver's app reflects it.

**Acceptance Scenarios**:

1. **Given** a driver carrying a delivery, **When** they confirm they have arrived, **Then**
   the customer is sent an arrival code and the driver is told a code has been sent.
2. **Given** the customer has been sent an arrival code, **When** the driver enters or scans
   that code, **Then** the delivery advances to unloading and the driver's screen reflects the
   new stage.
3. **Given** a delivery at the unloading stage, **When** the driver requests the delivery code,
   **Then** the customer is sent a delivery code.
4. **Given** the customer has been sent a delivery code, **When** the driver enters or scans
   it, **Then** the delivery is completed and the driver is released to take new work.
5. **Given** a driver enters an incorrect code, **When** they submit it, **Then** the delivery
   does not advance, the driver is told the code was not accepted, and they may retry.
6. **Given** a driver has made several failed attempts, **When** they exceed the allowed
   number, **Then** they are told to have a fresh code sent rather than being left retrying a
   code that can no longer work.
7. **Given** the driver has no connectivity, **When** they attempt any handover step, **Then**
   the app reports the step did not complete and never shows the delivery as advanced — the
   platform remains the only authority on what stage a delivery has reached.

---

### User Story 3 - A driver reviews their deliveries (Priority: P2)

A driver looks over the deliveries assigned to them — what is coming, what is underway, what
they have finished — described in delivery terms, not billing terms.

**Why this priority**: Drivers need to see their workload and confirm completed work, but it
is a review surface rather than the act of delivering. It is also where the current mock-up is
most visibly wrong: it files deliveries under invoice states that have no meaning for a driver.

**Independent Test**: Give a driver several orders across different stages. Their list shows
exactly those orders, correctly categorised, with no order belonging to another driver.

**Acceptance Scenarios**:

1. **Given** a driver with assigned deliveries, **When** they open their delivery list,
   **Then** every entry is a delivery genuinely assigned to them and no sample rows appear.
2. **Given** a driver viewing their list, **When** they filter by stage, **Then** the
   categories offered are exactly All, In progress, Completed and Cancelled — never invoice
   states such as "Deferred", "Paid" or "Failed".
3. **Given** a driver with more deliveries than fit one screen, **When** they scroll to the
   end, **Then** older deliveries load without duplicating or skipping any entry.
4. **Given** a driver with no deliveries at all, **When** they open the list, **Then** an
   explicit empty state is shown.
5. **Given** a driver taps a delivery in the list, **When** the detail opens, **Then** it shows
   that delivery, not a fixed sample.

---

### User Story 4 - Delivery detail reflects what is actually happening (Priority: P2)

A driver opens a delivery and sees its true current stage and the actions genuinely available
at that stage — not a progress indicator they can advance themselves.

**Why this priority**: A progress display that a driver can advance by tapping is actively
misleading: it can show a delivery as further along than the platform believes, which is
exactly the kind of disagreement that causes disputes over whether fuel was released. It ranks
below the flows above because a driver can still complete work without it being correct.

**Independent Test**: Open a delivery at each real stage and confirm the displayed stage
matches the platform's record, and that no interaction in the screen can change the displayed
stage on its own.

**Acceptance Scenarios**:

1. **Given** a delivery at any stage, **When** the driver opens its detail, **Then** the
   progress shown is the platform's stage for that delivery.
2. **Given** a driver interacting with the detail screen, **When** they tap anything other than
   a genuine delivery action, **Then** the displayed stage does not change.
3. **Given** a delivery's stage changes while the driver is looking at it, **When** that change
   occurs, **Then** the screen updates to the new stage.
4. **Given** a delivery stage where an action is not permitted, **When** the driver views it,
   **Then** that action is not offered — no control on this screen may be present but inert.
5. **Given** a completed delivery the customer rated, **When** the driver opens its detail,
   **Then** the customer's score and written review for that delivery are shown.
6. **Given** a completed delivery the customer did not rate, **When** the driver opens its
   detail, **Then** an explicit "not yet rated" state is shown in place of a score.

---

### User Story 5 - A driver sees their real standing and their day (Priority: P3)

A driver sees, at the top of their home screen, their genuine rating and how many deliveries
they have actually completed today — or an honest "not yet rated" where no rating exists —
alongside a duty indicator that reflects their real state rather than fixed text.

**Why this priority**: The fabricated `4.8` and `5` mislead a driver about their own standing
and workload, and hardcoded duty text undermines trust in everything else on the screen. It is
lowest priority because none of it blocks a driver from doing their job — but note that it
carries the largest share of *new* platform capability in this feature, since neither figure
has any representation today.

**Independent Test**: Trace every figure in the header to a platform record. Give one driver
completed, rated deliveries and another none at all; the first shows real numbers, the second
shows an explicit not-yet-rated state and a zero count — neither shows an invented value.

**Acceptance Scenarios**:

1. **Given** a driver who has been rated, **When** they open the home screen, **Then** the
   rating shown is the value the platform holds for them.
2. **Given** a driver who has never been rated, **When** they open the home screen, **Then** an
   explicit "not yet rated" state is shown — never a default score, a zero, or a placeholder.
3. **Given** a driver who has completed deliveries today, **When** they open the home screen,
   **Then** the count shown equals the number of deliveries they actually completed today.
4. **Given** a driver who has completed none today, **When** they open the home screen, **Then**
   a genuine zero is shown, distinct from "could not load".
5. **Given** a driver completes a delivery, **When** the home screen is next shown, **Then** the
   day's count reflects it without the driver needing to reinstall or sign out.
6. **Given** a driver views their duty indicator, **When** it renders, **Then** it reflects
   their real platform state, and no control is offered to change it.
7. **Given** a driver views the header, **When** they look for another driver's figures,
   **Then** none are reachable — a driver sees only their own.

---

### User Story 6 - A customer rates the driver who delivered to them (Priority: P3)

After a delivery is completed, the customer is offered the chance to rate the driver who
carried it. They may skip it.

**Why this priority**: This exists to make User Story 5's rating real. Without it, ratings can
never be created and every driver would permanently show "not yet rated", so the rating display
would be inert. It shares P3 with US5 for that reason: it is the other half of the same
capability, and equally non-blocking to a driver's actual work.

**Independent Test**: Complete a delivery, submit a rating as that customer, and confirm the
driver's displayed rating changes accordingly. Attempt to rate the same delivery twice, and to
rate a delivery belonging to someone else; both are refused.

**Acceptance Scenarios**:

1. **Given** an order that has been delivered, **When** the customer opens its detail, **Then**
   a rating control for the driver is present on that screen.
2. **Given** a customer sees the rating control, **When** they leave without using it, **Then**
   the delivery is left unrated, nothing is recorded, and they are not chased about it.
3. **Given** a customer submits a rating, **When** it is accepted, **Then** it contributes to
   that driver's rating.
4. **Given** a customer has already rated an order, **When** they reopen its detail, **Then**
   the rating they gave is shown and no further submission is accepted.
5. **Given** an order that is not yet delivered, **When** the customer opens its detail,
   **Then** no rating control is present.
6. **Given** a customer attempts to rate a delivery that was not theirs, **When** they submit,
   **Then** it is refused.
7. **Given** a driver views their own rating, **When** they inspect it, **Then** they cannot
   tell which customer gave which score.

---

### Edge Cases

- A driver is assigned a delivery while the app is open and showing "no active delivery" — the
  new assignment must appear without a manual restart.
- A driver's delivery is cancelled or reassigned by an administrator mid-journey — the app must
  stop presenting it as theirs rather than leaving a stale card in place.
- A driver is deactivated mid-delivery (spec 006 FR-038) — the session ends; the delivery must
  not remain shown as theirs on next sign-in.
- A driver enters a handover code for a delivery that has already advanced (for example the
  code was verified on a retry that appeared to fail) — the delivery must not advance twice.
- A driver scans a code belonging to a different delivery — it must be refused.
- The customer never received their code (delivery failure on the platform's side) — the driver
  needs a way to have a fresh code sent rather than being stuck.
- A driver has connectivity while loading the list but loses it while paging — already-loaded
  entries must remain readable.
- The customer's contact number is missing or unusable on a delivery — the call action must be
  absent rather than present and failing, and the driver still has the destination address.
- A delivery was rejected before any driver was involved — it can never appear in a driver's
  list at all, so no category needs to represent it.
- A driver's estimated arrival cannot be computed — the field must be absent rather than shown
  as zero or as a guess.
- A newly onboarded driver has no ratings at all — the header must say so, not show a default
  score, a zero, or an empty star row that reads as a bad rating.
- Every customer skips rating a driver — that driver stays not-yet-rated indefinitely, which
  must remain a stable, non-alarming state rather than degrading into a score.
- A driver completes a delivery just before or after midnight — the day's count must use one
  consistent day boundary, not shift depending on who is asking.
- A delivery is completed by an administrator override rather than by the driver — whether it
  counts toward the driver's day must be decided rather than left accidental.
- A rated driver is later deactivated — their rating must not be lost or recomputed by their
  absence.
- A customer submits a score with no written review — the driver's view must render cleanly
  with the review area absent, not as an empty quote block.
- A customer submits an abusive or personally identifying written review — nothing in this
  feature can remove it, since moderation is out of scope. This is an accepted, recorded risk
  of allowing free text (see Assumptions).
- A written review is submitted in a language or script different from the driver's app
  language — it is shown as written and never machine-translated or transliterated.

## Requirements *(mandatory)*

### Functional Requirements

#### Seeing the assigned delivery (US1)

- **FR-001**: The app MUST show the driver the delivery currently assigned to them, sourced
  from the platform, on the home screen.
- **FR-002**: The app MUST request the driver's active delivery whenever a driver session
  becomes active, and MUST NOT rely on any screen being visited first.
- **FR-003**: The active delivery display MUST show the fuel type, quantity, destination,
  estimated arrival, and the customer contact name held by the platform for that delivery.
- **FR-003a**: The platform MUST record the customer's contact name and phone number onto the
  delivery when a driver is assigned to it, so the driver can identify and reach the customer.
  This mirrors the contact details the platform already records about the driver for the
  customer's benefit.
- **FR-003b**: The customer's contact details MUST be visible only to the driver assigned to
  that delivery, and MUST NOT be exposed to any other driver.
- **FR-004**: When the driver has no active delivery, the app MUST show an explicit
  "no active delivery" state, distinct from both an error and a loading state.
- **FR-005**: When the active delivery cannot be loaded, the app MUST show a retryable error
  and MUST NOT present placeholder, sample or stale values as current.
- **FR-006**: The app MUST NOT display any delivery, customer, destination or quantity that is
  not sourced from the platform.
- **FR-007**: When a delivery reaches a terminal state, the app MUST stop presenting it as the
  driver's active delivery without requiring the driver to act.
- **FR-008**: On a change of signed-in driver, no value belonging to the previous driver may
  appear in any frame.

#### Completing a delivery (US2)

- **FR-009**: The driver MUST be able to tell the platform they have arrived, which causes the
  customer to be sent an arrival code.
- **FR-010**: The driver MUST be able to request that the customer be sent a delivery code once
  the delivery has reached the unloading stage.
- **FR-011**: The driver MUST be able to submit a handover code by typing it or by scanning the
  customer's code, and both routes MUST be treated identically.
- **FR-012**: The app MUST submit the handover code appropriate to the delivery's current
  stage, determined by the platform's stage rather than by which screen the driver is on.
- **FR-013**: A rejected code MUST leave the delivery unchanged, tell the driver it was not
  accepted, and allow a retry.
- **FR-014**: The app MUST NOT reveal, store or display the customer's handover code to the
  driver at any point.
- **FR-015**: The app MUST NOT advance, predict or locally simulate a delivery's stage; the
  platform's response is the only thing that may change the displayed stage.
- **FR-016**: When a handover step fails because of connectivity, the app MUST report the
  failure and leave the delivery visibly unchanged.
- **FR-017**: When the driver has exhausted the permitted attempts for a code, the app MUST
  direct them to have a fresh code sent rather than continuing to accept attempts.
- **FR-018**: On successful completion of a delivery, the app MUST reflect that the driver is
  free to receive new work.

#### Reviewing deliveries (US3)

- **FR-019**: The driver's delivery list MUST show only deliveries assigned to that driver.
- **FR-020**: The delivery list MUST offer exactly four categories — **All**, **In progress**,
  **Completed**, **Cancelled** — and MUST NOT present billing or invoice vocabulary such as
  "Deferred", "Paid" or "Failed" to a driver.
- **FR-020a**: "In progress" MUST cover every delivery the driver is currently carrying,
  whether under way or being unloaded. "Completed" MUST cover deliveries that were delivered.
  "Cancelled" MUST cover deliveries that were cancelled.
- **FR-020b**: The list MUST open on **All** by default.
- **FR-021**: The delivery list MUST load additional entries as the driver reaches the end of
  the list, without duplicating or omitting entries when new deliveries are assigned.
- **FR-022**: The delivery list MUST show an explicit empty state when the driver has no
  deliveries.
- **FR-023**: Selecting a delivery MUST open that delivery's detail.

#### Delivery detail (US4)

- **FR-024**: The delivery detail MUST derive its displayed stage from the platform's record
  for that delivery.
- **FR-025**: No interaction on the delivery detail other than a genuine delivery action may
  change the displayed stage.
- **FR-026**: The delivery detail MUST reflect a stage change that occurs while it is open.
- **FR-027**: The delivery detail MUST offer only the actions permitted at the delivery's
  current stage, and MUST NOT present controls that do nothing.
- **FR-027a**: The driver MUST be able to call the customer for the delivery they are carrying,
  from the delivery detail, using the contact number recorded on that delivery.
- **FR-027b**: Where a delivery has no usable contact number, the call action MUST be absent
  rather than present and failing.

#### The driver's standing and day (US5)

- **FR-028**: Every figure shown in the home header MUST be derived from the signed-in driver's
  real record or activity; no figure may be displayed with an invented value.
- **FR-029**: The platform MUST hold a rating for each driver, derived from the ratings
  customers have submitted for that driver's completed deliveries.
- **FR-030**: The app MUST show a driver their own current rating.
- **FR-031**: A driver who has never been rated MUST be shown an explicit "not yet rated"
  state. A default score, a zero, or an empty rating presented as a score are all prohibited.
- **FR-032**: The platform MUST report how many deliveries the driver completed on the current
  day, and the app MUST display that count.
- **FR-033**: The day's count MUST use a single, consistent day boundary defined by the
  platform, so the same driver's day does not differ between devices or time zones.
- **FR-034**: A driver MUST be able to see only their own rating and their own daily count.
- **FR-035**: The driver's duty indicator MUST reflect their actual state on the platform —
  whether they are connected, available, and not already carrying a delivery.
- **FR-036**: The app MUST NOT offer a driver any control that changes their own duty state.
  Duty is observed here, not set.

#### Rating a driver (US6)

- **FR-037**: A customer MUST be able to submit a rating for the driver from the order's own
  detail screen, once that order has been delivered. A rating consists of a whole-number score from 1 to 5, and MAY carry a
  short written review.
- **FR-037a**: The written review MUST be optional — a customer may submit a score alone.
- **FR-037b**: The written review MUST be length-bounded (at most 500 characters) and stored as
  plain text; it MUST NOT be rendered as markup anywhere it is displayed.
- **FR-037c**: The app MUST NOT interrupt the customer with an automatic rating prompt, dialog
  or sheet on delivery completion. Rating is offered in place, and the customer comes to it.
- **FR-037d**: Once a customer has rated an order, its detail MUST show the rating they gave
  rather than continuing to offer the rating control.
- **FR-038**: Rating MUST be optional. A skipped delivery records nothing and contributes
  nothing to the driver's rating.
- **FR-039**: A delivery MUST be rateable at most once.
- **FR-040**: Only the customer who received a delivery may rate it, and only once it has
  actually been delivered.
- **FR-041**: The driver MUST be able to see the score and the written review for each of their
  own completed deliveries, on that delivery's detail. Per-delivery feedback is deliberately
  attributable: the driver dealt with that customer in person, so the platform does not pretend
  otherwise.
- **FR-041a**: A completed delivery that has not been rated MUST show an explicit "not yet
  rated" state on its detail — never a zero, a default score, or an empty star row.
- **FR-041b**: A driver MUST NOT be able to see any rating or review belonging to a delivery
  that was not their own.
- **FR-042**: A driver's rating MUST survive their deactivation and MUST NOT be altered by it.

#### Cross-cutting

- **FR-043**: All driver-facing text introduced or corrected by this feature MUST be available
  in both supported languages and render correctly right-to-left.
- **FR-044**: The app MUST distinguish, for the driver, between "nothing assigned", "still
  loading" and "could not load" — these three MUST never render identically.
- **FR-045**: The app MUST distinguish "not yet rated" and "no deliveries completed today" from
  "could not load these figures" — an unreachable platform MUST NOT read as a poor record.

### Key Entities

- **Assigned Delivery**: A delivery the platform has given to this driver. Carries the fuel
  type, quantity, destination, current stage, estimated arrival, and the customer's contact
  name and phone number as recorded when the driver was assigned. The driver never authors any
  of these; they only observe them and act on the delivery.
- **Delivery Stage**: The platform's record of how far a delivery has progressed. The single
  authority for what the driver may do next and what the app displays.
- **Handover Code**: A short code the platform sends to the *customer*, which the driver
  obtains from the customer in person and submits back to prove arrival or completion. Issued
  on the driver's request; never visible to the driver through the app.
- **Duty State**: Whether the driver is currently regarded as available to receive work.
  Observed by the driver, never set by them.
- **Driver Rating**: A driver's overall standing, derived from the ratings customers submitted
  against their completed deliveries. Distinct from the absence of any rating, which is its own
  state and not a score. Visible only to the driver it belongs to.
- **Delivery Rating**: One customer's rating of one completed delivery — a whole-number score
  from 1 to 5, optionally accompanied by a short written review. Submitting is optional, and a
  delivery may be rated at most once.
- **Driver Day Summary**: How many deliveries the driver completed within the platform's
  current day.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A driver with an assignment sees that real delivery within 3 seconds of opening
  the app, with no sample data displayed at any point.
- **SC-002**: 100% of values shown on the driver's operational screens trace to a platform
  record — zero fabricated figures remain.
- **SC-003**: A driver can take a delivery from arrival through to completion entirely within
  the app, in under 2 minutes of interaction excluding physical unloading time.
- **SC-004**: Delivery completion succeeds on the first attempt for at least 95% of handovers
  where the correct code is presented.
- **SC-005**: The stage shown to a driver matches the platform's stage for that delivery in
  100% of checks — no screen can be made to disagree with the platform by interacting with it.
- **SC-006**: A change of signed-in driver leaks no value from the previous driver into any
  frame (0 occurrences across the switch test).
- **SC-007**: A delivery completed or cancelled elsewhere stops appearing as the driver's
  active delivery within 5 seconds, without driver action.
- **SC-008**: Every driver-facing screen in this feature renders without clipped or overflowing
  text in both languages.
- **SC-009**: A driver's displayed rating matches the platform's value for them in 100% of
  checks, and their day's count matches the deliveries they actually completed that day.
- **SC-010**: A driver who has never been rated is never shown a numeric score, across every
  screen and every language (0 occurrences).
- **SC-011**: A completed delivery can be rated by its customer exactly once; repeat and
  cross-customer attempts are refused in 100% of checks.
- **SC-012**: A driver can see the score and review for every one of their own rated deliveries,
  and for none belonging to another driver (0 cross-driver disclosures).

## Assumptions

- **The platform is already sufficient for the delivery flow.** The order list is scoped to the
  driver, and every handover step has a working endpoint. This feature is expected to require
  little or no new platform capability, other than the customer-contact mirror and the rating capability identified below.
- **A driver has at most one delivery in progress at a time.** The platform books a driver onto
  one delivery and releases them when it ends, so "the active delivery" is unambiguous.
- **The stage between assignment and being under way is not one a driver observes.** The
  platform moves a delivery through assignment and into transit as a single step, so the driver
  never sits at an intermediate assigned-but-not-moving stage.
- **Existing delivery machinery is reused, not rebuilt.** The components for fetching the
  active delivery and submitting handover codes already exist and are tested; this feature
  connects them rather than replacing them.
- **A customer's contact details are exposed to their assigned driver, deliberately.** Recorded
  onto the delivery at assignment and readable by that driver only. The platform already makes
  the symmetric disclosure — the customer can see and call their driver — and a driver who
  cannot reach anyone at a fuel station cannot get through the gate. The details persist on the
  completed delivery record, as the driver's own details already do.
- **Codes are read off the customer's own device.** The driver obtains the code face to face;
  the app never transports it to the driver.
- **The rating capability is created here, with deliberately minimal shape.** Resolved at the specification stage
  (2026-08-24). Because rating is a new domain, the following defaults are assumed
  and are the most likely things to want revisiting during clarification or planning:
  the *customer* is the only party who rates, since they are the only one who experiences the
  driver; rating happens after a delivery is complete; rating is optional; a delivery is
  rateable once; and a driver's rating is a simple average of the ratings submitted for them.
- **Per-delivery feedback is attributable, and that is deliberate** (Clarification Q2, 2026-08-24).
  The driver can tell which customer left which score and review. Combined with the absence of
  any takedown path, this means an unfair review is both permanent and traceable to a named
  customer — the two accepted risks compound, and are recorded together here rather than
  separately so the tradeoff stays visible.
- **A driver's rating does not influence dispatch.** Which driver receives which delivery stays
  a matter of capacity, fuel type, proximity and availability. Letting a score affect who gets
  work is a consequential policy decision that this feature deliberately does not take.
- **Ratings are not moderated, disputed or appealable in this feature.** No mechanism is
  provided to contest or remove a rating. **This is a knowingly accepted risk**, and it grew
  when Clarification Q1 admitted free-text reviews (2026-08-24): a driver has no recourse against an
  unfair or abusive written review, and an operator has no way to take one down. If that proves
  unacceptable in practice, a takedown path is the first thing to add — it is deliberately
  omitted here to keep this feature's scope contained, not because it is unnecessary.
- **The day boundary for the daily count is the platform's, not the device's.** One definition,
  applied consistently, so a driver's day does not change with a device's clock or time zone.
- **Location reporting is already handled.** Live position streaming during a delivery is
  existing behaviour and is not redesigned here, beyond starting and stopping with the active
  delivery as it already does.
- **Notifications are already handled.** Alerting the customer when a code is issued is
  existing platform behaviour.

## Out of Scope

- Letting a driver's rating influence dispatch, ranking, pay or eligibility — the rating is
  displayed, and nothing acts on it.
- Moderating, disputing, appealing or removing a rating once submitted.
- Rating anything other than the driver of a completed delivery (the customer does not rate the
  fuel company, the transporter, or the platform).
- Allowing a driver to set their own duty state — resolved as read-only at the specification
  stage (2026-08-24). An explicit on/off-duty control remains a candidate for a later feature.
- Allowing a driver to accept, decline, or choose between deliveries — assignment remains the
  transporter's decision.
- Turn-by-turn navigation beyond handing off to the existing map integration.
- Redesigning the visual layout of the driver's screens; this feature changes what the screens
  are *fed*, not how they are composed, except where a figure must be removed.
- Any client-facing (customer) screen. The one customer-facing change in this feature is a
  rating control added to the **existing** order detail screen for delivered orders (User Story
  6) — no new customer screen or route is created, and no automatic prompt is introduced. That
  change is unavoidable: a rating capability with no way to submit a rating would leave every
  driver permanently unrated.
- The driver's profile, identity and session surfaces, delivered by spec 006.
