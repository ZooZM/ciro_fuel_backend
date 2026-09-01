# Feature Specification: In-Transit Stop Detection & Driver Check-In

**Feature Branch**: `011-transit-stop-detection`

**Created**: 2026-08-28

**Status**: Draft

**Input**: User description: "During the in-transit leg (warehouse → customer station), track the
driver's phone location and detect when the truck has not moved for 10 minutes. When a stop is
detected, notify the driver asking them to state the reason for stopping; the reason is relayed to
the transportation company. If the driver does not respond within a time period, notify the
transport administrator that there is an issue with this order. Surface this on the transport
dashboard's order detail — a mock component for exactly this ('driver stopped moving for more than
10 minutes') already exists in the frontend project and was deleted in feature 009 for lack of
platform support. Tracking must work reliably on both Android and iOS, including while the driver's
app is backgrounded."

## Clarifications

### Session 2026-08-28

- Q: How does the stop prompt actually reach a driver whose app is backgrounded and whose phone is
  pocketed mid-drive, given the platform has no push provider and today's notifications are in-app
  only? → A: A device-local notification, raised from the socket event that already arrives while
  the background location service keeps the app alive — a real alert with sound, tapping it opens
  the reason prompt.
- Q: Is this feature safety/visibility oriented, or anti-theft/compliance monitoring of the driver?
  → A: Safety and delivery visibility. Detect stalls, ask the driver, escalate only unanswered ones.
  A theft-shaped stop surfaces as a side effect of non-response, not through the platform judging
  the driver's stops or accumulating them against their record.
- Q: Can a driver declare a stop proactively, before being asked? → A: Yes. A declared stop
  suppresses the prompt for its duration and shows to the transporter as an expected stop — the
  driver volunteering "I am fine, stopping for X" is exactly the signal the feature wants, arriving
  earlier than detection would produce it.
- Q: How long does a declared stop suppress prompting, so that one declaration cannot silence
  detection for the rest of a delivery? → A: The driver states a rough duration when declaring;
  suppression lapses when it expires and normal detection resumes, so an over-optimistic estimate
  self-corrects into an ordinary prompt rather than into silence.
- Q: What does the transport administrator see while a driver's device is silent (no positions
  arriving at all), given that case is scoped out of alerting? → A: The position is shown as stale
  with its age wherever it appears — no alert and no stop event — reusing the same
  stale-position discipline feature 009 already established for the tracking map.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The platform notices a stalled delivery and asks the driver why (Priority: P1)

A driver is carrying fuel from the warehouse to the customer's station. Somewhere along the way the
truck stops and stays stopped — a breakdown, an accident ahead, a checkpoint, or something that
needs help. Ten minutes pass with the truck in the same place. Rather than waiting for someone to
notice, the platform asks the driver directly what is going on, and gives them a quick way to say
so.

**Why this priority**: This is the detection itself — every other part of the feature is a
consequence of it. Without it, a stalled delivery is invisible until a customer complains or an
administrator happens to look at the map. It is also what makes the driver's own answer possible:
nothing can ask them for a reason until something notices there is something to ask about.

**Independent Test**: With a delivery in transit, hold the driver's device in one place for the
configured window; the driver receives a prompt asking why they have stopped. Delivered value: a
stalled delivery announces itself instead of going unnoticed.

**Acceptance Scenarios**:

1. **Given** a delivery in transit and a driver whose reported position has not meaningfully
   changed for the configured stop window, **When** that window elapses, **Then** the driver is
   asked to state why they have stopped.
2. **Given** a delivery in transit and a driver who is moving normally, **When** any amount of time
   passes, **Then** no stop is detected and the driver is never prompted.
3. **Given** a driver who stops briefly — less than the configured window — and then moves again,
   **When** they resume, **Then** no stop is ever raised for that pause.
4. **Given** a delivery that is not in the in-transit leg (awaiting assignment, loading, unloading,
   delivered), **When** the driver's position does not change for any length of time, **Then** no
   stop is detected — a parked truck at the warehouse or at the customer's gate is expected, not an
   incident.
5. **Given** the driver's app is backgrounded or the phone is locked while the truck is moving,
   **When** the driver's position continues to change, **Then** tracking continues and no false
   stop is raised.

---

### User Story 2 - The driver explains, and the transporter sees it (Priority: P1)

Having been asked, the driver states why they are stopped — picking a common reason quickly, since
they may be standing at the roadside, in traffic, or dealing with the problem itself. Whatever they
say reaches the transportation company, so the people responsible for the delivery know what is
happening without having to phone the driver.

**Why this priority**: The driver's own answer is the entire point of asking. A detection that
produces no explanation just tells an administrator that something *might* be wrong — the same
ambiguity the feature exists to remove.

**Independent Test**: With a stop raised, the driver submits a reason; the transport administrator
viewing that order sees the reason and when it was given. Delivered value: "why has this delivery
stopped" is answered by the person who actually knows.

**Acceptance Scenarios**:

1. **Given** a driver who has been asked why they stopped, **When** they submit a reason, **Then**
   that reason is recorded against the delivery and visible to the transportation company.
2. **Given** a driver submitting a reason, **When** they choose from the common reasons offered,
   **Then** they can submit without typing anything.
3. **Given** a driver whose situation is not covered by the common reasons, **When** they submit,
   **Then** they can describe it in their own words.
4. **Given** a driver who has explained a stop, **When** they remain stopped for the same reason,
   **Then** they are not repeatedly asked the same question about the same stop.
5. **Given** a driver who explained a stop and has since resumed driving, **When** they later stop
   again for a new reason, **Then** this is treated as a new stop and they are asked again.
6. **Given** a driver who knows they are about to stop, **When** they declare the stop with its
   reason and a rough duration before it is detected, **Then** the transportation company sees it as
   an expected stop and the driver is not prompted about it.
7. **Given** a driver who declared a stop, **When** the stop window elapses while they are still
   within their stated duration, **Then** they are not prompted and no unresponsive-driver alert is
   raised.
8. **Given** a driver still stopped past their own stated duration, **When** that duration expires,
   **Then** ordinary detection resumes and they are prompted as if they had never declared.

---

### User Story 3 - Silence itself becomes the alert (Priority: P1)

The driver has been asked why they stopped and has said nothing. That silence is the most worrying
case of all — it is consistent with a driver who cannot answer. After a further waiting period, the
transportation company is told plainly that this delivery has a problem and the driver is not
responding, so a human can act on it.

**Why this priority**: This is the case the feature most needs to catch. A driver who answers is,
by definition, fine enough to answer; a driver who does not is the one who might need help. Paired
with Story 1's detection, this is the safety net.

**Independent Test**: With a stop raised and the driver never responding, wait past the response
window; the transport administrator is notified that the delivery has an unexplained stop.
Delivered value: an unresponsive driver is escalated to a person, automatically.

**Acceptance Scenarios**:

1. **Given** a stop that the driver has been asked about, **When** the response window elapses with
   no reason given, **Then** the transportation company is notified that this delivery has an
   unexplained stop and the driver has not responded.
2. **Given** a stop the driver explained within the response window, **When** that window elapses,
   **Then** no unresponsive-driver alert is ever raised for that stop.
3. **Given** an unresponsive-driver alert already raised, **When** the driver belatedly submits a
   reason, **Then** the reason is recorded and shown normally — a late answer is a resolution, not
   an error.

---

### User Story 4 - The administrator sees and handles the alert (Priority: P2)

A transportation administrator opening a delivery that has stalled sees it stated plainly at the
top of the order: the driver stopped, for how long, where, and either their reason or the fact that
they have not answered. The administrator can mark that they have dealt with it, so the alert does
not keep demanding attention after the problem is handled.

**Why this priority**: Valuable, and the visible face of the whole feature — but Stories 1-3 deliver
their safety value through notifications alone, without an administrator ever opening the order.
This makes the situation easier to act on rather than making it known.

**Independent Test**: Open an order with an active stop alert; the alert is shown with the driver's
reason or their non-response, and can be marked handled. Delivered value: the administrator has one
place that explains a stalled delivery.

**Acceptance Scenarios**:

1. **Given** a delivery with an active stop alert, **When** an administrator views the order,
   **Then** the alert states how long the driver has been stopped, roughly where, and either the
   driver's reason or that they have not responded.
2. **Given** an alert the driver has explained, **When** an administrator views it, **Then** the
   driver's own words are shown — never replaced by a generic "stopped" message.
3. **Given** an active alert, **When** the administrator marks it handled, **Then** it stops being
   presented as demanding attention, while remaining on the delivery's record.
4. **Given** a delivery with no stop alert, **When** an administrator views it, **Then** no alert
   area is shown at all — never an empty or "no alerts" placeholder.

### Edge Cases

- **A driver stopped in legitimate, expected traffic.** Heavy congestion, a long red light, a
  border or weighbridge queue — the truck genuinely has not moved, and the driver is fine. The
  driver's own reason is what distinguishes this; the platform does not attempt to judge it. A
  driver who can see it coming can declare it in advance and avoid being prompted at all.
- **A driver declares a stop and then resumes early**, before the declared stop would have ended —
  the declaration simply stops applying; nothing needs correcting and no alert is raised.
- **A driver declares a stop and remains stopped past their own stated duration** — suppression
  lapses and they are prompted normally, exactly as if they had never declared. This is what stops a
  single declaration from silencing detection for the rest of a delivery.
- **The driver's device loses signal or the app is killed** while stopped. No position updates
  arrive at all, which is different from position updates showing no movement. No stop is raised;
  the last known position is instead shown as stale with its age (FR-017a), so the administrator is
  never left reading a frozen point as though it were live.
- **The driver's device denies or revokes location permission** mid-delivery. Tracking cannot
  continue, and this is not the same as a stopped truck.
- **A stop that begins before the in-transit leg and continues into it** — the window is measured
  from when the delivery entered the in-transit leg, not from before it.
- **The delivery completes while a stop alert is unresolved** — the alert must not keep escalating
  or demanding attention on a finished delivery.
- **The driver stops, explains, resumes, and stops again in the same place** — the second stop is a
  new stop and is asked about again, since the reason may be entirely different.
- **A driver stops repeatedly in short succession** — the platform must not generate a stream of
  alerts for what is effectively one stop-and-crawl situation.
- **The device reports small position jitter while genuinely parked** (GPS drift). Drift must not
  be mistaken for movement, or a stopped truck would never be detected at all.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The platform MUST detect when a driver carrying a delivery has not meaningfully
  changed position for a configurable stop window, defaulting to 10 minutes.
- **FR-002**: Stop detection MUST apply only during the in-transit leg — between departing the
  warehouse and arriving at the customer's station — and never during any other stage of a
  delivery.
- **FR-003**: The platform MUST NOT treat position changes smaller than a configurable movement
  threshold as movement, so that ordinary positional drift from a parked vehicle does not mask a
  genuine stop.
- **FR-004**: On detecting a stop, the platform MUST ask the driver to state the reason for it.
- **FR-004a**: The stop prompt MUST reach the driver as a device-level alert that is visible and
  audible while their app is backgrounded and their device is locked — not only as an entry inside
  the app that a driving driver would never see. Tapping the alert MUST open the reason prompt
  directly.
- **FR-005**: The driver MUST be able to answer by choosing from a set of common stop reasons
  without typing.
- **FR-006**: The driver MUST be able to describe a reason in their own words when none of the
  common reasons fits.
- **FR-007**: A submitted reason MUST be recorded against that delivery and made visible to the
  transportation company that owns it.
- **FR-008**: The platform MUST NOT ask a driver again about a stop they have already explained.
- **FR-008a**: The driver MUST be able to declare a stop **before** it is detected, giving both its
  reason (from the same set available when answering a prompt, FR-005/FR-006) and a rough expected
  duration.
- **FR-008b**: While a driver-declared stop is in effect, the platform MUST NOT prompt the driver
  about that stop and MUST NOT raise an unresponsive-driver alert for it — the driver has already
  provided the answer the prompt exists to obtain.
- **FR-008d**: A declared stop's suppression MUST lapse when its stated duration expires, after
  which ordinary detection resumes — a driver still stopped past their own estimate MUST be prompted
  normally. No single declaration may suppress detection for the remainder of a delivery.
- **FR-008c**: A driver-declared stop MUST be shown to the transportation company as an expected
  stop, visibly distinct from a detected stop the driver had to be asked about.
- **FR-009**: If the driver has not given a reason within a configurable response window, the
  platform MUST notify the transportation company that the delivery has an unexplained stop and the
  driver has not responded.
- **FR-010**: A reason submitted after the response window has elapsed MUST be recorded and shown
  normally, and MUST NOT be treated as an error.
- **FR-011**: The transportation administrator MUST be able to see, on the delivery itself, that a
  stop occurred, approximately how long it lasted, approximately where, and either the driver's
  reason or the fact that they did not respond.
- **FR-012**: The transportation administrator MUST be able to mark a stop alert as handled, after
  which it MUST NOT continue to be presented as demanding attention.
- **FR-013**: A delivery with no stop alert MUST show no alert area at all — never an empty state or
  a "no alerts" placeholder.
- **FR-014**: Once a delivery reaches its final state, the platform MUST NOT raise new stop alerts
  or continue escalating an existing one for it.
- **FR-015**: A driver who resumes moving after a stop and later stops again MUST be treated as
  having a new stop, and MUST be asked about it separately.
- **FR-016**: The platform MUST NOT raise more than one unresolved stop alert for a delivery at a
  time.
- **FR-017**: The platform MUST distinguish "the driver's position is being reported and is not
  changing" from "the driver's position is not being reported at all", and MUST NOT present the
  second as a stop.
- **FR-017a**: While no positions are arriving for a delivery, the driver's last known position MUST
  be presented as stale, stating how old it is, wherever that position is shown to the
  transportation company — never as though it were current. This raises no alert and creates no stop
  event; alerting on a silent device remains out of scope.
- **FR-018**: Location tracking MUST continue to report the driver's position while the driver's app
  is backgrounded or the device is locked, on both supported mobile platforms, for the duration of
  an active delivery.
- **FR-019**: The stop window, the movement threshold, and the response window MUST each be
  platform-level configuration values, adjustable without changing how the feature behaves.
- **FR-020**: The driver MUST NOT be asked about a stop, or have a stop raised, when they have not
  granted the location permission the feature depends on — that situation is its own condition, not
  a stop.

### Key Entities

- **Stop event**: A single stop on one delivery — whether it was **detected** (the platform noticed
  and asked) or **declared** (the driver said so first), when, roughly where the truck was, whether
  a reason was given (and what it was, and when), whether the transportation company was alerted for
  non-response, and whether an administrator has marked it handled. A delivery may accumulate
  several of these over its journey; at most one is unresolved at any moment.
- **Stop reason**: What the driver said — either one of the common reasons offered, or their own
  words. On a declared stop it is accompanied by the driver's own rough estimate of how long they
  expect to be stopped, which is what bounds the suppression (FR-008d).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A truck that stops during the in-transit leg and stays stopped past the configured
  window results in the driver being asked why, in 100% of cases where the driver's device is
  reporting its position.
- **SC-002**: A driver who is moving normally is never asked about a stop.
- **SC-003**: A driver can give a common reason for stopping in under 15 seconds from opening the
  prompt, without typing.
- **SC-004**: An unexplained stop reaches the transportation company within one minute of the
  response window elapsing.
- **SC-005**: A transportation administrator investigating a stalled delivery can determine, without
  contacting anyone, that it stopped, roughly for how long and where, and whether the driver
  explained it.
- **SC-006**: A driver's position continues to be reported while their app is backgrounded and while
  their device is locked, throughout an active delivery, on both supported mobile platforms.
- **SC-007**: Positional drift from a stationary vehicle never prevents a genuine stop from being
  detected.
- **SC-008**: A single stop never produces more than one prompt to the driver or more than one
  unresponsive-driver alert to the transportation company.
- **SC-009**: A driver who declares a stop in advance is not prompted about it for the duration they
  stated, and is prompted normally once that duration expires — a declaration never suppresses
  detection for the remainder of a delivery.
- **SC-010**: The stop prompt is visible and audible to a driver whose app is backgrounded and whose
  device is locked, on both supported mobile platforms, without them having to open the app first.

## Assumptions

- **"Has not moved" is measured against the platform's existing movement threshold**, which is
  already used to decide whether a driver's position has changed enough to be worth recording. Using
  a different threshold for this feature would mean the platform could consider a driver "moving"
  for one purpose and "stopped" for another at the same moment.
- **A driver whose device reports nothing at all is not a stopped driver.** Losing signal, closing
  the app, or running out of battery produces silence, not a stationary position. Since the
  platform's existing tracking sends a periodic position even when the driver is parked, "reporting
  the same position repeatedly" and "reporting nothing" are genuinely distinguishable — and only the
  first is a stop. **Alerting** the transporter about a device that has gone silent stays out of
  scope; **displaying** the silence honestly does not, and is covered by FR-017a's stale-position
  treatment, which reuses the discipline feature 009 already established for the tracking map.
- **The common stop reasons are a fixed, translated list** (for example: traffic, vehicle problem,
  rest or prayer break, refuelling, road closure, accident, other) rather than free text alone —
  a driver at the roadside should not have to type. The exact list is a product detail to be
  settled during planning, not a decision this spec fixes.
- **The response window before escalating to the transporter is shorter than the stop window
  itself** — the point is to reach a person quickly once a driver has already been silent for ten
  minutes, not to add another long wait on top.
- **This feature detects and reports; it does not act.** The platform never reroutes, reassigns, or
  cancels a delivery because of a stop. What to do about a stalled truck is the administrator's
  decision, informed by what this feature tells them.
- **This is safety and delivery visibility, not driver surveillance.** The platform never judges
  whether a stop was legitimate, never scores or ranks drivers on their stops, and never accumulates
  stops as a record against them — a driver's own stated reason closes a stop, and that is the end
  of it. A theft-shaped stop still surfaces, but through the one signal the platform can honestly
  act on: a driver who was asked and did not answer. This framing is deliberate and bounds the
  feature: route-deviation detection, geofenced no-stop zones, and per-driver stop histories are all
  **out of scope**, and adding any of them would make this a different feature requiring its own
  review of what the platform is entitled to infer about a person from their location.
- **A stop alert is per delivery, not per driver.** A driver carrying no delivery is not tracked for
  stops at all, and stops are recorded against the delivery they occurred on.
- **The driver's prompt is a device-level alert, which the platform cannot currently produce.**
  Today's notifications are in-app only — a stored notification plus a live socket event rendered on
  a list screen — so a driver mid-drive with a pocketed phone would never see one. Since the
  background location service (FR-018) already keeps the app and its socket alive for the duration
  of a delivery, the socket event *does* arrive; what is missing is the ability to surface it as a
  real alert. This feature adds that device-local alerting capability (FR-004a). It deliberately
  does **not** add a push provider — the app being alive is what makes a local alert sufficient
  here, and a genuine push provider remains a separate, larger concern.
- **Location is used only for the delivery it was collected for.** This feature reads the driver's
  position to detect a stalled delivery — it does not introduce a driver-history, replay, or
  behaviour-scoring capability, and no position data is retained beyond what the platform already
  retains for tracking.
