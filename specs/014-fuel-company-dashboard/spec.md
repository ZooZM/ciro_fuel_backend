# Feature Specification: Fuel Company Admin Dashboard — Live Platform Integration

**Feature Branch**: `013-fuel-company-dashboard`

**Created**: 2026-09-03

**Status**: Draft

**Input**: User description: "link the fuel company admin dashboard to the live platform"

## Context

The web dashboard's fuel company surface is a complete visual build with almost nothing behind it.
Of its 81 files, only the order approve/reject/force-complete actions reach the platform. Every
list, every statistic and every detail screen renders hardcoded sample rows.

The situation mirrors the transport company's equivalent integration closely enough that its
findings are the template here, including the one that blocks everything else: **no fuel company
administrator can sign in to this dashboard at all.** The dashboard's role vocabulary predates the
platform's split of the combined administrator role into separate fuel and transport company roles,
so a genuine fuel company token is discarded when the session is restored. The fuel company screens
are reachable today only through a demo role picker that fabricates a session with a placeholder
credential, which both the session bootstrap and the platform-access layer still honour.

The prior transport integration recorded this defect as fixed. It is not fixed on the dashboard's
main line — the demo picker is still routed, the placeholder credential is still honoured in three
places, and the role vocabulary is unchanged. This specification treats the dashboard's current
state as the ground truth, not the prior feature's notes.

The access boundary is also wrong in the more dangerous direction: the fuel company routes admit
clients, so a station owner passes the guard for the administration surface that sets their own
prices and credit limit.

Beyond the session, this feature has three distinct kinds of work. Most screens map onto platform
capabilities that already exist and need only to be connected. A second group displays figures the
platform has never computed. A third group was built against business capabilities that exist
nowhere in the platform — no data, no operation, no record — and, per the clarification below, those
capabilities are to be built.

### Current state (evidence)

Recorded here because the requirements below depend on it and it contradicts the prior feature's
notes:

- The dashboard's role constants name a single combined administrator role; neither the fuel nor the
  transport company role exists in them.
- The demo role-selection screen is routed, and the placeholder credential it issues is honoured by
  the session bootstrap and by the platform-access layer.
- The fuel company route group admits the client role alongside the combined administrator role.
- The dashboard carries two session stores and two platform-access layers; one of each is unused.
- Two fuel company page folders are empty, and neither has a route pointing at a
  fuel-company-specific screen.
- The invoices screen — including its commission and cashback controls — is the same screen the
  platform operator reaches, so those controls are presented today to both actors identically.

## Clarifications

### Session 2026-09-03

- Q: How should the six surfaces built against absent platform capability be resolved — build,
  delete, or label as preview? → A: Build the platform capability for all six.
- Q: Should per-station and per-owner activity figures be computed by the platform, or dropped? →
  A: Drop week-over-week trends; add simple counts and totals.
- Q: Is the platform operator's surface, which reuses the same components, in scope? → A: Yes, in
  scope.
- Q: Does an accepted fuel exchange request create a delivery on the platform? → A: No — record and
  agreement only; fulfilment is arranged between the two companies off-platform.
- Q: How is commission paid — through an integrated provider, or offline? → A: Both methods (bank
  transfer and the national payment service) are offered, and both are offline; the operator
  confirms each by hand. No payment provider is integrated.
- Q: Who sets the commission ceiling, and when is a company warned? → A: The operator sets it per
  company, with a platform-wide default until they do; the company is warned at 90% of it.
- Q: Does anything move a litre balance automatically? → A: Yes. The fuel company uploads the
  supplier (Aramco) invoice against the order; its quantity is what was actually supplied, the
  shortfall against the ordered quantity is credited to the station owner's litre balance, and that
  balance is drawn down automatically by later orders. Supplier-invoice reconciliation is therefore
  in scope, not deferred.
- Q: How is the supplied quantity obtained from the invoice? → A: The platform extracts it from the
  uploaded document and presents it for the administrator to confirm or correct; nothing moves until
  they confirm.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A fuel company administrator holds a real session (Priority: P1)

An administrator of a fuel company signs in with their real platform credentials and lands on their
own dashboard. They reach every fuel company screen and no other company's screens. A client, a
driver, or a transport company administrator who reaches a fuel company URL is refused. The platform
operator reaches their own surface and not a fuel company's. The demo role picker and the fabricated
session it issues are gone.

**Why this priority**: Nothing else in this feature is verifiable until this lands. Every screen
below needs a credential the platform will accept, and every screen below is currently viewed
through a session the platform never issued. It is also the only slice whose absence is invisible —
the screens render, they simply render to the wrong person on fabricated credentials.

**Independent Test**: Sign in as a seeded fuel company administrator, confirm the session survives a
reload and reaches the fuel company dashboard; sign in as a client and confirm every fuel company
URL is refused; confirm the demo picker no longer exists and no request carries a placeholder
credential.

**Acceptance Scenarios**:

1. **Given** a registered fuel company administrator, **When** they sign in, **Then** their session
   is accepted, retained across a reload, and they are directed to the fuel company dashboard.
2. **Given** a signed-in client, **When** they navigate to any fuel company route, **Then** they are
   refused and never see fuel company data.
3. **Given** a signed-in transport company administrator, **When** they navigate to any fuel company
   route, **Then** they are refused.
4. **Given** a signed-in fuel company administrator, **When** they navigate to any platform operator
   route, **Then** they are refused.
5. **Given** any visitor, **When** they navigate to the former demo role-selection address, **Then**
   no such screen exists.
6. **Given** an administrator whose session has expired, **When** they act on any screen, **Then**
   the session is renewed silently, or they are returned to sign-in if renewal fails.

---

### User Story 2 - The administrator decides on incoming orders (Priority: P2)

A station owner places a fuel order. The fuel company administrator sees it on their orders list,
opens it, and takes the decision only they can take: approve it with a final price, reject it with a
reason, or route it to one of their transporters. For an order stalled beyond recovery they can
force-complete it with a reason; for one no transporter accepted they can redispatch it. They never
see, and cannot invoke, actions belonging to the transporter or the driver.

**Why this priority**: This is the fuel company's actual job on the platform and the only stage of
the delivery chain where their decision is required. An order no one approves never moves.

**Independent Test**: With a seeded order awaiting approval, complete approve, reject, route and
redispatch from the dashboard and confirm each is reflected in the platform's own record and visible
to the station owner.

**Acceptance Scenarios**:

1. **Given** an order awaiting approval, **When** the administrator approves it with a final price,
   **Then** the order advances and the recorded price is the one they entered.
2. **Given** an order awaiting approval, **When** the administrator rejects it with a reason,
   **Then** the order is rejected and the reason is retained on it.
3. **Given** an approved order, **When** the administrator routes it to a transporter, **Then** the
   order becomes visible to that transporter and to no other.
4. **Given** an order the administrator's company is not party to, **When** they attempt any action
   on it, **Then** it is refused and it never appears in their list.
5. **Given** an order in a stage where an action does not apply, **When** the administrator views
   it, **Then** that action is not offered.
6. **Given** two administrators acting on the same order at once, **When** the second decision
   arrives, **Then** it is refused with a clear conflict message rather than silently overwriting.
7. **Given** an orders list longer than one page, **When** the administrator pages through it,
   **Then** no order is duplicated or skipped even while new orders arrive.

---

### User Story 3 - The administrator manages station owners, stations and credit (Priority: P3)

The administrator onboards a station owner, views the owners on their books, opens one to see their
stations, their credit limit and how much of it is used, and sets or changes that limit. They
register, edit and remove stations for an owner, and activate or deactivate an owner. When an owner
asks for a higher limit, the administrator sees the request and accepts it — at the requested amount
or a different one — or rejects it.

**Why this priority**: Station owners are where orders originate. An administrator who cannot
onboard one cannot grow their book, and the credit limit governs whether an owner can order on
deferred terms at all. The limit-request exchange is included here because it is the same actor on
the same screen, and because a limit that can only move when the administrator happens to think of
it is the reason owners are blocked.

**Independent Test**: Onboard an owner, register two stations, set a credit limit, raise a limit
request as that owner and resolve it, edit one station and remove the other — then confirm each from
a second session, and confirm a second fuel company sees none of it.

**Acceptance Scenarios**:

1. **Given** the administrator is on the station owners screen, **When** they onboard an owner,
   **Then** that owner can sign in as a client of this fuel company.
2. **Given** an existing owner, **When** the administrator registers a station for them, **Then**
   that station is available to the owner when placing an order.
3. **Given** an owner with a credit limit, **When** the administrator changes it, **Then** the new
   limit governs that owner's next deferred order.
4. **Given** an owner with unsettled deferred orders, **When** the administrator opens them,
   **Then** the used portion of the limit is shown and matches the platform's own accounting.
5. **Given** an owner requests a higher limit, **When** the administrator accepts it at a lower
   amount than requested, **Then** the accepted amount becomes the limit and the owner is told what
   was granted.
6. **Given** an owner requests a higher limit, **When** the administrator rejects it, **Then** the
   limit is unchanged and the owner is told it was declined.
7. **Given** a second fuel company's owner, **When** the administrator searches for them, **Then**
   they are not found.
8. **Given** an owner with no stations, **When** the administrator opens them, **Then** an empty
   state is shown rather than a blank or broken screen.
9. **Given** an owner is deactivated, **When** they attempt to sign in, **Then** they are refused.

---

### User Story 4 - The administrator manages the transporters they work with (Priority: P4)

The administrator sees the transport companies affiliated with their fuel company, onboards a new
one, opens one to see its contact details and the regions it serves, and sets which regions their
own company covers.

**Why this priority**: Routing an order requires at least one transporter to route to. A single
seeded transporter is enough to exercise Story 2, so this follows rather than blocks.

**Independent Test**: Onboard a transporter, confirm it appears as a routing destination on an
approved order, and confirm its details screen reflects what was entered.

**Acceptance Scenarios**:

1. **Given** the administrator is on the transporters screen, **When** they onboard a transport
   company, **Then** it becomes selectable when routing an order.
2. **Given** an onboarded transporter, **When** the administrator opens it, **Then** its contact
   details and served regions are shown as recorded by the platform.
3. **Given** the administrator sets the regions their company covers, **When** they save, **Then**
   the change is retained and reflected on reload.
4. **Given** a transporter affiliated with a different fuel company, **When** the administrator
   views their list, **Then** it does not appear.

---

### User Story 5 - The administrator sets fuel prices and delivery pricing (Priority: P5)

The administrator sets the per-litre price of each fuel grade their company sells, and the pricing
components that make up a delivery's cost. Prices already in force on placed orders are unaffected
by a later change.

**Why this priority**: Approving an order sets a final price, which depends on these values being
right. It is separated because an order can be approved with a manually entered price while this
screen is still unwired.

**Independent Test**: Change a grade's price and a pricing component, request a fresh quote as a
station owner, and confirm the quote reflects the new values while an order placed beforehand does
not.

**Acceptance Scenarios**:

1. **Given** the administrator changes a fuel grade's price, **When** an owner next requests a
   quote, **Then** the quote uses the new price.
2. **Given** an order placed before a price change, **When** it is viewed afterwards, **Then** it
   still shows the price in force when it was placed.
3. **Given** the administrator enters an invalid price, **When** they save, **Then** the change is
   refused with a message naming what is wrong.
4. **Given** a fuel grade the platform does not recognise, **When** the screen renders, **Then**
   only the platform's own grades are offered.

---

### User Story 6 - The administrator works their invoices (Priority: P6)

The administrator sees the invoices their company is party to, opens one to see the order behind it,
and settles one that has been paid.

**Why this priority**: An invoice exists from the moment an order is approved, not from the moment it
is delivered, so this is exercisable as soon as Story 2 works — without a driver, a truck or a
completed delivery. It sits here because settling one is only meaningful once orders are really
flowing, not because it is blocked.

**Independent Test**: Complete an order end to end, confirm its invoice appears, settle it, and
confirm the settlement is reflected for the counterparty.

**Acceptance Scenarios**:

1. **Given** a completed order, **When** the administrator opens the invoices screen, **Then** its
   invoice is listed.
2. **Given** an unsettled invoice, **When** the administrator settles it, **Then** it is recorded as
   settled and the counterparty sees it as settled.
3. **Given** an invoice belonging to another company, **When** the administrator lists invoices,
   **Then** it does not appear.
4. **Given** an already-settled invoice, **When** the administrator views it, **Then** settlement is
   not offered again.

---

### User Story 7 - The administrator opens the dashboard and sees their real position (Priority: P7)

The home screen shows counts and totals drawn from the administrator's own company's real activity —
orders by stage, station owners, stations, amounts outstanding — with no fabricated figure anywhere
on it. Quick actions lead to the screens that perform them.

**Why this priority**: It is the first screen an administrator sees, which is exactly why it must
not show invented numbers; but every figure on it summarises data the other stories expose directly.

**Independent Test**: With a known seeded data set, confirm every figure on the home screen matches
what the corresponding list screen shows.

**Acceptance Scenarios**:

1. **Given** a known set of orders, **When** the administrator opens the dashboard, **Then** each
   count matches the orders list filtered to the same stage.
2. **Given** a figure the platform does not compute, **When** the dashboard renders, **Then** that
   figure is absent rather than fabricated.
3. **Given** the dashboard is open, **When** the underlying data changes, **Then** the screen
   reflects the change without the administrator reloading.
4. **Given** the browser tab is hidden, **When** it is not in view, **Then** the screen stops
   refreshing until it is shown again.

---

### User Story 8 - The administrator receives notifications and answers support requests (Priority: P8)

The administrator sees their real notifications and marks them read, sees support requests raised by
their station owners and acknowledges them, and sees their real account and company details on their
profile.

**Why this priority**: Real, backed and self-contained, but none of it blocks the delivery chain.
The support inbox is the one item with a live platform capability and no screen at all today.

**Independent Test**: Raise a support request as a station owner, confirm it appears for the
administrator, acknowledge it, and confirm the owner sees it acknowledged.

**Acceptance Scenarios**:

1. **Given** an unread notification, **When** the administrator opens the notifications screen,
   **Then** it is listed, and marking it read is retained across a reload.
2. **Given** a station owner raises a support request, **When** the administrator opens the support
   screen, **Then** it is listed with the owner's message.
3. **Given** a support request, **When** the administrator acknowledges it, **Then** the owner sees
   it as acknowledged.
4. **Given** the administrator opens their profile, **When** it renders, **Then** it shows their
   real name, company and role rather than sample values.

---

### User Story 9 - The platform charges commission and pays cashback (Priority: P9)

The platform operator sets the commission the platform charges on each transport invoice, expressed
either as a percentage of the invoice or as an amount per unit of currency, and sets a cashback
programme paying a proportion back on each invoice that is paid — either to every company or to
named companies — which they can switch on and off. Commission accrues against each company as
invoices are raised, cashback accrues as invoices are paid, and both balances are visible to the
company they belong to. A company that accrues commission beyond its ceiling is barred from further
deferred dealing until it pays.

**Why this priority**: This is net-new platform capability, valuable but not on the delivery
critical path — orders complete without it. It precedes the ledger and payment story because those
settle the balances this one creates.

**Independent Test**: Set a commission rate as the operator, complete and pay an invoice, and
confirm the accrued commission and cashback match the rate; switch the cashback programme off and
confirm the next paid invoice accrues none.

**Acceptance Scenarios**:

1. **Given** the operator sets a commission rate as a percentage, **When** a transport invoice is
   raised, **Then** commission accrues against the company at that percentage.
2. **Given** the operator sets the commission as an amount per unit of currency, **When** an invoice
   is raised, **Then** commission accrues at that rate, and the screen states which basis is in use.
3. **Given** a rate change, **When** it is applied, **Then** commission already accrued is
   unchanged and only later invoices use the new rate.
4. **Given** the cashback programme is active for all companies, **When** an invoice is paid,
   **Then** cashback accrues to the paying company at the set rate.
5. **Given** the cashback programme targets named companies, **When** a company not named pays an
   invoice, **Then** no cashback accrues to it.
6. **Given** the cashback programme is switched off, **When** an invoice is paid, **Then** no
   cashback accrues.
7. **Given** a fuel company administrator views the commission and cashback terms, **When** the
   screen renders, **Then** the terms are shown as read-only and cannot be changed by them.
8. **Given** a company whose accrued commission reaches 90% of its ceiling, **When** it opens the
   dashboard, **Then** it is warned, and the warning states the accrued amount and the ceiling.
9. **Given** a company whose accrued commission exceeds its ceiling, **When** it attempts further
   deferred dealing, **Then** it is refused with the ceiling named, and **When** a confirmed payment
   brings it back below the ceiling, **Then** dealing resumes without operator intervention.
10. **Given** a newly onboarded company for which no ceiling has been set, **When** commission
    accrues against it, **Then** the platform-wide default ceiling governs it.

---

### User Story 10 - A company settles its account with the platform (Priority: P10)

The administrator sees the ledger of movements between their company and the platform — commission
charged, cashback paid, transfers made — with each movement's amount, method, date, supporting
document and state. They pay commission owed, in full or in part, by bank transfer or by the
national payment service, attaching a transfer document where one applies. The operator confirms a
transfer and the ledger records it.

**Why this priority**: Settles the balances Story 9 creates and is meaningless without them.

**Independent Test**: Accrue commission, pay part of it with a document attached, confirm the
movement appears as awaiting confirmation, confirm it as the operator, and confirm the balance falls
by the paid amount.

**Acceptance Scenarios**:

1. **Given** commission is owed, **When** the administrator opens the platform account screen,
   **Then** the amount owed and every prior movement are listed.
2. **Given** the administrator pays in full, **When** the payment is recorded, **Then** the balance
   owed becomes zero once confirmed.
3. **Given** the administrator pays in part, **When** the payment is recorded, **Then** the balance
   falls by exactly that amount once confirmed and the remainder stays owed.
4. **Given** a payment requires a supporting document, **When** none is attached, **Then** the
   payment is refused with the reason stated.
5. **Given** a recorded payment, **When** the operator confirms it, **Then** it is shown as
   confirmed to both parties and the balance updates.
6. **Given** a recorded payment awaiting confirmation, **When** the administrator views it, **Then**
   it is distinguishable from a confirmed one and is not counted as paid.
7. **Given** the ledger is longer than one page, **When** the administrator pages through it,
   **Then** no movement is duplicated or skipped.
8. **Given** an attached document, **When** either party opens it, **Then** it is retrievable, and
   no other company can retrieve it.

---

### User Story 11 - Supplier invoices reconcile what was ordered against what was supplied (Priority: P11)

An order is placed for a quantity of fuel. The fuel company buys that fuel from the supplier, and
the supplier's invoice states the quantity actually supplied — which is rarely the quantity ordered.
The administrator uploads that invoice against the order. The platform records the supplied
quantity, shows how much of the order it fulfilled, and credits the shortfall to the station owner
as a balance of litres owed, held per fuel grade. Later orders by that owner draw the balance down
automatically. The owner sees their own balance. Where a balance is wrong for a reason outside this
flow, the administrator can correct it, and the correction carries a reason and their name.

**Why this priority**: This is what makes the delivery chain financially honest — without it, an
owner who ordered 33,000 litres and received 31,501 has no record of the 1,499 they are owed. It
comes late because it needs orders completing (Story 2) and owners on the books (Story 3), and
because nothing else depends on it.

**Independent Test**: Place an order for a known quantity, upload a supplier invoice for a smaller
quantity, and confirm the shortfall appears as a balance for that owner and grade; place a second
order for that owner and confirm the balance is drawn down.

**Acceptance Scenarios**:

1. **Given** an order, **When** the administrator uploads the supplier invoice against it, **Then**
   the platform presents the quantity, grade, reference and date it extracted, alongside the ordered
   quantity, and records nothing until the administrator confirms.
1a. **Given** an extracted quantity the administrator judges wrong, **When** they correct it and
   confirm, **Then** the corrected value is what is recorded and what moves the balance, and what
   was originally extracted is retained.
1b. **Given** a document the platform cannot read, **When** it is uploaded, **Then** the
   administrator is able to enter the values by hand and the reconciliation proceeds.
2. **Given** a supplier invoice recording less than the ordered quantity, **When** it is recorded,
   **Then** the shortfall is credited to that owner's balance for that fuel grade, and the screen
   states the supplied quantity, the ordered quantity, the proportion fulfilled and the shortfall.
3. **Given** a supplier invoice recording the ordered quantity exactly, **When** it is recorded,
   **Then** no balance movement occurs.
4. **Given** a supplier invoice recording more than the ordered quantity, **When** it is recorded,
   **Then** the excess reduces the owner's existing balance for that grade, and the outcome is
   stated explicitly if the balance would fall below zero.
5. **Given** an owner with a balance for a fuel grade, **When** they place a later order for that
   grade, **Then** the balance is drawn down automatically and both the amount drawn and the
   remaining balance are shown before the order is placed.
6. **Given** a balance requiring correction outside this flow, **When** the administrator adjusts it
   with a reason, **Then** the new balance, the reason and their name are retained.
7. **Given** an adjustment attempted without a reason, **When** it is saved, **Then** it is refused.
8. **Given** an order that already has a supplier invoice, **When** a second is uploaded, **Then**
   it is refused, or it replaces the first and the balance movement is restated — never applied
   twice.
9. **Given** an owner of another fuel company, **When** the administrator attempts to view their
   balance, **Then** they are refused.
10. **Given** a station owner, **When** they view their own balance, **Then** it matches what the
    administrator sees, and every movement on it is traceable to the order or adjustment that caused
    it.

---

### User Story 12 - Fuel companies exchange fuel with one another (Priority: P12)

A fuel company administrator raises a request to another fuel company for a quantity of a fuel grade
at a price, for delivery at a stated time and place. The receiving company sees it among its
incoming requests and accepts or declines it. Each company sees its incoming and outgoing requests
separately, with the counterparty, grade, quantity, unit price and total on each, and can open one
to see its full terms and the counterparty's contact details.

**Why this priority**: An entirely new business domain between two fuel companies, touching no part
of the client-to-driver delivery chain. Largest and least coupled, so last.

**Independent Test**: Raise a request as one fuel company, accept it as the other, and confirm each
side sees it in the correct direction with the same terms.

**Acceptance Scenarios**:

1. **Given** an administrator raises an exchange request, **When** it is submitted, **Then** it
   appears among their outgoing requests and among the recipient's incoming requests.
2. **Given** an incoming request, **When** the recipient accepts it, **Then** both parties see it as
   accepted with the supplier and receiver identified.
3. **Given** an incoming request, **When** the recipient declines it, **Then** both parties see it
   as declined and it can no longer be accepted.
4. **Given** a request awaiting a response, **When** the raising company withdraws it, **Then** the
   recipient can no longer act on it.
5. **Given** a request, **When** either party opens it, **Then** the grade, quantity, unit price,
   total, delivery time and place, and the counterparty's contact details are shown.
6. **Given** a request between two other companies, **When** an administrator lists requests,
   **Then** it does not appear.
7. **Given** an administrator raises a request, **When** they enter a quantity or price the platform
   rejects, **Then** it is refused with the reason stated.
8. **Given** the exchange screen is open, **When** the administrator filters, **Then** they can see
   incoming and outgoing requests separately or together.
9. **Given** an accepted exchange request, **When** either party views the orders list, **Then** no
   order or delivery has been created from it.

---

### User Story 13 - The platform operator oversees fuel companies (Priority: P13)

The operator sees the fuel companies on the platform, onboards one, opens one to see its station
owners, stations, invoices and platform account, sets the commission and cashback terms, confirms
company payments, and sees exchange requests across the platform.

**Why this priority**: Every screen here reuses a component another story rewires, so it can only be
finished once they are. It is included because leaving it out would leave those shared components
half-migrated and the operator's screens silently broken.

**Independent Test**: As the operator, onboard a fuel company, open it, and confirm every figure
matches what that company's own administrator sees.

**Acceptance Scenarios**:

1. **Given** the operator opens the fuel companies screen, **When** it renders, **Then** every fuel
   company on the platform is listed with real figures.
2. **Given** the operator onboards a fuel company, **When** it is created, **Then** its
   administrator can sign in.
3. **Given** the operator opens a fuel company, **When** it renders, **Then** its station owners,
   stations, invoices and platform account are shown as that company's own administrator sees them.
4. **Given** a shared screen, **When** the operator and a fuel company administrator each open it,
   **Then** each sees only what their role permits, and controls reserved to the operator are absent
   for the administrator.
5. **Given** the operator suspends a fuel company, **When** its administrator signs in, **Then**
   they are refused and told why.

---

### Edge Cases

- A fuel company administrator whose company has been suspended signs in — refused, with the reason
  stated rather than an empty dashboard.
- The session expires mid-action, between opening a dialog and confirming it — the action completes
  after silent renewal, or is refused cleanly with entered values preserved.
- Two administrators of the same company approve the same order simultaneously — one succeeds, the
  other is told it has already been decided.
- An order is approved for an owner whose credit limit was exhausted in the interim — the refusal
  names the credit limit.
- An order is routed to a transporter deactivated between the list rendering and the decision — the
  refusal names the transporter's status.
- A credit limit is lowered below what an owner has already drawn — the outcome is stated explicitly
  rather than leaving a negative remainder.
- A limit request is resolved by one administrator while another is resolving it — one resolution
  applies and the second is told it is already resolved.
- A company's commission ceiling is reached mid-order — the refusal names the ceiling, and the order
  is not left half-placed.
- Commission accrues on an invoice that is later voided — the accrual is reversed rather than left
  standing.
- A payment is recorded and never confirmed — it remains distinguishable from a confirmed payment
  indefinitely and is never counted against the balance.
- An exchange request is accepted by the recipient at the moment the raiser withdraws it — one
  outcome applies and both parties see the same one.
- An exchange request names a fuel grade the recipient does not sell — refused at submission with
  the reason stated.
- The platform misreads a quantity from an invoice and the administrator confirms it without
  noticing — the confirmation screen shows the ordered quantity beside it, and both the extracted
  and confirmed values are retained so the misreading is discoverable afterwards.
- A document is uploaded that is not an invoice at all, or is unreadable — the administrator is
  offered manual entry rather than being blocked.
- An administrator abandons an upload at the confirmation step — nothing is recorded and no balance
  moves.
- A supplier invoice is uploaded twice for the same order, or the upload is retried after a timeout
  — the balance moves once, never twice.
- A supplier invoice is uploaded for an order that was cancelled or rejected — refused, with the
  order's state named.
- A supplier invoice records a quantity far larger than ordered, enough to take the owner's balance
  below zero — the outcome is stated explicitly at the point of recording rather than leaving a
  negative balance.
- An owner's balance is drawn down by an order that is later cancelled — the draw-down is returned
  to the balance.
- An owner holds a balance in a fuel grade their fuel company has stopped selling — the balance
  remains visible and is not silently discarded.
- A list returns no rows — an empty state distinguishes "you have none" from "we could not load
  them".
- The platform is unreachable — every screen shows a retryable error rather than an empty list that
  reads as zero.
- A station is removed while an order against it is in flight — the order retains the station
  details recorded when it was placed.
- An administrator opens a screen belonging to a company that is not theirs by editing the address —
  refused.

## Requirements *(mandatory)*

### Functional Requirements

#### Session, identity and access (Story 1)

- **FR-001**: The dashboard MUST recognise the platform's five current roles — platform operator,
  fuel company administrator, transport company administrator, client and driver — replacing the
  superseded combined-administrator role.
- **FR-002**: A fuel company administrator MUST be able to sign in with real platform credentials
  and have that session accepted, retained across reloads, and renewed silently when it expires.
- **FR-003**: The dashboard MUST NOT accept, issue or honour any fabricated session or placeholder
  credential. The demo role-selection screen and every path honouring a placeholder credential MUST
  be removed.
- **FR-004**: Every fuel company route MUST admit fuel company administrators only. Clients,
  drivers, transport company administrators and the platform operator MUST be refused before any
  fuel company data is requested.
- **FR-005**: Every platform operator route MUST admit the platform operator only.
- **FR-006**: A failed session renewal MUST return the administrator to sign-in. An access refusal
  MUST NOT be treated as an expired session.
- **FR-007**: The dashboard MUST have exactly one session store and exactly one platform-access
  layer; the unused duplicate of each MUST be removed.

#### Orders (Story 2)

- **FR-008**: The administrator MUST see the orders their company is party to, and no others.
- **FR-009**: The orders list MUST page without duplicating or skipping rows while orders are being
  created.
- **FR-010**: The administrator MUST be able to filter orders by delivery stage, using the
  platform's stage vocabulary in full.
- **FR-011**: The dashboard MUST represent every delivery stage the platform defines. An
  unrecognised stage MUST be displayed as its platform value rather than omitted or mislabelled.
- **FR-012**: The administrator MUST be able to approve an order, supplying the final price.
- **FR-013**: The administrator MUST be able to reject an order, supplying a reason.
- **FR-014**: The administrator MUST be able to route an approved order to one of their affiliated
  transporters.
- **FR-015**: The administrator MUST be able to redispatch an order no transporter accepted.
- **FR-016**: The administrator MUST be able to force-complete a stalled order, supplying a reason.
- **FR-017**: The dashboard MUST NOT offer the administrator any action reserved to another role —
  in particular driver verification, loading confirmation, vehicle reassignment, verification
  override, stop resolution, driver assignment and order cancellation.
- **FR-018**: An action that does not apply at the order's current stage MUST NOT be offered.
- **FR-019**: A refused action MUST show the platform's own reason. A conflicting simultaneous
  decision MUST be reported as a conflict, not as a generic failure.
- **FR-020**: The order detail screen MUST show the order's owner, station, fuel grade, quantity,
  itemised cost, assigned transporter and driver where each is recorded, and MUST omit rather than
  invent any that is absent.
- **FR-021**: Where the platform refuses to show a live position for an order, the dashboard MUST
  report the platform's reason rather than judging trackability locally.

#### Station owners, stations and credit (Story 3)

- **FR-022**: The administrator MUST see the station owners registered to their company, and no
  others.
- **FR-023**: The administrator MUST be able to onboard a station owner.
- **FR-024**: The administrator MUST be able to view an owner's stations, and to register, edit and
  remove a station for them.
- **FR-025**: The dashboard MUST be able to list every station belonging to the administrator's
  company across all its owners, not one owner at a time.
- **FR-026**: The administrator MUST be able to set and change an owner's credit limit, and MUST see
  how much of that limit is currently drawn.
- **FR-027**: The administrator MUST be able to activate and deactivate an owner; a deactivated
  owner MUST be refused sign-in.
- **FR-028**: A station's region and governorate MUST be set together and MUST be consistent with
  each other; an inconsistent pair MUST be refused with a message naming the inconsistency.
- **FR-029**: A station owner MUST be able to request an increase to their credit limit, stating the
  amount requested.
- **FR-030**: The administrator MUST be able to accept a limit request at the requested amount or a
  different one, or reject it, and the outcome MUST be communicated to the owner.
- **FR-031**: A limit request MUST be resolvable exactly once; a second resolution MUST be refused
  as already resolved.
- **FR-032**: Lowering a limit below the amount already drawn MUST be permitted only with the
  consequence stated explicitly at the point of the change.

#### Transporters (Story 4)

- **FR-033**: The administrator MUST see the transport companies affiliated with their company.
- **FR-034**: The administrator MUST be able to onboard a transport company.
- **FR-035**: The administrator MUST be able to view a transporter's recorded contact details and
  served regions.
- **FR-036**: The administrator MUST be able to set the regions their own company covers.

#### Pricing (Story 5)

- **FR-037**: The administrator MUST be able to view and set the per-litre price of each fuel grade
  their company sells, using the platform's grade vocabulary and no other.
- **FR-038**: The administrator MUST be able to view and set the delivery pricing components their
  company charges.
- **FR-039**: A price change MUST NOT alter the cost recorded on any order placed before it.
- **FR-040**: An invalid price or pricing component MUST be refused with a message naming the
  invalid value.

#### Invoices (Story 6)

- **FR-041**: The administrator MUST see the invoices their company is party to, and no others.
- **FR-042**: The administrator MUST be able to open an invoice and see the order behind it.
- **FR-043**: The administrator MUST be able to settle an unsettled invoice; settlement MUST NOT be
  offered on one already settled.

#### Dashboard home (Story 7)

- **FR-044**: The home screen MUST show only figures derived from the administrator's own company's
  real activity.
- **FR-045**: The dashboard MUST be able to obtain order counts for a fuel company.
- **FR-046**: The platform MUST supply counts and totals for the entities a fuel company owns —
  orders by stage, station owners, stations, and amounts outstanding.
- **FR-047**: Week-over-week and other period-comparison trend figures MUST NOT be displayed. The
  platform retains no historical baseline to compute them from, and a fabricated trend is
  indistinguishable from a real one.
- **FR-048**: Every figure the platform does not compute MUST be absent rather than fabricated,
  estimated or zero-filled. No screen MUST display a value the platform did not supply, except where
  computed entirely from values the platform supplied on the same screen. *(Amended after analysis:
  absorbs former FR-094, a near-duplicate of this rule.)*
- **FR-049**: List, detail and count screens MUST update without the administrator reloading, at the
  longest interval that still meets the freshness each screen requires.
- **FR-050**: No screen MUST refresh while its browser tab is hidden.
- **FR-051**: Quick actions MUST navigate to the screen that performs them; an action with no
  destination MUST NOT be shown.

#### Notifications, support and profile (Story 8)

- **FR-052**: The administrator MUST see their real notifications and be able to mark one read, with
  the read state retained.
- **FR-053**: The administrator MUST be able to see support requests raised by their station owners
  and acknowledge one.
- **FR-054**: The profile screen MUST show the administrator's real account and company details.

#### Platform commission and cashback (Story 9)

- **FR-055**: The platform operator MUST be able to set the commission the platform charges,
  expressed either as a percentage of each invoice or as an amount per unit of invoice value, and
  the screen MUST state which basis is in force.
- **FR-056**: Only the platform operator MUST be able to change the commission terms. A fuel company
  administrator MUST see them read-only.
- **FR-057**: Commission MUST accrue against a company as invoices are raised, at the rate in force
  when each invoice was raised.
- **FR-058**: A commission rate change MUST NOT alter commission already accrued.
- **FR-059**: The platform operator MUST be able to set a cashback rate on the same two bases,
  switch the programme on and off, and target it at every company or at named companies.
- **FR-060**: Cashback MUST accrue to a company as its invoices are paid, only while the programme
  is active and only if that company is targeted.
- **FR-061**: A company MUST see its own accrued commission and cashback balances.
- **FR-062**: Every company MUST have a commission ceiling — the maximum accrued commission it may
  owe the platform before further deferred dealing is refused.
- **FR-062a**: The platform operator MUST set the ceiling per company. A company MUST NOT be able to
  set or change its own ceiling, and MUST be able to see it.
- **FR-062b**: A platform-wide default ceiling MUST apply to a company for which the operator has
  set none, so that no company is ever without one. The operator MUST be able to change that
  default; changing it MUST NOT alter a ceiling the operator has set explicitly for a company.
- **FR-062c**: A company MUST be warned once its accrued commission reaches 90% of its ceiling, and
  the warning MUST state the accrued amount and the ceiling.
- **FR-062d**: Once accrued commission exceeds the ceiling, further deferred dealing MUST be refused
  with the ceiling named as the reason. Dealing MUST resume automatically once confirmed payment
  brings the accrued amount back below the ceiling.
- **FR-063**: Commission or cashback accrued against an invoice that is subsequently voided MUST be
  reversed when it is voided. *(Amended after analysis, then confirmed during implementation: at
  planning time no invoice-void path had been confirmed to exist, so this requirement was made
  conditional pending research.md's Open Items. Implementation task T011 found one —
  `InvoicesService.voidInvoice`, called from order cancellation — so the requirement reverts to an
  unconditional MUST.)*

#### Platform account and settlement (Story 10)

- **FR-064**: A company MUST see the ledger of movements between it and the platform, each showing
  its reference, kind, amount, method, date, state and supporting document where one exists.
- **FR-065**: The administrator MUST be able to pay commission owed, in full or in a stated part.
- **FR-066**: The administrator MUST be able to pay by bank transfer or by the national payment
  service.
- **FR-066a**: Neither payment method MUST be integrated with a payment provider. For each, the
  platform displays the details needed to pay elsewhere — account details and beneficiary for a bank
  transfer, a reference for the national payment service — and records what the payer reports having
  paid. The platform never initiates, takes or receives a payment.
- **FR-066b**: A payment reference the platform displays MUST state the period it remains valid for,
  and MUST NOT be presented as proof that anything has been paid.
- **FR-067**: Every recorded payment MUST carry evidence — an uploaded document, or the reference it
  was paid against. A payment recorded without evidence MUST be refused, naming the requirement.
- **FR-067a**: Every recorded payment MUST be confirmed by the platform operator by hand. No payment
  MUST ever be confirmed automatically, whichever method was used.
- **FR-068**: A recorded payment MUST be distinguishable from a confirmed one and MUST NOT reduce
  the balance owed until confirmed.
- **FR-069**: The platform operator MUST be able to confirm a recorded payment, after which both
  parties see it as confirmed and the balance reflects it.
- **FR-070**: A supporting document MUST be retrievable by the paying company and the platform
  operator, and by no one else.
- **FR-071**: The ledger MUST page without duplicating or skipping movements.
- **FR-072**: A partial payment MUST reduce the balance by exactly the amount paid and leave the
  remainder owed.

#### Supplier invoices and litre balances (Story 11)

- **FR-073**: The platform MUST hold, per station owner and per fuel grade, a balance of litres owed
  to that owner by their fuel company.
- **FR-073a**: The administrator MUST be able to upload a supplier invoice against an order, and the
  platform MUST record from it the quantity actually supplied, the fuel grade, the invoice's own
  reference and issue date, and the document itself.
- **FR-073a-i**: On upload, the platform MUST attempt to extract the supplied quantity, fuel grade,
  invoice reference and issue date from the document, and MUST present what it extracted to the
  administrator for confirmation.
- **FR-073a-ii**: The administrator MUST be able to correct any extracted value before confirming.
  No balance MUST move, and no value MUST be recorded, until they confirm.
- **FR-073a-iii**: Where extraction fails or yields nothing for a value, the administrator MUST be
  able to enter that value by hand. A failed extraction MUST NOT block the upload or the
  reconciliation.
- **FR-073a-iv**: The platform MUST retain both what it extracted and what the administrator
  confirmed, so that a systematic misreading is discoverable after the fact.
- **FR-073a-v**: The confirmation step MUST show the ordered quantity alongside the extracted one,
  so a misread is visible as an implausible shortfall before it is confirmed rather than after.
- **FR-073b**: The platform MUST show, for an order with a supplier invoice, the quantity ordered,
  the quantity supplied, the proportion of the order fulfilled, and the shortfall.
- **FR-073c**: A shortfall between the ordered and supplied quantities MUST be credited to that
  order's station owner as a balance of litres for that fuel grade.
- **FR-073d**: A supplied quantity exceeding the ordered quantity MUST reduce that owner's balance
  for that grade. Where the reduction would take the balance below zero, the outcome MUST be stated
  explicitly rather than leaving a negative balance unexplained.
- **FR-073e**: An order MUST accrue a balance movement from its supplier invoice at most once, even
  if the upload is repeated or retried. Replacing an invoice MUST restate the movement, never apply
  a second one.
- **FR-073f**: A supplier invoice MUST be retrievable by the fuel company that uploaded it and by
  the platform operator, and by no one else. Its quantity MUST NOT be alterable after recording
  except by replacing the invoice.
- **FR-073g**: A supplier invoice whose fuel grade differs from the order's MUST be refused, naming
  the mismatch.
- **FR-074**: A later order by an owner holding a balance for that fuel grade MUST draw the balance
  down automatically, and the amount drawn and the remaining balance MUST be shown before the order
  is placed.
- **FR-074a**: The administrator MUST be able to correct a balance directly for reasons outside the
  supplier-invoice flow. Every correction MUST carry a reason and be attributed to the administrator
  who made it.
- **FR-075**: A correction without a reason MUST be refused.
- **FR-075a**: Every movement on a balance MUST be traceable to the order or the correction that
  caused it.
- **FR-076**: A station owner MUST be able to see their own balances and their movements, and no one
  else's.
- **FR-077**: Balances MUST be shown only for the fuel grades the owner's fuel company sells.

#### Fuel exchange (Story 12)

- **FR-078**: A fuel company administrator MUST be able to raise an exchange request to another fuel
  company, stating the fuel grade, quantity, unit price, delivery time and delivery place.
- **FR-079**: A request MUST be visible to the raising company as outgoing and to the receiving
  company as incoming, and to no other company.
- **FR-080**: The receiving company MUST be able to accept or decline a request awaiting response.
- **FR-081**: The raising company MUST be able to withdraw a request awaiting response.
- **FR-082**: A request MUST reach a final outcome exactly once; a second attempt to resolve it MUST
  be refused as already resolved.
- **FR-083**: An accepted request MUST identify which party is supplier and which is receiver.
- **FR-084**: The administrator MUST be able to see incoming and outgoing requests separately or
  together, and to open one to see its full terms and the counterparty's contact details.
- **FR-085**: A request naming a fuel grade the receiving company does not sell MUST be refused at
  submission, with the reason stated.
- **FR-086**: An invalid quantity or price MUST be refused with the reason stated.
- **FR-086a**: An accepted exchange request MUST NOT create a delivery, an order, or a transport
  assignment on the platform. The platform records the agreed terms and the outcome; the two
  companies arrange fulfilment between themselves. The delivery time and place on a request are
  terms of that agreement, not instructions to the platform.
- **FR-086b**: The counterparty's contact details MUST be disclosed only to the two companies party
  to a request, and only once a request exists between them.

#### Platform operator oversight (Story 13)

- **FR-087**: The platform operator MUST see every fuel company on the platform, with real figures.
- **FR-088**: The platform operator MUST be able to onboard a fuel company, after which its
  administrator can sign in.
- **FR-089**: The platform operator MUST be able to open a fuel company and see its station owners,
  stations, invoices and platform account as that company's administrator sees them.
- **FR-090**: The platform operator MUST be able to suspend a fuel company, after which its
  administrator is refused sign-in and told why.
- **FR-091**: Where a screen serves both the platform operator and a fuel company administrator, it
  MUST present each only what their role permits, and controls reserved to the operator MUST be
  absent — not merely disabled — for the administrator.

#### Cross-cutting

- **FR-092**: Every screen MUST distinguish loading, empty and error states. An empty list MUST NOT
  read as a failure, and a failure MUST NOT read as zero.
- **FR-093**: Every error state MUST offer a retry that does not require a page reload.
- **FR-095**: New and rebuilt screens MUST be fully bilingual (Arabic default, right-to-left, and
  English). Untouched screens are not retrofitted.
- **FR-096**: Text entered by any company, owner or driver MUST NOT be rendered as markup.
- **FR-097**: Roles, delivery stages, fuel grades, movement kinds, request states and route
  addresses MUST be defined once as named constants, never written as literal values at the point of
  use.
- **FR-098**: Every monetary amount MUST state its currency, and every quantity its unit.
- **FR-099**: Every new record introduced by this feature MUST be scoped so that no company can read
  or write another company's records, by an automatic platform-wide mechanism — never by
  hand-written per-feature filters. The mechanism MUST match the record's **ownership**: the
  existing single-owner mechanism where one company owns the record; the existing multi-party
  mechanism where several roles inside one company must read it; and a membership-based mechanism
  where **more than one company** must read it. The test is whether more than one *company* must
  read the record, not whether more than one *role* must. *(Amended after analysis: as originally
  worded this requirement mandated the multi-party mechanism for every new record, which research
  R3 shows would make a fuel exchange request permanently invisible to its recipient.)*

### Key Entities

- **Fuel company**: Carries the grades it sells and their prices, its delivery pricing components,
  the regions it covers, its affiliated transporters, its station owners, its commission and
  cashback balances, and its commission ceiling.
- **Station owner**: A client of a fuel company, holding a credit limit, the portion drawn, an
  active state, litre balances per grade, and one or more stations.
- **Station**: A delivery destination belonging to one owner, with a name, region and governorate,
  address and location.
- **Order**: A fuel delivery, party to the owner, fuel company, transport company and driver, with
  its stage, grade, quantity and the itemised cost as it stood when placed.
- **Transport company**: A carrier affiliated with a fuel company, to which approved orders route.
- **Invoice**: A billing record against a completed order, with its parties and settlement state.
- **Credit limit request**: An owner's request for a higher limit, with the amount requested, its
  state, and the amount granted where accepted.
- **Supplier invoice**: The supplier's record of what was actually supplied against one order —
  its reference, issue date, fuel grade, quantity supplied, and the document itself.
- **Litre balance**: Litres owed by a fuel company to one station owner for one fuel grade, with a
  movement history. Each movement is traceable to the order whose supplier invoice caused it, or to
  a correction carrying a reason and its author.
- **Commission terms**: The basis (percentage or per-unit), the rate, and when each came into force.
- **Cashback programme**: The basis, the rate, whether active, and whether it targets every company
  or named companies.
- **Account movement**: One entry in a company's ledger with the platform — its kind (commission
  charged, cashback paid, transfer made), amount, method, date, state, and supporting document.
- **Exchange request**: A request between two fuel companies for a quantity of a grade at a price for
  a stated delivery, with its direction, state, and the parties' roles once accepted.
- **Support request**: A message from a station owner to their fuel company, raised or acknowledged.
- **Notification**: A message addressed to an administrator, read or unread.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fuel company administrator signs in with real credentials and reaches their
  dashboard; the session survives a reload. 100% of attempts by a client, driver, transport company
  administrator or platform operator to reach a fuel company screen are refused, and vice versa.
- **SC-002**: No screen in the fuel company or operator surface displays a value the platform did
  not supply. Verified by inspection: zero hardcoded sample records remain in any screen that ships.
- **SC-003**: An administrator takes an order from awaiting-approval to routed in under 60 seconds,
  and the station owner sees each change without reloading.
- **SC-004**: Every order decision taken on the dashboard is reflected identically in the platform's
  own record, 100% of the time.
- **SC-005**: An administrator onboards a station owner, registers a station and sets a credit limit
  in under 3 minutes.
- **SC-006**: Zero records belonging to another company are visible on any screen, in any list, or
  through any address entered directly — verified for every list and detail screen, and for every
  record type this feature introduces.
- **SC-007**: Every list, detail and action screen renders a distinguishable loading, empty and
  error state, and every error state offers a working retry.
- **SC-008**: Two administrators deciding on the same order, credit limit request, or exchange
  request simultaneously produce one applied outcome and one clear conflict message — never two
  applied outcomes, never an unexplained failure.
- **SC-009**: Every figure on the home screen matches the corresponding list screen for the same
  seeded data set.
- **SC-010**: The dashboard issues no platform requests while its tab is hidden.
- **SC-011**: For a seeded set of invoices, accrued commission and cashback match the rates in force
  when each invoice was raised and paid, to the last unit of currency, including across a rate
  change.
- **SC-012**: A partial payment reduces the balance owed by exactly the amount paid, and an
  unconfirmed payment reduces it by nothing.
- **SC-013**: A company whose accrued commission exceeds its ceiling is refused further deferred
  dealing 100% of the time, with the ceiling named.
- **SC-014**: An exchange request raised by one company appears to the counterparty with identical
  terms, and reaches exactly one final outcome.
- **SC-014a**: For a seeded set of orders and supplier invoices, every litre balance equals the sum
  of its movements, each movement traces to the order or correction that caused it, and a repeated
  or retried upload changes no balance a second time.
- **SC-014b**: An owner holding a balance who places a later order for that grade has it drawn down
  automatically, and sees the amount drawn and the remainder before placing the order.
- **SC-014c**: No litre balance ever moves from an extracted value the administrator has not
  confirmed. Verified by abandoning an upload at the confirmation step and observing no movement.
- **SC-014d**: Every recorded supplier invoice retains both what was extracted and what was
  confirmed, so extraction accuracy can be measured after the fact rather than assumed.
- **SC-015**: An administrator completes each primary journey — decide an order, onboard an owner,
  set a price, settle an invoice, pay commission, raise an exchange request — on first attempt
  without consulting documentation.
- **SC-016**: Every screen that ships is legible and operable in Arabic right-to-left and in English.

## Assumptions

- "Petrol company" in the dashboard's naming means the platform's fuel company administrator role.
  The two are the same actor; only the role vocabulary is being corrected, not the naming.
- "Station owner" means a client of a fuel company. The platform has no separate owner entity;
  owners are clients and stations belong to them.
- The commission and cashback terms are the platform operator's to set and the fuel company's to
  read. The screens today present the editing controls to both actors identically, which cannot be
  right for a rate one party charges the other; FR-056 resolves it in the operator's favour. If the
  intent was that a fuel company sets its own commission to *its* customers, that is a different
  capability and is not what is specified here.
- The cashback programme targets companies, not station owners, following the targeting control's
  own vocabulary.
- The platform operator's surface is in scope **only where it concerns fuel companies** — the
  operator's fuel company, station owner, station, invoice, platform account, payment and exchange
  screens, plus every component shared with the fuel company surface. The operator's transport
  company, driver and platform-order screens share nothing with this feature and are out of scope.
- Supplier-invoice reconciliation is in scope. The supplier invoice — an Aramco tax invoice in
  practice — is the authoritative record of the quantity actually supplied, and is what moves a
  litre balance. This reverses the deferral made when the loading stage was built, which rested on
  the platform having no authoritative delivered volume; the uploaded invoice supplies exactly that.
- The supplier invoice is treated as evidence of quantity, not as a billing document. The platform
  records what it says and does not price, settle, reconcile tax against, or account for it. The
  driver still enters no quantity anywhere.
- Extraction is an assistive step, never an authority. The administrator's confirmation is what the
  platform records, which is what keeps a misread from silently corrupting a balance. Extraction
  accuracy is therefore a convenience measure, not a correctness one, and the feature is correct
  even at zero extraction accuracy — the standard tax-invoice QR code carries seller, tax
  registration, timestamp and totals, but not line quantities, so the quantity must come from the
  document body or from the administrator.
- A supplier invoice covers one order and one fuel grade. Invoices spanning several orders, and
  orders supplied against several invoices, are not handled.
- The dashboard's existing platform-access layer and session store — the ones the transport company
  surface already uses — are canonical; the unused duplicates are removed rather than reconciled.
- The transport company integration's shape is the precedent: the session slice lands first and
  alone, the stage vocabulary lands before the screens depending on it, updates are periodic refresh
  except live vehicle position, and no screen ships against absent capability.
- The two empty fuel company folders — live tracking and settings — are out of scope. Neither has a
  fuel-company-specific screen; live tracking is served by a screen shared with the transport
  surface, and no settings route exists.
- The client and driver mobile applications are unchanged, except where a station owner must be able
  to see something this feature creates — their litre balance, and the outcome of a credit limit
  request. Those two are the only client-facing additions.
- Monetary amounts are in the platform's existing currency; no multi-currency handling is added.
- Seeded data is sufficient for verification; no production data is required.

## Dependencies

- **Platform addition required (FR-045/FR-046)**: the order-count summary capability admits
  transport company administrators and the platform operator only, and computes no owner or station
  counts. A fuel company administrator cannot obtain counts for their own orders today.
- **Platform addition required (FR-025)**: stations can be listed for one owner at a time only.
- **New platform capability (Story 9, Story 10)**: commission terms, cashback programme, accrual
  against invoices, per-company balances, commission ceiling and enforcement, the account ledger,
  partial and full payment, payment methods, document attachment and operator confirmation. None of
  this exists in any form.
- **New platform capability (Story 11)**: supplier-invoice upload against an order, the supplied
  quantity it establishes, per-owner per-grade litre balances with a movement history, and automatic
  draw-down of a balance by later orders. The draw-down reaches into order placement, which is
  client-facing — the only part of this feature that changes what a station owner does, rather than
  only what they see. It also requires reading values out of an uploaded document, which the
  platform does nowhere today; because confirmation is mandatory (FR-073a-ii), this can be delivered
  at whatever accuracy is achievable without affecting correctness.
- **New platform capability (Story 12)**: fuel exchange requests between fuel companies, with
  direction, lifecycle and contact disclosure.
- **New platform capability (FR-029/FR-030)**: credit limit requests. Credit limits themselves
  already exist; the request-and-resolve exchange does not.
- **Existing platform capability, no screen**: support requests can already be listed and
  acknowledged by a fuel company administrator, but the dashboard has no support screen at all.
- The dashboard is a separate repository from the platform. This specification, its plan and its
  tasks are the shared source of truth for both, following the arrangement used for the transport
  company integration.

## Out of Scope

- The platform operator's transport company, driver and platform-order screens.
- Pricing, settlement, tax reconciliation or accounting treatment of a supplier invoice. Only its
  quantity is acted upon.
- Fuel company live tracking and settings screens.
- Any change to the driver's mobile experience.
- Multi-currency support, tax computation beyond the existing pricing components, and accounting
  export in any format.
- Automatic collection of commission owed; payment is recorded and confirmed, never taken.
- Integration with any payment provider for commission settlement. Both offered methods are settled
  outside the platform and confirmed by hand.
- Fulfilment, transport, tracking or invoicing of an accepted fuel exchange. The platform records
  the agreement; it does not carry out or bill for the exchange.
