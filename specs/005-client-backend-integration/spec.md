# Feature Specification: Client Mobile App — Backend Integration

**Feature Branch**: `005-client-backend-integration`

**Created**: 2026-08-15

**Status**: Draft

**Input**: User description: "now i need you config all mobile app feature of client with backend the please read the file structures carefully before you starting"

## Context

The client-facing mobile app is visually complete but almost entirely disconnected from the
platform. A survey of `mobile_app/lib/features/` against the backend's REST surface found that of
every screen a CLIENT can reach, only the **home dashboard** and the **login screen** read live
data. Every other client screen renders sample values compiled into the app.

Concretely, today:

- **Orders list, order detail and track-order** are static previews. An in-app enum
  (`MockOrderState`) drives which status card is shown, and the list is a hardcoded array of five
  sample orders — even though a complete data layer (repository, use cases, `OrdersCubit`,
  `OrderDetailCubit`, `PaymentCubit`) already exists and is wired into dependency injection but
  never mounted by these screens.
- **Invoices and notifications** screens are static, despite having working cubits behind them.
- **Stations, payments, credit limit, profile, phone change and support** have no data or domain
  layer at all — presentation only.
- **Create order** offers a fixed station list, a fixed favourites list, a fixed ladder of tanker
  quantities and a sample price per litre, none of which come from the platform.
- The **home dashboard**, though largely live, still shows a fixed notification badge count and
  has non-functional "change station" and "contact driver" actions.

The result is a client who cannot see their real orders, cannot see a real price before
committing to a purchase, and cannot see the real state of their credit or invoices. This feature
closes that gap for every client-facing capability, and adds the backend capability required
where the platform does not yet expose the data a screen needs.

**Out of scope**: the driver experience (already integrated under feature 004) and the web admin
dashboard (feature 003).

## Clarifications

### Session 2026-08-15

- Q: How are the delivery fee, service fee and tax derived for an order's itemised breakdown? → A: Per fuel company — flat delivery fee, service fee as a percentage of the fuel line total, tax at a configurable rate applied to the sum.
- Q: How is a client's new phone number verified before a change takes effect? → A: SMS one-time code sent to the new number, reusing the platform's existing OTP mechanism; requires an SMS provider.
- Q: Who receives a support request raised from the client app, and how is it handled? → A: Routed to the client's fuel company admins as a notification, acknowledged by an admin; no threaded ticketing in this feature.
- Q: How are the client's order, invoice, payment and notification lists bounded? → A: Cursor-based pagination on all four, infinite scroll in the app, page size fixed by the platform.
- Q: What is the canonical term for a client's delivery destination — the backend calls it a station, this spec called it a delivery location? → A: **Station**. The existing backend and app naming stands; this spec was normalised to match.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See my real orders (Priority: P1)

A client opens the app and sees the orders they actually placed — the correct count, the correct
statuses, the correct fuel grades and quantities — and can open any one of them to see its real
current state, real history and real handover codes. The screen reflects what the platform
believes, not what the app was compiled with.

**Why this priority**: This is the app's core promise. A client who cannot see their own orders
has no reason to open the app at all, and every other screen either links into an order or
summarises a set of them. It is also the largest single correctness risk today: the app currently
displays five fabricated orders to every client, regardless of who they are.

**Independent Test**: Sign in as a client with a known set of orders on the platform, open the
orders list, and confirm each order shown matches the platform record for fuel grade, quantity,
status and date; confirm a client with no orders sees an empty state rather than sample rows.
Delivers value on its own — a client can check their orders without any other screen changing.

**Acceptance Scenarios**:

1. **Given** a client with four orders on the platform in different statuses, **When** they open
   the orders list, **Then** exactly those four orders are listed with their real statuses, and
   no sample order appears.
2. **Given** a client with no orders, **When** they open the orders list, **Then** an empty state
   is shown and no order rows are rendered.
3. **Given** a client viewing the orders list, **When** they apply a status filter, **Then** the
   filter narrows their whole order set rather than a fixed sample set or only the pages loaded
   so far.
3a. **Given** a client with more orders than fit one page, **When** they scroll to the bottom,
   **Then** the next page loads automatically, with no record repeated or skipped, until the end
   of their history is reached and shown as the end.
4. **Given** a client opens an order awaiting company approval, **When** the detail screen loads,
   **Then** the status shown is the platform's status for that order, and the actions offered are
   only those the platform permits in that status.
5. **Given** an order the client does not own, **When** its identifier is opened directly,
   **Then** access is refused and no order data is displayed.
6. **Given** the network is unavailable, **When** the orders list is opened, **Then** an error
   state with a retry action is shown rather than sample data.

---

### User Story 2 - Place an order at the real price (Priority: P1)

A client starts a new fuel request and sees the stations actually registered to their
account, the fuel grades their supplier actually sells, and the actual current price for the
grade and quantity chosen. On confirmation the order is created on the platform and appears
immediately in their orders list at the correct status for the payment method they chose.

**Why this priority**: Ordering is the revenue path, and a price shown to a client is a
commercial commitment. Today the price per litre and the entire cost breakdown are sample values,
so a client can commit to a purchase against a number the platform never quoted. This must be
correct before the app is put in front of real clients.

**Independent Test**: Sign in as a client, open the new-request flow, and confirm the station,
grades and unit price match the platform's records for that client's supplier; place an order and
confirm it appears on the platform with matching details. Testable without any change to the
orders list beyond Story 1.

**Acceptance Scenarios**:

1. **Given** a client whose supplier prices diesel at a given rate, **When** they select diesel in
   the new-request flow, **Then** the unit price and computed total shown reflect that rate.
2. **Given** a client selects a quantity, **When** the total is displayed, **Then** it is derived
   from the platform's price for that grade and quantity, not from a value stored in the app.
3. **Given** a client reviews the cost before confirming, **When** the breakdown is shown, **Then**
   the fuel line total, delivery fee, service fee and tax are each itemised, and they sum to the
   total presented.
4. **Given** a client confirms an order with the deferred payment method, **When** the order is
   created, **Then** no payment step is presented and the order appears awaiting company approval.
5. **Given** a client confirms an order with the direct payment method, **When** the order is
   approved, **Then** the client is taken to payment, and the order only advances once the
   platform confirms the payment — never on the app's own say-so.
6. **Given** the client's supplier does not sell a grade, **When** the grade list is shown,
   **Then** that grade is not offered.
7. **Given** order creation is rejected by the platform (for example, over credit limit),
   **When** the client confirms, **Then** the platform's reason is shown and no local order is
   created.

---

### User Story 3 - Follow a delivery as it happens (Priority: P2)

A client with an order out for delivery opens tracking and sees the real driver's name and plate,
the real vehicle position on the map, a real remaining distance and arrival estimate, and the
real handover code to give the driver — updating as the delivery progresses, and telling them
plainly when the position has gone stale.

**Why this priority**: This is the app's most visible differentiator and the screen clients open
most during an active delivery, but it only matters once orders themselves are real (Story 1).
The realtime channel and its cubit already exist and are proven by the driver app, so the work is
mounting them rather than building them.

**Independent Test**: With an order in transit and a driver emitting position, open tracking as
the client and confirm the driver identity, position, distance and arrival estimate match the
platform; stop the driver's updates and confirm the screen reports the position as stale.

**Acceptance Scenarios**:

1. **Given** an order in transit, **When** the client opens tracking, **Then** the driver name,
   plate and arrival estimate shown are the platform's, and no sample driver appears.
2. **Given** the driver's position updates, **When** the client is watching, **Then** the map
   marker and remaining distance update without the client reloading the screen.
3. **Given** no position update has arrived within the staleness window, **When** the client is
   watching, **Then** the screen states the position is out of date rather than showing a stale
   position as current.
4. **Given** an order not yet in transit, **When** the client opens tracking, **Then** a clear
   "not yet trackable" state is shown rather than an error.
5. **Given** the client is on the tracking screen, **When** the handover code is displayed,
   **Then** it is the platform's current code for that order and reflects its expiry.

---

### User Story 4 - Know what I owe and what I have paid (Priority: P2)

A client opens invoices and sees their real invoices with real amounts, due dates and settlement
status; opens payments and sees their real payment history; and can settle an outstanding invoice
from the app, with the result reflected only once the platform confirms it.

**Why this priority**: Financial figures shown to a client carry the highest consequence of being
wrong, and the deferred and credit payment methods make invoices the primary settlement path for
a large share of clients. Ranked below ordering because a client can transact without it, but it
must not ship stale.

**Independent Test**: Sign in as a client with known invoices and payments, open both screens, and
confirm every amount, date and status matches the platform record; settle an invoice and confirm
the platform record changes.

**Acceptance Scenarios**:

1. **Given** a client with outstanding and settled invoices, **When** they open invoices, **Then**
   each invoice's amount, issue date, due date and status match the platform.
2. **Given** a client with no invoices, **When** they open invoices, **Then** an empty state is
   shown.
3. **Given** a client opens payments, **When** the history loads, **Then** it lists their real
   payments with real amounts, dates and the order each relates to.
4. **Given** a client settles an outstanding invoice, **When** the platform confirms settlement,
   **Then** the invoice moves to settled in the app; **and** if confirmation does not arrive, the
   invoice remains outstanding and the client is told the payment is still being confirmed.
5. **Given** a client taps an invoice, **When** the detail opens, **Then** the order it was issued
   against is identified and reachable.

---

### User Story 5 - Understand my credit standing (Priority: P2)

A client sees their real credit limit, how much of it is currently consumed by unsettled orders
and invoices, and how much remains available — on the home dashboard and on the dedicated credit
screen — and is warned before placing an order that would exceed it.

**Why this priority**: Credit availability determines whether a client can order at all, and the
platform already rejects over-limit orders. Showing a fabricated available balance sets the
client up for a rejection they could not anticipate.

**Independent Test**: Sign in as a client with a known limit and known unsettled balance, and
confirm the limit, consumed and available figures on both the dashboard and the credit screen
match the platform's own calculation.

**Acceptance Scenarios**:

1. **Given** a client with a credit limit and unsettled orders, **When** they open the credit
   screen, **Then** limit, consumed and available are shown and are consistent with the platform.
2. **Given** a client with no credit limit assigned, **When** they open the credit screen,
   **Then** it states that no credit facility is assigned rather than showing a figure.
3. **Given** an order would exceed the client's available credit, **When** they attempt to confirm
   it on credit terms, **Then** they are warned before submission and told the shortfall.
4. **Given** an invoice is settled, **When** the client returns to the credit screen, **Then** the
   available figure reflects the settlement.

---

### User Story 6 - Be told when something changes (Priority: P3)

A client sees a notification badge that reflects their real unread count, opens a list of the
real notifications the platform has raised for them, and marking one read is remembered across
sessions and devices.

**Why this priority**: Notifications drive re-engagement with orders and invoices, but the client
can complete every task without them. The data layer already exists and is unused.

**Independent Test**: Raise a notification on the platform for a client and confirm the badge
count increases and the notification appears; mark it read and confirm the count decreases and
stays decreased after restarting the app.

**Acceptance Scenarios**:

1. **Given** a client with unread notifications, **When** any client screen showing the badge is
   opened, **Then** the badge shows the real unread count.
2. **Given** a client with no unread notifications, **When** the badge is shown, **Then** no count
   is displayed.
3. **Given** a client marks a notification read, **When** they restart the app, **Then** it
   remains read.
4. **Given** a notification relates to an order, **When** the client taps it, **Then** that order
   opens.

---

### User Story 7 - Manage my own profile (Priority: P3)

A client sees their real name, phone and station on the profile screen, can correct
their name and phone, and can change their profile picture — with changes persisting to the
platform and surviving a restart.

**Why this priority**: Correct contact details matter for delivery coordination, but a client can
transact without editing them and an admin can correct them on the client's behalf today.

**Independent Test**: Sign in, open profile, confirm the details match the platform record, change
the name, restart the app, and confirm the change persisted.

**Acceptance Scenarios**:

1. **Given** a signed-in client, **When** they open profile, **Then** their real name, phone,
   registered station and profile picture are shown.
2. **Given** a client edits their name, **When** they save, **Then** the platform record is
   updated and the new name appears everywhere it is displayed.
3. **Given** a client changes their phone number, **When** they save, **Then** a one-time code is
   sent by SMS to the new number and the change takes effect only once that code is submitted
   correctly.
3a. **Given** a client requests a code and abandons the flow, **When** they return, **Then** their
   original number is still in force.
3b. **Given** the code cannot be delivered, **When** the client waits, **Then** they are told the
   send failed and offered a retry rather than left waiting indefinitely.
4. **Given** an edit is rejected by the platform, **When** the client saves, **Then** the reason
   is shown and the previous value is retained.

---

### User Story 8 - Choose among my stations (Priority: P3)

A client sees the stations their fuel company has registered to their account, chooses
which one a new order goes to, and marks the ones they use most so they surface first. The client
selects from that set but does not add to it — registering a station remains the fuel company's
responsibility.

**Why this priority**: Every client can order today because at least one station is registered to
their account; choosing between stations is a convenience for multi-station clients rather than
a precondition for transacting.

**Independent Test**: Sign in as a client whose fuel company has registered more than one station
for them, confirm all are listed, select a non-default one for an order, and confirm the created
order carries that station.

**Acceptance Scenarios**:

1. **Given** a client with several registered stations, **When** they open the stations
   screen, **Then** exactly those stations are listed with their real names and addresses, and no
   control to create a new one is offered.
2. **Given** a client selects a different station while creating an order, **When** the
   order is created, **Then** the platform records that station as the delivery destination.
3. **Given** a client marks a station as a favourite, **When** they restart the app or sign in on
   another device, **Then** it is still marked.
4. **Given** a client has exactly one registered station, **When** they create an order, **Then**
   it is selected automatically and no choice is demanded.
5. **Given** the fuel company registers an additional station for the client, **When** the client
   next opens the stations screen, **Then** the new station appears without an app update.

---

### User Story 9 - Get help with a specific order (Priority: P3)

A client can reach support from anywhere in the app, and when they raise a problem from an order,
the order is identified to whoever handles it, so the client does not have to recite its details.

**Why this priority**: Support is a safety net rather than a primary task, and the existing
contact channels already function as static links. Included so the client journey is complete.

**Independent Test**: Open support from an order, raise a problem, and confirm the client's fuel
company administrators receive it with the order identified — and that no other company can see it.

**Acceptance Scenarios**:

1. **Given** a client on an order, **When** they raise a problem, **Then** the order is attached
   to the request without the client entering its number.
2. **Given** a client opens support with no order in context, **When** the screen loads, **Then**
   the contact channels are shown and no order is attached.
3. **Given** a support request is submitted, **When** the client returns to the screen, **Then**
   they can see that it was received, and whether it has been acknowledged.
4. **Given** a client raises a problem, **When** the request is routed, **Then** it reaches the
   administrators of that client's own fuel company and no administrator of any other company can
   see it.
5. **Given** a support request is submitted, **When** the client looks for a reply, **Then** the
   screen directs them to the phone or messaging channel rather than implying a written response
   will arrive in the app.

---

### Edge Cases

- **Signed out mid-session**: when the platform rejects the client's session on any screen, the
  app must recover the session silently once, and only if that fails return the client to sign-in
  without losing unsaved input on the new-request form.
- **Order changes while being viewed**: when an order's status advances on the platform while the
  client has its detail screen open, the screen must reflect the new status and withdraw actions
  that are no longer permitted, rather than allowing an action the platform will reject.
- **Price changes between quote and confirmation**: when the supplier's price changes after the
  client has seen a quote but before they confirm, the client must be shown the new total and
  asked to confirm again rather than being charged either figure silently.
- **Empty vs. failed**: every list must distinguish "you have none" from "we could not load
  yours"; a failure must never be presented as an empty set.
- **Slow or absent network**: every screen must reach a settled state — content, empty or error
  with retry — and must never display sample data as a fallback.
- **Partial data**: an order without an assigned driver, without an arrival estimate or without a
  final price must render with those fields marked unavailable rather than blank or zero.
- **Credit exactly at limit**: an order that brings the client exactly to their limit must be
  permitted; only one that exceeds it is refused.
- **Concurrent settlement**: an invoice settled elsewhere while the client is paying it must not
  produce a double payment; the client must be told it is already settled.
- **Language and direction**: every newly connected screen must render correctly in both Arabic
  (default, right-to-left) and English, including platform-supplied text and figures.
- **Stale tracking**: a delivery whose position stops updating must be reported as out of date
  rather than frozen at the last known point without explanation.
- **Undeliverable verification SMS**: a code that the provider cannot deliver — wrong country code,
  unreachable number, provider outage — must surface as a send failure with a retry, and must not
  leave the client waiting on a code that will never arrive.
- **Verification abandoned mid-flight**: a client who requests a code and then closes the app must
  find their original phone number still in force, and must not be blocked from starting the change
  again once the throttle window passes.
- **A new record arrives mid-scroll**: an order placed, or a notification raised, while the client
  is paging through a list must not cause a record they have already scrolled past to appear a
  second time, nor push an unseen one out of reach.
- **A long-standing client**: a client with several hundred orders must reach their first page as
  quickly as one with five, and must be able to page back to their oldest record without the list
  degrading.
- **Failure part-way down a list**: a page that fails to load must leave the pages already shown
  intact and offer a retry, rather than emptying the screen.

## Requirements *(mandatory)*

### Functional Requirements

#### Removal of fabricated data

- **FR-001**: Every client-facing screen MUST derive all displayed order, invoice, payment,
  credit, notification, profile, station and pricing values from the platform. No such value may
  originate in data compiled into the app.
- **FR-002**: The sample-data definitions currently backing the client screens, and the in-app
  status enum currently driving the order detail screen's presentation, MUST be removed once the
  screens they support read live data. Any that survive MUST be confined to automated tests and
  design previews and MUST be unreachable from a running client build.
- **FR-003**: No client screen may fall back to sample data when a request fails; failure MUST be
  presented as a failure with a retry action.

#### Orders

- **FR-004**: The orders list MUST show exactly the orders belonging to the signed-in client, with
  their platform status, fuel grade, quantity, station, payment method and dates.
- **FR-005**: Status filters on the orders list MUST apply to the client's whole order set as held
  by the platform, not merely to the pages the app has loaded (see FR-048d).
- **FR-006**: The order detail screen MUST present the order's platform status and MUST derive
  which status card, actions and progress step are shown from that status alone.
- **FR-007**: The order detail screen MUST offer only the actions the platform permits for that
  order in its current status and for the CLIENT role — cancellation and re-dispatch among them —
  and MUST reflect the platform's response rather than assuming success.
- **FR-008**: The order detail screen MUST show the handover code only when the platform issues
  one for that order, and MUST reflect its expiry.
- **FR-009**: An order the signed-in client does not own MUST NOT be displayed under any
  navigation path.

#### Ordering and pricing

- **FR-010**: The new-request flow MUST offer only the fuel grades the client's supplier sells.
- **FR-011**: The unit price and computed total shown during the new-request flow MUST come from
  the platform's current price for the selected grade.
- **FR-011a**: The platform MUST record and disclose an itemised cost breakdown for every order —
  the fuel line total, the delivery fee, the service fee and the tax — alongside the total.
- **FR-011b**: The itemised components disclosed for an order MUST sum to the total presented to
  the client; the app MUST NOT compute, infer or apportion any component itself.
- **FR-011c**: The platform MUST apply a single, centrally-defined rule set to derive each fee and
  the tax, so two orders with the same grade and quantity, placed against the same fuel company,
  itemise identically. Delivery distance is deliberately **not** a pricing input under this rule
  set — the delivery fee is flat per order.
- **FR-011d**: A component that does not apply to an order MUST be disclosed as zero rather than
  omitted, so the breakdown always reconciles to the total.
- **FR-011e**: The breakdown MUST be shown at the point of quotation, on the order detail receipt
  and on the invoice, and the three MUST agree for a given order.
- **FR-011f**: Each fuel company MUST hold its own pricing configuration: a flat delivery fee per
  order, a service fee expressed as a percentage of the fuel line total, and a tax rate. These sit
  alongside the fuel prices the company already configures.
- **FR-011g**: An order's components MUST be derived as: fuel line total = unit price × quantity;
  delivery fee = the company's flat fee; service fee = the company's percentage applied to the fuel
  line total; tax = the company's rate applied to the sum of the preceding three. The total is the
  sum of all four.
- **FR-011h**: The tax rate MUST be configuration, never a value fixed in code, so a change in the
  statutory rate takes effect without a release of either the platform or the app.
- **FR-011i**: An order MUST retain the fee and tax figures in force when it was priced. A later
  change to a company's configuration MUST NOT alter the breakdown of an order already placed.
- **FR-011j**: A fuel company with no pricing configuration MUST NOT be able to have orders priced
  against it; the client MUST be told pricing is unavailable rather than shown a total derived from
  defaults or zeros.
- **FR-012**: The station offered MUST be one registered to the client's account.
- **FR-013**: The order MUST be created on the platform with the grade, quantity, station, delivery
  timing and payment method the client selected, and MUST appear in the orders list immediately
  afterwards.
- **FR-014**: An order placed on deferred or credit terms MUST NOT present a payment step.
- **FR-015**: An order placed on direct terms MUST advance past payment only on the platform's
  confirmation of that payment, never on the app's own observation of the payment gateway.
- **FR-016**: A rejection from the platform on order creation MUST be surfaced to the client with
  the platform's reason, and no order may be shown locally as created.
- **FR-017**: The selectable quantities offered MUST reflect the tanker capacities the client's
  own fuel company sells in, held as that company's configuration alongside its prices, rather
  than a list fixed in the app.
- **FR-017a**: The offered quantities MUST NOT be derived from the fleet records of transport
  companies. Those belong to a different tenant, and reading them to build a client-facing list
  would cross a company boundary that FR-046a forbids.

#### Delivery tracking

- **FR-018**: The tracking screen MUST show the platform's driver identity, vehicle plate,
  position, remaining distance and arrival estimate for the watched order.
- **FR-019**: The tracking screen MUST update as the platform reports new positions, without the
  client reloading.
- **FR-020**: The tracking screen MUST report a position as out of date once no update has
  arrived within the platform's staleness window.
- **FR-021**: An order the platform does not consider trackable MUST produce an explanatory state
  rather than an error or an empty map.

#### Money

- **FR-022**: The invoices screen MUST show the client's real invoices with amount, issue date,
  due date, settlement status and the order each was issued against.
- **FR-023**: The payments screen MUST show the client's real payment history with amount, date,
  method and the order or invoice each relates to.
- **FR-024**: Settling an invoice from the app MUST take effect only on the platform's
  confirmation; until then the invoice MUST remain outstanding and the client MUST be told
  confirmation is pending.
- **FR-025**: An invoice already settled elsewhere MUST NOT be payable again, and the client MUST
  be told it is settled.
- **FR-026**: The client's credit limit, consumed amount and available balance MUST be shown from
  the platform on both the home dashboard and the credit screen, and MUST agree with each other.
- **FR-027**: A client with no credit facility MUST be told so rather than shown a figure.
- **FR-028**: A client MUST be warned before submitting an order that would exceed their available
  credit, and told the shortfall.
- **FR-029**: Every monetary amount MUST be displayed with its currency and in the numeral
  convention of the active language.

#### Notifications

- **FR-030**: The notification badge MUST show the client's real unread count, and MUST show
  nothing when that count is zero.
- **FR-031**: The notifications screen MUST list the platform's notifications for the client, and
  marking one read MUST persist on the platform.
- **FR-032**: A notification that refers to an order MUST open that order when tapped.

#### Profile and stations

- **FR-033**: The profile screen MUST show the client's real name, phone, registered stations and
  profile picture.
- **FR-034**: A client MUST be able to change their own name and profile picture, persisted to the
  platform.
- **FR-035**: A change of phone number MUST take effect only after the new number is verified by a
  one-time code sent to that number by SMS.
- **FR-035a**: The verification code MUST be generated, stored and validated by the same mechanism
  the platform already uses for delivery handover codes — hashed at rest, single-use, expiring, and
  attempt-throttled — rather than a second, parallel mechanism.
- **FR-035b**: The code MUST be sent to the **new** number, never the existing one, so possession of
  the new number is what is proven.
- **FR-035c**: The client's phone number MUST remain unchanged until a correct code is submitted;
  an abandoned or expired verification MUST leave the original number in force.
- **FR-035d**: The number of verification attempts and the number of code requests MUST both be
  throttled, and the client MUST be told when a limit is reached and when they may retry.
- **FR-035e**: A number already registered to another account MUST be refused before any code is
  sent.
- **FR-035f**: When the SMS provider cannot deliver, the client MUST be told the code could not be
  sent and offered a retry; the app MUST NOT report a code as sent when it was not.
- **FR-035g**: The verification code MUST NOT be returned to the app in any response, logged, or
  displayed anywhere in the interface.
- **FR-036**: The platform MUST support more than one station per client, registered by
  the client's fuel company.
- **FR-036a**: The stations screen MUST list exactly the stations registered to the signed-in
  client, and a client MUST be able to select which is used for a new order.
- **FR-036b**: A client MUST NOT be able to create, rename or remove a station from the
  app; the app MUST NOT present controls implying otherwise.
- **FR-036c**: A station the fuel company registers or withdraws MUST be reflected for the client
  without an app update; a withdrawn station MUST remain readable on historical orders that used
  it.
- **FR-036d**: Where a client has exactly one registered station, it MUST be selected
  automatically and no choice demanded.
- **FR-037**: A client's marking of a favourite station MUST persist across sessions and devices.

#### Support

- **FR-038**: A problem raised from an order MUST carry that order's identity to the handling
  party without the client entering it.
- **FR-038a**: A support request MUST be routed to the administrators of the client's own fuel
  company, and MUST be visible to no other company.
- **FR-038b**: Routing MUST reuse the platform's existing notification mechanism rather than
  introduce a separate delivery path.
- **FR-038c**: A support request MUST record who raised it, when, the order it concerns if any, and
  the client's description of the problem.
- **FR-039**: A client MUST be able to see that a submitted support request was received, and
  whether a fuel company administrator has acknowledged it.
- **FR-039a**: A support request MUST carry exactly two states — submitted and acknowledged. No
  threaded conversation, admin reply, or resolution workflow is in scope for this feature.
- **FR-039b**: The support screen MUST continue to offer the direct phone and messaging contact
  channels alongside submission, since those remain the responsive path until the administration
  surface exists.

#### Cross-cutting

- **FR-040**: The platform MUST remain the sole authority for every order, invoice and payment
  state transition; the app MUST NOT advance any state on its own initiative.
- **FR-041**: Every client screen MUST reach one of content, empty or error-with-retry, and MUST
  show a loading indication while in flight.
- **FR-042**: When the platform rejects the client's session, the app MUST attempt a single silent
  session recovery before returning the client to sign-in; concurrent requests MUST NOT each
  trigger their own recovery attempt.
- **FR-043**: A refusal by the platform on grounds of permission or ownership MUST be treated as a
  boundary and MUST NOT trigger session recovery.
- **FR-044**: Every newly connected screen MUST render correctly in Arabic (default,
  right-to-left) and English, including platform-supplied text.
- **FR-045**: No credential, handover code or payment detail may be written to logs or diagnostic
  output.
- **FR-046**: Where a screen requires data the platform does not currently expose, the platform
  MUST be extended to expose it, scoped so a client can read and amend only their own. No screen
  may be simplified merely to avoid extending the platform.
- **FR-046a**: Every capability added to the platform under FR-046 MUST enforce the same tenant
  and ownership isolation as the capabilities already in place, and MUST be covered by tests that
  assert a client cannot reach another client's data through it.
- **FR-046b**: The platform MUST expose the client's own payment history (FR-023), phone-number
  verification (FR-035), support-request submission and acknowledgement (FR-038/FR-039), the
  multi-station catalogue and favourite marking (FR-036/FR-037), the itemised cost breakdown
  (FR-011a), the credit standing calculation (FR-026) and the unread notification count (FR-030),
  as these are the gaps between the client journey and the platform's current surface.
- **FR-046c**: Where the platform already serves a need, that capability MUST be used as-is rather
  than duplicated — the client's own record, their orders, their invoices, their notifications,
  their supplier's fuel prices and their own profile update among them.
- **FR-047**: Data already fetched MUST be reused across screens within a session rather than
  refetched on every navigation, and MUST be refreshed when the client pulls to refresh.
- **FR-048**: The client's order, invoice, payment and notification lists MUST each be paginated by
  cursor, with the page size decided by the platform rather than requested by the app.
- **FR-048a**: Each list MUST load its next page as the client scrolls, without an explicit action,
  and MUST indicate that a further page is loading.
- **FR-048b**: Each list MUST return records newest-first, so the first page is the one a client
  most likely wants.
- **FR-048c**: Pagination MUST be stable while a client pages: a record inserted or reordered
  between page requests MUST NOT cause an already-seen record to repeat, nor an unseen one to be
  skipped.
- **FR-048d**: A status or date filter MUST be applied by the platform across the client's whole
  set, not by the app across the pages it happens to hold. Filtering MUST NOT silently narrow
  results to the currently loaded pages.
- **FR-048e**: The end of a list MUST be distinguishable from a page still loading and from a page
  that failed; a failed page MUST offer a retry without discarding the pages already shown.
- **FR-048f**: An outstanding invoice MUST be reachable regardless of its age, so that every amount
  counting against the client's credit standing can be inspected.
- **FR-048g**: Pull-to-refresh MUST reset a list to its first page rather than merge new records
  into a partially paged view.

### Key Entities

- **Order**: A client's request for a quantity of a fuel grade to a station, carrying
  its status, chosen payment method, price, assigned driver and vehicle once dispatched, delivery
  timing, and the history of its transitions. The client sees the subset the platform permits.
- **Order Price**: What an order costs the client — the quoted total, the confirmed final total
  once known, and the itemised components that reconcile to it: the fuel line total, the delivery
  fee, the service fee and the tax. Every component is the platform's; none is derived in the app.
- **Invoice**: An amount owed by the client for one or more orders, with issue date, due date,
  amount and settlement status.
- **Payment**: A settlement attempt against an order or invoice, with amount, method, date and
  outcome. Only the platform may record one as successful.
- **Credit Standing**: The client's credit limit, the portion consumed by unsettled orders and
  invoices, and the remaining available balance.
- **Station**: A client's own site that takes fuel deliveries — a named place with its address and
  coordinates, registered to a client by their fuel company. A client may have several; the client
  selects among them and may mark favourites, but may not add or remove them. Note the direction:
  a station *receives* fuel, it does not dispense it. This is the canonical term across the
  platform, the app and this spec (an earlier draft of this spec called it a "delivery location").
- **Fuel Price**: The current rate the client's supplier charges for a fuel grade, from which
  every price the client is shown derives.
- **Pricing Configuration**: A fuel company's flat delivery fee, service fee percentage and tax
  rate, held alongside its fuel prices. The single authority behind every itemised breakdown; the
  figures in force at pricing time are retained on the order.
- **Notification**: A message the platform raised for the client, with its type, subject, time
  and whether it has been read; may reference an order.
- **Client Profile**: The client's own name, phone, picture and registered stations — the subset
  of their account they may view and amend.
- **Support Request**: A problem a client raised, optionally attached to an order, recording who
  raised it, when, their description, and whether a fuel company administrator has acknowledged it.
  It has two states only — submitted and acknowledged — and belongs to the client's fuel company.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of order, invoice, payment, credit, notification, profile, station and price
  values shown to a client originate from the platform; an audit of the client build finds zero
  reachable sample-data definitions.
- **SC-002**: For a client account seeded with a known set of orders, invoices and payments, every
  figure shown on every client screen matches the platform record exactly, verified field by
  field.
- **SC-003**: A client can go from opening the app to a submitted order in under 90 seconds,
  including seeing the real price before confirming.
- **SC-004**: A client's orders list is usable within 2 seconds of opening on a normal mobile
  connection; a slower response shows a loading indication rather than a blank screen.
- **SC-004a**: Time to a usable first page is independent of how many records the client has: a
  client with 500 orders reaches their list no slower than a client with 5, measured across both.
- **SC-004b**: Paging through a client's entire history of orders, invoices, payments and
  notifications produces no repeated and no skipped record across 100% of trials, including trials
  where new records arrive mid-scroll.
- **SC-005**: The price a client is shown at the moment of confirmation matches the amount the
  platform records for that order in 100% of confirmations, or the client is asked to confirm the
  new figure.
- **SC-006**: A delivery in progress reflects a driver's movement within 10 seconds, and a
  delivery whose position has stopped updating is reported as out of date within one staleness
  window.
- **SC-007**: Every client screen reaches content, empty or error-with-retry in 100% of trials
  across normal, slow and disconnected networks; no trial produces a blank or indefinitely
  loading screen.
- **SC-008**: Zero instances of a client viewing data belonging to another client across the
  permission test suite, including direct navigation to identifiers they do not own, and including
  every capability newly added to the platform for this feature.
- **SC-008a**: The itemised components of an order's cost reconcile to its total in 100% of
  orders, and the quote, the receipt and the invoice show the same figures for the same order.
- **SC-008b**: For a client with several registered stations, an order placed against a
  non-default station is recorded by the platform against that station in 100% of trials.
- **SC-009**: Every newly connected screen passes review in both Arabic and English with no
  clipped, mis-ordered or untranslated content.
- **SC-010**: No credential, handover code or payment detail appears in logs across a full
  exercise of the client journey.
- **SC-011**: Support contacts that begin "I can't see my order / my figures are wrong" fall to
  near zero once the app is in front of real clients, measured over the first month.

## Assumptions

- **Existing data layers are reused, not rebuilt.** The orders, invoices, notifications, auth and
  tracking domain and data layers already exist in the app, are registered for injection and are
  exercised by tests; this feature mounts them into the screens rather than writing new ones.
- **The app's architecture is unchanged.** Clean Architecture with cubits, the single-flight
  session-refresh interceptor, and the realtime tracking channel all stay as feature 002 and
  spec 004 established them. This feature does not revisit those decisions.
- **The platform remains the sole authority for state.** Every order, invoice and payment
  transition is decided by the platform; the app requests and reflects, never decides. This is
  already the rule for the driver app and is carried over unchanged.
- **Client permissions extend spec 004's, they do not loosen it.** Spec 004 lets a client read
  their own orders, invoices and profile, create orders, cancel and request re-dispatch, and read
  the current handover code. D1 adds their own payment history, support requests, stations and
  phone verification to that list. Every addition stays self-scoped: nothing here
  lets a client see another client's data, or any data belonging to a fuel or transport company.
- **The driver experience is untouched.** Feature 004 integrated it; this feature changes only
  client-reachable screens and any shared component they use, without regressing the driver build.
- **Handover codes are never shown on a driver build**, and that rule is unaffected here.
- **Existing platform capability is preferred over new.** Where an endpoint already serves a
  need — the client's own record, their invoices, their notifications, their supplier's fuel
  prices, their own profile update — it is used as-is rather than duplicated.
- **Bilingual Arabic-default with full right-to-left support** continues to apply to every screen
  touched.
- **Delivery timing options** offered at order creation are the ones the platform already
  supports; this feature does not introduce new scheduling semantics.
- **Payment gateway integration is unchanged.** The native gateway for direct orders, and the
  platform webhook as the sole confirmation of payment, both stand as feature 002 established
  them; this feature connects the screens around them.
- **Clients have intermittent but generally functional mobile connectivity**, and the app is
  expected to degrade to explicit error states rather than to offline operation. Offline ordering
  is out of scope.
- **The existing backend suites stay green.** The platform changes D1, D2 and D3 require touch
  shared ground — the order record, the user record, tenant isolation — so the existing unit and
  end-to-end suites are treated as a regression gate on this feature, not just the new tests.

## Resolved Decisions

Three decisions materially shaped this feature. All are settled; they are recorded here because
each one carries consequences a reader will otherwise have to reconstruct.

- **D1 — The platform may be extended.** Where a client screen needs data the platform does not
  expose, the platform gains that capability rather than the screen being cut down to fit. Stories
  4, 7, 8 and 9 therefore ship complete. This is the largest driver of scope: it brings payment
  history, phone verification, support requests and the station catalogue into the feature as
  backend work, not just app work. See FR-046 through FR-046c.
- **D2a — "Station" is the canonical term** (clarification session 2026-08-15), keeping the
  backend schema, the app and the feature-002/004 specs as they are. This spec was normalised to
  match rather than the other way round, which avoids a rename across the user record, `/auth/me`,
  the mobile entity and two other specs. What D2 changes is the field's cardinality and ownership,
  not its name.
- **D2 — A client may have several stations, registered by their fuel company.** The
  client selects among them and marks favourites, but cannot add, rename or remove one. This
  replaces today's single embedded station per client and means the fuel company needs a way to
  register them — that administration surface belongs to the web dashboard (feature 003) and is
  called out as a dependency below, not built here. See FR-036 through FR-036d.
- **D3 — Order costs are itemised.** The client sees the fuel line total, the delivery fee, the
  service fee and the tax, and they reconcile to the total. This is a pricing-model change rather
  than plumbing: the platform must gain the fee and tax rules to derive each component, and those
  rules become the single authority behind the quote, the receipt and the invoice alike. See
  FR-011a through FR-011e.

### Consequent dependencies

- **Fee and tax rules are settled** (clarification session 2026-08-15): per fuel company, a flat
  delivery fee, a service fee as a percentage of the fuel line, and a configurable tax rate. See
  FR-011f–FR-011j. What remains is operational rather than definitional — each fuel company needs
  its configuration populated before its clients can be quoted, and FR-011j makes an unconfigured
  company fail loudly rather than quietly quote zero.
- **An SMS provider must be chosen and provisioned.** Phone verification (clarification session
  2026-08-15) is the feature's only new third-party dependency. It needs a provider decision,
  credentials in every environment, and a stance on what happens when the provider is down —
  FR-035f requires the failure to be visible to the client rather than swallowed. This is the one
  item here that has procurement lead time, so it should be started early.
- **Two capabilities now wait on the web dashboard (feature 003), which has no code yet.**
  Registering stations (D2 excludes creating them from the client app) and reading or
  acknowledging support requests both need a fuel company administration surface. Until it exists,
  stations must be seeded directly, and submitted support requests will accumulate unread — which
  is why FR-039b keeps the phone and messaging channels prominent rather than letting the
  submission form imply someone is watching. Neither is acceptable at launch; both are fine during
  development.
- **Existing orders predate the itemised breakdown.** Orders already recorded carry only a total.
  How they present once D3 lands — back-filled, or shown as a total alone — needs deciding during
  planning.
