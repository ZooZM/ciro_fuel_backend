# Feature Specification: Driver App Backend Completion & Cross-Device Delivery Continuity

**Feature Branch**: `013-driver-app-backend-completion`

**Created**: 2026-09-03

**Status**: Draft

**Input**: User description: "i need you work with driver app i need close all features to be linked with backend and mack sure the order sesion work on another device that work on 013 spec"

## Overview

Two halves of one goal: **nothing a driver can see or press is fabricated, and a delivery belongs to the
driver rather than to the handset in their pocket.**

Specs 006–011 wired the driver's *critical path* — sign-in, the active delivery, vehicle verification,
loading, handover codes, stop reasons. What they did not close are the surfaces around it. The driver's
notification centre is a hardcoded list of invented rows on a screen with no data connection at all,
while a complete, working notification capability sits one folder away and already drives the unread
badge on the very same navigation bar. The driver's account screen greets every driver by the same
fabricated name and shows them a station they do not have. Three controls on driver screens are dead —
including **"I cannot reach the destination"**, pressed by a driver who has a problem, which does
nothing whatsoever.

The second half is sharper. A driver whose phone breaks, is stolen, or dies mid-delivery signs in on a
replacement — and the platform's answer to what happens next is currently *unstated*. Two concrete
defects sit behind it:

1. **An unanswered stop question does not survive the switch.** The platform records stop events on the
   delivery and already returns them to the driver, but the driver's app never reads them. The only way
   a driver has ever been able to answer "why did you stop?" is the device alert raised at the moment
   the socket delivered it. On a new device that alert is gone, the question is invisible, and the
   silence escalates to the transporter as though the driver ignored it.

2. **The displaced device is trusted to disarm itself.** Signing in elsewhere ends the old session and
   pushes a revocation, and a cooperating app obeys it. But the platform validates a session only at
   the moment a live connection is opened, never again on the frames that follow — so an old handset
   whose connection stays open, whose app was killed before it processed the push, or which simply
   never receives it, can keep reporting positions as the authoritative location of that truck. Two
   devices in two places both writing one truck's whereabouts is not a display glitch: it is the input
   to stop detection, to dispatch proximity, and to what the customer sees on their map.

## Clarifications

### Session 2026-09-03

- **Q: What should the dead "I cannot reach the destination" control do?**
  **A: Reuse the existing stop machinery rather than building a parallel problem-report system** — a
  blocked driver's report is recorded as a stop on the delivery, carrying the driver's stated reason,
  in the one place a driver's reasons already live and the transporter already reads.

  **With one correction, which the reuse makes necessary rather than optional.** A driver-*declared*
  stop exists to say "I am stopping on purpose, do not ask me why" — it is recorded already resolved,
  it suppresses detection for a duration the driver states, and it notifies nobody. The transporter is
  reached only when a *detected* stop goes unanswered. So filing "I cannot reach" as an ordinary
  declaration would tell no one and would silence the alert that would otherwise have been raised — the
  exact opposite of what a blocked driver is asking for. A blocked-driver report therefore reuses the
  stop record and its reason vocabulary but MUST reach the transporter, and MUST NOT suppress
  detection. See FR-039/FR-039a/FR-039b.

- **Q: Does the driver's in-app navigation view get a live map?**
  **A: No.** It keeps handing turn-by-turn to the device's own maps app, which already works. The
  non-functional map controls layered over the static image are removed, and the image must not present
  itself as a live map. See FR-041/FR-041a.

- **Q: Does "close all features" cover the client persona's remaining fabricated surfaces?**
  **A: Driver persona only — but the shared defect underneath is fixed at its root, not worked around.**
  Notification handlers registered before the live connection exists are silently inert, which is why
  no notification push has ever been received by either persona. Fixing that where connections are
  established retires it for both at once; the client gains working pushes as a consequence, with its
  own verification proving nothing else about the client moved. The client's own fabricated surfaces
  (the order-detail preview state, the account and settings placeholders) stay out of scope. See
  FR-028a/FR-042.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Continue a delivery on a replacement device (Priority: P1)

A driver is midway through a delivery when their phone becomes unusable — the battery dies, the screen
breaks, it is left at the depot. They pick up a second phone, sign in, and continue the same delivery
from exactly the point they left it: the same stage, the same next action, any outstanding question
still asked, and the truck visible on the customer's map again without anyone at the office having to
intervene.

**Why this priority**: This is the failure that strands a loaded fuel truck. Every other item in this
feature is a surface that looks wrong; this one stops a delivery from completing and has no manual
workaround short of an administrator overriding the order.

**Independent Test**: Start a delivery to a mid-journey stage on one device, sign in on a second device
as the same driver, and confirm the delivery is present at the same stage with the correct next action
and no repeated work — testable end to end with two devices and no other part of this feature built.

**Acceptance Scenarios**:

1. **Given** a driver has an in-progress delivery and has already verified their vehicle at departure,
   **When** they sign in on a different device, **Then** the delivery appears at its current stage and
   the driver is **not** asked to verify the vehicle again.
2. **Given** a delivery already past loading, **When** the driver signs in on a different device,
   **Then** the loading step is not repeated and the driver's next action is the one the delivery's
   actual stage calls for.
3. **Given** the platform has asked why the truck stopped and the driver has not yet answered,
   **When** they sign in on a different device and open the delivery, **Then** the outstanding question
   is visible on the delivery and can be answered there.
4. **Given** the driver has answered or the stop is resolved, **When** they open the delivery on any
   device, **Then** no outstanding question is shown for it.
5. **Given** a delivery awaiting a customer handover code that was already issued to the customer,
   **When** the driver continues on a different device, **Then** the code the customer already holds is
   still the code that completes the step — the customer is not sent a second one and is not left
   holding a dead one.
6. **Given** the driver signs in on the replacement device and grants location permission, **When** the
   truck next moves, **Then** the customer's tracking view shows the truck moving again without the
   driver taking any action beyond signing in.
7. **Given** the driver signs in on a replacement device, **When** the delivery is displayed, **Then**
   the customer, destination, vehicle and warehouse details shown are the same ones the previous device
   showed — none of them are blank or fabricated.

---

### User Story 2 - The replaced device stops speaking for the driver (Priority: P2)

When a driver signs in somewhere new, the device they left behind must stop being able to report where
that truck is or act on that delivery — and that must hold whether or not the old device cooperates,
because the common reasons for switching devices (a dead battery, a crash, a phone in a drawer) are
precisely the cases where it cannot.

**Why this priority**: It is the other half of US1 and a data-integrity problem, not a cosmetic one — a
stale device reporting positions corrupts stop detection, dispatch proximity and the customer's map.
It is P2 rather than P1 only because a cooperating device already disarms itself today, so the
uncovered case is the exception rather than the norm.

**Independent Test**: With a delivery in progress on device A, sign in on device B, then have device A
attempt to report a position and act on the delivery over its existing connection — both must be
refused, and the truck's recorded whereabouts must be unaffected.

**Acceptance Scenarios**:

1. **Given** device A holds an open live connection and device B signs in as the same driver, **When**
   device A reports a position, **Then** the platform does not record it as the truck's location and
   does not treat it as movement.
2. **Given** the same situation, **When** device A attempts any action on the delivery, **Then** the
   platform refuses it and states that the session has ended.
3. **Given** device A is unreachable when the replacement sign-in happens, **When** device A later
   regains connectivity, **Then** it is refused and shows the driver why their session ended.
4. **Given** device A cooperates normally, **When** it is displaced, **Then** it stops reporting
   positions, signs the driver out and states the reason — the behaviour available today, unchanged.
5. **Given** device A is displaced while it was reporting positions, **When** the platform stops
   accepting them, **Then** the last position it did record is not discarded and the delivery's
   history shows no gap other than the real interval before the replacement device reported.

---

### User Story 3 - A real notification centre for the driver (Priority: P2)

A driver opens their notifications tab and sees the notifications the platform actually sent them —
assignments, status changes, handover codes, stop questions — newest first, with unread ones marked,
filterable, and arriving while the app is open without a manual refresh. Reading them clears the badge
on the navigation bar.

**Why this priority**: This is the single largest fabricated surface remaining in the driver app: an
entire screen of invented rows, on a tab whose badge next to it already shows a real count. A driver
who taps a badge reading "3" and sees three notifications about an order that does not exist has been
told the app is lying to them. The capability exists platform-side and elsewhere in the app, so the
gap is a connection, not a new capability.

**Independent Test**: Send a driver several notifications of different kinds, open the tab, and confirm
each appears with the right content and read state, that filters partition them correctly, and that a
notification sent while the screen is open appears without a refresh.

**Acceptance Scenarios**:

1. **Given** a driver with notifications on the platform, **When** they open the notifications tab,
   **Then** they see those notifications, newest first, with unread ones visually distinguished.
2. **Given** a driver with no notifications, **When** they open the tab, **Then** they see a stated
   empty state — never sample content.
3. **Given** the notifications list is loading or fails to load, **When** the driver is on the tab,
   **Then** they see a loading state or an error with a retry — never fabricated rows standing in for
   the real ones.
4. **Given** the driver opens an unread notification, **When** it is read, **Then** it is no longer
   unread on any device and the navigation-bar badge count drops accordingly.
5. **Given** the driver presses the "mark all as read" control, **When** it completes, **Then** every
   notification is read and the badge shows nothing.
6. **Given** the driver is on the notifications tab, **When** the platform sends a new notification,
   **Then** it appears in the list without the driver leaving or refreshing the screen.
7. **Given** the driver's notification list, **When** it is displayed, **Then** it offers no category
   filter that cannot match a notification a driver is able to receive — the mock's three category tabs
   are gone — and it offers the All / Unread filter the client's list already offers.
8. **Given** the driver selects the Unread filter, **When** the list re-renders, **Then** it shows only
   unread notifications, and reading one removes it from that view.
9. **Given** a notification concerns a specific delivery, **When** the driver opens it, **Then** they
   are taken to that delivery.

---

### User Story 4 - Every driver surface shows the signed-in driver (Priority: P3)

A driver opening their account screen sees their own name and their own details — not a name belonging
to nobody, and not a station, which is something a driver does not have at all.

**Why this priority**: It is a trust defect rather than a functional one — the driver can still do their
job — but a screen that greets everyone by the same invented name undermines confidence in everything
else the app states, including the delivery details it is asked to be believed about.

**Independent Test**: Sign in as two different drivers and confirm each account screen shows that
driver's own identity, with nothing carried over between them.

**Acceptance Scenarios**:

1. **Given** a signed-in driver, **When** they open their account screen, **Then** it shows their own
   name and details as the platform holds them.
2. **Given** a driver signs out and a different driver signs in on the same device, **When** the second
   driver opens the account screen, **Then** none of the first driver's details are shown.
3. **Given** the driver's details are still loading or fail to load, **When** the screen renders,
   **Then** it states that — it does not fall back to any placeholder identity.
4. **Given** a driver opens the account screen, **When** they look at what is presented about them,
   **Then** nothing describes a concept that does not apply to a driver.
5. **Given** the driver opens the terms and the app-information entries, **When** they do, **Then**
   each shows content addressed to a driver, and the app version shown is the version actually running.

---

### User Story 5 - No dead controls on a driver screen (Priority: P3)

Every button a driver can press either does what it says or is not there. In particular, a driver who
cannot reach a destination has a real way to say so, and the transporter hears about it.

**Why this priority**: A control that does nothing is worse than an absent one during a delivery: the
driver believes they have reported a problem and stops trying. Lowest priority because the count is
small and each is individually contained — though the blocked-driver report is the one item here that
adds real capability rather than removing a pretence.

**Independent Test**: Walk every driver screen and press every control; each produces a visible effect,
and any that cannot has been removed. Separately, file a blocked-driver report and confirm the
transporter receives it while stop detection stays armed.

**Acceptance Scenarios**:

1. **Given** a driver cannot reach the destination, **When** they report it, **Then** they state a
   reason, the report is recorded on the delivery, and the transporter responsible for that delivery is
   told without waiting for any silence to elapse.
2. **Given** a driver has reported that they cannot reach the destination, **When** the truck then sits
   still, **Then** stop detection is **not** suppressed by that report — the report is a call for help,
   not a request to stop being asked.
3. **Given** a driver has reported being unable to reach the destination, **When** they open the
   delivery on any device, **Then** the report is visible there with what they said.
4. **Given** the driver's navigation view, **When** it is displayed, **Then** it presents no control
   that does not control anything, and nothing on it presents itself as a live map when it is not.
5. **Given** the driver wants turn-by-turn directions, **When** they start navigation, **Then** the
   device's own maps app opens on the delivery's destination.
6. **Given** any control on a driver-facing screen, **When** the driver presses it, **Then** something
   observable happens — a screen opens, an action is sent, or a stated reason is shown for why it
   cannot proceed.
7. **Given** a driver needs to contact support, **When** they use the contact control, **Then** a
   contact attempt actually starts.

---

### Edge Cases

- **The replacement sign-in happens while the truck is parked.** The new device's first position is not
  movement; a delivery that was already stalled must not be treated as having resumed simply because a
  different device reported the same place.
- **The replacement device refuses location permission.** The driver must be told the delivery cannot be
  tracked and what to do, rather than the app appearing to work while reporting nothing.
- **The stop question's answer window expires between devices.** An answer arriving after the
  transporter was already told is still accepted and recorded — the driver is not shown an error for
  answering late.
- **Several stops accumulated on one delivery.** The driver sees and can answer the one that is
  outstanding, without ambiguity about which is being answered.
- **The old device is displaced while it holds an unsent action.** Its refusal must state that the
  session ended, never appear as a generic failure the driver might retry indefinitely.
- **Both devices are online at the same instant.** Exactly one is authoritative, and the outcome does
  not depend on which device's frame happens to arrive first.
- **The driver signs in on a replacement while the delivery has just been completed.** The new device
  shows no active delivery rather than a stale one.
- **A notification arrives for a delivery the driver no longer holds.** Opening it must lead somewhere
  coherent rather than an error screen.
- **The notification list is long.** It loads progressively rather than requiring the whole history
  before anything is shown.
- **Mark-all-as-read is pressed with nothing unread.** Nothing changes and no error is shown.
- **A notification type the app does not recognise arrives.** It is listed with a neutral presentation
  rather than dropped silently or rendered blank.

## Requirements *(mandatory)*

### Functional Requirements

#### Delivery continuity across devices (US1)

- **FR-001**: A driver signing in on any device MUST be shown their current in-progress delivery, if any,
  without further action.
- **FR-002**: The stage of the delivery shown MUST be the stage the platform holds, on every device — no
  device may hold a stage of its own.
- **FR-003**: A step already completed on a previous device (vehicle verification at departure, loading
  confirmation, arrival) MUST NOT be requested again on a replacement device.
- **FR-004**: A handover code already issued to a customer MUST remain the code that completes the step
  after a device change; the platform MUST NOT be made to issue a second one because the driver changed
  devices.
- **FR-005**: The driver's app MUST read outstanding stop questions from the delivery itself, not only
  from the alert that announced them.
- **FR-006**: An unanswered, unresolved stop question MUST be visible on the delivery whenever the driver
  opens it, on any device, until it is answered or resolved.
- **FR-007**: The driver MUST be able to answer an outstanding stop question from the delivery screen,
  identifying the specific stop being answered.
- **FR-008**: A stop question that has been answered or resolved MUST NOT be presented as outstanding.
- **FR-009**: Position reporting MUST resume on the replacement device once the driver has signed in and
  granted permission, without requiring the driver to open any particular screen.
- **FR-010**: A replacement device MUST NOT report a position as movement solely because it is the first
  position that device has sent; whether the truck has moved is a property of the truck, not the handset.
- **FR-011**: If a replacement device cannot report positions (permission refused or unavailable), the
  driver MUST be told, on the delivery screen, that the delivery is not being tracked.
- **FR-012**: The customer's view of the delivery MUST show the truck's position as stale, with its age,
  for the duration of the device change, and MUST resume live once the replacement reports — the
  customer is never shown a frozen position presented as current.
- **FR-013**: All delivery details a driver acts on — customer, destination, vehicle, tank, warehouse,
  quantity, fuel grade — MUST come from the platform on every device, with absence shown as absence.

#### Enforcing the single live session (US2)

- **FR-014**: The platform MUST stop accepting position reports from a device whose session has been
  displaced, without relying on that device to stop sending them.
- **FR-015**: The platform MUST refuse any delivery action from a device whose session has been
  displaced, and the refusal MUST state that the session has ended rather than presenting as a generic
  failure.
- **FR-016**: A position reported by a displaced device MUST NOT be recorded as the truck's location and
  MUST NOT affect movement bookkeeping used to decide whether a truck has stalled.
- **FR-017**: The platform MUST end a displaced device's live connection rather than leaving it open and
  inert.
- **FR-018**: A displaced device that was unreachable when displacement occurred MUST be refused when it
  next reconnects, and MUST tell the driver why their session ended.
- **FR-019**: Positions legitimately recorded before displacement MUST be retained; enforcing
  displacement MUST NOT discard delivery history.
- **FR-020**: Exactly one device MUST be authoritative for a driver at any moment; the outcome MUST NOT
  depend on the arrival order of frames from two devices.
- **FR-021**: A device switch MUST be recorded such that an administrator investigating a tracking gap
  can see that the driver changed devices and when.

#### Driver notification centre (US3)

- **FR-022**: The driver's notifications screen MUST show the notifications the platform holds for that
  driver, and MUST contain no fabricated, sample or hardcoded entries.
- **FR-023**: Notifications MUST be shown newest first, with unread ones visually distinguished from read
  ones.
- **FR-024**: The screen MUST show a distinct, stated state for loading, for an empty list, and for a
  failure — with a retry on failure.
- **FR-025**: Opening a notification MUST mark it read on the platform, so its read state holds across
  devices.
- **FR-026**: The unread badge on the driver's navigation bar MUST reflect the same unread state the list
  shows, and MUST update when notifications are read.
- **FR-027**: The driver MUST be able to mark every notification read in one action, after which nothing
  is unread and the badge shows nothing.
- **FR-028**: A notification arriving while the driver has the app open MUST appear in the list without
  the driver refreshing or leaving the screen.
- **FR-028a**: Live delivery of notifications MUST be fixed where connections are established, so that
  interest registered before a connection exists is honoured once it does — not by requiring each
  screen to remember to register itself afterwards. Registering interest MUST NOT be silently
  ineffective under any ordering. This is the reason no notification push has ever been delivered to
  either persona, and it is fixed once rather than worked around per screen.
- **FR-029**: A filter MUST NOT be offered that nothing a driver can receive would ever match. Only two
  notification types are addressed to a driver today and both are order-related, so the mock's three
  category tabs (All / Orders / System) are removed rather than wired (research R7). Should the platform
  later send drivers a genuinely different kind of notification, category filters become meaningful and
  this requirement permits them.
- **FR-029a**: The driver's list MUST offer the same **All / Unread** filter the client's list already
  offers — a real distinction the platform supports directly. Both personas' lists therefore filter the
  same way for the same reason (research R7a).
- **FR-030**: A notification concerning a specific delivery MUST take the driver to that delivery when
  opened.
- **FR-031**: A notification of a kind the app does not recognise MUST be listed with neutral
  presentation rather than dropped or shown blank.
- **FR-032**: The list MUST load progressively rather than requiring the driver's entire notification
  history before anything is displayed.

#### Driver identity surfaces (US4)

- **FR-033**: Every driver-facing screen presenting the driver's identity MUST present the signed-in
  driver's own details as the platform holds them.
- **FR-034**: No driver-facing screen may fall back to a placeholder name, placeholder contact details,
  or a station — a concept that does not apply to a driver.
- **FR-035**: While identity is loading or has failed to load, the screen MUST state that, and MUST NOT
  render a placeholder identity in its place.
- **FR-036**: Signing out MUST clear the previous driver's details, so a subsequent driver on the same
  device never sees them.
- **FR-037**: Terms and about/app-information entries reachable from a driver's account screen MUST show
  content addressed to a driver, and the app version shown MUST be the version running.

#### Live controls (US5)

- **FR-038**: No control on a driver-facing screen may be inert. Each MUST perform a real action, or be
  removed.
- **FR-039**: A driver who cannot reach the destination MUST be able to report it, stating a reason, and
  the report MUST be recorded on the delivery as a stop — reusing the record and reason vocabulary the
  platform already keeps for stops, not a parallel reporting mechanism.
- **FR-039a**: A blocked-driver report MUST reach the transporter responsible for that delivery
  promptly, without waiting for any response window or silence to elapse. It is distinguishable from a
  stop the platform detected and from a stop the driver merely declared, so the transporter can tell
  "the driver is asking for help" from "the driver answered a question" and from "the driver said they
  would be stopping."
- **FR-039b**: A blocked-driver report MUST NOT suppress stop detection for the delivery. A driver
  reporting that they are stuck is asking to be noticed, and suppression exists to stop the platform
  asking — applying it here would silence the alert the report exists to raise.
- **FR-039c**: A blocked-driver report MUST be visible on the delivery, with what the driver stated, on
  any device the driver later opens it from.
- **FR-040**: The support contact control reachable by a driver MUST start a real contact attempt.
- **FR-041**: The driver's navigation view MUST NOT present any control that does not control anything,
  and MUST NOT present a fixed image as though it were a live map.
- **FR-041a**: Turn-by-turn navigation MUST continue to be handed to the device's own maps app, opened
  on the delivery's destination. This feature adds no in-app live map for the driver.

#### Scope boundary

- **FR-042**: This feature's user-facing scope is the DRIVER persona. The client persona's own remaining
  fabricated surfaces are out of scope, and client behaviour MUST be verifiably unchanged except where
  FR-028a's shared fix necessarily improves it.
- **FR-042a**: Dashboard behaviour MUST be verifiably unchanged **except** that the transport
  administrator's stop presentation MUST recognise and distinctly present a blocked-driver report. This
  is not an optional extra: the dashboard mirrors the platform's stop vocabulary as a fixed set, and an
  unrecognised value renders as a missing label beside a real stop on a real delivery rather than
  failing loudly — so introducing the report without this leaves it unreadable exactly where FR-039a
  requires it to be read (research R10).
- **FR-043**: The rule that a driver holds one live session at a time MUST be retained; this feature
  enforces that rule rather than relaxing it.

### Key Entities

- **Delivery session**: The driver's relationship to an in-progress delivery. Held by the platform, not
  by a device — a device is a view onto it and an input to it. Everything a device needs to present or
  act on the delivery is retrievable from the platform.
- **Live session**: One driver, one device, at one time. Carries the fact of which device is
  authoritative and, once displaced, the reason it ended.
- **Stop question**: An unanswered "why did this truck stop?" recorded on the delivery, addressable
  individually because a delivery can accumulate several. Answerable from the delivery, not only from
  the alert that announced it.
- **Blocked-driver report**: A stop the driver raised themselves because they cannot reach the
  destination, carrying their stated reason. Shares the stop record with detected and declared stops and
  is distinguishable from both: unlike a declared stop it does not suppress detection and it does reach
  the transporter, and unlike a detected stop it did not begin with the platform asking.
- **Notification**: A message the platform sent to this driver, with a kind, a subject it may refer to
  (usually a delivery), a time, and a read state that belongs to the driver rather than to a device.
- **Driver identity**: The signed-in driver's own name and contact details as the platform holds them.
  Has no station.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A driver whose device fails mid-delivery can resume that delivery on a replacement and
  complete it, with no administrator intervention and no step repeated.
- **SC-002**: Resuming on a replacement device takes under 2 minutes from picking it up to seeing the
  delivery at its correct stage — sign-in and device unlock included.
- **SC-003**: 100% of outstanding stop questions are visible and answerable from the delivery on a
  device that never received the alert announcing them.
- **SC-004**: After a device switch, the customer's tracking view resumes showing live movement within
  one position-reporting interval of the replacement device starting to report, and shows the position
  as stale, with its age, for the whole interval before that.
- **SC-005**: A displaced device cannot influence a truck's recorded whereabouts: 0% of positions it
  reports after displacement are recorded, verified with the displaced device deliberately reporting
  from a different place.
- **SC-006**: 0 delivery actions succeed from a displaced device, and every refusal states that the
  session ended.
- **SC-007**: The driver's notification list matches the platform's record exactly — same items, same
  order, same read state — with 0 entries that did not come from the platform.
- **SC-008**: A notification sent while the driver has the notifications screen open appears within 5
  seconds without any driver action.
- **SC-009**: The unread badge and the list agree on the unread count in 100% of checks, including
  immediately after reading one and after marking all read.
- **SC-010**: Across two drivers signing in on the same device in turn, 0 details of the first are
  visible to the second.
- **SC-011**: Every control reachable on a driver-facing screen produces an observable effect; 0 inert
  controls remain, verified by a walkthrough of every driver screen.
- **SC-012**: A driver reporting they cannot reach the destination reaches the responsible transporter
  within 1 minute, with the driver's stated reason, in 100% of cases — and in 0% of cases does that
  report cause a subsequent genuine stall to go undetected.
- **SC-013**: Notification pushes are delivered in 100% of checks regardless of the order in which
  screens and connections start up, verified against the startup orderings that previously produced
  silent failure.
- **SC-014**: Existing client and dashboard behaviour is unchanged, evidenced by their existing
  verification suites passing at the same counts as before this feature — with the sole intended
  difference that the client also now receives notification pushes.

## Assumptions

- **A driver holds one live session at a time.** The established rule that signing in displaces the
  previous session is retained; "works on another device" means *resumable on a replacement*, not two
  devices at once. Allowing concurrent devices would require deciding which one's position is the
  truth, which is the problem this feature removes rather than creates.
- **Stop events are already recorded on the delivery and already returned to the driver by the
  platform.** The gap is on the driver's device, which never reads them, so surfacing an outstanding
  stop question needs no new platform capability.
- **The notification capability exists and is already in use.** The driver's unread badge is already
  driven by real data; only the screen beside it is fabricated. Marking a single notification read
  already exists; marking all read in one action may not, and the requirement is that the control works
  — not how.
- **Live notification delivery has never worked for anyone.** FR-028a is therefore a fix, not a
  regression risk: the client cannot lose behaviour it has never had. Its improvement is the one
  intended client-visible change in a driver-scoped feature.
- **The stop record can carry a third kind of stop.** It already distinguishes stops the platform
  detected from stops the driver declared, so a driver-raised report is an addition to an existing
  distinction rather than a new concept — which is why reusing it is cheaper than a parallel report and
  keeps every reason a driver has given in one place.
- **A device switch mid-delivery raises no new alert of its own.** The resulting tracking gap already
  surfaces through existing staleness presentation and stalled-delivery detection; adding a second
  alarm for the same silence would double-notify the transporter.
- **Duty status stays display-only.** The driver's on/off-duty indicator shows a real platform value and
  is not a control today. Giving drivers shift control is a genuine gap but a separate feature with its
  own dispatch consequences, and is out of scope here.
- **The delivery details the driver acts on already come from the platform.** This feature asserts that
  and closes the remaining identity and notification surfaces around them; it does not re-plumb the
  delivery path itself.
- **Location permission is the driver's to grant.** A refusal is a legitimate outcome the app must state
  plainly; this feature does not attempt to work around it.
- **Both personas ship from one app.** Changes to shared surfaces must leave the client persona's
  behaviour identical, and that is verified rather than assumed.

## Out of Scope

- **Real push-provider delivery (FCM/APNs)** — device notifications while the app is fully terminated.
  Alerts continue to depend on the app's live connection, as they do today. **Raised during the analysis
  pass on 2026-09-03 and deferred to feature 014**, for three reasons: it is a new external dependency
  with credential management (Firebase service-account keys, which spec 012 requires to flow through
  Secret Manager), two platform config files and APNs certificates, none of which exist in either
  codebase today; folding it in roughly doubles this feature and mixes a new dependency into a
  gap-closing one; and the `NotificationPresenter` seam (spec 011) means waiting costs **no rework** —
  a push provider's foreground presentation drops into that existing interface, and Story 3 will not
  need rebuilding.

  **Carry this into 014 — it is the finding that is easy to miss.** A device token *outlives a session*,
  where a socket does not. Today displacement makes the abandoned handset go quiet because its
  connection dies, which is the whole of User Story 2. With a push provider, unless the token is
  invalidated as part of the displacement path, the driver's next order assignment is pushed to the
  phone they left in the depot — US2's failure mode reintroduced through a different door. Token
  invalidation on sign-out **and on displacement** is a P1 requirement of 014, not a follow-up.
- Driver shift control (going on and off duty).
- Concurrent multi-device sessions for one driver.
- Any change to how the customer places, pays for, or is billed for an order.
- Route deviation, geofenced no-stop zones, or per-driver stop histories — explicitly excluded when stop
  detection was designed, and excluded here for the same reason.
- A live in-app map for the driver; turn-by-turn stays with the device's own maps app.
- The client persona's remaining fabricated surfaces — the order-detail preview state and the account
  and settings placeholders. Only the shared live-delivery defect underneath them is fixed here.
