# Feature Specification: Multi-Tier Accounts, Regional Routing & Billing

**Feature Branch**: `004-multi-tier-platform`

**Created**: 2026-08-09

**Status**: Draft — awaiting approval before implementation

**Input**: Restructure the platform onto a four-level account hierarchy (CIRO → Fuel
Company → Transportation Company → Client), route every order Client → Fuel Company →
Transportation Company → Driver by the client's region, introduce a billing domain with
three payment methods (direct, deferred/paid-by-transporter, credit limit), and capture
structured station addresses (region → governorate → map pin → editable text).

---

## Why this is a re-architecture, not an increment

Three foundations of feature 001 change meaning:

1. **Tenancy goes from two levels to four.** Today a record belongs to exactly one company.
   An order now has four legitimate viewers in different companies.
2. **Order routing gains a hop.** Today: client → company admin approves → auto-dispatch
   picks a driver. Now a Transportation Company sits between approval and the driver.
3. **Money becomes a first-class entity.** Today payment is a webhook that flips an order's
   status. Now invoices exist independently, with their own lifecycle and three settlement
   paths.

Everything below is written so each user story can ship and be demonstrated on its own.

---

## Clarifications

### Session 2026-08-09

- Q: When does a client pay under the direct method, given the final price is set at approval? → A: Invoice is issued at approval with the final price; the client pays then and the order stays in `PENDING_PAYMENT` until settled.
- Q: Under deferred payment, is the transporter reimbursed by the client through the platform? → A: No — settled outside the platform. One invoice, payer = Transportation Company; the client sees it read-only. No reimbursement is tracked.
- Q: When is a client's credit consumed? → A: At approval, when the invoice is issued with the final price. Available credit is always derived as limit minus outstanding issued credit invoices; a credit shortfall is therefore refused at approval, not at order placement.
- Q: Does the existing 30-minute payment timeout apply to all three payment methods? → A: Direct only. Deferred and credit orders proceed on issue and never expire for non-payment; the existing window, retry and paymentTimeoutCount are unchanged.
- Q: Who creates Client (gas station) accounts? → A: The Fuel Company only. They run the region/governorate/pin/address flow and set the credit limit; Transportation Companies see clients only through orders routed to them.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - CIRO onboards an isolated Fuel Company (Priority: P1)

As the platform operator, CIRO creates a Fuel Company account so that company can operate
its own regions, transporters and clients without ever seeing another Fuel Company's data.

**Why this priority**: Nothing else can be created until a Fuel Company exists, and tenant
isolation is the platform's core security promise. This story alone proves the new hierarchy.

**Acceptance scenarios**:

1. **Given** CIRO is signed in, **When** they create a Fuel Company with its admin account,
   **Then** that admin can sign in and sees only their own company.
2. **Given** two Fuel Companies exist, **When** one company's admin lists any resource,
   **Then** no record belonging to the other appears, and requesting one by its identifier
   is indistinguishable from it not existing.
3. **Given** CIRO is signed in, **When** they list companies, **Then** every Fuel Company is
   visible, because CIRO alone is exempt from isolation.

---

### User Story 2 - Fuel Company assigns regions to a Transportation Company (Priority: P1)

A Fuel Company admin creates a Transportation Company and assigns it the regions it may
serve, so incoming orders can be routed by the client's location.

**Why this priority**: Regional assignment is the input the routing rule depends on; without
it no order can reach a transporter.

**Acceptance scenarios**:

1. **Given** a Fuel Company admin, **When** they create a Transportation Company and assign
   it one or more regions, **Then** that transporter is listed as serving exactly those regions.
2. **Given** a region already served by one transporter, **When** the admin assigns the same
   region to a second transporter, **Then** the system states how the conflict is resolved
   (see FR-014) rather than silently accepting an ambiguous mapping.
3. **Given** a Transportation Company admin, **When** they view their account, **Then** they
   see their assigned regions but cannot change them.

---

### User Story 3 - Client registers a station with a structured address (Priority: P1)

A Fuel Company admin registers a client's station as region → governorate → map pin →
editable street text, so orders carry a human-readable destination and can be routed
regionally.

**Why this priority**: Region determines routing, and the address text is what removes the
last placeholder from the delivery screens.

**Acceptance scenarios**:

1. **Given** a Fuel Company admin is creating a client account, **When** the region and
   governorate are chosen and a pin is dropped, **Then** a street address is fetched for that
   pin and shown in an editable field.
2. **Given** a fetched address, **When** it is edited before saving, **Then** the edited text
   is what is stored and later displayed.
3. **Given** the address lookup is unavailable, **When** the pin is dropped, **Then** the
   address field stays empty and editable and saving still succeeds — lookup failure never
   blocks registration.
4. **Given** a saved station, **When** any later screen shows the delivery destination,
   **Then** it shows the stored text, with no repeat lookup.

---

### User Story 4 - Order routes Client → Fuel Company → Transportation Company → Driver (Priority: P1)

An order is approved by the Fuel Company, dispatched to the transporter serving the client's
region, and given to one of that transporter's available drivers.

**Why this priority**: This is the core journey the whole restructure exists to serve.

**Acceptance scenarios**:

1. **Given** a client places an order, **When** the Fuel Company admin opens it, **Then** they
   see the order together with the Transportation Company designated by the client's region.
2. **Given** the Fuel Company approves the order, **When** the designated transporter signs in,
   **Then** the order appears in their queue with their available drivers listed, ranked by
   suitability for this specific trip.
3. **Given** the transporter assigns a driver, **When** that driver signs in, **Then** the trip
   appears for them and no other driver can take it.
4. **Given** two transporter staff assign a driver simultaneously, **When** both submit,
   **Then** exactly one assignment succeeds.
5. **Given** the client's region has no serving transporter, **When** the order is approved,
   **Then** it is held for manual assignment and the Fuel Company is notified — it is never
   silently stuck.

---

### User Story 5 - Order is paid by one of three methods (Priority: P2)

Each order settles through direct payment, deferred payment by the transporter, or the
client's credit limit — each producing an invoice with its own lifecycle.

**Why this priority**: Delivery works without billing (P1 stories are demonstrable alone), but
the finance screens and the business model depend on this.

**Acceptance scenarios**:

1. **Given** an approved order priced by the Fuel Company, **When** the invoice is issued at
   approval, **Then** it records the payer, the final amount, and the method.
2. **Given** direct payment, **When** the invoice is issued, **Then** the order waits in
   `PENDING_PAYMENT`; **When** the client settles it, **Then** the order proceeds to routing
   and the invoice is marked settled exactly once even if the payment provider notifies twice.
3. **Given** deferred payment, **When** the transporter receives the order, **Then** they can
   see and settle the single invoice as its payer, and the client can see that same invoice
   read-only; no reimbursement between the two is created or tracked by the system.
4. **Given** credit-limit payment, **When** the invoice is issued at approval, **Then** the
   client's available credit falls by the invoice amount; **When** it is later settled,
   **Then** the available credit is restored by that amount.
5. **Given** a credit order whose final price exceeds the client's available credit, **When**
   the Fuel Company approves it, **Then** approval is refused with a message naming the
   shortfall, and no invoice is issued and no credit consumed.
6. **Given** several credit orders are placed before any is approved, **When** they are
   approved in turn, **Then** each is checked against the credit remaining at its own approval
   — placing an order reserves nothing.

---

### User Story 6 - Live delivery shows driver, vehicle, destination and ETA (Priority: P2)

While an order is in transit, the client sees who is delivering, in which vehicle, to which
address, and roughly when it will arrive.

**Why this priority**: This is what removes the remaining placeholders from the mobile
dashboard, but it depends on Story 4 having assigned a driver.

**Acceptance scenarios**:

1. **Given** a driver is assigned, **When** the client views the order, **Then** they see the
   driver's name and vehicle plate without being able to read any other driver's record.
2. **Given** the driver's position is known, **When** the client views the order, **Then** an
   estimated arrival time is shown and updates as the driver moves.
3. **Given** no position has been reported yet, **When** the client views the order, **Then**
   the arrival estimate is absent rather than fabricated.

---

### Edge Cases

- A Transportation Company's region assignment is removed while it has orders in flight —
  in-flight orders stay with it; only new routing changes.
- A client's station is moved to a different region while an order is in flight — the order
  keeps the transporter it was routed to.
- A driver is deactivated mid-trip — existing behaviour holds: the trip completes, no new
  assignments.
- An invoice is settled after the order is already cancelled — the settlement must be
  recorded and refunded/credited rather than silently applied.
- A deferred or credit invoice stays unsettled indefinitely — the order still completes; the
  outstanding balance is a billing matter, never a delivery blocker.
- Credit limit is lowered below the client's current outstanding balance — existing invoices
  stand; new credit approvals are refused until the balance falls.
- A credit order is placed while credit is available but approved after other orders have
  consumed it — approval is refused at that point, since placement reserves nothing.
- The same region is assigned to two transporters of the *same* Fuel Company (see FR-014).
- Two Fuel Companies both serve the same region — allowed, because they are isolated tenants;
  routing is always resolved within the client's own Fuel Company.
- The address lookup returns nothing for a valid pin — the client saves free text.

---

## Requirements *(mandatory)*

### Functional Requirements

**Hierarchy & isolation**

- **FR-001**: System MUST support four account levels: CIRO (platform operator), Fuel Company,
  Transportation Company, and Client, plus Drivers belonging to a Transportation Company.
- **FR-002**: System MUST treat each Fuel Company as an isolated tenant: no Fuel Company may
  read or write any record belonging to another, and a cross-tenant request MUST be
  indistinguishable from the record not existing.
- **FR-003**: CIRO MUST be the only role exempt from tenant isolation, and the only role able
  to create and manage Fuel Companies.
- **FR-004**: A Transportation Company and a Client MUST each belong to exactly one Fuel
  Company, and MUST NOT see any record outside their own scope.
- **FR-004a**: Only the owning Fuel Company MAY create and manage Client accounts, including
  their station details and credit limit. A Transportation Company MUST NOT create clients and
  MUST see a client only through an order routed to it.
- **FR-005**: System MUST enforce isolation centrally rather than per-feature, so that a new
  endpoint is protected by default rather than by developer discipline.

**Multi-party records**

- **FR-006**: An order MUST record its participants explicitly — client, Fuel Company,
  Transportation Company (once routed), and driver (once assigned).
- **FR-007**: Each participant MUST see an order only through their own role's scope: a client
  sees their own orders, a driver only trips assigned to them, a Transportation Company only
  orders routed to it, and a Fuel Company all orders in its tenant.
- **FR-008**: A participant MUST NOT gain read access to another participant's wider records
  by virtue of sharing an order — specifically, a client may see the assigned driver's name
  and vehicle plate *for that order* and nothing more.

**Addresses & regions**

- **FR-009**: System MUST store, for each client station: region, governorate, coordinates,
  and a final address text, captured by the Fuel Company at client creation.
- **FR-010**: System MUST offer the 13 Saudi regions and their governorates as a fixed
  selectable list, in Arabic and English.
- **FR-011**: System MUST derive a suggested address text from the dropped pin at registration
  time, and MUST allow that text to be edited before saving.
- **FR-012**: System MUST NOT call an external address lookup when reading or listing orders —
  stored text only.
- **FR-013**: Failure of the address lookup MUST NOT block account creation.

**Routing**

- **FR-014**: System MUST resolve exactly one Transportation Company for an order from the
  client's region within the client's Fuel Company. Where more than one transporter serves
  that region, the Fuel Company MUST choose at approval time, with the system offering the
  candidates.
- **FR-015**: System MUST show the Fuel Company the designated Transportation Company at the
  point of approving an order.
- **FR-016**: An approved order whose region has no serving transporter MUST be held in an
  explicit unroutable state and notified to the Fuel Company.
- **FR-017**: System MUST present the Transportation Company with its currently available
  drivers for the order, ranked by suitability for that trip (vehicle capacity, supported fuel
  type, proximity), excluding drivers who are inactive, offline or already on a trip.
- **FR-018**: Driver assignment MUST be atomic: concurrent assignment attempts MUST result in
  exactly one assigned driver.
- **FR-019**: The backend MUST remain the sole authority for every status transition; no client
  application may assert or derive one.

**Billing**

> **Amended — the billing requirements below were reversed in order.** As
> originally written, the invoice was issued at approval and a direct order paid
> before it was routed. That could not survive the rule that **the delivery leg
> is priced by the transport company that performs it**: until routing chooses
> that company, nobody can say what the haul costs, so an invoice issued at
> approval billed the fuel line alone and a customer was asked to pay a total
> that excluded delivery. Routing now comes first and produces the figure; the
> station owner reviews and settles it afterwards. FR-020, FR-020a, FR-020b,
> FR-024 and FR-025 below state the amended order. Everything downstream of
> settlement — assignment, loading, transit, handover — is unchanged.

- **FR-020**: System MUST issue an invoice for every order **at routing**, once a Transportation
  Company has been resolved and the delivery leg it charges for is therefore priced, recording
  the final amount, the payer, the method, and the lifecycle state. No invoice is issued, and no
  payment is collected, before the order is routed. An invoice MUST be issued exactly once and
  MUST carry the complete total, never the fuel line alone.
- **FR-020a**: An order MUST be routed to a Transportation Company **before** payment is
  requested, because routing is what makes the total knowable. Once routed and priced, the order
  MUST return to the station owner in `PENDING_PAYMENT` and MUST NOT be assigned a driver until
  they settle it — under direct payment by paying the invoice, and under deferred or credit
  payment by explicitly accepting the total. Refusing the total is the client's existing
  cancellation; the system MUST NOT provide a separate refusal.
- **FR-020a-i**: Routing, pricing and invoice issuance MUST succeed or fail together. An invoice
  refused on a credit limit or a commission ceiling MUST undo the routing that produced the
  figure it refused, leaving the order approved, un-routed, uninvoiced and routable again — never
  committed to a Transportation Company the platform has declined to bill. That order MUST remain
  recoverable once the cause is cleared, without needing to be approved a second time.
- **FR-020b**: The payment window and its retry/timeout accounting MUST apply to direct payment
  only, and a payment deadline MUST be recorded only where one is enforced. Deferred and credit
  orders await the station owner's acceptance with **no deadline at all** and MUST NOT be
  expired or cancelled for non-acceptance: they are settled against an invoice rather than a
  gateway, and cancelling one because nobody opened the application would invent a failure the
  platform does not otherwise have.
- **FR-021**: System MUST support three payment methods — direct (client pays), deferred
  (Transportation Company pays on the client's behalf), and credit limit.
- **FR-022**: A deferred invoice MUST name the Transportation Company as its single payer, be
  settleable only by them, and remain visible to the client as a read-only record. The system
  MUST NOT create or track any reimbursement between transporter and client — that is settled
  outside the platform.
- **FR-023**: A Fuel Company MUST be able to set a credit limit per client.
- **FR-024**: Issuing a credit invoice at routing MUST reduce the client's available credit by
  its amount; settling it MUST restore that amount. Placing an order MUST NOT reserve credit.
  The amount consumed is the complete total including the delivery leg, which is what the client
  will actually be billed.
- **FR-024a**: Available credit MUST be derived as the credit limit minus the total of
  outstanding issued credit invoices, never held as an independently mutated counter.
- **FR-025**: Routing MUST be refused when a credit order's final price exceeds the client's
  available credit at that moment, naming the shortfall; no invoice is issued and no credit is
  consumed by a refused routing. The check runs against the complete total including the delivery
  leg — it could not run at approval, where that figure does not yet exist (FR-020a).
- **FR-026**: Payment confirmation MUST remain provider-driven and idempotent: repeated
  notifications for the same payment MUST settle an invoice exactly once.
- **FR-027**: Credit and payment balances MUST be updated atomically with the invoice state, so
  a failure can never leave credit consumed without an invoice or vice versa.

**Delivery visibility**

- **FR-028**: A client MUST see the assigned driver's name and vehicle plate for their order.
- **FR-029**: System MUST provide an estimated arrival time derived from the driver's last known
  position and the destination, and MUST omit it when no position is known.
- **FR-030**: System MUST expose the stored destination address text on the order.

**Migration**

- **FR-031**: Existing companies, users and orders MUST be migrated into the new hierarchy
  without data loss, and the migration MUST be re-runnable safely.
- **FR-032**: Every existing capability that survives this change (authentication by phone,
  OTP handover, tracking, tenant isolation) MUST continue to pass its existing tests.

### Key Entities

- **Fuel Company** — isolated tenant; owns regions, transporters, clients, credit limits.
- **Transportation Company** — belongs to a Fuel Company; serves assigned regions; owns drivers.
- **Client (Station)** — belongs to a Fuel Company; has region, governorate, coordinates,
  address text, credit limit and outstanding balance.
- **Region / Governorate** — fixed reference list used for routing.
- **Order** — gains explicit participants, a routing state, and a link to its invoice.
- **Invoice** — amount, **exactly one payer**, method (direct / deferred / credit), lifecycle state, settlement
  record; the unit that credit is consumed and restored against.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero cross-tenant exposure: 100% of attempted reads and writes across Fuel
  Companies are denied, and denied indistinguishably from a missing record.
- **SC-002**: An order placed by a client reaches an assigned driver through Fuel Company
  approval and Transportation Company assignment without any manual data correction.
- **SC-003**: 100% of concurrent driver-assignment attempts for one order result in exactly one
  assignment.
- **SC-004**: Credit accounting never drifts: after any sequence of issue/settle/cancel
  operations, available credit equals the limit minus outstanding invoices, in 100% of cases.
- **SC-005**: Repeated payment notifications settle an invoice exactly once, 100% of the time.
- **SC-006**: No screen in either client application displays placeholder data for driver name,
  vehicle plate, destination address, station name or finance figures.
- **SC-007**: Order listing and reading make zero external address-lookup calls.
- **SC-008**: All capabilities retained from feature 001 still pass their tests after migration.

---

## Assumptions

- CIRO is a single platform operator account; Fuel Companies are many and mutually isolated.
- Regional routing is always resolved *within* the client's own Fuel Company, so two Fuel
  Companies may serve the same region without conflict.
- The existing driver-eligibility logic (capacity, fuel type, proximity, availability) is
  retained as the ranking and validation layer behind the transporter's manual choice.
- Arrival estimates are approximate, derived from straight-line distance and an average speed;
  they are presented as estimates, not commitments.
- The address lookup is used only at registration, never on read paths.
- Phone remains the login identifier for Client and Driver; email for all administrative roles.

## Open items

All design decisions raised during clarification are now settled (see Clarifications above).
One provisioning task remains:

1. **Google Maps API key** with Geocoding enabled must be provisioned for the server before
   Phase 2. This is a provisioning task, not a design decision.
