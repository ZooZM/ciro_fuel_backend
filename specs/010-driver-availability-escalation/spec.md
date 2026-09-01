# Feature Specification: Driver Availability & Assignment Escalation

**Feature Branch**: `010-driver-availability-escalation`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "On the transport admin's order-assignment screen, the driver candidate
list currently shows only online+available drivers, and an empty state ('no drivers available')
when none are. Change this to show ALL of the transporter's drivers — online and offline — with
offline drivers visually hinted/de-emphasized (not selectable, or selectable-but-clearly-marked-
unavailable) instead of disappearing entirely. Additionally, prepare the order-assignment
notification path so that when an order is assigned to a driver, the platform sends a push
notification to the driver, and if the driver does not acknowledge it within a configurable time
period, the platform falls back to sending an SMS to the driver's phone."

## Clarifications

### Session 2026-08-27

- Q: What should the escalation SMS actually contain, given SMS is an unencrypted, carrier-visible
  channel unlike the in-app push notification? → A: Minimal — an order reference and an
  instruction to open the app; no customer name, address, or delivery detail.
- Q: What happens to a pending escalation if the order is cancelled, or the assignment itself
  changes to a different driver, before the window elapses? → A: The pending escalation is
  cancelled outright — no SMS is ever sent for an assignment that no longer applies.
- Q: Must a pending escalation survive a platform restart (durable), or is best-effort acceptable?
  → A: Durable — a pending escalation MUST still fire once its window has elapsed, even if the
  platform restarted in the meantime; this is the same silent-failure risk the feature exists to
  close, just moved one layer down if left best-effort.
- Q: What happens when a burst of assignments causes many escalations to become due at once (e.g.
  a large seeded/bulk-routed batch)? → A: The platform MUST cap or throttle escalation SMS sends
  per time window; escalations beyond the cap are queued and sent as soon as capacity allows,
  never dropped.
- Q: Does assigning an offline or already-committed driver need a recorded reason, or is a plain
  confirmation click enough? → A: A short reason is required and recorded, consistent with the
  platform's existing verification-override pattern — not just a checkbox.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See every driver, not just the ones online (Priority: P1)

A transportation administrator opens a routed order to assign it. Today, if no driver happens to
be online and available at that exact moment, the screen tells them flatly that no drivers are
available — even though the company's fleet has drivers on file who are simply offline right now.
The administrator needs to see the whole roster, understand at a glance who is genuinely eligible
right now versus who is not (and why), and never be told "no drivers exist" when drivers do exist.

**Why this priority**: This is the more urgent of the two problems the request describes — an
administrator staring at a false "nothing here" screen while their fleet sits one screen away is a
daily point of confusion, and it is also the foundation the assignment-to-an-offline-driver flow
(Story 2) depends on: if offline drivers are invisible, they can never be picked in the first
place.

**Independent Test**: With a transportation company that has both an online, available driver and
an offline driver on file, opening any routed order's assignment screen shows both — the online
one ready to pick, the offline one visibly distinguished but present. Delivered value: the
administrator always sees their real fleet, never a false negative.

**Acceptance Scenarios**:

1. **Given** a transportation company with at least one online, available driver and at least one
   offline driver, **When** an administrator opens a routed order's assignment screen, **Then**
   both drivers appear in the candidate list, with the offline one visually and unambiguously
   marked as not currently available.
2. **Given** a transportation company whose entire fleet is currently offline, **When** an
   administrator opens a routed order's assignment screen, **Then** every driver still appears
   (marked offline), and the "no drivers at all" message is shown only when the company truly has
   no drivers on file.
3. **Given** the candidate list is shown, **When** drivers are ranked, **Then** online and
   available drivers appear ahead of offline or otherwise-unavailable ones, with the existing
   nearest-first ordering preserved among the eligible ones.
4. **Given** an offline driver in the list, **When** the administrator views it, **Then** they can
   see roughly how long ago that driver was last seen online, to help judge whether waiting for
   them makes sense.
5. **Given** a driver who is online but already committed to another delivery, **When** the
   candidate list is shown, **Then** that driver is distinguished from both a genuinely eligible
   driver and a fully offline one — "busy," not "offline," not "available."
6. **Given** an administrator selects an offline driver, **When** they attempt to commit the
   assignment without providing a reason, **Then** the assignment is refused until a short reason
   is supplied; providing one lets it proceed and records the reason against the assignment.
7. **Given** an administrator selects an already-committed (`BUSY`) driver, **When** they attempt
   to commit the assignment, **Then** it is refused regardless of any reason supplied — visibility
   only, never an override path (corrected during implementation, FR-007).

---

### User Story 2 - Get the assignment to the driver even if the first notification doesn't land (Priority: P1)

An administrator assigns an order to a driver. The driver's phone should light up immediately —
but push notifications sometimes silently fail to arrive (a dead connection, a killed app, a
driver whose phone is face-down in a truck cab). Today, nothing catches that failure; the order
just sits assigned while nobody actually knows about it. The platform needs to notice when a
driver has not acknowledged their new assignment within a reasonable window and reach them a
second way — by SMS — so a delivery never stalls silently just because one notification attempt
was silently lost.

**Why this priority**: Paired with Story 1, this is the other half of "an order can actually
become a driver's real, known work" — the core promise of assignment at all. A silently-missed
notification is functionally indistinguishable from an assignment that never happened, until
someone thinks to check.

**Independent Test**: Assign an order to a driver whose device never acknowledges the push
notification; after the configured waiting period elapses, an SMS is sent to that driver's phone
without any further action from the administrator. Delivered value: an assignment can no longer
go unnoticed by the driver for longer than the configured window.

**Acceptance Scenarios**:

1. **Given** an order has just been assigned to a driver, **When** the assignment commits,
   **Then** the driver receives a push notification describing the new assignment.
2. **Given** a driver has received the assignment notification, **When** they acknowledge it
   within the configured time period, **Then** no SMS is ever sent for that assignment.
3. **Given** a driver has not acknowledged the assignment notification, **When** the configured
   time period elapses, **Then** the platform sends exactly one SMS to that driver's registered
   phone number, containing only an order reference and an instruction to open the app.
4. **Given** an SMS escalation has already been sent for an assignment, **When** the driver later
   acknowledges the original notification, **Then** the system treats this as a normal, non-error
   resolution — it does not re-notify or re-escalate.
5. **Given** a driver has no valid phone number on file, **When** the escalation window elapses
   without acknowledgment, **Then** the platform records that the SMS escalation could not be
   attempted, and the assignment itself is unaffected.

---

### User Story 3 - See whether the driver actually got the message (Priority: P2)

Having sent a notification and, possibly, an escalation SMS, an administrator investigating a
delivery that seems stuck wants to know: did the driver ever acknowledge this assignment? Was an
SMS sent? This turns "the driver hasn't started moving" from a mystery into a known, actionable
state.

**Why this priority**: Valuable for troubleshooting and for building confidence in Story 2's
mechanism, but the escalation itself (Story 2) delivers its value without an administrator ever
having to look — this is visibility on top of an already-working safety net, not the net itself.

**Independent Test**: Open an assigned order whose driver has not yet acknowledged; the order
detail states plainly that the assignment is not yet acknowledged and whether an SMS was sent.
Delivered value: no more guessing whether the driver actually knows about their delivery.

**Acceptance Scenarios**:

1. **Given** an assigned order whose driver has not yet acknowledged the assignment, **When** an
   administrator views the order, **Then** they see that the assignment is unacknowledged.
2. **Given** an assigned order for which an SMS escalation was sent, **When** an administrator
   views the order, **Then** they see that an SMS was sent, and roughly when.
3. **Given** an assigned order whose driver has acknowledged the assignment, **When** an
   administrator views the order, **Then** they see that it was acknowledged, and are never shown
   a stale "unacknowledged" state after the fact.

### Edge Cases

- A driver's device acknowledges the notification at the exact instant the escalation window
  elapses — the system must not send an SMS whose need has already passed, nor treat the near-miss
  as an error.
- A driver goes offline again immediately after acknowledging — acknowledgment, once recorded, is
  permanent for that assignment; it does not get undone by the driver going offline again.
- A driver's phone number changes between assignment and the moment an SMS would be sent — the
  escalation SMS uses whatever phone number is on file at the moment it is actually sent, not the
  one on file at assignment time.
- An order is reassigned to a different vehicle (not a different driver) after the original
  assignment — this does not restart the acknowledgment window; a vehicle reassignment is not a
  new driver assignment.
- An order is cancelled while an escalation is still pending — the pending escalation is cancelled
  and no SMS is sent for it. (Narrowed during implementation — see FR-014a: the platform has no
  path to reassign an order's driver once assigned, only to cancel the order outright, so
  cancellation is the only "no longer applies" case that actually exists.)
- The SMS provider itself fails to deliver the escalation message — the platform still records
  that an escalation attempt was made, distinct from "no phone number on file."
- A large batch of orders is assigned in quick succession (e.g. bulk routing), causing many
  escalations to become due at once — the send-rate cap defers the excess ones rather than sending
  them all simultaneously; none are dropped, they simply queue behind the cap.
- A company's entire driver roster is suspended or deactivated — the candidate list still shows
  them (Story 1 shows "the whole roster"), but none are selectable, and the "no drivers at all"
  empty state is reserved for a company with literally zero driver accounts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The order-assignment candidate list MUST show every driver belonging to the
  administrator's transportation company, not only those currently online and available.
- **FR-002**: The candidate list MUST visually distinguish a driver who is not currently eligible
  for assignment (offline, or online but already committed to another delivery) from one who is
  genuinely available right now.
- **FR-003**: The candidate list MUST rank online, available drivers ahead of offline or
  otherwise-unavailable ones, preserving the existing nearest-first ordering among the eligible
  drivers.
- **FR-004**: The candidate list MUST state, for each ineligible driver, which of the two
  ineligibility reasons applies — offline, or online-but-already-committed — rather than a single
  generic "unavailable" label.
- **FR-005**: The candidate list MUST show, for an offline driver, approximately how long ago they
  were last seen online.
- **FR-006**: The "no drivers at all" empty state MUST be shown only when the company has zero
  driver accounts on file — never merely because none are currently online.
- **FR-007**: The administrator MUST be able to select an **offline** driver shown in the list to
  complete an assignment — an offline driver is not excluded from assignment, only clearly marked
  as such at the point of selection. (Corrected during implementation: a `BUSY` driver — one
  already committed to another delivery — is shown and clearly marked, per FR-001/FR-004, but
  remains **not** assignable; their `activeOrderId` is a one-to-one pointer to the single delivery
  they already hold, the same invariant the platform's own concurrency guarantees are built on, and
  force-reassigning them would either violate it or silently orphan their current delivery. Neither
  this spec nor any clarification designed for that, so it stays out of scope here — visibility
  only, not an override path.)
- **FR-008**: Selecting an **offline** driver MUST require the administrator to provide and record a short reason before the
  assignment commits — a plain confirmation click is not sufficient — consistent with how the
  platform already records a reason for other administrator overrides of a normal rule.
- **FR-009**: When an order is committed to a driver, the platform MUST send that driver an in-app
  notification describing the new assignment, as it already does today. ("In-app," not "push" —
  the platform has no push provider; see the Assumptions section, which explains why this matters
  for an offline driver in particular.)
- **FR-010**: The platform MUST be able to determine, for a given assignment notification,
  whether the driver has acknowledged it.
- **FR-011**: If a driver has not acknowledged the assignment notification within a configurable
  time period, the platform MUST send that driver an SMS to their registered phone number.
- **FR-011a**: The escalation SMS MUST be limited to an order reference and an instruction to open
  the app — it MUST NOT include the customer's name, address, or any other delivery detail, since
  SMS is an unencrypted, carrier-visible channel unlike the in-app push notification.
- **FR-012**: The escalation time period MUST be a platform-level configuration value, adjustable
  without requiring a change to how the feature itself behaves.
- **FR-012a**: A pending escalation MUST be durable — it MUST still fire once its window has
  elapsed even if the platform restarted while it was pending. A restart MUST NOT be a way for an
  escalation to silently never happen.
- **FR-013**: The platform MUST send at most one escalation SMS per assignment — a driver who
  never acknowledges is never sent a second or repeated SMS for the same assignment.
- **FR-013a**: The platform MUST cap the rate of escalation SMS sends within a configurable time
  window. An escalation that becomes due while the cap is in effect MUST be queued and sent as
  soon as capacity allows, never silently dropped — a burst of simultaneous assignments (e.g. a
  large batch routed at once) MUST NOT be able to trigger an uncapped flood of SMS sends.
- **FR-014**: A driver who acknowledges an assignment after an escalation SMS has already been
  sent for it MUST be treated as a normal, successful resolution — this is not an error condition
  and produces no further notification.
- **FR-014a**: If the order is cancelled before the escalation window elapses, the platform MUST
  cancel the pending escalation — no SMS is sent for an assignment that no longer applies.
  (Narrowed during implementation: the platform has no capability to reassign an order's *driver*
  once assigned — only cancellation ends an assignment early; `reassignVehicle` changes truck/tank
  only and was never in scope here. The original wording anticipated a driver-reassignment path
  that does not exist, so this FR covers cancellation alone.)
- **FR-015**: If a driver has no valid phone number on file when the escalation window elapses,
  the platform MUST record that the escalation could not be attempted, and this MUST NOT affect
  the underlying assignment or the driver's ability to be assigned future orders.
- **FR-016**: The administrator MUST be able to see, for any assigned order, whether the driver
  has acknowledged the assignment, and if not, whether an escalation SMS was sent and
  approximately when.
- **FR-017**: The platform MUST NOT present an assignment as acknowledged unless the driver has
  actually done so — no assumed or inferred acknowledgment based on the passage of time or on
  unrelated activity.

### Key Entities

- **Driver availability state**: For a given driver, the combination of whether they are currently
  online, whether they are already committed to another delivery, and when they were last seen
  online — determines how they are presented and whether they are directly selectable without
  extra confirmation.
- **Assignment notification**: The record, per order assignment, of the push notification sent to
  the driver, whether and when it was acknowledged, and whether an escalation SMS was sent as a
  result (cancelled outright if the order or assignment changes before the window elapses).
- **Offline-assignment reason**: The short, mandatory reason an administrator records when
  assigning a driver who was not currently online or was already committed elsewhere — an audit
  trail for a deliberate override of the normal eligible-driver path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator assigning any routed order sees their company's entire driver
  roster, with each driver's eligibility immediately clear, in 100% of cases — never a "no drivers
  available" message while the company has drivers on file.
- **SC-002**: Among drivers who acknowledge their assignment notification promptly, none ever
  receive a duplicate SMS about that same assignment.
- **SC-003**: A driver who does not acknowledge an assignment within the configured window
  receives a follow-up SMS within one minute of that window elapsing, except when the send-rate
  cap (FR-013a) is in effect, in which case it is sent as soon as capacity allows and is never
  dropped.
- **SC-004**: Every assignment where an SMS escalation could not be attempted (no valid phone on
  file) is recorded as such, distinguishable from an assignment where the driver simply
  acknowledged in time.
- **SC-005**: An administrator investigating a specific assigned order can determine, without
  contacting anyone, whether the driver has acknowledged it and whether an SMS was sent.
- **SC-006**: A pending escalation whose window elapses while the platform is restarting still
  results in the SMS being sent once the platform is back up — a restart never causes an
  escalation to be silently skipped.

## Assumptions

- **Acknowledgment is an explicit signal, not an inference.** A driver's assignment counts as
  acknowledged when their device confirms it — opening the assigned delivery in the driver app (or
  an equivalent explicit in-app action) — never merely from the driver's device being online or
  connected, which can be true for unrelated reasons.
- **An offline driver is deliberately selectable.** The whole reason an SMS fallback exists is that
  the platform must be able to reach a driver who is not currently reachable by push notification
  — if offline drivers could never be assigned in the first place, the escalation mechanism this
  feature adds would have nothing to protect. Offline selection is therefore a first-class,
  supported path, gated by a recorded reason (FR-008), not a disabled/blocked state.
- **The escalation window defaults to a short, dispatch-appropriate interval** (on the order of a
  few minutes) unless the platform operator configures otherwise; the exact default is an
  implementation detail for the planning phase, not a product decision this spec fixes.
- **For an offline driver, the SMS is not a fallback channel — it is the only one.** The platform's
  "push notification" (FR-009) is, in reality, an in-app notification plus a live socket event;
  neither reaches a driver whose device isn't connected. Since Story 1 of this same feature makes
  assigning an offline driver a first-class, intended action, the escalation window's default
  should be chosen short enough that an offline driver isn't left unreachable for long — this
  strengthens, rather than changes, FR-012's "configurable" requirement.
- **The escalation send-rate cap (FR-013a) defaults to a sensible operational value** chosen at
  planning time (informed by the SMS provider's own throughput limits); this spec fixes only that
  a cap must exist and that queuing (never dropping) is the required behavior when it is reached.
- **This escalation mechanism applies only to the initial driver-assignment notification** — not to
  every notification type the platform sends. Other notifications (arrival, verification
  reminders, etc.) are out of scope for this feature.
- **No automatic reassignment.** If a driver never acknowledges even after the SMS escalation, the
  platform does not automatically reassign the order to someone else — the existing manual
  stalled-delivery tools (override, reassignment) remain the administrator's own recourse. This
  feature only ensures the driver is reachably notified, not that the order automatically resolves
  itself.
- **A suspended or deactivated driver is still visible** in the roster (per Story 1's "whole
  roster" principle) but is never selectable, regardless of online state.
- **SMS delivery is a best-effort send, not a guaranteed-delivery contract** — the platform records
  that it attempted the send; carrier-level delivery confirmation is out of scope.
