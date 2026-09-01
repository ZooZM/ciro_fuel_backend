# Feature Specification: Transport Admin Dashboard — Live Order Lifecycle

**Feature Branch**: `009-transport-dashboard-order-lifecycle`

**Created**: 2026-08-26

**Status**: Draft

**Input**: User description: "now i need you start link with transport admin at dashboard in web i need test the order lifecycle between client, driver and transport dashboard"

## Overview

The transportation company administrator is the only participant in a delivery whose entire
surface is still a picture. The web dashboard has a full set of transport screens — orders list,
order detail, tracking map, drivers, trucks and tanks, dashboard home — and every one of them
renders numbers and rows written into the component files by hand. Meanwhile the platform behind
them can already do the transporter's real job end to end: it can offer a ranked list of nearby
drivers for an order routed to this transporter, commit a driver together with a specific tractor
and trailer, hold the delivery while the driver physically verifies the vehicle, watch it move,
and record the customer's handover.

The consequence is that a delivery cannot currently be carried from start to finish by the people
who are supposed to carry it. A customer can place an order on the mobile app, and a fuel company
administrator can approve and route it — and there it stops, because the act that moves it
forward, choosing who drives it, exists only as an operation nobody can reach. The driver's app
is ready and waiting for work that will never arrive.

This feature connects the transportation administrator's screens to the live platform and,
having done so, establishes a repeatable end-to-end walkthrough in which one order travels the
whole chain — customer places, fuel company approves and routes, transport administrator
assigns, driver verifies and loads and drives and hands over, customer confirms and rates —
with each participant watching the same order change state on their own screen.

Two facts about the current dashboard shape the work. First, the transport screens that *do*
have data-fetching code fetch the wrong things: the actions wired up (approve an order, reject
it, force-complete it) belong to the fuel company administrator, and a transportation
administrator is not permitted to perform any of them. The transporter's own two actions —
list candidate drivers, commit an assignment — are absent, and the one dispatch address the
dashboard does know is a path the platform no longer serves. Second, the dashboard's picture of
an order is several revisions out of date: it does not know that a delivery now passes through a
loading stage, that a vehicle is a tractor and a trailer rather than a field on the driver, or
that a departure can be verified.

## Clarifications

### Session 2026-08-26

- Q: How do the transport screens achieve the required update freshness (FR-014/FR-016,
  SC-003/SC-004), given the dashboard's existing polling-only constraint? → A: Hybrid — keep
  repeated background refresh for lists, detail and counts; use a live connection **only** for the
  tracking map's truck position and in-transit stage pushes. Minimising server cost is the
  governing constraint for the dashboard, so refresh intervals must be the longest that still meet
  the stated freshness bounds, and no screen may refresh while nobody is looking at it.
- Q: The dashboard is a separate repository from the platform — how is this feature's work tracked
  across the two? → A: This specification is the single source of truth for the whole feature,
  including the dashboard's half. The dashboard repository carries a matching feature branch and a
  short pointer back to this specification, but no parallel specification of its own; every
  planning artifact lives here.
- Q: Is the end-to-end walkthrough a manual procedure or an automated test? → A: Both. The written
  manual procedure remains the headline deliverable, because two of the three surfaces are mobile
  apps no browser driver can operate. It is backed by an automated platform-level test driving the
  whole lifecycle, and by automated browser coverage of the dashboard's assignment and tracking
  screens — the half where the defects are expected and the only half a browser can reach.
- Q: The fuel company administrator has no dashboard, yet must approve and route the order — how
  is that step performed? → A: By a documented, repeatable script that signs in as that role and
  calls the platform's real approval and routing interface. No screen is built for that persona,
  and the step must not be short-circuited by writing stored data or by an auto-advance setting —
  the platform's genuine pricing and routing behaviour has to run.
- Q: The mobile applications' notification vocabulary shares no values with the platform's, so
  every live notification currently degrades to an unrecognised type — is that fixed here? → A:
  Answered "yes, fix it here" — but **the premise proved false on verification**. The two
  vocabularies are already identical, value for value, with a deliberate fallback for anything
  unrecognised. No repair is needed. The intent behind the answer is kept as a standing
  requirement: the vocabularies must be confirmed to agree as part of the walkthrough, and any
  divergence found is in scope to fix as an isolated change.
- Q: The dashboard expects page-numbered lists but the platform returns cursor-based ones, and the
  overview needs totals a cursor cannot give — how is this resolved? → A: Cursor paging everywhere,
  with the dashboard's own picture of a paged response corrected to match the platform's. The
  overview's totals come from a dedicated summary request returning every figure in one call,
  never from walking the lists — which is both the correct answer for FR-019 and the cheap one for
  the cost constraint.
- Q: The transport screens are written in hardcoded Arabic despite a bilingual requirement — what
  language scope applies to the new work? → A: Every screen this feature adds or rebuilds is fully
  bilingual and correct in both layout directions from the start, because the translation
  infrastructure already exists unused and retrofitting is what makes bilingual work expensive.
  Existing screens this feature does not touch are not retrofitted; one that is rebuilt to carry
  live data is brought up to standard in the process.
- Q: How much of fleet management ships here, given that card pairing needs physical hardware to
  verify? → A: All of it. The hardware constraint does not apply — programmed cards, card readers
  that behave as keyboards attached to operator machines, and operator devices able to read cards
  directly are all available for testing. So tractor and trailer records, card pairing, the
  scannable credential's whole lifecycle, and driver management all ship. Pairing must accept both
  the keyboard-style reader and a device reading the card itself, detecting which is available
  rather than assuming.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assign a routed order to a driver and a vehicle (Priority: P1)

An order has been approved by the fuel company and routed to this transportation company. The
administrator opens it, sees who ordered what and where it must go, and is shown the drivers who
could take it — ranked, with the nearest and most available first, and with each driver's most
recently operated tractor already suggested. The administrator picks a driver, confirms or
changes the tractor, picks a trailer whose capacity and permitted grades suit the load, and
commits. The order becomes that driver's work, and the driver's phone lights up with it.

**Why this priority**: This single action is the break in the chain. Without it no order placed
by a customer can ever reach a driver, and every other screen in this feature describes work that
cannot begin. It is also the transportation administrator's defining responsibility — the reason
the role exists.

**Independent Test**: With an order sitting in the routed state, an administrator can open it,
choose a driver, tractor and trailer, and commit — after which the order shows as assigned and
the chosen driver sees it in their app. Delivered value: orders start moving.

**Acceptance Scenarios**:

1. **Given** an order routed to the administrator's transportation company, **When** the
   administrator opens its detail view, **Then** they see the customer, the fuel grade and
   volume, the destination, and a list of candidate drivers ordered by suitability.
2. **Given** the candidate list is shown, **When** the administrator selects a driver, **Then**
   that driver's most recently operated tractor is pre-selected, unless it is out of service or
   already committed to another delivery, in which case nothing is pre-selected.
3. **Given** a driver and tractor are chosen, **When** the administrator chooses a trailer whose
   capacity is smaller than the ordered volume or which is not permitted to carry the ordered
   grade, **Then** the assignment is refused with a message naming the reason, and the order
   stays routed.
4. **Given** a valid driver, tractor and trailer, **When** the administrator commits the
   assignment, **Then** the order moves to assigned, names the driver and vehicle on every
   participant's view of it, and the driver receives it on their device.
5. **Given** an order that another administrator has already assigned, or that has been
   cancelled, **When** this administrator attempts to assign it, **Then** the attempt is refused
   and the view corrects itself to the order's true current state.

---

### User Story 2 - Watch a delivery move through every stage (Priority: P1)

Once assigned, the administrator can follow the delivery. The order detail shows where it stands
right now — assigned, awaiting the driver's departure verification; loading at the warehouse; in
transit to the customer; unloading; delivered — with the time each stage began. The tracking
screen shows the truck's position on a map as the driver moves, alongside the driver's name,
the vehicle, the destination and the estimated arrival. Nothing on these screens is invented:
every value is the platform's own record of the delivery.

**Why this priority**: Assignment without visibility is a handoff into darkness. The
administrator is accountable for deliveries in progress, and the loading stage in particular is
new enough that a dashboard which cannot display it will silently misreport where a truck is.
This is also the half of the walkthrough the tester actually watches.

**Independent Test**: With an assigned order, an administrator watching the order detail and
tracking screens sees each stage appear as the driver advances it on their phone, and sees the
truck's position change as the driver moves. Delivered value: the transporter knows the state of
their fleet.

**Acceptance Scenarios**:

1. **Given** an assigned order, **When** the driver verifies the tractor and departs for the
   warehouse, **Then** the administrator's view of the order shows the loading stage and the time
   it began, without the administrator reloading the page.
2. **Given** an order in transit, **When** the administrator opens the tracking screen, **Then**
   the truck appears at its last known position with the driver's name, the vehicle, the
   destination and the estimated arrival time.
3. **Given** the tracking screen is open on a moving delivery, **When** the driver's position
   changes, **Then** the position shown updates without the administrator reloading the page.
4. **Given** an order that is not yet in transit or has already been delivered, **When** the
   administrator opens the tracking screen for it, **Then** they are told the delivery is not
   currently trackable rather than shown a stale or empty map.
5. **Given** any order belonging to this transportation company, **When** the administrator views
   its history, **Then** every stage it has passed through is listed in order with its timestamp,
   including whether the departure was verified by the driver or overridden by an administrator.

---

### User Story 3 - Run the full lifecycle across all three participants (Priority: P1)

A tester takes a single order the whole way: a customer places it on the mobile app; the fuel
company administrator approves and routes it; the transportation administrator assigns a driver
and vehicle; the driver verifies the tractor, loads at the warehouse, drives, arrives, takes the
customer's handover code, and completes the delivery; the customer confirms receipt and rates it.
At every step, each of the three participants sees the same order in the same state on their own
screen. The walkthrough is written down as a repeatable procedure, with the starting data it
needs and the expected observation at each step.

**Why this priority**: This is what the user actually asked for. The individual screens can each
look correct while the chain between them is broken — a mismatch in how one participant names a
stage, a notification that never arrives, an assignment the driver's app cannot parse. Only the
full traversal proves the platform works, and it is the acceptance test for this feature as a
whole.

**Independent Test**: Following the written procedure against a running platform, one order
reaches delivered and rated, with every intermediate state observed on all three surfaces.
Delivered value: demonstrable proof the product works end to end.

**Acceptance Scenarios**:

1. **Given** a prepared environment with a customer, a fuel company administrator, a
   transportation administrator, a driver, a tractor, a trailer and a warehouse, **When** the
   tester follows the procedure, **Then** one order reaches the delivered and rated state with no
   step requiring direct data manipulation to proceed.
2. **Given** the order is at any stage, **When** the tester compares the customer's view, the
   driver's view and the administrator's view, **Then** all three name the same stage — no
   participant shows a stage the others do not recognise.
3. **Given** a stage advances, **When** the participants who should be told about it are checked,
   **Then** each has received a notification whose meaning matches the stage, rather than an
   unrecognised or blank one.
4. **Given** the walkthrough has been run once, **When** a second tester runs it from the written
   procedure alone, **Then** they reach the same end state without needing to ask how.

---

### User Story 4 - Manage the fleet the assignment draws from (Priority: P2)

The administrator maintains the drivers, tractors and trailers that assignment chooses between:
registering a new tractor and pairing its identity card, registering a trailer with its capacity
and the grades it may carry, taking a vehicle out of service and putting it back, and adding or
suspending drivers. What the assignment screen offers is exactly what the administrator has
registered here.

**Why this priority**: The walkthrough can begin against seeded fleet data, so this does not block
it outright. But the trailer's capacity and permitted grades are what make Story 1's guards
meaningful rather than theoretical, and card pairing sits on the walkthrough's critical path the
moment the driver verifies against a real card rather than a seeded one — a card must be bound to
a tractor here before the driver's verification can succeed there.

**Independent Test**: An administrator can register a tractor and a trailer, pair a physical card,
issue its scannable credential, and see both vehicles offered on the next assignment — after which
a driver can verify against that card. Delivered value: the transporter controls their own fleet.

**Acceptance Scenarios**:

1. **Given** the fleet screen, **When** the administrator registers a tractor, **Then** it
   appears in the fleet list and is offered on subsequent assignments.
2. **Given** the pairing screen is open and a reader that behaves as a keyboard is attached,
   **When** the operator presents a card, **Then** its identifier is captured without the operator
   clicking into a field first, and is shown for confirmation before it is bound.
3. **Given** the pairing screen is open on a device that can read cards itself, **When** the
   operator presents a card to the device, **Then** it is captured the same way, and the screen
   never asks the operator which method to use.
4. **Given** the pairing screen is open, **When** a person types an identifier by hand at human
   speed, **Then** it is not mistaken for a scanned card and must be submitted explicitly as a
   manual entry.
5. **Given** a card already bound to another tractor, **When** the operator presents it, **Then**
   the pairing is refused and the tractor already holding it is named.
6. **Given** a registered tractor with a paired card, **When** the administrator issues its
   scannable credential, **Then** the driver can verify that tractor by either the card or the
   credential.
7. **Given** a leaked or compromised scannable credential, **When** the administrator revokes or
   reissues it, **Then** the old one stops being accepted immediately and the new one works.
8. **Given** a tractor or trailer currently committed to a delivery, **When** the administrator
   attempts to take it out of service, **Then** they are told it is in use and the delivery is
   unaffected.
9. **Given** a driver record, **When** the administrator suspends it, **Then** that driver stops
   appearing as an assignment candidate and cannot sign in.
10. **Given** the fleet list, **When** the administrator views it, **Then** each tractor shows
    whether it has a paired card and a live credential, so an unverifiable vehicle is visible
    before it is assigned rather than at the gate.

---

### User Story 5 - Resolve a delivery that has stalled (Priority: P2)

A driver reaches the yard and the tractor's card will not read — a damaged card, a dead phone,
the wrong truck at the gate. Rather than the delivery stopping, the administrator can override
the verification with a recorded reason, or reassign the delivery to a different vehicle. An
overridden departure is marked as overridden everywhere it appears and is never presented as
verified.

**Why this priority**: Real operations stall, and a platform that can only continue when
everything works is not usable in a fuel yard. It is a secondary path — the walkthrough proves
the primary one — but it is the difference between a demonstrable product and an operable one.

**Independent Test**: With a delivery held at verification, an administrator can override it with
a reason and the delivery continues, showing as overridden rather than verified. Delivered value:
deliveries do not die at the gate.

**Acceptance Scenarios**:

1. **Given** an assigned delivery whose driver cannot verify the tractor, **When** the
   administrator overrides the verification and gives a reason, **Then** the delivery proceeds and
   both the override and the reason are recorded on it.
2. **Given** an overridden departure, **When** any participant views the delivery, **Then** it is
   shown as overridden by an administrator, never as verified by the driver.
3. **Given** an assigned delivery whose tractor has broken down, **When** the administrator
   reassigns it to a different tractor or trailer, **Then** the delivery continues with the new
   vehicle, the released vehicle becomes available again, and the change is recorded.
4. **Given** a delivery that has already departed the warehouse, **When** the administrator
   attempts to override its departure verification, **Then** the attempt is refused as no longer
   applicable.

---

### User Story 6 - See the transportation company's own position at a glance (Priority: P3)

The dashboard home and the drivers, clients and invoices screens show this transportation
company's real figures: deliveries awaiting assignment, deliveries in progress, deliveries
completed in the period, drivers currently on duty, and outstanding settlements — with the
awaiting-assignment count acting as the administrator's work queue.

**Why this priority**: These are the screens the administrator opens first each morning, but
every figure on them is derivable from data the earlier stories already surface, and none of them
is required to move an order. Wired last, they are also the strongest signal that the earlier
work is genuinely live rather than mocked.

**Independent Test**: With deliveries in several states, the dashboard home's counts match what
the orders list contains, and change as deliveries advance. Delivered value: the transporter's
daily overview is trustworthy.

**Acceptance Scenarios**:

1. **Given** deliveries in various states, **When** the administrator opens the dashboard home,
   **Then** every count shown matches the number of deliveries actually in that state for this
   company.
2. **Given** the dashboard home is open, **When** a delivery advances, **Then** the affected
   counts change without the administrator reloading the page.
3. **Given** a company with no deliveries at all, **When** the administrator opens the dashboard
   home, **Then** they see an explicit empty state rather than zeros presented as achievement or
   a permanently loading screen.

---

### Edge Cases

- **A stage the dashboard has never heard of.** The delivery lifecycle gained a loading stage
  after these screens were drawn. Every place the dashboard names a stage must recognise all of
  them; an unrecognised stage must be shown honestly as unknown rather than silently omitted,
  mislabelled as an adjacent stage, or rendered blank.
- **Two administrators, one order.** Two people in the same transportation company open the same
  routed order and both press assign. Exactly one succeeds; the other is told the order has
  already been assigned and their view corrects itself.
- **The order moves on while a screen is open.** The customer cancels, or the fuel company
  reroutes to a different transporter, while the administrator has the assignment screen open.
  The pending action is refused on the platform's authority, not permitted by the stale screen.
- **A vehicle committed twice.** The same tractor or trailer is chosen for two deliveries in
  quick succession. The second is refused, and the vehicle only becomes available again when its
  delivery ends or it is released by reassignment.
- **No candidates at all.** No driver is available or in range for a routed order. The
  administrator sees an explicit statement that there are no candidates and what to do about it,
  not an empty list indistinguishable from a failed load.
- **Viewing someone else's delivery.** An administrator addresses a delivery belonging to a
  different transportation company. It is indistinguishable from one that does not exist — no
  hint is given that it is real.
- **The session expires mid-walkthrough.** The administrator's credentials lapse while a screen
  is polling. They are returned to sign-in with their destination preserved, not shown an error
  loop or stale data.
- **Connectivity drops during tracking.** The live position stops arriving. The screen states
  that the position is stale and how old it is, rather than continuing to present the last known
  point as current.
- **A delivery that never gets a rating.** The customer completes the delivery but does not rate
  it. Everywhere a rating would appear, absence is shown as not-yet-rated — distinct from a score
  of zero.
- **The customer's handover code is requested twice.** The driver requests the customer's
  handover code more than once, or the customer opens their code screen repeatedly. The
  administrator's view of the delivery is unaffected and never displays the code.
- **A card is presented to the wrong screen.** A reader that behaves as a keyboard types wherever
  the focus happens to be. A card presented while the pairing screen is closed, or while focus
  sits in an unrelated field, must not be absorbed as text into that field, submitted as part of
  another form, or bound to anything.
- **A card is presented twice in quick succession.** A reader that repeats, or an operator who
  holds the card against it, must produce one binding and one confirmation — not several.
- **The card reader and the device reader are both available.** The screen must settle on one
  without asking the operator to choose, and a card presented once must not register twice.
- **A card is presented before a tractor is chosen.** The screen must hold the captured
  identifier and ask which tractor it belongs to, rather than discarding the read and making the
  operator present the card again.
- **The credential is rotated while a driver is mid-verification.** The attempt in flight against
  the superseded credential is refused, and the driver is told to obtain the current one rather
  than being left on a screen that silently never succeeds.

## Requirements *(mandatory)*

### Functional Requirements

#### Assignment (Story 1)

- **FR-001**: The transportation administrator MUST be able to see, for an order routed to their
  company, the ordering customer, the fuel grade, the volume, the destination, and the requested
  delivery window.
- **FR-002**: The system MUST present, for a routed order, the drivers eligible to take it,
  ordered by suitability, with each driver's name, contact, on-duty state and distance from the
  destination.
- **FR-003**: The system MUST pre-select, for a chosen driver, the tractor that driver most
  recently operated, and MUST pre-select nothing when that tractor is out of service or already
  committed to another delivery.
- **FR-004**: The administrator MUST be able to choose the tractor and the trailer independently
  of the pre-selection, from the vehicles their company has registered and which are in service
  and uncommitted.
- **FR-005**: The system MUST refuse an assignment whose chosen trailer cannot hold the ordered
  volume or is not permitted to carry the ordered grade, and MUST state which of the two
  conditions failed.
- **FR-006**: The system MUST refuse an assignment for an order that is not awaiting driver
  assignment, and the administrator's view MUST then show the order's true current state.
- **FR-007**: On a committed assignment, the order MUST become assigned to that driver with that
  tractor and trailer, and the assigned driver MUST receive the delivery on their device without
  reopening the app.
- **FR-008**: The system MUST guarantee that concurrent assignment attempts on one order result in
  exactly one assignment, with the losing attempt told the order is already assigned.
- **FR-009**: The administrator MUST be able to reach assignment directly from a work queue of
  orders awaiting assignment, without searching for them.

#### Delivery progress and tracking (Story 2)

- **FR-010**: Every place the dashboard names a delivery's stage MUST recognise the full set of
  stages the platform can report, including the loading stage between assignment and transit.
- **FR-011**: A stage the dashboard does not recognise MUST be displayed as unknown, and MUST NOT
  be omitted, blanked, or shown as a different stage.
- **FR-012**: The order detail MUST list every stage the delivery has passed through, in order,
  each with the time it occurred.
- **FR-013**: The order detail MUST state whether the departure was verified by the driver or
  overridden by an administrator, and MUST NOT present an override as a verification.
- **FR-014**: A delivery's stage shown on screen MUST update while the administrator watches,
  without a manual reload, within a bounded interval of the change.
- **FR-015**: The tracking screen MUST show the assigned truck's most recent known position, the
  driver's name, the vehicle, the destination, and the estimated time of arrival.
- **FR-016**: The truck's position on the tracking screen MUST update as the driver moves,
  without a manual reload.
- **FR-017**: The tracking screen MUST state explicitly when a delivery is not currently
  trackable, distinguishing that from a delivery whose position is merely unknown.
- **FR-018**: When live position updates stop arriving, the screen MUST state that the position is
  stale and how long ago it was recorded.
- **FR-019**: The administrator MUST be able to filter and page through their company's
  deliveries by stage and date without duplicated or skipped rows as new deliveries arrive.
- **FR-020**: Delivery lists, order detail and overview counts MUST stay current by repeated
  background refresh, at the longest interval that still satisfies the stated freshness bounds.
- **FR-021**: The truck's position on the tracking map, and stage changes for a delivery in
  transit, MUST arrive over a live connection rather than by repeated refresh.
- **FR-022**: No screen may refresh in the background while it is not being viewed — refresh MUST
  stop when the tab is hidden or the screen is left, and resume on return.
- **FR-023**: A live connection MUST be opened only while a screen that needs one is open and its
  delivery is trackable, and MUST be closed when that screen is left.
- **FR-024**: Only one live connection MUST be held per administrator session, regardless of how
  many deliveries are being observed.

#### End-to-end walkthrough (Story 3)

- **FR-025**: The feature MUST provide a written, repeatable walkthrough carrying one order from
  placement to delivery and rating, naming at each step which participant acts and what each of
  the other participants should then observe.
- **FR-026**: The walkthrough MUST specify the starting data it requires — the participants, the
  fleet, the warehouse, and the pricing needed for an order to be priced and approved — and how to
  bring that data into existence.
- **FR-027**: The walkthrough MUST be completable without direct manipulation of stored data to
  advance any step.
- **FR-028**: All three participants MUST name the same stage for the same delivery at the same
  time; no participant may display a stage the others cannot express.
- **FR-029**: Every notification a participant receives during the walkthrough MUST carry a
  meaning that participant recognises, and MUST NOT degrade to an unrecognised or blank type.
- **FR-030**: The walkthrough MUST record, for each step, the observable evidence that the step
  succeeded, so a second person can run it and judge the result without assistance.

- **FR-031**: The platform MUST have an automated end-to-end test that drives one delivery
  through every stage of the lifecycle, from placement to delivery and rating, asserting each
  participant's permitted view and action at each stage.
- **FR-032**: The dashboard MUST have automated browser coverage of the assignment flow,
  including the capacity and grade refusals and the already-assigned refusal.
- **FR-033**: The dashboard MUST have automated browser coverage of the tracking screen,
  including the not-trackable and stale-position states.
- **FR-034**: The automated tests MUST run without a human operating any mobile device; the
  mobile participants' steps MUST be exercisable through the platform directly.

- **FR-035**: The walkthrough MUST supply a documented, repeatable means of performing the fuel
  company administrator's approval and routing steps through the platform's real interface, under
  that role's real authorization, without a screen being built for that persona.
- **FR-036**: That means MUST exercise the platform's genuine approval and routing behaviour —
  including pricing — and MUST NOT bypass it by writing stored data directly or by any
  auto-advance setting.

- **FR-037**: The walkthrough MUST confirm that every participant's application recognises the
  full vocabulary of notification meanings the platform can send, by observing a real notification
  of each kind the lifecycle produces arrive and be named correctly — not by comparing the two
  vocabularies by eye.
- **FR-038**: Any divergence FR-037 uncovers MUST be repaired as an isolated change, with the
  platform's and the mobile applications' existing test suites green before and after, because it
  would touch personas this feature otherwise leaves alone.

#### Fleet management (Story 4)

- **FR-039**: The administrator MUST be able to register, amend and list their company's tractors,
  including the plate and identifying details.
- **FR-040**: The administrator MUST be able to register, amend and list their company's trailers,
  including capacity and the fuel grades each may carry.
- **FR-041**: The administrator MUST be able to pair a tractor's physical identity card and to
  issue, reissue and revoke its scannable credential, and a revoked or superseded credential MUST
  stop being accepted.
- **FR-042**: The administrator MUST be able to take a tractor or trailer out of service and
  return it, and the system MUST refuse to withdraw one currently committed to a delivery.
- **FR-043**: The administrator MUST be able to add, amend, suspend and reinstate the drivers in
  their fleet, and a suspended driver MUST stop appearing as an assignment candidate and be unable
  to sign in.
- **FR-044**: Fleet screens MUST offer only vehicles belonging to the administrator's own
  transportation company.

- **FR-045**: The card-pairing screen MUST accept a card presented through a reader that behaves
  as a keyboard, capturing the identifier without the operator having to click into a field first,
  and MUST distinguish a reader's rapid input from a person typing so that hand-typed text is
  never mistaken for a scanned card.
- **FR-046**: The card-pairing screen MUST also accept a card read directly by the operator's own
  device where that device can read cards itself, and MUST detect which of the two paths is
  available rather than assuming either.
- **FR-047**: Where neither path is available, the screen MUST say so plainly and offer the
  identifier to be entered by hand, clearly marked as a manual entry.
- **FR-048**: A card identifier MUST only ever be captured while the pairing screen is open and
  awaiting one; no other screen or field may absorb a card presented by mistake.
- **FR-049**: The screen MUST show the operator what was captured and which tractor it will be
  bound to, and MUST require an explicit confirmation before binding.
- **FR-050**: Pairing a card already bound to another tractor MUST be refused and MUST name the
  tractor holding it, rather than silently rebinding.
- **FR-051**: A card identifier MUST NOT be written to logs, diagnostics, or any record beyond the
  binding itself.
- **FR-052**: The scannable credential MUST be issuable, rotatable and revocable from the
  dashboard, MUST be displayable for the driver to capture, and rotation or revocation MUST take
  effect immediately for verification attempts.
- **FR-053**: The dashboard MUST show, for each tractor, whether it currently has a paired card
  and a live scannable credential, so an unpairable vehicle is visible before it is assigned.

#### Stalled deliveries (Story 5)

- **FR-054**: The administrator MUST be able to override a departure verification the driver
  cannot complete, supplying a reason, and the delivery MUST then proceed.
- **FR-055**: An overridden departure MUST be recorded with its reason and MUST be presented as
  overridden wherever the delivery is viewed.
- **FR-056**: The system MUST refuse an override for a delivery that has already departed the
  warehouse.
- **FR-057**: The administrator MUST be able to reassign a delivery to a different tractor or
  trailer before it departs, releasing the previous vehicle for other work.
- **FR-058**: A reassignment MUST be recorded on the delivery with what changed and when.

#### Company overview (Story 6)

- **FR-059**: The dashboard home MUST show this company's counts of deliveries awaiting
  assignment, in progress, and completed in the selected period, each matching what the
  corresponding list contains.
- **FR-060**: The dashboard home MUST show how many of the company's drivers are currently on
  duty.
- **FR-061**: The dashboard home MUST show outstanding settlements owed by or to the company.
- **FR-062**: Every figure on the dashboard home MUST come from the platform's records; no
  fabricated or placeholder value may remain on any transport screen once that screen is wired.
- **FR-063**: Counts MUST refresh as deliveries advance, without a manual reload.
- **FR-064**: Each list and figure MUST distinguish three states from one another: loading, empty,
  and failed.

- **FR-065**: Every paged list in the dashboard MUST use the platform's cursor-based paging, and
  the dashboard's own picture of a paged response MUST be corrected to match it.
- **FR-066**: The overview counts MUST be served by a dedicated summary request that returns them
  directly, and MUST NOT be derived by fetching or walking the underlying lists.
- **FR-067**: The summary request MUST return every figure the dashboard home shows in a single
  call, so that opening the home costs one request rather than one per figure.

#### Access and integrity (all stories)

- **FR-068**: Every transport screen MUST be reachable only by an authenticated transportation
  company administrator, and access MUST be refused before any data for that screen is requested.
- **FR-069**: A transportation administrator MUST NOT see or act on any delivery, driver, vehicle
  or client belonging to another company, and such a record MUST be indistinguishable from one
  that does not exist.
- **FR-070**: The dashboard MUST NOT offer the administrator any action their role cannot
  perform — in particular the fuel company's approval, rejection, cancellation and completion
  actions (four, not three: implementation found the platform also refuses this role's attempt
  to cancel an order, which the original pass here had not named).
- **FR-071**: The dashboard MUST never display a customer's delivery handover code.
- **FR-072**: The platform MUST remain the sole authority on whether a stage change is permitted;
  no dashboard screen may advance a delivery on its own judgement.
- **FR-073**: When the administrator's session lapses, they MUST be returned to sign-in with their
  intended destination preserved, and no stale data may remain visible.
- **FR-074**: Every screen this feature adds or rebuilds MUST be fully bilingual: no user-visible
  text may be written directly into a screen, every string MUST come from the shared translation
  layer, and both languages MUST be populated at the point the screen is called done.
- **FR-075**: Every screen this feature adds or rebuilds MUST lay out correctly both
  right-to-left and left-to-right, including the assignment flow, the fleet forms, the tracking
  map's surrounding panels, and every error, empty and loading state.
- **FR-076**: Existing transport screens this feature does not otherwise touch are NOT required
  to be translated as part of it; where such a screen is rebuilt to carry live data, it MUST be
  brought up to FR-065 and FR-066 in the process.
- **FR-077**: A value the platform has not recorded MUST be presented as absent, never as zero or
  blank — a driver who has never been rated reads as not yet rated, not as a score of zero, and a
  figure that could not be loaded reads as failed, not as nothing.
- **FR-078**: No credential belonging to an administrator's session may be held anywhere a script
  on the page can read it.

### Key Entities

- **Delivery order**: The unit that travels the whole chain. Carries the customer, the grade and
  volume, the destination, the itemised cost, the current stage, the full stage history, the
  assigned driver, the assigned tractor and trailer, the departure verification or its override,
  and — once complete — the customer's rating.
- **Assignment candidate**: A driver offered for a routed order, with the attributes that make
  them suitable — availability, on-duty state, distance from the destination — and the tractor
  they most recently operated.
- **Tractor**: The powered vehicle a transportation company registers, carrying the identity
  credentials a driver verifies against, and either in service or withdrawn, free or committed to
  a delivery. Whether it currently holds a paired card and a live credential is part of what the
  administrator sees, because a tractor missing either cannot be verified at the gate.
- **Card binding**: The association between one physical card and one tractor. A card belongs to
  at most one tractor at a time, and its identifier is held only for this binding — never logged
  or copied elsewhere.
- **Scannable credential**: The rotatable secret a driver may present instead of the card. It can
  be issued, rotated and revoked independently of the card, and only its current value is ever
  accepted.
- **Trailer**: The towed vessel, carrying the capacity and the permitted fuel grades that decide
  whether it may take a given order — the attributes the assignment guards test.
- **Driver**: A person in the transportation company's fleet, with an on-duty state, a location,
  a delivery history and an aggregate rating that may be absent when never rated.
- **Warehouse**: The place a delivery loads before travelling to the customer.
- **Departure verification**: The record that a driver confirmed they were at the assigned
  tractor — present when verified, absent when an administrator overrode it, so that an override
  can never read as a verification.
- **Notification**: The message telling a participant their delivery changed, carrying a meaning
  every participant's app understands.
- **Settlement**: An amount owed between the transportation company and a fuel company for
  completed deliveries.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One order travels from customer placement to delivered and rated, observed on all
  three participants' screens, with no step requiring direct data manipulation.
- **SC-002**: A transportation administrator assigns a driver and vehicle to a routed order in
  under 60 seconds from opening the order, without leaving the assignment screen to look
  something up.
- **SC-003**: A stage change made by any participant becomes visible on the administrator's open
  screen within 15 seconds, with no manual reload.
- **SC-004**: A moving truck's position on the tracking screen is never more than 60 seconds
  behind the driver's device while the delivery is in transit and connectivity holds.
- **SC-005**: Zero fabricated values remain on any wired transport screen — every figure, row and
  label is traceable to a platform record.
- **SC-006**: All stages the platform can report are named correctly on every transport screen,
  verified by driving one delivery through every stage and reading each screen at each stage.
- **SC-007**: 100% of assignment attempts that violate a capacity or grade rule are refused, with
  the failing rule named, verified across a set of deliberately invalid combinations.
- **SC-008**: Concurrent assignment attempts on one order produce exactly one assignment in 100%
  of trials.
- **SC-009**: Every attempt by an administrator to view or act on another company's record is
  refused indistinguishably from a record that does not exist, across every transport screen.
- **SC-010**: A second tester, given only the written walkthrough, completes it end to end without
  asking a question.
- **SC-011**: Every list and figure on every transport screen presents loading, empty and failed
  as three visibly distinct states.
- **SC-012**: A delivery stalled at verification is carried to completion by an administrator
  override in under 2 minutes, and reads as overridden — never verified — on every screen
  afterwards.
- **SC-013**: An administrator who leaves a transport screen open but unattended for 10 minutes
  generates no platform requests for that period beyond what an open live connection costs.
- **SC-014**: An administrator session observing deliveries holds at most one live connection,
  regardless of how many deliveries are open or observed.
- **SC-015**: A one-hour session of ordinary transport administration issues no more platform
  requests than the freshness bounds in SC-003 and SC-004 require, measured against a documented
  expected count per screen.
- **SC-016**: An automated test carries one delivery through every stage of the lifecycle and
  passes in continuous integration with no human operating a mobile device.
- **SC-017**: Automated browser tests cover the assignment flow's success path and each of its
  refusal paths, and the tracking screen's live, not-trackable and stale states.
- **SC-018**: Both automated suites and the existing platform and mobile suites are green at the
  point the feature is called complete, with any pre-existing failures named in advance.
- **SC-019**: An operator pairs a physical card to a tractor in under 30 seconds from opening the
  pairing screen, using either input path, without consulting instructions.
- **SC-020**: A card presented while the pairing screen is not awaiting one is absorbed by no
  field on any screen, verified across every transport screen with a reader attached.
- **SC-021**: Hand-typed identifiers are never accepted as scanned reads, and scanned reads are
  never rejected as hand-typed, across at least 20 trials of each.
- **SC-022**: A revoked or rotated credential stops being accepted for verification immediately —
  within the time of a single verification attempt — with no stale-credential window.
- **SC-023**: A driver verifies a tractor against a card paired through the dashboard, end to end,
  as part of the walkthrough.

## Assumptions

- The order lifecycle, dispatch, fleet, verification, tracking, rating and notification
  capabilities this feature exposes already exist on the platform and are exercised by its test
  suites; this feature connects the transportation administrator's screens to them and is not
  expected to add new platform capability except where a gap is found during wiring.
- The customer's and driver's mobile experiences are already connected end to end, so the
  walkthrough's failures are expected to lie in the transport dashboard or in the seams between
  participants rather than in the mobile apps themselves. This was verified rather than assumed:
  the driver's vehicle verification, its card reading, the loading stage and the notification
  vocabulary are all present and current in the mobile application.
- The project's own context notes describe the vehicle-and-loading work as planned but not built,
  and the notification vocabularies as mismatched. Both were checked directly and found stale —
  the platform and the mobile applications carry that work already. **The dashboard is the only
  surface still behind**, which narrows this feature considerably and is why no platform capability
  is expected to be added. Any further claim from those notes should be verified before it is
  relied on in planning.
- The fuel company administrator has no screens of their own and will not get any here; their
  approval and routing steps are driven by a documented script against the platform's real
  interface. The walkthrough therefore proves three of the four personas end to end, and the
  fourth only at the platform level — an accepted limit, since that persona's dashboard is a
  feature of its own.
- The web dashboard's existing transport screens, layouts and visual design are kept as they
  are; this feature replaces the data behind them and adds only the surfaces the assignment and
  fleet actions require.
- The feature spans two independent repositories — the platform and the dashboard — which share
  no branch or tag. This specification governs both halves; the dashboard repository holds only a
  feature branch and a pointer back here. Because nothing enforces the correspondence
  automatically, the walkthrough is the only thing that proves the two halves agree, which is a
  further reason it is a P1 deliverable rather than a closing formality.
- "Done" for this feature is defined only at the walkthrough level, never per repository: neither
  half can be called complete on its own tests alone.
- Server cost is the governing constraint on how the dashboard stays current: between two designs
  that both meet a stated freshness bound, the one that asks the platform for less is correct.
  This is why the split in FR-020/FR-021 falls where it does — repeated refresh is cheap at the
  intervals lists and counts need, and ruinous at the interval a moving truck needs.
- The platform already admits a transportation administrator to a delivery's live position feed
  and already refuses one for a delivery that is not in transit, so FR-021 and FR-017 are expected
  to need no platform change.
- The walkthrough is run against a development environment with a seeded set of participants and
  fleet, on a single machine, by one tester coordinating all three surfaces.
- Warehouse records needed by the walkthrough may be seeded directly. Vehicle records may be
  seeded for an early run, but the finished walkthrough registers and pairs them through the
  dashboard, since fleet management ships in this feature.
- The testing environment has programmed physical cards, at least one reader that presents itself
  to the operator's machine as a keyboard, and at least one operator device able to read a card
  directly. Both input paths are therefore verifiable, and neither may be built without being
  tested.
- Reading a card directly on the operator's device is available only in some browsers and
  typically requires a secure connection and a deliberate gesture; the keyboard-style reader is
  the path that always works, so it is the one the screen must never be without.
- The dashboard's own access token is already held in memory only, never in storage a script can
  read. The refresh contract this feature corrects (sending the refresh token in the request body,
  per the recorded deviation) does not change that — the refresh token passes through a request and
  a response and is never written to `localStorage`, `sessionStorage`, or any other script-readable
  location (FR-078). Any existing code found doing otherwise is a defect to fix as part of this
  correction, not a pattern to extend.
- The fuel company administrator's dashboard, the invoice and settlement workflows beyond the
  overview figure, and reconciliation of the delivered volume against the supplier's invoice are
  outside this feature.
