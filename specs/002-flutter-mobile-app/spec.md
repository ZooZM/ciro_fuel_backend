# Feature Specification: Client & Driver Mobile Application

**Feature Branch**: `002-flutter-mobile-app`

**Created**: 2026-07-20

**Status**: Draft

**Input**: User description: "Initialize the Flutter mobile application for the Client and Driver personas of the fuel delivery platform. Clean Architecture + MVVM with Bloc/Cubit state management, Dio networking with automatic JWT injection and refresh, and a Socket.io client wired to the backend `/tracking` namespace for live driver location. Deliver the folder blueprint and prove backend integration with the core networking (interceptors) and WebSocket client. Keep the code clean and self-documenting — no over-commenting."

## Clarifications

### Session 2026-07-20

- Q: How should the DRIVER app stream location relative to app state? → A: Foreground plus active-delivery background — location streams in the foreground and continues while the app is backgrounded only during an active delivery, and stops when idle.
- Q: Which map provider renders live tracking? → A: Google Maps (`google_maps_flutter`).
- Q: How does the CLIENT complete payment in-app, given webhook confirmation? → A: Native gateway SDK — the Sadad/Mada native SDK provides an in-app payment form; the app initiates payment and observes the webhook-driven order state for confirmation.
- Q: What session-security posture ships in v1 for the persisted login? → A: Secure device storage only (Keychain/Keystore); no in-app biometric/PIN app-lock in v1 (deferred as a fast-follow).

## User Scenarios & Testing *(mandatory)*

The mobile app serves two field-facing personas of the existing multi-tenant fuel delivery platform: **CLIENT** (a fuel-station operator who orders fuel) and **DRIVER** (who fulfills deliveries). Both authenticate against the same backend, are scoped to their company by the token they receive, and interact with the same order lifecycle from opposite ends.

### User Story 1 - Secure sign-in and uninterrupted session (Priority: P1)

A CLIENT or DRIVER opens the app, signs in with phone number and password, and remains signed in across app restarts without re-entering credentials. When their short-lived access token expires mid-use, the app renews it silently in the background so no action fails or interrupts them; only a genuinely invalid session returns them to the login screen.

**Why this priority**: Every other capability is gated on an authenticated, correctly-scoped session. Without silent renewal, users are ejected mid-delivery — unacceptable for a driver on the road. This is the foundational MVP slice.

**Independent Test**: Sign in as each role, force-close and reopen the app (session persists), let the access token expire while the app is open and perform any authenticated action (it succeeds transparently), then revoke the session server-side and confirm the app returns to login exactly once without a retry storm.

**Acceptance Scenarios**:

1. **Given** a registered, active CLIENT account, **When** they submit valid credentials, **Then** they land on the CLIENT home scoped to their company and their session is retained after an app restart.
2. **Given** a signed-in user whose access token has just expired, **When** they trigger any authenticated request, **Then** the app renews the token behind the scenes and the original action completes without a visible error.
3. **Given** a user whose refresh credential is no longer valid (revoked, deactivated account, or suspended company), **When** a renewal is attempted, **Then** the app clears the local session and returns them to the login screen with a single, clear message.
4. **Given** a suspended company or deactivated account, **When** the user attempts to sign in, **Then** they receive a non-enumerating failure message and are not admitted.

---

### User Story 2 - Client orders fuel, pays, and follows it to delivery (Priority: P1)

A CLIENT creates a fuel order (fuel type and quantity), waits for the company to set the final price and approve, pays within the allowed window, then watches the assigned driver approach in real time. On arrival the CLIENT receives a one-time arrival code and, at unloading completion, a one-time delivery code, sharing each with the driver to prove the handoff. The order advances through its states live on their screen until it is delivered.

**Why this priority**: This is the revenue-generating journey and the reason the CLIENT persona exists. It exercises the full order state machine, the payment window, live tracking, and the two-step proof-of-delivery from the customer side.

**Independent Test**: As a CLIENT, place an order, receive an approved final price, complete payment before the window closes, observe the order move through its live states with the driver's position updating on a map, and surface both one-time codes at the correct moments.

**Acceptance Scenarios**:

1. **Given** an authenticated CLIENT, **When** they submit a valid fuel type and quantity, **Then** the order is created in the pending-approval state and appears in their order list.
2. **Given** an order the company has priced and approved, **When** the CLIENT views it, **Then** the final price and a payment action are shown with the remaining time in the payment window.
3. **Given** an approved order awaiting payment, **When** the CLIENT does not pay before the window closes, **Then** the app reflects the reverted state and communicates that payment lapsed.
4. **Given** a paid order in transit, **When** the driver moves, **Then** the CLIENT sees the driver's location update on a map within seconds and the order status change live as it happens.
5. **Given** the driver has arrived, **When** the arrival code is issued to the CLIENT, **Then** it is shown only to that CLIENT and never exposed to the driver's app.

---

### User Story 3 - Driver executes an assigned delivery end-to-end (Priority: P1)

A DRIVER, once dispatched to an order, sees the delivery job with pickup/drop details, marks themselves en route, and streams their location while driving — automatically, without draining the battery through constant updates. On arrival they collect and verify the CLIENT's arrival code to begin unloading, then verify the delivery code to close the job. Repeated wrong codes are refused and rate-limited; the driver's app never displays the codes themselves.

**Why this priority**: The delivery cannot complete without the driver side of the two-step OTP and the location stream. It is the mirror of US2 and equally essential to a working MVP.

**Independent Test**: As a DRIVER assigned to an order, go en route, confirm location frames are emitted only when moved beyond the displacement threshold or on the periodic heartbeat, enter a correct arrival code to advance to unloading, enter a correct delivery code to complete, and confirm wrong codes are rejected and throttled after repeated attempts.

**Acceptance Scenarios**:

1. **Given** a DRIVER with an active assigned order, **When** they open the app, **Then** the assigned delivery is presented with the destination and required fuel details.
2. **Given** a DRIVER in transit, **When** they move more than the displacement threshold or the heartbeat interval elapses, **Then** a location update is sent; smaller movements within the interval are not sent.
3. **Given** a DRIVER at the destination, **When** they enter the CLIENT's arrival code correctly, **Then** the order advances to unloading; an incorrect code is rejected.
4. **Given** repeated incorrect code entries, **When** the throttling ceiling is reached, **Then** further attempts are refused for the cooldown period with a clear message.
5. **Given** a completed unloading, **When** the DRIVER enters the correct delivery code, **Then** the order is marked delivered and the driver is freed for the next dispatch.

---

### User Story 4 - Real-time tracking and in-app notifications (Priority: P2)

While an order is in transit, the CLIENT (and any authorized watcher) receives continuous location and status updates over a live connection, and both personas receive in-app notifications for the events that matter to them — final price ready, payment lapsed, no available driver, delivery completed. The live connection recovers automatically after transient network loss and reflects stale data when heartbeats stop.

**Why this priority**: It sharpens US2/US3 into a responsive experience but the core flows can be demonstrated with polling fallbacks, so it ranks below the two primary journeys.

**Independent Test**: With an order in transit, drop and restore connectivity and confirm the live connection re-establishes and resumes updates; stop the driver's heartbeat and confirm the watcher's view marks the position as stale; trigger a notifiable backend event and confirm the correct persona receives an in-app notification.

**Acceptance Scenarios**:

1. **Given** an in-transit order being watched, **When** the network drops briefly and recovers, **Then** the live connection reconnects automatically and updates resume without a manual refresh.
2. **Given** a watched order, **When** the driver's heartbeats stop arriving, **Then** the watcher's view indicates the location is stale rather than showing it as current.
3. **Given** a notifiable event for a persona, **When** it occurs, **Then** the corresponding user receives an in-app notification referencing the relevant order.

---

### Edge Cases

- **Expired access token during a live socket session**: the socket context is fixed at handshake; on token expiry the app must renew and re-establish the tracking connection without losing the watched order.
- **Simultaneous 401 responses** from several in-flight requests must trigger only one token renewal, with the others queued and retried once — never a renewal stampede.
- **Cross-tenant or non-existent order** access returns an indistinguishable "not found"; the app must present it uniformly and never leak existence.
- **Watching an order that is not in a trackable state** (not in transit/unloading) is refused; the app must handle the refusal gracefully rather than showing an empty map.
- **Background/foreground transitions on mobile**: the location stream and socket must pause and resume correctly as the OS suspends the app, respecting platform background-execution limits.
- **Payment window elapses while the CLIENT is on the payment screen**: the app must reflect the reverted order state and disable the stale payment action.
- **One-time codes must never appear in the wrong persona's app**, in logs, or in analytics.
- **Offline launch**: with no connectivity, a persisted session should still open the app to a meaningful state rather than a crash or blank screen.

## Requirements *(mandatory)*

### Functional Requirements

**Authentication & session**
- **FR-001**: The app MUST allow a CLIENT or DRIVER to sign in with phone number and password and receive a role- and company-scoped session.
- **FR-002**: The app MUST persist the session in secure device storage (platform Keychain/Keystore) so the user remains signed in across app restarts; v1 adds no in-app biometric/PIN app-lock on top of that (deferred).
- **FR-003**: The app MUST attach the current access credential to every authenticated backend request automatically, without per-screen handling.
- **FR-004**: The app MUST detect an expired access credential, renew it once in the background, and transparently retry the originally failed request(s).
- **FR-005**: The app MUST serialize concurrent renewals so multiple simultaneous failures cause exactly one renewal, then replay the queued requests.
- **FR-006**: The app MUST clear the local session and return to sign-in when renewal is not possible (invalid/revoked credential, deactivated account, suspended company), showing a single non-technical message.
- **FR-007**: The app MUST present sign-in failures without revealing whether the account exists or why it was refused.

**Order lifecycle (CLIENT)**
- **FR-008**: A CLIENT MUST be able to create a fuel order specifying fuel type and quantity, and see it enter the pending-approval state.
- **FR-009**: A CLIENT MUST be able to view their orders and each order's current lifecycle state.
- **FR-010**: A CLIENT MUST be able to see the company-set final price and pay for an approved order through the in-app native payment gateway, seeing the time remaining in the payment window; payment confirmation is reflected via the backend webhook-driven order state, not asserted by the app itself.
- **FR-011**: The app MUST reflect order state changes (approval, payment lapse, in transit, unloading, delivered, rejected, cancelled) as they occur.
- **FR-012**: The app MUST display each one-time code (arrival, delivery) only to the CLIENT it is issued to, at the correct lifecycle moment, and never expose it to the driver side.

**Delivery execution (DRIVER)**
- **FR-013**: A DRIVER MUST be able to view the order currently assigned to them with the details needed to fulfill it.
- **FR-014**: A DRIVER MUST be able to stream their live location while fulfilling an order, including while the app is backgrounded during an active delivery; location streaming MUST stop when there is no active delivery.
- **FR-015**: The app MUST only send a location update when displacement exceeds the movement threshold OR the heartbeat interval has elapsed, avoiding continuous polling.
- **FR-016**: A DRIVER MUST be able to enter and verify the CLIENT's arrival code to advance the order to unloading, and the delivery code to complete it.
- **FR-017**: The app MUST surface rejection and throttling of incorrect code attempts clearly, and MUST never display the codes themselves to the driver.

**Real-time tracking & notifications**
- **FR-018**: The app MUST establish an authenticated live connection to the backend tracking channel and subscribe a CLIENT/watcher to a specific order's updates.
- **FR-019**: A watcher's map MUST reflect the driver's reported position within seconds of it being sent.
- **FR-020**: The app MUST automatically re-establish the live connection after transient network loss and resume updates, and MUST re-authenticate the connection after a token renewal.
- **FR-021**: The app MUST indicate stale location data when heartbeats stop rather than presenting an old position as current.
- **FR-022**: The app MUST deliver in-app notifications to the correct persona for notifiable events (final price ready, payment lapsed, no eligible driver, delivery completed).

**Platform behavior & resilience**
- **FR-023**: The app MUST scope every action to the signed-in user's company and present cross-tenant/non-existent resources as an indistinguishable "not found."
- **FR-024**: During an active delivery the driver app MUST keep the location stream running across background/foreground transitions (requesting the appropriate "while-in-use / active-trip" background-location permission); outside an active delivery, and for the watcher's live connection, it MUST pause and resume cleanly within platform limits.
- **FR-025**: The app MUST present clear, user-friendly feedback for network failures, throttling, and validation errors without exposing internal error details.
- **FR-026**: The app MUST support both driver and client personas from a single installable build, presenting the appropriate experience based on the authenticated role.

### Key Entities *(include if feature involves data)*

- **Session**: The authenticated user's access credential, renewal credential, and derived identity (user id, role, company) held on the device; drives request authorization and the live connection handshake.
- **User (persona)**: The signed-in CLIENT or DRIVER, including role and company scope, determining which experience and actions are available.
- **Order**: The unit of work both personas act on — fuel type, quantity, final price, current lifecycle state, payment window, and associated delivery — mirrored from the backend and updated live.
- **Location update**: A driver-reported position (coordinates + timestamp) streamed while in transit and consumed by watchers, with a received-at marker used to detect staleness.
- **One-time code**: A short-lived arrival or delivery verification code, visible only to the issuing CLIENT and entered by the driver to advance the order.
- **Notification**: An in-app message targeted to a persona for a lifecycle or dispatch event, referencing the related order.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A returning user reaches their role home in under 3 seconds from app launch on a persisted session, with no re-login required.
- **SC-002**: When an access credential expires mid-session, 100% of the affected user actions complete successfully via silent renewal, with zero visible errors and no more than one renewal per expiry event.
- **SC-003**: A watcher sees the driver's updated position on the map within 10 seconds of the driver reporting it.
- **SC-004**: While in transit, the driver app sends no more than one location update per movement-threshold-or-heartbeat event, keeping updates aligned to the platform's displacement/heartbeat policy (no per-second streaming).
- **SC-005**: A CLIENT can complete the create-order-to-payment flow in under 3 minutes given an approved price.
- **SC-006**: The two-step code verification succeeds on first correct entry in at least 95% of deliveries, and repeated wrong entries are refused after the throttling ceiling 100% of the time.
- **SC-007**: The live tracking connection automatically recovers from a transient network drop within 15 seconds in at least 95% of occurrences without user intervention.
- **SC-008**: One-time codes appear in the wrong persona's app, logs, or analytics in 0% of deliveries.

## Assumptions

- The backend defined in `specs/001-fuel-delivery-platform/` is the sole integration target; the app introduces no new server-side capability and consumes the existing REST contract (`/api/v1`) and the `/tracking` Socket.io namespace as specified in that feature's contracts.
- Per the project constitution and constraints, the app is built with **Flutter** (single codebase targeting iOS and Android), **Clean Architecture (data/domain/presentation) with MVVM**, and **Bloc/Cubit** state management; networking uses **Dio** with interceptors, and the live connection uses a **Socket.io** client. These are inherited implementation constraints, not open choices.
- Both personas ship in one installable build; the authenticated role selects the experience (no separate driver/client binaries in v1).
- Map rendering uses **Google Maps** (`google_maps_flutter`); this feature requires displaying a live position on the map, not authoring a routing engine. Turn-by-turn navigation remains a future concern.
- Payment uses the **Sadad/Mada native payment SDK** in-app: the app presents the native payment form and initiates payment, then treats the backend webhook-driven order state as the source of truth for confirmation rather than asserting success from the client.
- v1 relies on secure device storage for the session with **no in-app biometric/PIN app-lock** (fast-follow). Localization, theming, and push (out-of-app) notifications are future concerns; v1 covers in-app notifications over the live connection.
- Device clocks are reasonably accurate; staleness and payment-window countdowns rely primarily on backend-provided timestamps.
- "Silent renewal," "displacement threshold," "heartbeat interval," "payment window," and throttling limits take their exact values from the backend contracts and are not redefined by the app.

**Terminology (glossary for cross-artifact consistency)**: "one-time code" ≡ **OTP** (arrival OTP, delivery OTP); "live connection" / "tracking channel" ≡ the backend **`/tracking` Socket.io namespace**; "final price" ≡ the company-approved `finalPrice` (distinct from the pre-approval `estimatedPrice`). Design artifacts (data-model, contracts, tasks) use the right-hand terms.
