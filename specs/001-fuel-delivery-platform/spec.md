# Feature Specification: Multi-Tenant B2B Fuel Delivery Logistics Platform

**Feature Branch**: `001-fuel-delivery-platform`

**Created**: 2026-07-19

**Status**: Draft

**Input**: User description: "Architect and build a secure, Multi-Tenant SaaS B2B Fuel Delivery Logistics Platform. Fuel stations (clients) request fuel deliveries, company admins approve them, the system dispatches the nearest capable driver, payment is confirmed through national payment channels (Sadad/Mada), and delivery is tracked in real time. Each fuel-logistics company operates as an isolated tenant with strict data separation, four user roles (platform owner, company admin, client, driver), a strict order lifecycle, proximity-based smart dispatch, resource-efficient live tracking, and protection against double-booking of drivers."

## Clarifications

### Session 2026-07-19

- Q: How is the payable amount for an order determined? → A: Hybrid pricing — the Company Admin maintains a base price per fuel type in company settings; the system auto-calculates and shows an "Estimated Price" to the client at order creation; during Pending Approval the admin may adjust it (delivery fees, market changes) to set the binding "Final Price"; on approval the client is notified of the Final Price and confirms it by completing payment.
- Q: Must the driver accept an assignment, or is assignment automatic? → A: Auto-assign — the nearest eligible driver is assigned immediately with no acceptance step; the driver is notified of the assignment.
- Q: What happens if the client never pays an order in Pending Payment? → A: 30-minute payment deadline — on expiry the assigned driver is released back to the available pool, the order reverts to Approved, and both the client and company admin are notified; re-dispatch happens when the client or admin explicitly re-initiates it (not automatically, to avoid re-locking drivers).
- Q: What proof of delivery is required? → A: Two-step OTP verification with a new Unloading state: In Transit → (arrival OTP) → Unloading → (delivery OTP) → Delivered. On physical arrival the driver signals arrival; the system generates a single-use Arrival OTP revealed ONLY to the client, which the driver must obtain from station staff and submit to enter Unloading. When unloading finishes, a second single-use Delivery OTP is generated (again revealed only to the client) and must be submitted by the driver to reach Delivered. OTPs are securely stored, invalidated after use, and never exposed to the driver by the system.
- Q (operational review): What if the client cannot produce the OTP (hardware failure)? → A: The Company Admin may force-complete the delivery, bypassing OTP verification; the order moves to Delivered with an explicit, permanently visible manual-override flag (and reason) in its status history.
- Q (operational review): How are unreachable drivers kept out of dispatch? → A: The system tracks each driver's last-seen signal; a driver silent for more than 6 minutes (two missed heartbeats) is automatically marked Offline and excluded from dispatch until they reconnect.
- Q (operational review): Does dispatch match fuel type? → A: Yes — a driver's truck carries a set of supported fuel types (recorded with the truck's capacity on the driver profile), and dispatch excludes trucks that do not support the ordered fuel type.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Client Orders Fuel Through the Full Delivery Lifecycle (Priority: P1)

A fuel station operator (Client) signs in, creates a fuel delivery order specifying fuel type, quantity, and delivery location. The order awaits approval by the logistics company's admin. Once approved, the system assigns a driver, the client completes payment through a supported national payment channel, the driver delivers the fuel, and the order is marked delivered.

**Why this priority**: This is the core revenue-generating flow of the entire platform. Without a working order lifecycle from request to delivery, no other capability has value.

**Independent Test**: Can be fully tested by creating an order as a client, approving it as a company admin, assigning a driver, simulating a payment confirmation, and progressing the order to delivered — verifying the order passes through every stage in the correct sequence and no stage can be skipped.

**Acceptance Scenarios**:

1. **Given** a signed-in client, **When** they submit a fuel order with quantity and delivery location, **Then** the order is created in "Pending Approval" status showing an Estimated Price derived from the company's base price for that fuel type, and is visible to their company's admin.
2. **Given** an order in "Pending Approval", **When** the company admin reviews it — optionally adjusting the Estimated Price to set the Final Price — and approves it, **Then** the order moves to "Approved" with the Final Price recorded, the client is notified of the Final Price, and the order becomes eligible for driver assignment.
3. **Given** an approved order with an assigned driver, **When** payment confirmation is received, **Then** the order moves to "In Transit".
4. **Given** an order in "In Transit", **When** the driver signals arrival at the station, **Then** the system generates a single-use Arrival OTP visible only to the client, and the order stays "In Transit" until the driver submits that OTP correctly, upon which it moves to "Unloading".
5. **Given** an order in "Unloading", **When** unloading finishes and the driver submits the single-use Delivery OTP (visible only to the client), **Then** the order is marked "Delivered" and the driver becomes available for new assignments.
6. **Given** an order in any status, **When** any actor attempts a status change that skips a stage (e.g., "Pending Approval" directly to "In Transit", or "In Transit" directly to "Delivered"), **Then** the change is rejected and the order remains in its current status — the sole exception being the audited Company Admin force-complete (FR-025), which may close an order from "In Transit" or "Unloading" with a permanently flagged override.

---

### User Story 2 - Tenant Data Isolation and Role-Based Access (Priority: P1)

Each fuel-logistics company operates in its own isolated workspace. A company admin manages only their own company's users, drivers, and orders. Clients and drivers see only data belonging to their company. The platform owner is the only actor with cross-company visibility for platform administration.

**Why this priority**: This is a multi-tenant B2B platform — a single data leak between competing companies is a business-ending event. Isolation must exist before any tenant onboards.

**Independent Test**: Can be tested by creating two companies with their own admins, clients, and orders, then verifying that no user of company A can view, list, modify, or infer the existence of any record belonging to company B through any interface.

**Acceptance Scenarios**:

1. **Given** users in two different companies, **When** a company admin of company A lists orders, **Then** only company A's orders are returned — never company B's.
2. **Given** a company admin of company A who knows the identifier of a company B record, **When** they request that record directly, **Then** access is denied without confirming the record exists.
3. **Given** the platform owner, **When** they browse companies and orders, **Then** they can view data across all companies.
4. **Given** a client, **When** they attempt an admin-only action (e.g., approving an order or managing users), **Then** the action is denied.
5. **Given** a driver, **When** they access the system, **Then** they see only orders assigned to them and their own profile.

---

### User Story 3 - Smart Driver Dispatch (Priority: P2)

When an order is approved, the system finds the most suitable driver: it excludes drivers who are inactive or already on a job and trucks that cannot carry the ordered quantity, then selects from the remaining candidates by closest geographic proximity to the delivery location.

**Why this priority**: Manual dispatch works as a stopgap, but automated proximity-and-capacity matching is the platform's key operational differentiator and directly drives delivery speed.

**Independent Test**: Can be tested by seeding several drivers with varying availability, truck capacities, and locations, approving an order, and verifying the chosen driver is the nearest one that is active, free, and has sufficient capacity.

**Acceptance Scenarios**:

1. **Given** multiple available drivers with sufficient truck capacity, **When** dispatch runs for an approved order, **Then** the driver nearest to the delivery location is assigned.
2. **Given** a nearby driver whose truck capacity is below the ordered quantity, **When** dispatch runs, **Then** that driver is skipped in favor of the nearest driver with sufficient capacity.
3. **Given** a nearby driver who is inactive or already on an active delivery, **When** dispatch runs, **Then** that driver is not considered.
4. **Given** no eligible driver exists, **When** dispatch runs, **Then** the order remains in "Approved" status and the company admin is informed that no driver is available.
5. **Given** two orders approved at nearly the same moment with only one eligible driver, **When** dispatch runs for both, **Then** the driver is assigned to exactly one order — never both.

---

### User Story 4 - Real-Time Delivery Tracking (Priority: P2)

While a delivery is in transit, the client and company admin can watch the driver's position update live on a map. Position updates are sent only when the driver has moved a meaningful distance or after a periodic heartbeat, keeping battery and network usage low.

**Why this priority**: Live visibility builds client trust and reduces "where is my fuel?" support load, but deliveries can complete without it.

**Independent Test**: Can be tested by simulating a driver moving along a route and verifying watchers receive location updates on meaningful movement (more than 50 meters) or at the heartbeat interval (every 3 minutes), and receive nothing in between.

**Acceptance Scenarios**:

1. **Given** an order in transit, **When** the driver moves more than 50 meters, **Then** watching users receive the updated position.
2. **Given** an order in transit with a stationary driver, **When** 3 minutes elapse without movement, **Then** a heartbeat position update is delivered so watchers know the driver is still connected.
3. **Given** a driver who moves less than 50 meters between heartbeats, **When** watchers observe the feed, **Then** no intermediate updates are delivered.
4. **Given** a user from a different company, **When** they attempt to watch a delivery, **Then** they are denied access to the tracking feed.

---

### User Story 5 - Platform & Company Onboarding (Priority: P3)

The platform owner registers a new fuel-logistics company, uploading its commercial registration document. The company admin then sets up their workspace: adding clients (fuel stations with locations), drivers, and trucks with capacities, including profile pictures and required documents.

**Why this priority**: Onboarding is required for real-world operation but can initially be performed with minimal tooling; the delivery and isolation flows above deliver the core value.

**Independent Test**: Can be tested by registering a company with its commercial register document, then, as its admin, creating client and driver accounts with uploaded files, and verifying each new user can sign in with the correct role and company association.

**Acceptance Scenarios**:

1. **Given** the platform owner, **When** they register a new company with its commercial registration document, **Then** the company workspace is created and its admin can sign in.
2. **Given** a company admin, **When** they create a client account with the station's location, **Then** the client can sign in and create orders for that company only.
3. **Given** a company admin, **When** they register a driver with a truck and its maximum capacity, **Then** the driver becomes eligible for dispatch once active.
4. **Given** any user uploading a document or profile picture, **When** the upload completes, **Then** the file is stored and retrievable only by authorized users of the same company (or the platform owner).

---

### Edge Cases

- What happens when payment confirmation arrives twice for the same order (duplicate webhook)? The second confirmation must be ignored without corrupting the order state.
- What happens when payment confirmation arrives for an order that is not awaiting payment (including after a 30-minute payment timeout)? It must be rejected and logged, and any actual charge flagged for manual reconciliation.
- What happens when the payment deadline expires while the client is mid-checkout? The driver is released and the order reverts to Approved; the client is informed that re-dispatch must be re-initiated before paying again.
- What happens when two dispatch attempts try to book the same driver simultaneously? Exactly one succeeds; the other must select a different driver or report none available.
- What happens when a driver loses connectivity mid-delivery? The order stays in transit; watchers see the last known position and the time it was received; the missing heartbeat makes staleness visible. After 6 silent minutes the driver is marked Offline (excluded from any future dispatch) without disturbing the in-progress order.
- What happens when a driver's device dies while they are idle? They are marked Offline within 6 minutes and no longer receive assignments until they reconnect.
- What happens when a driver account is deactivated while on an active delivery? The active delivery completes or is cancelled by the admin (driver re-assignment is out of scope for v1); the driver receives no new assignments.
- What happens when a client cancels an order? Cancellation is allowed before driver assignment (Pending Approval or Approved); afterwards, only the company admin may cancel — except that the client may decline the Final Price while the order awaits payment, which cancels it (FR-009).
- What happens when a client orders a fuel type the company has not priced? Order creation is rejected with a clear message telling the client to contact the company; no order is created until the admin configures a base price for that fuel type.
- What happens when the company admin rejects an order? The order reaches a terminal rejected state and the client is informed.
- What happens when a driver repeatedly submits wrong OTPs? Attempts are throttled and logged; the order state does not change, and the company admin can see the failed attempts.
- What happens when the client cannot retrieve the OTP at handover (app/device issue)? The order remains in its current state until the Company Admin intervenes: the admin may force-complete the delivery (FR-025), which is permanently flagged as a manual override with a reason in the order's status history.
- What happens if the driver signals arrival twice? The existing unused Arrival OTP remains valid; no duplicate OTP is issued while one is active.
- What happens when an uploaded file is of a disallowed type or excessive size? The upload is refused with a clear message and no partial file is stored.
- What happens when a user's account is deleted or role changes while they hold an active session? Subsequent actions reflect the new permissions, not the stale ones.
- What happens under a burst of repeated requests from one source? The system throttles the source without degrading service for other tenants.

## Requirements *(mandatory)*

### Functional Requirements

**Tenancy & Access Control**

- **FR-001**: System MUST associate every company-owned record (users, orders, trucks, files, locations) with exactly one company.
- **FR-002**: System MUST automatically restrict every data read and write to the acting user's company, without relying on per-feature developer discipline; cross-company access attempts MUST be denied without revealing whether the target exists.
- **FR-003**: System MUST support exactly four roles — Platform Owner, Company Admin, Client, and Driver — each limited to their permitted actions; the Platform Owner is the only role exempt from company scoping.
- **FR-004**: System MUST authenticate all users before any data access and identify each request's user, role, and company from verified credentials.
- **FR-005**: System MUST throttle excessive repeated requests per source to protect availability for all tenants.

**Order Lifecycle**

- **FR-006**: System MUST enforce the order lifecycle: Pending Approval → Approved → Assigned to Driver → Pending Payment → In Transit → Unloading → Delivered; any transition outside this sequence MUST be rejected, with exactly three sanctioned exceptions: the payment-deadline reversion (Pending Payment → Approved, FR-015a), terminal exits to Rejected/Cancelled per FR-008/FR-009, and the audited Company Admin force-complete (In Transit/Unloading → Delivered, FR-025).
- **FR-007**: Clients MUST be able to create orders with fuel type, quantity, and delivery location; new orders start in Pending Approval.
- **FR-008**: Company Admins MUST be able to approve or reject orders belonging to their company only; approval fixes the order's Final Price.
- **FR-008a**: Company Admins MUST be able to maintain a base price per fuel type in their company settings; the system MUST display an auto-calculated Estimated Price (base price × quantity) to the client at order creation. Order creation for a fuel type without a configured base price MUST be rejected with a clear message.
- **FR-008b**: During approval, the Company Admin MAY adjust the amount (e.g., delivery fees, market changes) to set the Final Price; if unadjusted, the Estimated Price becomes the Final Price. The client MUST be notified of the Final Price upon approval and confirms it by completing payment.
- **FR-009**: Clients MUST be able to cancel their own order before driver assignment (i.e., while Pending Approval or Approved). After assignment, only the Company Admin may cancel — with one exception: while the order awaits payment, the Client MAY decline the Final Price, which cancels the order and releases the assigned driver.
- **FR-010**: System MUST record the actor and timestamp of every order status change.

**Dispatch**

- **FR-011**: System MUST select drivers for approved orders by excluding inactive drivers, offline drivers (FR-024), drivers already on an active delivery, trucks whose maximum capacity is below the ordered quantity, and trucks that do not support the ordered fuel type, then choosing the nearest remaining driver to the delivery location. Assignment is immediate and requires no driver acceptance; the driver MUST be notified of the assignment.
- **FR-012**: System MUST guarantee a driver can hold at most one active delivery at a time, even under simultaneous dispatch attempts.
- **FR-013**: When no eligible driver exists, System MUST keep the order in Approved status and notify the Company Admin.

**Payment**

- **FR-014**: System MUST move an order to In Transit only after receiving a verified payment confirmation from the supported national payment channels (Sadad/Mada).
- **FR-015**: System MUST process each payment confirmation exactly once; duplicate or out-of-sequence confirmations MUST NOT alter order state and MUST be logged.
- **FR-015a**: If payment is not confirmed within 30 minutes of entering Pending Payment, System MUST release the assigned driver back to the available pool, revert the order to Approved, and notify both the client and the Company Admin. Re-dispatch after a payment timeout MUST be explicitly re-initiated by the client or Company Admin (never automatic); after two consecutive payment timeouts on the same order, only the Company Admin may re-initiate dispatch (bounds the assign→timeout loop). A payment confirmation arriving after the deadline MUST be treated as out-of-sequence per FR-015.

**Tracking**

- **FR-016**: System MUST deliver live driver positions to the order's client and company admin while the order is in transit, updating on movement greater than 50 meters or on a heartbeat every 3 minutes — never by continuous per-second streaming.
- **FR-017**: System MUST restrict each tracking feed to authorized users of the order's company (plus the Platform Owner).
- **FR-024**: System MUST record a last-seen timestamp for every driver signal (connection, location update, heartbeat) and MUST automatically mark drivers Offline when silent for more than 6 minutes; Offline drivers are excluded from dispatch (FR-011) and return to eligibility automatically on their next signal. Offline detection MUST NOT alter the state of an in-progress delivery.

**Proof of Delivery (Two-Step OTP)**

- **FR-021**: When the driver signals physical arrival at the delivery location, System MUST generate a secure single-use Arrival OTP and reveal it ONLY to the order's client; the order moves from In Transit to Unloading only when the driver submits the correct Arrival OTP.
- **FR-022**: When unloading completes, System MUST generate a secure single-use Delivery OTP revealed ONLY to the order's client; the order moves from Unloading to Delivered only when the driver submits the correct Delivery OTP.
- **FR-023**: Each OTP MUST be securely stored, invalidated immediately after successful use, and MUST NEVER be exposed to the driver through any system response; repeated incorrect OTP submissions MUST be throttled and logged.
- **FR-025**: Company Admins MUST be able to force-complete a delivery stuck at either OTP step (emergency override for hardware/connectivity failure at the station): the order transitions directly to Delivered, the assigned driver is released, and the status history entry MUST carry a permanent manual-override flag with the admin's identity and a required reason. Drivers and Clients MUST NOT be able to trigger this override.

**Onboarding & Files**

- **FR-018**: Platform Owner MUST be able to register companies, including capturing the company's commercial registration document.
- **FR-019**: Company Admins MUST be able to create and deactivate client and driver accounts, and register trucks with a maximum carrying capacity, within their own company.
- **FR-020**: System MUST accept file uploads (commercial registers, profile pictures) with type and size validation, and restrict file access to the owning company and the Platform Owner.

### Key Entities

- **Company**: A fuel-logistics tenant. Holds identity details, commercial registration document, and active/suspended status. The isolation boundary for all other data.
- **User**: A person acting in one of four roles. Clients carry a station location; Drivers carry availability status, online/offline presence with a last-seen timestamp, and current position. Every user except the Platform Owner belongs to exactly one Company.
- **Truck**: A delivery vehicle with a maximum fuel capacity and a set of supported fuel types, associated with a driver and a company; its capabilities are kept directly on the driver's profile so dispatch eligibility is evaluated in a single pass.
- **Order**: A fuel delivery request — fuel type, quantity, delivery location, Estimated Price (system-calculated at creation), Final Price (fixed by admin at approval), current lifecycle status, status history (actor + timestamp per change, with a manual-override flag and reason where applicable), securely stored proof-of-delivery verifications (Arrival OTP and Delivery OTP, each single-use with used/invalidated state and timestamps), links to the requesting client, approving admin, assigned driver, and payment confirmation.
- **Fuel Type Price**: A company-level setting mapping each offered fuel type to a base price per unit, maintained by the Company Admin and used to compute Estimated Prices.
- **Payment Confirmation**: A record of a verified payment event from a national payment channel, tied to exactly one order, processed exactly once.
- **Location Update**: A driver position report (coordinates + time) associated with a driver and, while in transit, an order.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A client can create a fuel order in under 2 minutes, and the full lifecycle (request → approval → assignment → payment → delivery confirmation) is completable end-to-end without manual data correction.
- **SC-002**: Zero cross-tenant data exposure: in security testing, 100% of attempted cross-company reads and writes are denied.
- **SC-003**: 100% of invalid order status transitions are rejected in lifecycle testing; no order ever reaches Delivered without a recorded payment confirmation and both successful OTP verifications (arrival and delivery).
- **SC-004**: Under simultaneous dispatch of competing orders, no driver is ever double-booked (0 occurrences across concurrency test runs).
- **SC-005**: Dispatch selects the nearest eligible driver in 95% of test scenarios within 5 seconds of order approval.
- **SC-006**: Watchers see a driver movement of more than 50 meters reflected within 10 seconds, and a stationary driver produces no more than one update per 3-minute window.
- **SC-007**: Duplicate payment confirmations produce zero state changes and zero duplicate financial records across all replay tests.
- **SC-008**: The platform supports at least 50 concurrent tenant companies and 500 concurrent active users without functional degradation.
- **SC-009**: In proof-of-delivery testing, 0 orders close via driver action alone: every Delivered order carries either two used, invalidated OTP verifications or a flagged Company Admin manual override with a recorded reason, and no system response to a driver ever contains an OTP value.
- **SC-010**: In presence testing, 100% of drivers silent for more than 6 minutes are excluded from dispatch results, and 100% of reconnecting drivers regain eligibility without manual intervention.

## Assumptions

- The platform serves the Saudi market: payments settle through Sadad/Mada channels, initiated externally and confirmed to the platform asynchronously; the platform never handles raw card data.
- Payment is required after driver assignment and before the delivery departs (per the mandated lifecycle). Pricing follows the hybrid model in the Clarifications section: company-set base prices produce an Estimated Price; the admin fixes the Final Price at approval.
- One truck is operated by one driver at a time; capacity is compared against a single order's quantity (no multi-order load pooling in v1).
- Dispatch runs automatically upon approval; the Company Admin can see the outcome but manual driver re-assignment beyond cancellation is out of scope for v1.
- Rejected and cancelled orders are terminal states supplementing the six-stage happy path.
- Notifications to admins/clients (e.g., "no driver available") are delivered in-app; SMS/email channels are out of scope for v1.
- Company suspension by the Platform Owner blocks all of that company's users from signing in but preserves data.
- Uploaded files are limited to common document/image formats with a reasonable size cap (assumed 10 MB) — final limits configurable.
- Technical delivery constraints supplied with the request (entry-point naming, storage directory name `sys_storge`, framework, database, transactionality, real-time transport, containerization, CI/CD, and security middleware) are recorded as binding implementation constraints for the planning phase and intentionally excluded from this business specification.
