# Feature Specification: Driver Authentication & Session

**Feature Branch**: `006-driver-auth-session`

**Created**: 2026-08-22

**Status**: Draft

**Input**: User description: "now we work with driver side i need see the arch of files and folders and start with auth feature"

## Context

The mobile app serves two personas from one binary. The CLIENT persona was brought to
live data by spec 005. The DRIVER persona is the remaining half, and this feature opens
that work at the point every driver session begins: getting into the app and staying in
it safely.

Sign-in itself already works for a driver — the login form, the phone/password call, the
token store, the silent refresh and the role-based landing redirect are shared with the
client and are live today. What does **not** exist for a driver is everything *around*
the session: the driver never sees their own real identity (their profile screen shows a
hard-coded name, phone and email), their session sits unprotected on a handset
anyone can pick up, a driver locked out in the field has no way back in, and signing
out only forgets the tokens locally rather than ending the session at the server.

Drivers are the persona where these gaps hurt most. They are company-provisioned users
working from a shared or company-issued handset, out on the road, without desk access to
an administrator. This feature closes the session lifecycle for them end to end.

## Clarifications

### Session 2026-08-22

- Q: Session revocation granularity — may a driver hold sessions on several devices at once? → A: Single active session per driver. A new sign-in ends any previous session; sign-out and password reset both end it.
- Q: How promptly must a revoked session take effect on an idle device? → A: Pushed over the app's live connection, with the reconnect handshake as the fallback when that connection is down.
- Q: Does app lock change whether a driver is on duty and dispatchable? → A: No. Lock is a device-privacy control only; the driver stays on duty while locked. Handling an assignment the driver never sees is deferred to the driver-operations feature.
- Q: What must the platform record about session events? → A: Audit every session lifecycle event — sign-in, sign-out, displacement by another device, password reset, and deactivation-driven revocation — with time, driver and cause. Per-request access logging is out of scope.
- Q: Who decides whether app lock is on? → A: Nobody — it is always on and not configurable, by driver or company. Enforced purely client-side against the device's native biometric hardware (Face ID / Touch ID / fingerprint), so it needs no backend administration and cannot be disabled. **Technical directive**: implement with the native Flutter biometric package (`local_auth`), already a dependency. **Resolved gap**: where no biometric is enrolled or the sensor is unusable, the challenge falls back to the device passcode rather than stranding the driver — still device-level, still not driver-disableable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A driver sees their own identity after signing in (Priority: P1)

A driver signs in with their phone number and password and lands on the driver home
screen. Their profile shows who they actually are: their real name, their verified phone
number, their photo, the transportation company they drive for, and the truck they are
assigned to. Nothing on the screen is a stand-in for a real value.

**Why this priority**: It is the smallest change that turns the driver app from a demo
into an account. A driver who sees someone else's placeholder name has no reason to trust
anything else the app tells them, and cannot confirm they are signed in as themselves —
which matters immediately on a shared handset.

**Independent Test**: Sign in as a seeded driver, open the driver profile screen, and
confirm every displayed field matches that driver's record. Sign out, sign in as a second
driver, and confirm the screen shows the second driver's values with no trace of the
first.

**Acceptance Scenarios**:

1. **Given** a driver with a full record signs in, **When** they open their profile,
   **Then** their name, phone number, email, photo, company name and assigned truck are
   the values held for that driver.
2. **Given** a driver has no photo on file, **When** they open their profile, **Then**
   they see a neutral placeholder avatar rather than an empty or broken image.
3. **Given** a driver has no truck assigned yet, **When** they open their profile,
   **Then** the truck row states that no truck is assigned rather than showing blank or
   invented plate details.
4. **Given** a driver signs out and a second driver signs in on the same device,
   **When** the second driver opens any driver screen, **Then** no value belonging to the
   first driver is visible at any point, including the first frame.
5. **Given** the profile cannot be loaded because the device is offline, **When** the
   driver opens their profile, **Then** they see a clear failure message and a retry
   action, not placeholder values.

---

### User Story 2 - A driver's session is locked to their person (Priority: P1)

A driver returns to a handset that has been sitting on the dashboard, in a depot, or in
another driver's hands. Before the session is usable again the app requires them to prove
it is still them, against the device's own biometric hardware. This protection is always
on. No driver and no administrator can switch it off.

**Why this priority**: Driver accounts can release fuel. A driver's session can mark an
order delivered and confirm handover OTPs, so an unattended unlocked handset is a
financial exposure, not just a privacy one. Making it mandatory rather than optional means
the guarantee holds for every driver on every handset without anyone having to administer
it — which matters because there is no administration surface to configure it from.

**Independent Test**: Send the app to the background, bring it back, and confirm it
demands re-authentication. Search the app for any control that disables the lock and
confirm none exists.

**Acceptance Scenarios**:

1. **Given** a signed-in driver, **When** they search every settings screen in the app,
   **Then** there is no control anywhere that turns the lock off or weakens it.
2. **Given** a signed-in driver, **When** the app returns to the foreground more than 2
   minutes after being backgrounded, **Then** they must re-authenticate before reaching any
   driver screen.
3. **Given** the unlock challenge fails or is dismissed, **When** the driver tries to
   proceed, **Then** they stay on the lock screen with the option to retry or to sign out
   entirely.
4. **Given** the handset has a biometric enrolled, **When** the challenge is presented,
   **Then** it is satisfied by that biometric — Face ID, Touch ID or fingerprint.
5. **Given** the handset has no biometric enrolled, or the sensor is unusable because it is
   wet, gloved, damaged or locked out after repeated failures, **When** the challenge is
   presented, **Then** the driver may satisfy it with the device passcode instead and is
   never left unable to reach a delivery in progress.
6. **Given** the handset has neither a biometric nor a device passcode set, **When** the
   driver signs in, **Then** they are told the app requires a device lock and are sent to
   set one up before they can continue.
7. **Given** the lock is engaged, **When** a delivery-related push or notification arrives,
   **Then** the driver is still required to unlock before acting on it.
8. **Given** the lock is engaged during a shift, **When** dispatch looks for available
   drivers, **Then** the locked driver is still considered on duty and assignable.

---

### User Story 3 - A locked-out driver recovers access from the field (Priority: P2)

A driver has forgotten their password, or their password was changed by their company.
From the login screen they request a reset, prove ownership of their registered phone
number with a one-time code, choose a new password, and sign in — without needing to
reach an administrator.

**Why this priority**: It removes a hard stop that today ends a driver's working day. It
is P2 rather than P1 because a driver who is already signed in is unaffected, and an
administrator can currently reset a password out of band — slowly.

**Independent Test**: From the login screen, run the full recovery flow for a seeded
driver against a stubbed code sender, then sign in with the new password.

**Acceptance Scenarios**:

1. **Given** a driver taps the recovery link and enters their registered phone number,
   **When** they submit, **Then** a one-time code is sent to that number and they are
   taken to a code-entry step.
2. **Given** a driver enters a phone number that is not registered, **When** they submit,
   **Then** they see the same neutral confirmation as a registered number, so the app
   never reveals which numbers exist.
3. **Given** a driver enters the correct code, **When** they submit a new password
   meeting the password rules, **Then** the password is changed and they can sign in with
   it immediately.
4. **Given** a driver enters an incorrect code, **When** they submit, **Then** they are
   told the code is wrong and may retry until the attempt limit is reached, after which
   they must request a new code.
5. **Given** a code has expired, **When** the driver submits it, **Then** they are told it
   expired and are offered a resend.
6. **Given** a driver requests codes repeatedly, **When** they exceed the request rate,
   **Then** further requests are refused for a cooling-off period with the wait time
   stated.
7. **Given** a password reset completes, **When** any session for that driver is still
   active on another device, **Then** that session can no longer be renewed.

---

### User Story 4 - Signing out actually ends the session (Priority: P2)

A driver hands the handset back at the end of a shift and signs out. The session is over
everywhere: the device holds no credentials, and the discarded session cannot be revived
by anyone holding a copy of it.

**Why this priority**: It converts a local gesture into a real security boundary. It is
P2 because the current behaviour is not wrong for the ordinary case — it is only
insufficient for a lost or shared device, which is exactly the driver's case.

**Independent Test**: Sign out, then attempt to renew the session using the credentials
issued before sign-out, and confirm the renewal is refused.

**Acceptance Scenarios**:

1. **Given** a signed-in driver confirms sign-out, **When** the sign-out completes,
   **Then** they land on the login screen and no driver data remains readable on the
   device.
2. **Given** a driver has signed out, **When** the session credentials issued before that
   sign-out are presented for renewal, **Then** renewal is refused.
3. **Given** a driver taps sign-out while offline, **When** the server cannot be reached,
   **Then** the local session is still cleared and they land on the login screen.
4. **Given** a driver is signed out, **When** they reopen the app, **Then** they see the
   login screen with their remembered phone number prefilled and no session restored.
5. **Given** a driver's live location was being reported, **When** they sign out,
   **Then** reporting stops and the driver is no longer presented as on duty.

---

### User Story 5 - A revoked driver loses access promptly (Priority: P3)

A transportation company deactivates a driver — they left, were suspended, or lost their
licence. The driver's app stops working within the current shift rather than at the end
of the credential's natural life, and the driver is told plainly that their account is no
longer active.

**Why this priority**: It closes the window between an administrative decision and its
effect on the road. P3 because deactivation already blocks fresh sign-in and session
renewal; this narrows a bounded remaining window rather than opening a new capability.

**Independent Test**: Deactivate a signed-in driver's account, then have the app perform
any authenticated action and confirm it is refused and the driver is returned to the
login screen with an explanation.

**Acceptance Scenarios**:

1. **Given** a signed-in driver is deactivated, **When** the deactivation takes effect,
   **Then** the app ends the session within seconds without waiting for the driver to act,
   and returns them to the login screen with a message that the account is not active.
2. **Given** a deactivated driver is on the login screen, **When** they try to sign in,
   **Then** they are refused with a message that does not reveal whether the password was
   correct.
3. **Given** a driver is deactivated mid-delivery, **When** they are signed out, **Then**
   the order they were carrying is left in a state an administrator can reassign, and the
   driver is not left believing the delivery is still theirs.
4. **Given** a driver is deactivated while their device has no live connection, **When** the
   device next re-establishes that connection, **Then** the connection is refused and the
   session ends immediately, without waiting for any further driver action.

---

### Edge Cases

- A driver's account is deactivated between entering their password and the app landing
  on the home screen.
- The registered phone number is changed by an administrator while the driver holds an
  active session.
- Two drivers sign in on the same handset within the same minute; the second must never
  see the first's cached identity, orders, or notifications.
- The device clock is wrong by hours, which affects both code expiry and session lifetime
  judgements made on the device.
- The app is force-quit during the recovery flow, between code verification and setting
  the new password.
- A driver enrols a new fingerprint on the device — the app must not treat a previously
  stored approval as still valid for the new enrolment.
- The biometric sensor locks itself out after repeated failed attempts, which on some
  devices persists until the device passcode is entered.
- A driver removes their only enrolled biometric, or factory-resets the device lock, while
  holding an active session mid-delivery.
- A driver is wearing gloves in cold weather or has fuel-wet hands for an entire shift, so
  the biometric path is effectively unavailable to them all day.
- The recovery code arrives after the driver has already requested a second one; only the
  most recent code may work.
- A driver signs out while the handset is in airplane mode, then the device comes back
  online hours later.
- A driver signs in on a second handset while the first is mid-delivery with an order
  assigned and location reporting active.
- A revocation is pushed at the exact moment the device's live connection is dropping, so
  the signal is neither delivered nor retried.
- Session renewal and app-lock re-authentication are triggered at the same moment by a
  resume from background.
- A driver with no assigned truck attempts to start a shift.

## Requirements *(mandatory)*

### Functional Requirements

#### Driver identity (US1)

- **FR-001**: The app MUST display the signed-in driver's own name, phone number, email,
  and photo on the driver profile screen, sourced from the driver's record rather than
  from any fixed value in the app.
- **FR-002**: The app MUST display the name of the transportation company the driver
  belongs to.
- **FR-003**: The app MUST display the truck assigned to the driver, including its plate
  identifier and the fuel types it may carry, and MUST state plainly when no truck is
  assigned.
- **FR-004**: The app MUST show a neutral placeholder for any identity field the record
  legitimately lacks, and MUST NOT substitute an invented value.
- **FR-005**: The app MUST allow a driver to update their own display name and profile
  photo, and MUST reflect the saved values without requiring a restart.
- **FR-006**: The app MUST allow a driver to change their registered phone number by
  confirming a one-time code sent to the new number, and MUST keep the previous number in
  force until that confirmation succeeds.
- **FR-007**: The app MUST surface a retryable failure state when driver identity cannot
  be loaded, and MUST NOT fall back to placeholder identity values.
- **FR-008**: The app MUST guarantee that no value belonging to a previous driver is visible
  in the **first frame** shown after a new sign-in — the narrower, harder guarantee than
  FR-030's general cache-clearing, since a value surviving even one frame is what a driver
  would actually see.
- **FR-009**: The driver's notification badge MUST reflect that driver's actual unread
  count.

#### Session protection on the device (US2)

- **FR-010**: The app MUST require an unlock challenge for every driver, always. It MUST
  NOT expose any setting — to the driver, to their company, or to platform support — that
  disables the lock, shortens its threshold, or weakens the method it accepts.
- **FR-011**: The lock MUST be enforced entirely on the device against the operating
  system's own authentication, so that it holds without any server-side configuration and
  cannot be lifted by changing a record on the platform.
- **FR-012**: The app MUST require re-authentication before exposing any driver screen
  after it has been in the background beyond the inactivity threshold (default 2 minutes;
  see Assumptions), and on every cold launch into an existing session.
- **FR-013**: The challenge MUST be satisfied by the device's enrolled biometric where one
  exists. Where none is enrolled, or the sensor is unavailable, unreadable or locked out,
  the device passcode MUST be accepted instead, so a sensor failure never strands a driver
  mid-delivery.
- **FR-013a**: Where the device has neither an enrolled biometric nor a passcode, the app
  MUST require the driver to set up a device lock before reaching any driver screen, and
  MUST state plainly why.
- **FR-014**: The app MUST let a driver abandon the unlock challenge by signing out.
- **FR-015**: Failing the unlock challenge MUST NOT end the session by itself; the driver
  stays on the lock screen and may retry.
- **FR-016**: The app MUST NOT allow a notification tap to navigate to its destination
  screen while the unlock challenge is pending — the challenge must resolve first.
- **FR-017**: The app MUST re-require enrolment approval when the device's enrolled
  biometrics change, so a newly enrolled biometric cannot inherit the prior approval.
- **FR-018**: Unlocking MUST NOT require the driver's password, and the app MUST NOT store
  the driver's password on the device for any purpose.
- **FR-018a**: The unlock challenge MUST NOT change the driver's duty state. A locked device MUST leave
  the driver on duty and dispatchable, and MUST keep reporting their location if a delivery
  is in progress — a screen lock is not a break.

#### Password recovery (US3)

- **FR-019**: The app MUST let a driver start password recovery from the login screen
  without an existing session.
- **FR-020**: The platform MUST send a one-time code to the phone number registered for
  the account when recovery is requested.
- **FR-021**: The response to a recovery request MUST be identical whether or not the
  number is registered, so the flow cannot be used to discover accounts.
- **FR-022**: A one-time code MUST expire after its bounded lifetime (default 5 minutes;
  see Assumptions) and MUST be usable at most once.
- **FR-023**: Only the most recently issued code for an account MUST be accepted;
  requesting a new code MUST invalidate any earlier outstanding code.
- **FR-024**: Verification attempts MUST be limited per code (default 5), after which that
  code is refused and a new one must be requested.
- **FR-025**: Recovery requests MUST be rate-limited per account and per originating device
  (default 3 requests per 15 minutes), and a refused request MUST state how long the
  driver must wait.
- **FR-026**: A new password MUST meet the platform's existing password rules, and the app
  MUST state the rules before submission rather than only on rejection.
- **FR-027**: Completing a password reset MUST end the driver's active session, wherever it
  is held, and prevent its renewal.
- **FR-028**: The platform MUST record each recovery request and each failed verification
  attempt, in addition to the completed reset FR-043 already covers, without recording the
  code itself or the new password.

#### Ending a session (US4)

- **FR-029**: Signing out MUST end the session at the server such that credentials issued
  before sign-out can no longer be renewed, on any device.
- **FR-030**: Signing out MUST clear every stored credential and all cached driver data
  from the device.
- **FR-031**: Signing out MUST succeed locally even when the server is unreachable, and
  the app MUST NOT strand the driver in a signed-in state it cannot leave.
- **FR-032**: Signing out MUST stop live location reporting and MUST leave the driver no
  longer presented as on duty.
- **FR-033**: Signing out MUST require an explicit confirmation, so a mis-tap on a dense
  settings list cannot end a shift's session.
- **FR-034**: The remembered phone number MUST survive sign-out so the next sign-in is
  prefilled, and MUST NOT be accompanied by any stored password.

#### Loss of eligibility (US5)

- **FR-035**: The platform MUST push a session-ended signal to a driver's device as soon as
  the session is revoked — by deactivation, password reset, or a sign-in elsewhere —
  without waiting for the driver to perform an action.
- **FR-035a**: When the device has no live connection at the moment of revocation, the
  platform MUST refuse that session's next connection attempt, so re-establishing the
  connection ends the session rather than resuming it.
- **FR-035b**: An authenticated action by a driver whose session has been revoked MUST be
  refused, as the backstop for both paths above.
- **FR-036**: On any of these signals the app MUST end the local session and return the
  driver to the login screen, stating which of the three causes applies.
- **FR-037**: A sign-in attempt by a deactivated driver MUST be refused with a message
  that does not distinguish a wrong password from an inactive account.
- **FR-038**: When a driver is signed out involuntarily, any delivery assigned to them
  MUST remain in a state an administrator can reassign.

#### Cross-cutting

- **FR-039**: Every driver-facing string introduced by this feature MUST be available in
  Arabic and English and MUST render correctly right-to-left.
- **FR-040**: No credential, one-time code, or password MUST ever appear in a log, crash
  report, or error message shown to the driver, **in production**. A development-only stand-in
  for an unprocured SMS provider that deliberately logs the code so a developer can read it
  (mirroring the platform's existing `NoopSmsSender`, spec 005 research R4) is not what this
  requirement forbids — it is unreachable once a real provider is configured, exactly as the
  existing stand-in already is.
- **FR-041**: The platform MUST remain the sole authority on whether a session is valid;
  the app MUST NOT grant access based on locally cached judgement alone.
- **FR-042**: A driver MUST hold at most one active session at any time. Signing in on a
  second device MUST end the session on the first, and the driver on the first device MUST
  be returned to the login screen with a message that they signed in elsewhere.
- **FR-043**: The platform MUST record every session lifecycle event for a driver — sign-in,
  sign-out, displacement by a sign-in elsewhere, password reset, and revocation by
  deactivation — capturing at minimum when it happened, which driver it concerns, and what
  caused it.
- **FR-044**: Session records MUST be retained for at least 2 years — the same period the
  platform already retains order and payment history, long enough to answer, after the fact,
  which driver held a session at the time a given delivery was completed.
- **FR-045**: Session records MUST NOT contain credentials, one-time codes, passwords, or
  anything from which a session could be reconstructed or resumed.
- **FR-046**: The platform MUST NOT log every authenticated request a driver makes; the
  audit trail covers session lifecycle events only.

### Key Entities

- **Driver account**: A person who transports fuel, belonging to exactly one
  transportation company. Carries the identity shown in the app (name, phone, email,
  photo), an active/inactive standing, an assigned truck, and duty state.
- **Truck**: The vehicle bound to a driver, identified by its plate and constrained to
  the fuel types it may carry.
- **Session**: A driver's authenticated presence — **at most one per driver at a time**,
  mirroring the one-active-order constraint the platform already enforces. Established by
  sign-in, renewable while the driver remains eligible, and ended by sign-out, password
  reset, deactivation, or a sign-in on another device.
- **Recovery code**: A short-lived, single-use, single-outstanding proof that the
  requester controls the phone number registered to an account.
- **Unlock challenge**: The mandatory proof-of-person the device performs before the app
  becomes usable. It has no stored preference and no configurable state — it is a property
  of the app, satisfied by whatever the operating system can currently authenticate with.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A driver reaching their profile screen sees only values belonging to their
  own account — zero placeholder or hard-coded identity values remain on any driver
  screen.
- **SC-002**: After a second driver signs in on the same handset, no data from the
  previous driver is observable on any screen, at any point, in 100% of switches.
- **SC-003**: The unlock challenge is in force on 100% of driver devices, with no driver
  and no administrator able to disable it — verified by the absence of any control that
  does so.
- **SC-004**: An unattended handset returned to the foreground reaches no driver screen
  without a successful unlock, in 100% of attempts.
- **SC-004a**: A driver whose biometric sensor cannot read them still reaches an in-progress
  delivery via the device passcode, in 100% of attempts — the mandatory lock produces zero
  hard lockouts of a driver from a delivery already assigned to them.
- **SC-005**: A driver who has forgotten their password can regain access from the field
  in under 3 minutes without contacting an administrator.
- **SC-006**: A recovery attempt using an expired, superseded, or already-used code
  succeeds 0% of the time.
- **SC-007**: A session discarded at sign-out cannot be revived, in 100% of attempts.
- **SC-008**: A deactivated driver with a live connection loses app access within 5 seconds
  of the deactivation taking effect, without touching the device. With no live connection,
  access ends at the first reconnection attempt.
- **SC-009**: Support contacts about drivers unable to sign in fall by at least 70% once
  self-service recovery is available.
- **SC-009a**: For any completed delivery, an administrator can determine which driver held
  the session at that moment and how that session began and ended, in 100% of cases.
- **SC-010**: Every new driver-facing screen and message in this feature renders correctly
  in Arabic right-to-left with no clipped or overflowing text.

## Assumptions

- Driver accounts are provisioned by a transportation company administrator. Self-service
  registration is out of scope; recovery restores access to an existing account only.
- Sign-in remains phone number plus password, as it is today for both personas. This
  feature does not change the credential type.
- The registered phone number is the only recovery channel. Drivers are not assumed to
  have working access to their registered email while on the road.
- One-time codes are delivered through the platform's existing code-issuing and message-
  sending capability, already used for delivery handover and phone verification.
- Password rules are the platform's existing rules; this feature states them to the driver
  but does not redefine them.
- **Binding technical directive (from clarification, 2026-08-22)**: the mandatory unlock
  challenge is implemented with the native Flutter biometric package (`local_auth`), which
  is already a dependency of the app and already wrapped by the existing device-security
  helper. The challenge permits the operating system's passcode fallback so that a failed
  or absent sensor cannot hard-lock a driver out of a delivery; it is never satisfied by an
  in-app password or PIN of our own.
- The mandatory lock applies to the **driver persona only**. The client persona keeps its
  existing optional app-lock behaviour; this feature must not silently impose the driver
  policy on clients sharing the same binary.
- Concrete defaults chosen where the description did not specify one, all tunable without
  reopening this spec: app-lock inactivity threshold **2 minutes** of background time;
  recovery code **6 digits**, **5-minute** lifetime, **5** verification attempts per code,
  **3** recovery requests per **15 minutes** per account.
- The driver's on-duty presence continues to be established by the app's live connection,
  as it is today; this feature governs when that connection starts and stops relative to
  the session, not how presence is determined.
- Truck assignment is performed by a transportation company administrator; the driver app
  displays the assignment and never changes it.
- The web administration dashboard is where deactivation and truck assignment are
  performed. Its absence does not block building this feature — those states can be seeded
  directly — but it does gate the feature's real-world use.
- Session audit records follow the platform's existing retention practice for order and
  payment history, since their purpose is to be reconcilable against exactly those records.
- Push notification delivery and device registration are handled separately and are out of
  scope here; this feature only governs whether a notification can be acted on while the
  app is locked.
- Changes to shared sign-in, session renewal, and sign-out behaviour affect the client
  persona too. Any such change must leave the existing client suites green.

## Out of Scope

- The driver's operational screens: order list, delivery detail, navigation, handover OTP,
  and live location reporting. These are the next slices of driver-side work and depend on
  this one only for a real session.
- Acknowledgement, timeout or re-offer of an order assigned to a driver who does not see it
  (because the device is locked, backgrounded or out of coverage). FR-018a deliberately
  keeps a locked driver dispatchable, which makes this a real gap — but it belongs to
  dispatch and driver-operations, not to the session lifecycle.
- Self-service driver registration or company onboarding.
- Alternative sign-in methods: social sign-in, single sign-on, or magic links.
- Administrator-facing screens for creating, deactivating, or assigning drivers.
- Any restructuring of the app's folder layout. The structural migration is tracked
  separately; this feature adds files in the places the current structure dictates.
