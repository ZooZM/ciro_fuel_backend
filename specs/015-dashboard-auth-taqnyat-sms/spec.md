# Feature Specification: Web Dashboard Authentication & Taqnyat SMS Provider

**Feature Branch**: `015-dashboard-auth-taqnyat-sms`

**Created**: 2026-09-03

**Status**: Draft (clarified)

**Input**: User description: "Auth feature for the web dashboard, plus swapping the backend SMS provider to Taqnyat. SMS_SENDER: ciro, SMS_BEARER_TOKEN: (secret), SMS_ENDPOINT_URL: https://api.taqnyat.sa/v1/messages, SMS body field: body. Taqnyat API: POST https://api.taqnyat.sa/v1/messages with Authorization: Bearer <token>, JSON body { recipients: [msisdn], body: <text>, sender: \"ciro\" }. Wire the dashboard login/session/refresh/logout flow to the live backend for SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN, including password recovery over SMS via Taqnyat."

**Repositories**: backend (this repository) and the web dashboard at `E:\zeyad\web_dashboard_ciro_fuel`.

## Overview

Administrators sign in to the web dashboard by entering their mobile number and the one-time code
they receive by SMS. That single sentence is the feature, and today not one part of it works.

Three things must become true, and each is a different kind of gap:

1. **The platform cannot send an SMS at all.** The message-sending seam exists and a Taqnyat adapter
   behind it exists, but the platform is configured to a development stand-in that only writes the
   message to a log. Every SMS the platform believes it sends — a sign-in code, a password-reset
   code, a phone-verification code, the driver-assignment escalation fallback — is silently not
   sent. Taqnyat becomes the live provider, and the configuration gaps that let a deployment believe
   it configured a provider when it did not are closed.

2. **There is no such thing as signing in with a code.** The dashboard's sign-in screens are already
   drawn for it — a mobile number, then a code, then the dashboard — but there is no endpoint behind
   them. The screens currently fake it by putting the phone number where an email belongs and the
   code where a password belongs, which the platform can only ever refuse. The platform gains a real
   request-code / verify-code pair, hardened against the abuse an unauthenticated numeric-code
   endpoint attracts.

3. **An administrator can only hold one session at a time, and nobody decided that.** The platform
   ends every prior session on every sign-in — a rule written for drivers, where one person holds
   one delivery on one phone. Inherited by an office role that works across a desktop and a laptop,
   it means signing in in one place silently signs you out in the other. Administrators get a
   capped set of concurrent sessions instead, each independently revocable. **No other role's
   behaviour changes.**

Email-and-password sign-in continues to work alongside the code path, and password recovery over
SMS continues to exist for administrators who have a password — both are kept, not replaced.

What is *not* a gap, and is deliberately not rebuilt: the dashboard's session store, silent-renewal
interceptor, sign-out, identity bootstrap, role vocabulary, and route guards are already implemented
and already agree with the platform. This feature wires the sign-in screens to real endpoints and
extends that machinery; it does not replace it.

## Clarifications

### Session 2026-09-03

- Q: Dashboard admin login method — email+password (backend as-is), passwordless phone + SMS-OTP
  (new backend endpoints), or both? → A: **Passwordless phone + SMS-OTP.** The backend gains a
  request-code / verify-code endpoint pair that issues a token pair for the three admin roles; the
  dashboard keeps its designed phone → verify UX.
- Q: Does SMS-OTP login replace email+password for admins, or coexist? → A: **Coexist.** Both
  email+password and phone SMS-OTP sign an administrator in. `/auth/login` (email+password) stays
  available for admin roles; password recovery over SMS stays for administrators who have a
  password. The dashboard's designed, visible flow is phone → SMS-OTP.
- Q: Brute-force protection on the new SMS-OTP login endpoint? → A: **Strict.** Reuse the
  password-reset hardening (per-phone request rate limit; per-code attempt lockout; expiry;
  enumeration-safe identical responses) AND add a temporary block on the phone number after
  repeated failed code entries across multiple codes, AND a CAPTCHA / proof-of-work challenge on
  repeated code requests.
- Q: One-time code length (dashboard renders 4 boxes, backend primitive generates 6 digits)? → A:
  **6 digits**, for both the new SMS-OTP login code and the existing password-reset code. The
  shared backend primitive is unchanged; the dashboard's code-entry screen is corrected to 6 boxes.
- Q: Concurrent sessions for administrators (the platform currently displaces every prior session on
  every sign-in)? → A: **Allow concurrent, but capped.** An administrator may hold up to a
  configured number of simultaneous sessions (default 3); signing in beyond the cap ends the oldest
  one, which is told why. This requires per-session tracking rather than the current single
  account-level counter. DRIVER and CLIENT behaviour is unchanged — they keep exactly one session.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The platform can actually send an SMS (Priority: P1)

Every text message the platform is supposed to send is delivered through Taqnyat, from the sender
name "ciro": sign-in codes, password-reset codes, phone-verification codes, and the
driver-assignment escalation fallback. A deployment that has not supplied a working Taqnyat
configuration refuses to start rather than starting up silently unable to send anything. When
Taqnyat accepts a request but refuses the specific recipient, the platform treats that as a failed
send, not a success.

**Why this priority**: Both sign-in (US2) and recovery (US5) are undeliverable without it, and the
driver-assignment escalation fallback — a driver who never saw an assignment — starts working the
moment it lands. It is the only story that delivers value entirely on its own.

**Independent Test**: Configure the platform for Taqnyat against a test account. Trigger any
existing SMS-sending action (a password-reset request for a known account) and confirm a real
message arrives from "ciro". Start the platform in production mode with the bearer token missing and
confirm it refuses to start, naming the missing setting. Simulate a Taqnyat response that lists the
recipient as rejected and confirm the platform records the send as failed.

**Acceptance Scenarios**:

1. **Given** the platform configured for Taqnyat, **When** any platform action sends an SMS,
   **Then** the recipient receives a message from sender "ciro" with the expected content.
2. **Given** a production start-up, **When** the bearer token or the sender name is missing or
   empty, **Then** the platform fails to start and names which setting is absent.
3. **Given** a production start-up, **When** the SMS provider is left as the development stand-in,
   **Then** the platform fails to start (already enforced; MUST remain so).
4. **Given** Taqnyat responds accepting the request but listing the recipient as rejected (invalid
   number, blocked prefix, insufficient balance), **Then** the platform treats the send as failed
   and never reports the message as delivered.
5. **Given** Taqnyat does not respond within the allowed time or returns a transport error, **Then**
   the platform treats the send as failed rather than hanging or assuming success.
6. **Given** any SMS is sent, **When** the send is logged, **Then** the log line contains no message
   body and no code.
7. **Given** a Saudi number in local form ("05XXXXXXXX"), **Then** it is normalised to international
   form; **Given** a number that cannot be confidently interpreted, **Then** it is passed through
   unchanged so Taqnyat rejects it and the failure is loud.

---

### User Story 2 - An administrator signs in with their mobile number and a code (Priority: P1)

A fuel-company administrator, a transport-company administrator, or the platform operator opens the
dashboard, enters the mobile number on their account, and taps "send code". A six-digit code arrives
by SMS. They enter it and land on the home screen for their role, holding a real platform session
with their real identity, company and permissions. Someone who is not an administrator — a driver, a
client, a number belonging to nobody — sees exactly the same screen and the same message, and never
receives a code.

**Why this priority**: This is the feature's headline journey and the only sign-in path the
dashboard actually presents. Nothing else on the dashboard is reachable until it works.

**Independent Test**: Seed one administrator of each of the three roles with a mobile number. For
each, request a code from the dashboard, read it from the received SMS, enter it, and confirm they
land on the correct home screen with their identity shown. Request a code for a driver's number, a
client's number, and an unregistered number, and confirm all three produce an identical on-screen
result and no SMS.

**Acceptance Scenarios**:

1. **Given** a seeded FUEL_COMPANY_ADMIN with a mobile number, **When** they request a code and
   enter the one they receive, **Then** they are signed in and land on the fuel-company home screen
   with their name and company shown.
2. **Given** a seeded TRANSPORT_COMPANY_ADMIN, **When** they complete the same flow, **Then** they
   land on the transport-company home screen and cannot reach any fuel-company or operator surface.
3. **Given** a seeded SUPER_ADMIN, **When** they complete the same flow, **Then** they reach the
   operator surface and are not confined to one company's data.
4. **Given** a DRIVER's or CLIENT's mobile number, **When** a code is requested for it, **Then** the
   on-screen result is identical to the administrator case, **no** SMS is sent, and no code that
   could sign them in to the dashboard exists.
5. **Given** an unregistered number, **When** a code is requested, **Then** the on-screen result is
   identical to every other case and no SMS is sent.
6. **Given** a delivered code, **When** it is entered wrongly, after it has expired, after a newer
   code was requested, or after the attempt limit is reached, **Then** all four produce the same
   "incorrect or expired code" result with no attempt counter shown.
7. **Given** a signed-in administrator, **When** they reload the browser, **Then** they remain
   signed in without repeating the code.
8. **Given** the dashboard as shipped by this feature, **When** its source and running app are
   inspected, **Then** there is no demo role picker, no hard-coded token, and no path that renders
   real screens without a validated session.

---

### User Story 3 - Sign-in abuse is contained (Priority: P1)

The sign-in endpoints are open to the internet and accept a phone number and a short numeric code,
so they attract guessing, SMS-cost abuse, and attempts to work out which numbers belong to
administrators. Repeated code requests for one number are refused; after a few of them a challenge
must be solved before another is issued. Repeated wrong codes lock that code out, and sustained
wrong codes across several requests temporarily block the number entirely. None of these refusals
reveal whether the number belongs to an account.

**Why this priority**: It ships with US2, not after it. An unhardened code endpoint is a live SMS
bill and a credential-guessing surface from the moment it is deployed, and retrofitting the limits
later means the enumeration-safety property has to be re-established across every response.

**Independent Test**: Script repeated code requests for one number and confirm refusal after the
configured limit with a "try again later" response, then a challenge requirement. Script repeated
wrong code entries and confirm lockout of that code, then a temporary block of the number. Run every
one of those against a registered administrator number and an unregistered number and confirm the
responses are indistinguishable.

**Acceptance Scenarios**:

1. **Given** repeated code requests for one number within the window, **When** the limit is
   exceeded, **Then** further requests are refused with a "try again later" response that states
   when to retry.
2. **Given** the request limit has been hit repeatedly, **When** another code is requested, **Then**
   a challenge must be completed before a code is issued, and an unsolved or invalid challenge
   yields no code and no SMS.
3. **Given** an issued code, **When** it is entered incorrectly the configured number of times,
   **Then** that code is locked out and can never succeed, even if the correct value is later
   entered.
4. **Given** repeated failed code entries spanning several separately requested codes, **When** the
   threshold is crossed, **Then** the number is temporarily blocked: new code requests and code
   entries for it are refused for a stated period.
5. **Given** any of the refusals above, **When** the same sequence is run against an unregistered
   number, **Then** the responses are identical in status, body and observable timing.
6. **Given** the abuse controls, **When** they are applied, **Then** they are enforced on the
   platform and never only in the browser — a caller bypassing the dashboard is subject to all of
   them.
7. **Given** a legitimate administrator who mistypes a code once or twice, **When** they then enter
   it correctly, **Then** they sign in normally — the controls do not punish ordinary use.

---

### User Story 4 - An administrator works from more than one machine (Priority: P1)

An administrator signed in on their office desktop opens the dashboard on a laptop and signs in
there too. Both stay signed in. Signing out on the laptop ends only the laptop's session; the
desktop keeps working. Signing in on a fourth device ends the oldest session, and that device is
told plainly why. When the account's password is reset or the account is deactivated, every session
everywhere ends at once.

**Why this priority**: Without it, US2 delivers a dashboard that logs administrators out of their
own other machine every time they sign in — which reads as a defect and would surface immediately in
normal use. Drivers and clients keep their existing one-session-only behaviour untouched.

**Independent Test**: Sign the same administrator in from three separate browser profiles and
confirm all three remain able to load data. Sign out of one and confirm the other two are unaffected
and the signed-out one's renewal credential is refused. Sign in from a fourth and confirm the oldest
is ended with a stated reason. Reset the password from elsewhere and confirm all remaining sessions
end. Repeat the three-device test as a DRIVER and confirm the second sign-in still displaces the
first.

**Acceptance Scenarios**:

1. **Given** an administrator signed in on two devices, **When** both make requests, **Then** both
   succeed; neither device was ended by the other's sign-in.
2. **Given** an administrator signed in on two devices, **When** they sign out on one, **Then** that
   device returns to sign-in and its renewal credential is refused if replayed, while the other
   device continues working uninterrupted.
3. **Given** an administrator holding the maximum number of sessions, **When** they sign in once
   more, **Then** the oldest session is ended and that device, on its next platform contact, is
   returned to sign-in with a stated reason naming the device limit.
4. **Given** an administrator with several live sessions, **When** their password is reset, **Then**
   every one of those sessions ends.
5. **Given** an administrator with several live sessions, **When** the operator deactivates the
   account or suspends the company, **Then** every one of those sessions ends with the corresponding
   stated reason.
6. **Given** a DRIVER or a CLIENT, **When** they sign in on a second device, **Then** the first
   device's session ends exactly as it does today — no behaviour change for those roles.
7. **Given** any session that has been ended for any reason, **When** its renewal credential is
   presented afterwards, **Then** it does not produce a working session regardless of its own
   remaining lifetime.

---

### User Story 5 - A session stays alive, and ending it actually ends it (Priority: P1)

A signed-in administrator keeps working for hours without being unexpectedly signed out: their
session renews itself silently in the background. When the platform ends their session for its own
reasons, the dashboard notices promptly, returns them to sign-in, and says why in plain language.
Being refused a screen their role may not see never signs them out.

**Why this priority**: A dashboard that signs administrators out mid-task is unusable. The machinery
for this largely exists already in the dashboard; this story is about making it correct against the
new per-session model and proving it.

**Independent Test**: Sign in, let the access credential age past its lifetime, perform an action,
and confirm it succeeds with no visible interruption. Fire several requests simultaneously against
an expired credential and confirm exactly one renewal occurs. Trigger an authorization refusal and
confirm no renewal and no sign-out follow.

**Acceptance Scenarios**:

1. **Given** an administrator whose access credential has expired, **When** they trigger any data
   request, **Then** the dashboard silently obtains a new credential and the request completes with
   no visible error and no sign-out.
2. **Given** several data requests that all hit an expired credential at once, **Then** the dashboard
   renews once, not once per request.
3. **Given** a renewal that fails for any reason, **Then** the dashboard ends the session and returns
   the administrator to sign-in — it does not retry indefinitely and does not sit on a blank screen.
4. **Given** the dashboard receives an authorization-boundary refusal (the administrator asked for
   something their role may not see), **Then** it surfaces that refusal and does **not** renew and
   does **not** sign them out.
5. **Given** the platform has ended a session, **When** the dashboard next contacts the platform,
   **Then** the administrator is returned to sign-in with the platform's stated reason shown in
   plain language.
6. **Given** two dashboard tabs open on one device, **When** a renewal happens in one, **Then** the
   other continues working; signing out in one ends the session for both on their next request.

---

### User Story 6 - Email and password still work (Priority: P2)

An administrator who has a password can still sign in with their email address and password, and the
platform still accepts it. This path is unchanged by the feature; it is kept working so that
administrators without a usable mobile number, and any automation or seeding script that signs in
this way, are not stranded by the new code-based path.

**Why this priority**: It is existing behaviour to preserve rather than new capability to build, and
the dashboard's visible sign-in flow is the code path. It matters mainly as a regression guard.

**Independent Test**: Sign in as each of the three administrator roles with email and password
directly against the platform and confirm a working session, a correct identity, and correct
participation in the multi-session rules from US4.

**Acceptance Scenarios**:

1. **Given** an administrator with a password, **When** they sign in with email and password, **Then**
   they receive a working session identical in every respect to one obtained via a code.
2. **Given** a wrong password, an unknown email, or a deactivated account, **Then** the response is
   one identical generic failure that does not reveal which of the three occurred.
3. **Given** a DRIVER's or CLIENT's valid email and password, **When** used to reach a dashboard
   screen, **Then** the dashboard refuses them because this surface is administrator-only.
4. **Given** an administrator signing in by password, **Then** they participate in the same
   concurrent-session cap as a code sign-in — the two paths share one session model.

---

### User Story 7 - An administrator recovers a forgotten password over SMS (Priority: P2)

An administrator who has a password and cannot remember it chooses "forgot password", enters the
mobile number on their account, receives a six-digit code by SMS, enters it, and sets a new
password. Every session that account had open ends.

**Why this priority**: With code-based sign-in available, a forgotten password is no longer a
lock-out — it is an inconvenience, so recovery moves behind the paths that unblock people.

**Independent Test**: With Taqnyat configured, request a reset for a seeded administrator, read the
code from the SMS, complete the reset, and sign in with the new password. Repeat with an
unregistered number and confirm an identical outcome.

**Acceptance Scenarios**:

1. **Given** an administrator on the sign-in screen, **When** they choose "forgot password" and
   submit the number on their account, **Then** they see a neutral confirmation and a real SMS with
   a six-digit code arrives.
2. **Given** a delivered reset code, **When** they enter it and set a new password, **Then** the new
   password works on the next sign-in and the old one does not.
3. **Given** a completed password reset, **Then** every session that account held ends.
4. **Given** a number belonging to no account, **Then** the outcome shown is identical to the
   registered case.
5. **Given** a wrong, expired, superseded, or attempt-locked reset code, **Then** all four produce
   the same "incorrect or expired code" result with no attempt count shown.
6. **Given** the SMS send fails, **Then** what the administrator sees is unchanged; the failure is
   recorded for operators and they can request another code.

---

### Edge Cases

- **An administrator has no mobile number on file**: code sign-in is impossible for them. The
  request-code screen still returns the neutral confirmation (no oracle), and they sign in with
  email and password (US6) or an operator adds their number.
- **Two administrators share a mobile number**: not permitted — the number that identifies a
  sign-in must resolve to exactly one account, or a code would sign in an ambiguous person.
- **A code arrives after the administrator has already requested a newer one**: the older code is
  superseded and fails with the same undifferentiated message as a wrong code.
- **A code is requested but never entered**: it expires silently; nothing is left signed in.
- **The device that receives the SMS is not the device signing in**: fully supported — the code is
  typed in wherever the administrator is working.
- **The oldest session is evicted by the cap while its device is mid-action**: the in-flight request
  either completes or fails as an ended session; the device is returned to sign-in with the
  device-limit reason on its next contact. No partial or corrupted state.
- **All of an administrator's sessions are on one device across several browser profiles**: they
  count individually against the cap; the platform cannot and does not try to identify "a device".
- **Taqnyat balance exhausted mid-day**: every send becomes a recipient rejection, recorded as
  failed. Administrators see "code sent" but none arrives, because the neutral response cannot
  reveal a send failure without becoming an enumeration oracle. Operator-facing logging is the
  mitigation.
- **Redis unavailable**: the rate limits, lockouts and temporary blocks depend on it. Sign-in MUST
  fail closed rather than fall open — an unprotected code endpoint is worse than a briefly
  unavailable one.
- **A non-Saudi number submitted for a code**: not force-expanded to a Saudi number; sent as-is so
  Taqnyat rejects it and the failure is loud rather than delivering a code to the wrong person.
- **Clock skew on the access credential**: a small allowance prevents a spurious sign-out at the
  expiry boundary.

## Requirements *(mandatory)*

### Functional Requirements

#### A. Taqnyat SMS provider

- **FR-001**: In production the platform MUST send every SMS through Taqnyat. The development
  stand-in that only logs the message MUST remain impossible to select in production.
- **FR-002**: The platform MUST send to Taqnyat at the configured endpoint with the bearer token in
  the request authorization, the message text in the body field named `body`, the sender name set to
  the configured sender ("ciro"), and the recipient as a bare international number (no leading "+"
  or "00").
- **FR-003**: When the platform is configured for Taqnyat, start-up validation MUST reject an empty
  or missing bearer token and an empty or missing sender name, naming which is absent. A production
  deployment MUST NOT be able to run "configured for Taqnyat" with either value blank.
- **FR-004**: A Taqnyat response that accepts the request but lists the recipient as rejected MUST be
  treated as a failed send; the platform MUST NOT report the message as delivered.
- **FR-005**: A Taqnyat request that times out or returns a transport error MUST be treated as a
  failed send, and the outbound request MUST be time-bounded so a non-responsive provider cannot
  hold a platform request open.
- **FR-006**: A Taqnyat rejection (bad token, inactive sender, HTTP error) MUST fail loudly to its
  caller — never a swallowed error that lets the caller believe the message was sent.
- **FR-007**: The platform MUST NOT log a message body or any code, for any provider. Only a
  provider-side message identifier and success/failure MAY be logged.
- **FR-008**: Saudi mobile numbers in local form ("05XXXXXXXX") MUST be normalised to international
  form before sending. A number that cannot be confidently interpreted MUST be passed through
  unchanged so the provider rejects it.
- **FR-009**: Taqnyat configuration MUST be supplied through the platform's existing settings and
  secret mechanisms under the platform's existing setting names; no provider-specific rename is
  introduced (see Assumptions for the value mapping).
- **FR-010**: Switching the SMS provider MUST require no code change in any feature that sends an
  SMS — sign-in codes, password reset, phone verification, and assignment escalation all continue to
  call the same sending seam.

#### B. Sign-in with a mobile number and a one-time code

- **FR-011**: The platform MUST provide a way to request a sign-in code for a mobile number, and a
  way to submit that number with a code and receive a session, without any prior credential.
- **FR-012**: A sign-in code MUST be six digits and MUST be generated by the platform's existing
  shared one-time-code primitive — not a second generator.
- **FR-013**: A sign-in code MUST expire after a configured period and MUST be single-use.
- **FR-014**: A code MUST be issued and sent **only** when the submitted number resolves to exactly
  one active account holding one of SUPER_ADMIN, FUEL_COMPANY_ADMIN, or TRANSPORT_COMPANY_ADMIN. In
  every other case — unknown number, DRIVER, CLIENT, inactive account, or a number matching more
  than one account — no code is created and no SMS is sent.
- **FR-015**: The response to a code request MUST be identical in status, body and observable timing
  for every outcome in FR-014, and identical again whether the SMS send succeeded or failed.
- **FR-016**: Submitting a correct, unexpired, unconsumed code MUST establish a session and return
  the same session material and identity shape that email-and-password sign-in returns, so both
  paths are interchangeable to everything downstream.
- **FR-017**: A wrong code, an expired code, a superseded code, and an attempt-locked-out code MUST
  all return the same refusal, with no attempt count and no remaining-attempts figure.
- **FR-018**: Requesting a new code MUST supersede any unconsumed code previously issued for that
  number.
- **FR-019**: A sign-in code MUST NOT be returned in any API response, MUST NOT be logged, and MUST
  NOT be readable by any endpoint.
- **FR-020**: A code MUST be stored only in a form from which the code itself cannot be recovered.

#### C. Sign-in abuse controls

- **FR-021**: Code requests MUST be rate-limited per submitted number over a configured window. The
  limit MUST be applied before, and independently of, whether an account is found, so it cannot
  become an account-existence oracle.
- **FR-022**: Exceeding the request rate limit MUST return a "try again later" refusal that states
  when the caller may retry.
- **FR-023**: After a configured number of rate-limited code requests for one number, a challenge
  (CAPTCHA or equivalent proof-of-work) MUST be required before another code is issued. A missing,
  invalid, or replayed challenge response MUST yield no code and no SMS.
- **FR-024**: Each issued code MUST allow only a configured number of verification attempts; beyond
  that the code MUST be permanently unusable even if the correct value is subsequently submitted.
- **FR-025**: Failed verification attempts MUST be counted per number across separately issued
  codes. Crossing a configured threshold MUST temporarily block that number: both code requests and
  code submissions for it are refused for a configured period.
- **FR-026**: A temporary block MUST expire on its own after the configured period; no operator
  action is required to clear it.
- **FR-027**: Every refusal in this section MUST be indistinguishable between a registered
  administrator number and an unregistered number.
- **FR-028**: Every control in this section MUST be enforced by the platform. Browser-side timers or
  disabled buttons are presentation only and MUST NOT be the enforcement point.
- **FR-029**: A successful sign-in MUST reset that number's failed-attempt accumulation.
- **FR-030**: If the store backing these controls is unavailable, code request and code verification
  MUST be refused (fail closed) rather than proceeding unprotected.
- **FR-031**: Code-request and code-verification activity MUST be recorded in the platform's session
  audit trail, including refusals and blocks, without recording the code itself.

#### D. Concurrent administrator sessions

- **FR-032**: An account holding SUPER_ADMIN, FUEL_COMPANY_ADMIN, or TRANSPORT_COMPANY_ADMIN MUST be
  able to hold more than one simultaneous session, up to a configured maximum (default 3).
- **FR-033**: DRIVER and CLIENT accounts MUST continue to hold exactly one session, with a new
  sign-in displacing the previous one. This feature MUST NOT change their behaviour in any
  observable way.
- **FR-034**: Each session MUST be independently identifiable and independently revocable; a
  credential MUST be attributable to the specific session it belongs to.
- **FR-035**: Signing out MUST end **only** the session that performed the sign-out. Other sessions
  for that account MUST continue working.
- **FR-036**: Completing a password reset MUST end **every** session for that account.
- **FR-037**: Deactivating an account, or suspending its company, MUST end **every** session for that
  account.
- **FR-038**: When an administrator signs in while already holding the maximum number of sessions,
  the oldest session MUST be ended and the new one established. The ended session MUST report a
  distinct, stated reason identifying the device limit — not the reason used for driver
  displacement.
- **FR-039**: A credential belonging to an ended session MUST NOT renew, and MUST NOT authorise any
  request, regardless of its own remaining lifetime.
- **FR-040**: Every session end MUST be recorded in the session audit trail with its cause and the
  specific session it applied to.
- **FR-041**: The set of session-end reasons MUST remain identical across the platform, the
  dashboard, and both mobile clients; adding the device-limit reason MUST be reflected everywhere
  that mirrors it.
- **FR-042**: The maximum number of concurrent administrator sessions MUST be configurable without a
  code change.

#### E. Dashboard sign-in surface

- **FR-043**: The dashboard's sign-in flow MUST be: enter mobile number → request code → enter the
  six-digit code → signed in. The code-entry screen MUST accept exactly six digits.
- **FR-044**: The dashboard MUST call the platform's real code-request and code-verify endpoints. It
  MUST NOT submit a phone number as an email or a code as a password.
- **FR-045**: The dashboard MUST support exactly three roles for sign-in: SUPER_ADMIN,
  FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN. A genuine session for any other role MUST be refused
  at the dashboard with a generic "this account cannot use the dashboard" message, before any
  session is established.
- **FR-046**: Each administrator role MUST land on its own home screen after sign-in; a role MUST NOT
  fall through to another role's surface.
- **FR-047**: The dashboard MUST present the resend timer, the "change number" affordance, and the
  request/blocked refusals returned by the platform, using the platform's stated retry time rather
  than a locally invented one.
- **FR-048**: The dashboard MUST present the challenge required by FR-023 when the platform demands
  one, and MUST NOT allow the flow to proceed without it.
- **FR-049**: The demo role picker, any hard-coded or placeholder credential, and any path that
  accepts a placeholder credential as a real session MUST NOT exist in the dashboard or the
  platform.
- **FR-050**: Every dashboard route that renders real data or performs a real action MUST be guarded
  by a session check and a role check that both run before any data for that route is requested.
- **FR-051**: Route guards MUST deny in both directions — no administrator role reaches a surface
  outside its remit.
- **FR-052**: All screens introduced or rebuilt by this feature MUST be fully bilingual
  Arabic (default) / English with correct right-to-left layout, consistent with the dashboard's
  established approach.
- **FR-053**: Sign-in, session-ended and error messages MUST be phrased for a non-technical
  administrator and MUST NOT expose internal error codes, stack traces, or which internal check
  failed.

#### F. Session lifecycle in the dashboard

- **FR-054**: When a platform request is refused because the access credential has expired, the
  dashboard MUST attempt a silent renewal and, on success, retry the original request transparently.
- **FR-055**: Concurrent requests that all encounter an expired credential MUST trigger exactly one
  renewal; the others MUST wait for and reuse its result.
- **FR-056**: A renewal that fails for any reason MUST end the dashboard session and return the
  administrator to sign-in; the dashboard MUST NOT retry indefinitely and MUST NOT leave a blank or
  broken screen.
- **FR-057**: The dashboard MUST distinguish an authentication failure (renew, or sign out) from an
  authorization-boundary refusal (surface it; never renew, never sign out).
- **FR-058**: Signing out MUST end the session on the platform, not only in the browser; the renewal
  credential held beforehand MUST be refused afterward.
- **FR-059**: The dashboard MUST detect a platform-ended session within one renewal cycle of the next
  platform contact, return the administrator to sign-in, and state the platform's reported reason —
  including the new device-limit reason.
- **FR-060**: On browser reload the dashboard MUST restore the session from stored credentials
  without repeating the code, provided the session is still valid on the platform.
- **FR-061**: The dashboard MUST re-derive identity, role, company and permissions from the platform
  on restore and on renewal — never solely from stored values.
- **FR-062**: The access credential MUST be held only in memory. The renewal credential MUST be
  stored in the browser and MUST NOT be exposed beyond what the platform's existing body-based
  renewal requires (see Assumptions).
- **FR-063**: The platform MUST continue to enforce its active-account and session-validity checks on
  every dashboard request and renewal; the dashboard is not a privileged client.

#### G. Email-and-password sign-in (preserved)

- **FR-064**: Email-and-password sign-in MUST continue to work for all administrator roles, returning
  the same session material and identity shape as code sign-in.
- **FR-065**: A failed email-and-password sign-in MUST return one generic message that does not
  reveal whether the email exists, the password was wrong, or the account is inactive.
- **FR-066**: A session obtained by password MUST be subject to the same concurrent-session rules as
  one obtained by code — one session model, two ways in.
- **FR-067**: The dashboard's role vocabulary MUST match the platform's roles exactly; any obsolete
  role name from before the administrator-role split MUST NOT exist.

#### H. Password recovery over SMS (preserved)

- **FR-068**: The dashboard MUST offer a "forgot password" path that collects the mobile number on
  the account and returns a neutral confirmation identical for registered numbers, unregistered
  numbers, and failed sends.
- **FR-069**: A recovery code MUST be six digits, delivered by SMS through the configured provider,
  with a stated expiry.
- **FR-070**: A wrong, expired, superseded, or attempt-locked recovery code MUST all produce the same
  refusal with no attempt count shown.
- **FR-071**: Recovery requests MUST be rate-limited per submitted number, applied before and
  regardless of whether an account is found.
- **FR-072**: Completing a recovery MUST end every session for that account (FR-036).
- **FR-073**: An SMS send failure during recovery MUST be recorded for operators and MUST NOT change
  what the administrator sees.
- **FR-074**: Recovery MUST reuse the platform's existing recovery primitives — code hashing, expiry,
  attempt lockout, single-use reset token, audit trail. No second recovery mechanism is introduced.

### Key Entities

- **Administrator session**: one signed-in administrator on one browser. Independently identified,
  independently endable, and attributable from any credential it issued. An account may hold several,
  up to the configured cap; the oldest is evicted beyond it. Carries enough to order sessions by age
  and to record why one ended.
- **Sign-in code record**: one issued sign-in code for one mobile number — the code in
  non-recoverable form, its expiry, its attempt count, and whether it has been consumed or
  superseded. Short-lived.
- **Sign-in abuse counters**: per-number request counts within a window, per-number failed-attempt
  accumulation across codes, active temporary blocks, and outstanding challenge requirements. All
  time-bounded and self-expiring.
- **Password-reset record**: the platform's existing short-lived recovery record — hashed code,
  expiry, attempt count, single-use reset token, consumed marker. Reused unchanged.
- **SMS send attempt**: one call to the provider — normalised recipient and outcome (provider
  message identifier on success, failure reason otherwise). The body is never persisted or logged.
- **SMS provider configuration**: provider selector, bearer token (secret), sender name, endpoint,
  supplied through existing settings and secret mechanisms.
- **Session-end reason**: the shared vocabulary describing why a session ended, mirrored identically
  by the platform, the dashboard and both mobile clients. Gains a device-limit value.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator of any of the three roles can go from opening the dashboard to their
  home screen using a mobile number and a code in under 90 seconds, including SMS delivery time.
- **SC-002**: With Taqnyat configured against a live account, a requested code is delivered as an SMS
  from sender "ciro" in at least 95% of attempts, allowing for carrier-side variance.
- **SC-003**: A production start-up with the Taqnyat bearer token or sender name missing fails to
  start and names the missing setting — 100% of the time.
- **SC-004**: A Taqnyat recipient-rejection or timeout is recorded as a failed send in 100% of
  simulated cases and is never reported as delivered.
- **SC-005**: No log line produced by any SMS-sending flow contains a message body or a code —
  verified by inspection across every such flow.
- **SC-006**: Code requests for an administrator number, a driver number, a client number, an
  inactive administrator, and an unregistered number return byte-for-byte identical status and body —
  100% of comparisons. **Response timing is deliberately not part of this criterion**: the platform
  does not claim a constant-time guarantee here, matching the posture its existing password-recovery
  flow already takes, and claiming one the implementation does not provide would be worse than
  stating the limit. A registered number does strictly more work (issue a record, attempt a send),
  so a determined attacker with clean timing data may still distinguish the cases; the mitigation is
  the rate limit and the block (SC-009), not indistinguishable latency.
- **SC-007**: No code is issued or sent for any non-administrator or unknown number — 0 occurrences
  across the test suite.
- **SC-008**: Guessing a six-digit code is bounded to the configured attempts per code and to the
  configured failed-attempt threshold per number, after which further attempts are refused — a
  scripted guessing run reaches 0 successful sign-ins.
- **SC-009**: A scripted burst of code requests for one number is refused after the configured limit,
  and a challenge is required thereafter — 100% of runs; the number of SMS messages sent never
  exceeds the configured limit.
- **SC-010**: An administrator can hold the configured number of simultaneous sessions and use all of
  them; signing in once more ends exactly one session — the oldest — and no others.
- **SC-011**: Signing out on one device leaves every other session of that account working — 100% of
  cases — and the signed-out session's renewal credential is refused 100% of the time.
- **SC-012**: A password reset or an account deactivation ends 100% of that account's sessions.
- **SC-013**: DRIVER and CLIENT session behaviour is unchanged: a second sign-in still displaces the
  first, verified by the existing suites passing unmodified.
- **SC-014**: An administrator's session survives **at least 20 consecutive access-credential
  renewals** with zero unexpected sign-outs and no visible interruption — the automated form of "can
  work a full day", chosen because it is reproducible in a test that advances the clock rather than
  an observation that takes one. The renewed credential must carry the same session identity each
  time; a renewal that silently opens a new session would pass a shorter check and fail this one.
- **SC-015**: Concurrent requests hitting an expired credential produce exactly one renewal, verified
  under a burst of at least 5 simultaneous requests.
- **SC-016**: An authorization-boundary refusal never causes a sign-out or a renewal — 0 occurrences
  across the test suite.
- **SC-017**: When the platform ends a session, the dashboard returns the administrator to sign-in
  with the correct stated reason within one renewal cycle (target: under 60 seconds) of the next
  platform contact — 100% of cases.
- **SC-018**: The "forgot password" outcome is identical for a registered number, an unregistered
  number, and a failed send — verified byte-for-byte.
- **SC-019**: Switching the SMS provider setting between the development stand-in and Taqnyat
  requires no change to any file outside configuration and secrets — verified by diff.
- **SC-020**: Neither mobile client's authentication or SMS behaviour changes as a result of this
  feature — their existing test suites remain green with no modification.

## Assumptions

- **Two repositories**: the platform lives in this repository; the dashboard lives at
  `E:\zeyad\web_dashboard_ciro_fuel`. This feature spans both; they meet at the authentication
  contract.
- **Superseding prior auth slices**: features 009 and 014 each contained a first-slice attempt at
  wiring one administrator role's sign-in. This feature replaces those with one shared
  implementation for all three roles.
- **Much of the dashboard side already exists and is correct**: the session store, the in-memory
  access credential plus stored renewal credential, the single-flight renewal interceptor, the
  sign-out path, the identity bootstrap, the three-role vocabulary, the route guards, and the
  session-end reason mirror are already implemented and already agree with the platform. This
  feature extends them; it does not rebuild them. The concrete dashboard work is the sign-in screens,
  the six-digit code entry, the challenge presentation, and the new device-limit reason.
- **Renewal-credential transport stays as it is**: the platform returns the renewal credential in the
  response body and the dashboard stores it, which is already implemented and already working. This
  feature does **not** move it to a cookie; doing so would change both mobile clients' renewal path,
  which this feature cannot test. The access credential remains in memory only.
- **"Remember me"**: the checkbox on the sign-in screen governs whether the session survives closing
  the browser (persistent storage of the renewal credential) or ends with it. Unchecked is the
  default.
- **A mobile number identifies at most one account** for sign-in purposes. Where the data does not
  already guarantee this, code sign-in is refused for an ambiguous number rather than guessing.
- **Setting names are the platform's existing ones.** The deployment's stated values map on as:
  sender name → the existing sender-name setting (value "ciro"); bearer token → the existing SMS key
  setting; endpoint → the existing endpoint setting (`https://api.taqnyat.sa/v1/messages`); and the
  provider selector is set to the Taqnyat value. No new secret, IAM binding, or manifest entry is
  created.
- **Taqnyat request shape** is as documented: `POST` to the endpoint with `Authorization: Bearer
  <token>`, JSON body `{ recipients: [<number>], body: <text>, sender: "ciro" }`, recipients as bare
  international numbers. A `2xx` is not proof of delivery — a rejected recipient is reported inside
  the response payload and counts as a failure.
- **A Taqnyat test account with the "ciro" sender approved** is available for verifying the live
  path; where it is not, the send path is verified against a simulated provider and the live check is
  a pre-launch step.
- **The challenge mechanism** (FR-023) is a third-party CAPTCHA or a self-hosted proof-of-work; which
  one is a planning decision. It is required only after repeated refusals, never on a first request,
  so ordinary sign-in is unaffected.
- **Defaults for anything unstated**: code expiry, attempt limits, request windows and the session
  cap take the platform's existing configured defaults where equivalents exist (5-minute expiry, 5
  attempts, 3 requests per 15 minutes) and a default of 3 for the session cap.
- **The dashboard does not poll while a browser tab is hidden** — existing behaviour, unchanged.

## Dependencies

- The dashboard repository at `E:\zeyad\web_dashboard_ciro_fuel` must be available to modify.
- A Taqnyat account with the "ciro" sender name approved, and a bearer token, for live verification
  (otherwise deferred to pre-launch).
- The platform's existing secret-management mechanism to hold the bearer token.
- A challenge/CAPTCHA provider or a self-hosted equivalent for FR-023.
- The platform's existing Redis-backed counters for the abuse controls.
- No dependency on any change to either mobile client.

## Out of Scope

- Removing password sign-in, or removing passwords from administrator accounts.
- Email-based recovery, security questions, and operator-assisted reset flows.
- A screen for administrators to view or end their own other sessions.
- Delivery-receipt callbacks from Taqnyat; "sent" means a clean provider acceptance with no recipient
  rejection.
- Alerting or dashboards on SMS failure rates; ensuring failures are logged is in scope, building an
  alert is not.
- Any change to DRIVER or CLIENT authentication, session behaviour, or mobile client code.
- Two-factor authentication on top of password sign-in.
