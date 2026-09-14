# Feature Specification: Platform Operator (Super Admin) Dashboard — Backend Integration

**Feature Branch**: `017-super-admin-dashboard-backend`

**Created**: 2026-09-12

**Status**: Draft

**Input**: User description: "now we work with super admin module in dashboard E:\zeyad\web_dashboard_ciro_fuel\src\admin i need link with backend and i need you scan ui very good and if something missing in back end mack api`s and logic in backend based on front end"

## Overview

The platform operator (CIRO, `SUPER_ADMIN`) is the only role on this platform whose dashboard
surface has never been finished. Feature 013 wired one sub-module of it — fuel companies, the
cross-company invoice and platform-account ledgers, and the billing settings — and feature 016 wired
the fuel-exchange oversight pair. **Every other operator screen is a static mock-up**: the operator's
own home dashboard, the platform-wide orders list and order detail, the driver roster and driver
detail, the whole transport-companies section, notifications, the profile's security panel, and the
cashback payment flow.

This feature finishes that surface: it connects each remaining screen to real platform data, and —
where the screen asks for something the platform cannot answer — it builds the missing capability in
the backend rather than deleting the screen or fabricating the number.

It also corrects one defect found while scanning: **the operator's fuel-companies list has been
showing transport companies too.** The screen requests companies of type `FUEL`; the platform accepts
that request, ignores the filter, and returns every company on the platform. The count cards above
the list are computed from the same unfiltered result, so the operator's stated "number of fuel
companies" has been the total number of companies since feature 013 shipped.

**Spans two repositories**: this backend and the dashboard at `E:\zeyad\web_dashboard_ciro_fuel`.

## Clarifications

### Session 2026-09-12

- Q: A transport company created by the operator was to require no parent fuel company. Verification
  against the platform found this is not a legal state: the parent is the transport administrator's
  tenant isolation key (a missing one raises an isolation violation on every scoped read), and order
  routing resolves candidate transporters by that same parent, so an unparented transporter is never
  routed to — silently. Keep it, or require a parent? → A: The operator names the parent fuel company
  when onboarding. The parent stays required; no isolation or routing change is made in this feature.
  A genuinely platform-level transporter is deferred to its own feature.
- Q: The driver roster's truck column has no backing field — a driver is bound to a truck only for the
  duration of one order, so an idle driver has no current truck, and a last truck can only be derived
  from that driver's order history, which the driver-surveillance exclusion forbids reading. Which?
  → A: Show the last operated truck, derived from order history. The exclusion is narrowed to permit
  deriving this one fleet fact, and only this one — the orders it was derived from are never exposed.
- Q: The operator's order screens offer four buckets over the platform's twelve states, leaving the
  placement of `PENDING_PAYMENT`, `CANCELLED` and `AWAITING_ROUTING` undecided. Which mapping?
  → A: Keep the four buckets for the summary cards, add a fifth "needs attention" card for
  `AWAITING_ROUTING` (an order no transporter serves, which only a human can resolve), count
  `CANCELLED` separately from `REJECTED`, and let the filter reach the real states beneath the
  buckets.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The operator sees the platform's real numbers on their home screen (Priority: P1)

The operator signs in and lands on their dashboard. Today it shows six invented figures — nine fuel
companies, six transporters, ninety-seven stations, six hundred and twelve orders a month, a
2.48M riyal trading volume and 210M litres — none of which come from anywhere. After this story each
figure is the platform's own count for the period the operator selects, and the two distribution
charts beneath them break those totals down by company type and by order state.

**Why this priority**: It is the first screen the operator sees, it is the screen that makes the
whole surface either trustworthy or not, and every figure on it is currently wrong. An operator who
learns the home screen lies has no reason to believe any other screen.

**Independent Test**: Sign in as the operator against a seeded platform, read each figure on the
dashboard, and reconcile it against the underlying records — every card matches a count that can be
independently derived, and changing the date range changes the period-bounded figures and leaves the
point-in-time figures alone.

**Acceptance Scenarios**:

1. **Given** a platform with a known number of active fuel companies, transport companies and
   stations, **When** the operator opens their dashboard, **Then** each of those three cards shows
   that number.
2. **Given** a selected date range, **When** the operator changes it, **Then** the order count,
   trading volume and litres-traded cards recompute for the new range, and the company-count cards
   — which are point-in-time facts, not period facts — do not change.
3. **Given** a platform with orders in several states, **When** the operator reads the order-state
   distribution chart, **Then** the segments sum to the same order total the stat card above shows.
4. **Given** a period in which nothing happened, **When** the operator opens the dashboard,
   **Then** the period cards read zero — not blank, and not the previous period's figures.
5. **Given** a figure the platform cannot derive, **When** the dashboard renders, **Then** that
   element is absent rather than shown with a placeholder or a fabricated trend.

---

### User Story 2 - The operator's fuel-company list stops counting transporters (Priority: P1)

The operator opens the fuel-companies screen. It lists the platform's fuel companies and counts
them. Today it lists and counts every company of both types.

**Why this priority**: This is a live defect in already-shipped, already-"verified" code, on the
operator's most-used screen. It is cheap to fix and it is currently misinforming the only person on
the platform whose job is oversight. It is also a prerequisite for Story 1 — the dashboard's
company-type distribution chart cannot be right while the platform cannot filter companies by type.

**Independent Test**: Seed a platform with a known mix of fuel and transport companies; open the
operator's fuel-companies screen; confirm the list contains exactly the fuel companies and the count
card states exactly that number.

**Acceptance Scenarios**:

1. **Given** a platform with 3 fuel companies and 5 transport companies, **When** the operator opens
   the fuel-companies screen, **Then** the list shows 3 rows and the total card reads 3.
2. **Given** the same platform, **When** the operator opens the transport-companies screen,
   **Then** the list shows 5 rows and no fuel company appears.
3. **Given** a request for companies with no type stated, **When** the operator makes it,
   **Then** every company of both types is returned — an absent filter means "no filter", it does
   not silently default to one type.
4. **Given** a fuel company administrator (not the operator) requesting companies of any type,
   **When** the request is made, **Then** they receive only their own company, exactly as before —
   the type filter narrows a result, it never widens one.

---

### User Story 3 - The operator works the platform-wide order list and one order in full (Priority: P1)

The operator opens the orders screen and sees every order on the platform, whoever raised it and
whichever companies are carrying it. They filter by state, search, page through, and open one order
to see its full record: quantity and grade, the station and its owner, loading and delivery
locations, the transporter, the driver, the delivery timeline, the linked invoices, the supplier
invoice and the litre balance it feeds, and the platform's own commission on it. Where an order has
gone wrong, they can force it closed.

**Why this priority**: Orders are the platform's product. An operator who cannot see an order cannot
answer a dispute, and the four counters at the top of this screen are the operator's only view of
whether the platform is working at all.

**Independent Test**: Place orders across several companies and states; open the operator's orders
screen; confirm every order appears regardless of which companies it belongs to, that the state
counters match, and that opening one shows every field the detail screen renders against the real
record.

**Acceptance Scenarios**:

1. **Given** orders belonging to several different fuel and transport companies, **When** the
   operator lists orders, **Then** all of them appear — the operator is the one role that is not
   scoped to a company.
2. **Given** an order list, **When** the operator filters by a summary bucket or by a single real
   state, **Then** only matching orders are shown and the paging total reflects the filter.
2a. **Given** orders spread across every state, **When** the operator reads the summary cards,
   **Then** the bucket counts sum to the platform's total order count, with no order counted twice
   and none counted in no bucket.
2b. **Given** an order that no transporter serves, **When** the operator opens the orders screen,
   **Then** it is counted under "needs attention" and not under "in progress".
2c. **Given** one order a fuel company rejected and one a client cancelled, **When** the operator
   reads the summary cards, **Then** they are counted separately, not as one figure.
3. **Given** an order, **When** the operator opens it, **Then** the header names that order, and the
   order data, transporter, supplier, customer, driver, timeline and invoice cards all describe that
   same order.
4. **Given** an order that has a confirmed supplier invoice, **When** the operator opens it,
   **Then** the supplied-versus-ordered quantity and the resulting litre balance are shown; **and
   given** an order that has none, **Then** that card is absent rather than showing zeros.
5. **Given** an order stuck at a late stage, **When** the operator forces it complete with a stated
   reason, **Then** it completes and the reason is recorded against it.
6. **Given** an order at a stage that cannot be force-completed, **When** the operator attempts it,
   **Then** the platform refuses and says so, and the order does not move.
7. **Given** a figure the order does not carry — a street-level distance, a commission the platform
   never computed for that order — **When** the detail screen renders, **Then** that element is
   absent rather than showing a fabricated value.

---

### User Story 4 - The operator oversees transport companies and onboards one (Priority: P2)

The operator opens the transport-companies screen, sees every transporter on the platform with its
status, the areas it covers and its order volume, opens one to see its details, its administrator,
its drivers and its coverage, suspends or reinstates it, and onboards a new one.

**Why this priority**: Transport companies are the half of the platform the operator currently has no
surface for at all — the fuel-company half was built in feature 013 and this is its missing mirror.
It is P2 rather than P1 because, unlike orders, nothing breaks while it is absent; the operator
simply cannot act.

**Independent Test**: Onboard a transport company through the operator's form; confirm it appears in
the list with its own administrator able to sign in; suspend it and confirm the status changes and
the administrator is refused.

**Acceptance Scenarios**:

1. **Given** a platform with transport companies, **When** the operator opens the list, **Then**
   each appears with its real name, status, covered-area count and order volume.
2. **Given** the operator completes the onboarding form naming a parent fuel company, **When** they
   submit it, **Then** the transport company and its first administrator are created together — if
   either fails, neither is created and no half-made company is left behind.
3. **Given** the operator submits the onboarding form naming no parent fuel company, **When** they
   submit it, **Then** the platform refuses and creates nothing.
4. **Given** a newly onboarded transport company, **When** its administrator signs in to the
   dashboard, **Then** they reach their own transport surface with their own empty fleet, and every
   data screen loads — none raises an isolation failure.
5. **Given** a transport company the operator onboarded and one its parent onboarded itself,
   **When** the parent fuel company's administrator lists their transporters, **Then** both appear,
   indistinguishable from one another.
6. **Given** an active transport company, **When** the operator suspends it, **Then** its status
   changes and its administrator can no longer sign in.
7. **Given** a transport company detail screen, **When** the operator opens it, **Then** the company's
   administrator account and its drivers are shown from real records, and any card the platform
   cannot fill is absent rather than mocked.

---

### User Story 5 - The operator sees the platform's driver roster (Priority: P2)

The operator opens the drivers screen and sees every driver on the platform, which transport company
employs them, which truck they operate, and whether they are active and on duty. They open one to see
that driver's own record and their employer.

**Why this priority**: The operator needs to answer "who is this driver and who employs them" when a
dispute reaches them. That question is answerable from roster facts alone.

**Independent Test**: Seed drivers across several transport companies; open the operator's drivers
screen; confirm every driver appears with their employing company and truck, and that the filters
narrow the roster correctly.

**Acceptance Scenarios**:

1. **Given** drivers employed by several different transport companies, **When** the operator lists
   drivers, **Then** all of them appear, each naming its employer.
2. **Given** the roster, **When** the operator filters by active or on-duty state, **Then** only
   matching drivers are shown.
3. **Given** a driver, **When** the operator opens their detail screen, **Then** the driver's own
   record and their employing company are shown from real data.
4. **Given** a driver's detail screen, **When** it renders, **Then** it shows no live position, no
   per-driver trip history and no per-driver aggregate counts — the operator sees who a driver is and
   what fleet they belong to, never a picture of where that person has been.
5. **Given** a driver who has completed deliveries on several trucks, **When** the operator views the
   roster, **Then** the most recent of those trucks is named, and nothing about the deliveries it was
   derived from — how many, when, for whom, or where — appears anywhere on the screen or in what the
   platform sent to it.
6. **Given** a driver who has never been assigned a truck, **When** the operator views the roster,
   **Then** their truck is shown as absent rather than blank-but-populated or placeholder text.

---

### User Story 6 - The operator reads their notifications and announces to the platform (Priority: P3)

The operator's notifications screen shows their real notifications, read and unread, and they can
mark them read. From the dashboard's quick actions they can send an announcement that reaches every
company administrator on the platform.

**Why this priority**: The notification list is a small wiring job over an endpoint that already
exists. The announcement is a genuinely new capability, and it is the one quick action on the
dashboard that names a thing the platform cannot do at all.

**Independent Test**: Trigger a notification for the operator and confirm it appears; send an
announcement and confirm every company administrator receives it and no one else does.

**Acceptance Scenarios**:

1. **Given** notifications addressed to the operator, **When** they open the notifications screen,
   **Then** those notifications are listed with their real content and time, newest first.
2. **Given** unread notifications, **When** the operator marks one read, or marks all read,
   **Then** the unread count falls accordingly and stays fallen across a reload.
3. **Given** the operator composes an announcement, **When** they send it, **Then** every active
   company administrator on the platform receives it, and clients and drivers do not.
4. **Given** an announcement addressed to a subset of companies, **When** it is sent, **Then** only
   administrators of those companies receive it.
5. **Given** an announcement send that fails partway, **When** it is retried, **Then** no
   administrator receives the same announcement twice.

---

### User Story 7 - The operator manages their own account and sign-in (Priority: P3)

The operator opens their profile, sees their own identity and platform-wide counts, reads when they
last signed in and how many sessions they currently hold, and changes the mobile number they sign in
with.

**Why this priority**: Feature 015 made the administrator's mobile number the sign-in identifier.
The screen that states which number that is, and lets the operator change it, is currently showing a
masked placeholder — so the one screen an operator would consult before changing their own access
tells them nothing.

**Independent Test**: Sign in as the operator from two devices; confirm the profile reports two
sessions and the correct last-sign-in time; change the number and confirm the new number signs in and
the old one does not.

**Acceptance Scenarios**:

1. **Given** a signed-in operator, **When** they open their profile, **Then** their real name, email
   and sign-in mobile number are shown.
2. **Given** an operator holding two sessions, **When** they open their profile, **Then** it reports
   two active sessions and the time of the most recent sign-in.
3. **Given** the operator starts a mobile-number change, **When** they confirm the code sent to the
   new number, **Then** that number becomes their sign-in identifier.
4. **Given** a number already in use by another account, **When** the operator attempts to change to
   it, **Then** the change is refused and their existing number is unchanged.
5. **Given** the operator's own profile, **When** it renders, **Then** any permission or statistic the
   platform does not actually record is absent rather than displayed as a fixed list.

---

### User Story 8 - The operator settles a cashback owed to a fuel company (Priority: P3)

The platform's cashback programme computes what the platform owes each fuel company. The operator
opens the payment screen for one company, sees the amount owed, records that they have paid it in
full or in part — stating the method, the reference and attaching the evidence — and the company's
balance falls by that amount.

**Why this priority**: The cashback programme has been computable since feature 013 and settleable
never. It is P3 because the money moves outside the platform either way; what is missing is the
record that it moved.

**Independent Test**: Accrue a cashback balance for a fuel company, record a payout against it
through the operator's screen, and confirm the company's balance falls by exactly that amount and the
payout appears in both the operator's and the company's ledger.

**Acceptance Scenarios**:

1. **Given** a fuel company with an accrued cashback balance, **When** the operator opens the payment
   screen for it, **Then** the amount owed is the platform's own computed figure, not typed in.
2. **Given** that balance, **When** the operator records a full payout with a reference and evidence,
   **Then** the balance falls to zero and the payout is recorded against that company.
3. **Given** that balance, **When** the operator records a partial payout, **Then** the balance falls
   by exactly the amount paid and the remainder stays owed.
4. **Given** a payout amount greater than the balance owed, **When** the operator attempts it,
   **Then** the platform refuses and records nothing.
5. **Given** a recorded payout, **When** the fuel company's own administrator opens their platform
   account, **Then** they see that payout in their ledger as money received from the platform.
6. **Given** a recorded payout, **When** the operator views it, **Then** the direction of the money
   is unambiguous on its face — a payout is never indistinguishable from a payment the company made.

---

### Edge Cases

- **A period with no activity**: every period-bounded figure reads zero. Zero and "not computed" are
  different facts and must render differently.
- **A company with no administrator**: the platform must not create one, and a company that somehow
  has none must display as such rather than showing an empty administrator card.
- **A transport company that no fuel company has ever routed to**: appears in the operator's list
  with zero orders and zero covered areas, not as absent.
- **A driver who has never connected**: appears on the roster with no duty state, not omitted. (This
  is the same omission feature 010 found in dispatch: a listing that sorts or filters on a field a
  never-connected driver does not have silently drops that driver entirely.)
- **An order whose station, transporter or driver has since been deactivated**: the order still opens
  and still names them — an order's record is what was true when it happened.
- **An announcement sent while a company is suspended**: that company's administrator does not
  receive it, since they cannot sign in to read it.
- **An announcement to a company whose administrator account is deactivated**: skipped, and the skip
  is recorded, rather than counted as delivered.
- **A cashback payout recorded twice for the same reference**: the second is refused, not applied.
- **A cashback balance that changes between the screen loading and the payout being recorded**: the
  payout is evaluated against the balance at the moment it is recorded, never against the figure the
  screen was showing.
- **The operator changing their own mobile number to the number of an account that is deactivated**:
  refused — a deactivated account still holds its identifier.
- **The operator's last session being revoked while they are using the dashboard**: handled by the
  existing session mechanism unchanged; this feature reports session state and never changes it.
- **A transport company suspended while one of its drivers is mid-delivery**: the delivery continues;
  suspension governs sign-in, not an in-flight order.
- **Paging through a list while new records are being created**: no record is shown twice and none is
  skipped.

## Requirements *(mandatory)*

### Functional Requirements

#### Platform overview (Story 1)

- **FR-001**: The platform MUST provide the operator a single platform-wide overview covering, for a
  stated period: the number of orders, the total value of those orders, and the total volume of fuel
  they moved.
- **FR-001a**: These three figures do NOT share one basis, and the overview MUST say which basis each
  uses. The order count is every order **raised** in the period, in whatever state it has since
  reached. The value and the volume count **delivered** orders only, by their delivery date. A single
  basis is not available: value and volume are meaningless for an order that has not been delivered,
  and an order count restricted to delivered orders would make five of the six state buckets in
  FR-006 structurally zero.
- **FR-002**: That overview MUST also carry point-in-time counts of fuel companies, transport
  companies and stations, which are counts as of now and are NOT bounded by the stated period.
- **FR-003**: The overview MUST be computed across every company on the platform, with no company
  scoping applied.
- **FR-004**: The overview MUST state the period it was computed for, so a reader can tell which
  figures the dates apply to.
- **FR-005**: When no period is stated, the overview MUST default to the current calendar month, and
  MUST say so in its response rather than leaving the caller to assume it.
- **FR-006**: The overview MUST break the order count down by the order state buckets of FR-023a, and
  the company count down by company type, such that each breakdown sums to the total it belongs to.
- **FR-007**: The overview MUST be readable by the platform operator alone. Every other role MUST be
  refused.
- **FR-008**: A period in which nothing happened MUST yield zeros, never absent fields.
- **FR-009**: The overview MUST NOT carry any period-over-period trend figure unless the platform
  actually computes one; the dashboard MUST NOT display a trend the overview does not carry.

#### Company listing (Story 2)

- **FR-010**: Listing companies MUST accept a company-type filter and MUST honour it.
- **FR-011**: An absent or empty type filter MUST mean "every type", never a silent default to one.
- **FR-012**: The type filter MUST narrow a caller's existing visibility and MUST NOT widen it — a
  fuel company administrator filtering by type still sees only their own company.
- **FR-013**: Listing companies MUST additionally accept a status filter, subject to the same two
  rules.
- **FR-014**: The operator's fuel-company count cards MUST be derived from a result that is genuinely
  filtered to fuel companies.

#### Platform-wide orders (Story 3)

- **FR-015**: The operator MUST be able to list every order on the platform, unscoped by company.
- **FR-016**: That listing MUST support filtering by order state — both by summary bucket (FR-023a)
  and by any single real state beneath it — and MUST page without duplicating or skipping records.
- **FR-016a**: That listing MUST accept an order identifier and return that order alone, so the
  operator can reach a named order directly rather than paging to it. Searching by free text —
  station name, company name, customer — is NOT in scope: no such field is indexed for search on
  this platform, and adding one is its own feature.
- **FR-017**: Each listed order MUST carry enough to render the operator's table row without a
  further request per row: its reference, the raising fuel company, the station and its owner, the
  fuel grade and quantity, the loading and delivery locations, the transporter, the delivery time,
  the state, and the payment method.
- **FR-018**: The operator MUST be able to open one order and read its full record, including the
  fields the platform already restricts to operator and fuel-company eyes.
- **FR-019**: The operator's order view MUST include the confirmed supplier invoice and the litre
  balance it produces where one exists, and MUST omit that section entirely where none does.
- **FR-020**: The operator MUST be able to force an order complete, stating a reason, at the same
  stages a fuel company administrator may.
- **FR-021**: A force-completion at a stage that does not permit it MUST be refused with a stated
  reason and MUST leave the order untouched.
- **FR-022**: The platform's own commission on an order MUST be shown where the platform records one,
  and the element MUST be absent where it does not.
- **FR-023**: The operator MUST be able to read the counts behind the order state summary cards for
  the whole platform.
- **FR-023a**: The summary buckets MUST be: **new** (awaiting approval, approved, routed to a
  transporter, awaiting payment), **in progress** (assigned, loading, in transit, unloading),
  **completed** (delivered), **rejected**, **cancelled**, and **needs attention** (awaiting routing).
- **FR-023b**: Rejected and cancelled MUST be counted and filterable separately. They are different
  acts by different parties and MUST NOT be presented as one outcome.
- **FR-023c**: Orders awaiting routing MUST be surfaced as their own count, never folded into another
  bucket. This is the state in which the platform cannot proceed without a person, and the operator's
  screen exists to surface exactly that.
- **FR-023d**: Every one of the platform's order states MUST belong to exactly one bucket, and the
  buckets MUST together account for every order — so the buckets sum to the total, with none
  double-counted and none unreachable.
- **FR-024**: No order-detail element MUST be rendered from a value the platform does not hold. Where
  the design calls for one, the element is dropped and the drop recorded.

#### Transport companies (Story 4)

- **FR-025**: The operator MUST be able to list every transport company on the platform with its
  name, identifier, status and joining date.
- **FR-026**: Each listed transport company MUST carry the number of areas it covers and the number
  of orders it carried in the period.
- **FR-026a**: That period is the same date range the operator selected for their overview, and
  defaults the same way when none is stated (FR-005). The two screens MUST NOT disagree about what
  "this period" means.
- **FR-026b**: The order volumes for a page of transport companies MUST be resolved together, not
  one request or one query per company.
- **FR-027**: The operator MUST be able to onboard a transport company, supplying the company's own
  details and its first administrator's details.
- **FR-028**: A transport company and its first administrator MUST be created as one unit of work —
  a failure on either MUST leave neither, and MUST NOT leave a company that no one can sign in to.
- **FR-029**: The operator MUST name the fuel company a transport company belongs to when onboarding
  it. Every transport company on the platform has exactly one parent fuel company; this feature does
  not change that.
- **FR-030**: The operator's onboarding form MUST let them choose the parent from the platform's fuel
  companies, and MUST refuse a submission that names none.
- **FR-031**: A transport company onboarded by the operator MUST be indistinguishable, afterwards,
  from one its parent fuel company onboarded itself — its parent's administrator reads and manages
  it, order routing resolves it, and region and delivery-rate assignment behave identically. Who
  performed the onboarding MUST NOT be recorded as a difference in the company's own behaviour.
- **FR-032**: This feature MUST NOT change the transport administrator's tenant isolation key, nor
  the query that resolves which transporters may be routed an order. A transport company with no
  parent remains an illegal state, and the platform MUST continue to refuse to produce one.
- **FR-033**: The operator MUST be able to suspend and reinstate a transport company, and a suspended
  company's administrator MUST be refused sign-in with the stated reason.
- **FR-034**: The operator MUST be able to read a transport company's administrator account,
  including the mobile number that administrator signs in with.
- **FR-035**: The operator MUST be able to read the drivers a transport company employs.
- **FR-036**: The operator MUST be able to read the areas a transport company covers.
- **FR-037**: Transport-company detail elements the platform cannot fill — a performance rating, an
  average delivery time — MUST be absent rather than displayed with an invented value.

#### Driver roster (Story 5)

- **FR-038**: The operator MUST be able to list every driver on the platform, unscoped by company.
- **FR-039**: Each listed driver MUST carry their name, identifier, contact number, employing
  transport company, most recently operated truck, active state and duty state.
- **FR-039a**: The most recently operated truck MUST be derived from the driver's delivery record.
  There is no stored field for it, and this feature MUST NOT add one — a stored value would drift
  from the deliveries that are the actual evidence of what a driver drove.
- **FR-039b**: A driver who has never been assigned a truck MUST show no truck, not a placeholder.
  "Never driven" and "truck unknown" MUST NOT render identically.
- **FR-040**: A driver who has never connected MUST appear in that listing, with their duty state
  stated as unknown rather than the driver being omitted.
- **FR-041**: The roster MUST support filtering by active state and by duty state.
- **FR-042**: The operator MUST be able to open one driver and read that driver's own record and their
  employing company.
- **FR-043**: The operator's driver views MUST NOT carry the driver's location, current or historical.
- **FR-044**: The operator's driver views MUST NOT carry per-driver trip counts, trip history or stop
  history. The boundary spec 011 drew — safety and delivery visibility, never driver surveillance —
  holds for the operator exactly as it holds for a transport administrator.
- **FR-044a**: FR-044 is narrowed in exactly one respect: the driver's delivery record MAY be read to
  derive the identity of the most recently operated truck (FR-039a). Nothing else about those
  deliveries MUST leave that derivation — not the orders, their count, their dates, their customers,
  their routes, nor anything positional. The exception is a single fleet fact about a vehicle, not a
  window onto a person's movements, and MUST NOT be widened to carry a second fact "while we are
  already reading the history".
- **FR-045**: The driver detail screen MUST drop the cards that render the excluded data rather than
  render them empty.

#### Notifications and announcements (Story 6)

- **FR-046**: The operator MUST be able to read their own notifications, paged, with unread state.
- **FR-047**: The operator MUST be able to mark one notification read and to mark all read.
- **FR-048**: The operator MUST be able to compose and send an announcement to the platform.
- **FR-049**: An announcement MUST reach every active administrator of every active company on the
  platform by default.
- **FR-050**: An announcement MUST support being addressed to a named subset of companies, in which
  case only those companies' administrators receive it.
- **FR-051**: An announcement MUST NOT reach clients or drivers.
- **FR-052**: Sending an announcement MUST be recorded as one announcement, distinct from the
  individual deliveries it produces, so the operator can see what was sent and to whom.
- **FR-053**: Announcement delivery MUST be safe to retry — a retried send MUST NOT deliver the same
  announcement to the same recipient twice.
- **FR-054**: An announcement MUST record which intended recipients it could not reach, and why,
  rather than counting them as delivered.
- **FR-055**: Sending an announcement MUST NOT block the operator's request on the delivery of every
  individual notification.
- **FR-056**: Only the platform operator MUST be able to send an announcement.

#### Operator profile and sessions (Story 7)

- **FR-057**: The operator MUST be able to read their own account: name, email, and the mobile number
  they sign in with.
- **FR-058**: The operator MUST be able to read when they last signed in.
- **FR-059**: The operator MUST be able to read how many sessions their account currently holds.
- **FR-060**: The operator MUST be able to change the mobile number they sign in with, confirming the
  change with a code sent to the new number.
- **FR-061**: A mobile number already held by any account MUST be refused, and the operator's existing
  number MUST be left unchanged.
- **FR-062**: Changing the sign-in number MUST NOT sign the operator out of their other sessions —
  concurrent administrator sessions are a capability feature 015 built deliberately.
- **FR-063**: The profile MUST NOT display a permission list, a statistic, or an account figure the
  platform does not actually record.

#### Cashback settlement (Story 8)

- **FR-064**: The platform MUST record money paid by the platform TO a company, as a movement whose
  direction is explicit and distinguishable from money a company pays the platform.
- **FR-065**: The operator MUST be able to read what the platform currently owes a named company
  under the cashback programme.
- **FR-066**: The operator MUST be able to record a payout against that balance, stating the amount,
  the method, a reference, and attaching evidence.
- **FR-067**: A payout MUST reduce the company's owed balance by exactly the amount recorded.
- **FR-068**: A payout greater than the balance owed MUST be refused and MUST record nothing.
- **FR-069**: A payout MUST be evaluated against the balance at the moment it is recorded, never
  against a figure the operator's screen was displaying.
- **FR-070**: A payout carrying a reference already recorded for that company MUST be refused rather
  than applied a second time.
- **FR-071**: A recorded payout MUST appear in the receiving company's own platform-account ledger,
  identified as money received from the platform.
- **FR-072**: Only the platform operator MUST be able to record a payout. A company MUST NOT be able
  to record money as having been paid to it.
- **FR-073**: No payment provider is integrated. The platform records that a payment happened
  elsewhere; it does not move money.

#### Cross-cutting

- **FR-074**: Every operator-only capability added by this feature MUST refuse every other role,
  including a fuel company administrator and a transport company administrator.
- **FR-075**: No capability added by this feature MUST change what any non-operator role can see or
  do. The mobile applications and the fuel-company and transport-company dashboard surfaces MUST be
  unaffected.
- **FR-076**: Every operator screen MUST distinguish loading, empty and failed states, and MUST offer
  a retry on failure rather than rendering an empty screen.
- **FR-077**: Every operator screen rebuilt or newly wired by this feature MUST be fully bilingual
  (Arabic default, English) with correct right-to-left layout. Screens this feature does not touch
  MUST NOT be retrofitted.
- **FR-078**: Where a design element has no data source, it MUST be removed and the removal recorded,
  following the precedent already set on this platform for exactly this situation.

### Key Entities

- **Platform Overview**: the operator's cross-company picture for a period — order count, order
  value, litres moved, plus point-in-time company and station counts, and the two breakdowns beneath
  them. Derived, never stored.
- **Company**: unchanged by this feature. A transport company still belongs to exactly one parent
  fuel company; the operator names that parent when onboarding one rather than the parent's own
  administrator doing so.
- **Announcement**: a message the operator sends to the platform — its content, who it was addressed
  to, when it was sent, who it reached, and who it could not reach and why. Distinct from the
  individual notifications it produces.
- **Account Movement**: gains an outbound direction — money the platform paid a company — alongside
  the inbound movements it records today. Carries amount, method, reference, evidence, and the
  operator who recorded it.
- **Driver Roster Entry**: the operator's view of a driver — identity, employer, most recently
  operated truck, active and duty state. Derived, never stored. Carries no location, and nothing of
  the delivery record beyond the single truck identity read out of it (FR-044a).
- **Session**: already recorded per administrator by feature 015. This feature reads session count
  and last sign-in from it and changes nothing about how sessions are created or revoked.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every figure on the operator's home dashboard reconciles exactly against an
  independently derived count of the underlying records, for any selected period.
- **SC-002**: The operator's fuel-company list and its count card contain exactly the platform's fuel
  companies, and zero transport companies, on a platform seeded with both.
- **SC-003**: The operator can locate any order on the platform and open its full record, regardless
  of which companies are party to it, in under 30 seconds from the dashboard.
- **SC-004**: The operator can onboard a transport company and have its administrator sign in to
  their own surface, end to end, in under 5 minutes with no assistance from any other role.
- **SC-005**: 100% of transport companies that existed before this feature continue to be visible to,
  and manageable by, their parent fuel company's administrator, with no change in behaviour.
- **SC-006**: A transport company onboarded by the operator is routed orders, and is read and managed
  by its parent fuel company's administrator, identically to one that parent onboarded itself —
  demonstrated by exercising both through the same journey and observing no difference.
- **SC-007**: Zero screens in the operator's module render a figure that does not come from the
  platform; every remaining gap is recorded as an explicit removal.
- **SC-008**: An announcement sent to the platform reaches 100% of active company administrators and
  0% of clients and drivers, verified by recipient role.
- **SC-009**: A retried announcement send produces zero duplicate deliveries.
- **SC-010**: The operator's profile reports a session count and last-sign-in time that match what
  actually happened, verified by signing in from two devices.
- **SC-011**: A recorded cashback payout changes the receiving company's balance by exactly the amount
  recorded, and that payout is visible in that company's own ledger identified as incoming.
- **SC-012**: Every capability added by this feature refuses every role other than the platform
  operator, verified per capability.
- **SC-013**: The mobile applications' and the two company dashboard surfaces' existing test suites
  pass unchanged after this feature lands.
- **SC-014**: No operator screen shows the driver's location or any per-driver trip aggregate,
  verified by inspecting what the platform actually sends to those screens, not only what they render.
  The single permitted derivation (FR-044a) is verified the same way: the truck's identity reaches
  the screen and no delivery record, count or date accompanies it.

## Assumptions

- **The operator is the only consumer.** Every capability this feature adds is for the platform
  operator. Where an existing capability is extended rather than added, the extension is inert for
  every other role — the precedent this platform already set with the company-identifier filter on
  user listing.
- **Announcements reuse the existing notification mechanism.** The platform's "push notification" is
  a stored notification plus a live socket emission; no external push provider exists and this
  feature does not add one. An announcement fans out into one notification per recipient
  administrator, produced in the background rather than inside the operator's request.
- **Announcements reach administrators, not every user.** "إرسال إشعار للمنصة" is read as reaching the
  companies on the platform, through the person who runs each. Fanning out to every client and driver
  would be a different feature with a different consent question behind it.
- **The cashback payout records, it does not pay.** Consistent with how the platform already handles
  a company paying it: details are displayed, the payer pays elsewhere, and the platform records what
  was reported with evidence attached.
- **Trading volume is the value of orders in the period**, computed from the order totals the platform
  already records. Litres moved is the delivered quantity over the same period. Neither is a new
  stored figure; both are derived, and both count delivered orders only, bounded by the delivery
  date. **The order count is not**: it counts every order raised in the period, whatever state it has
  since reached, because it is the figure the state breakdown of FR-006 must sum to. FR-001a states
  both bases and requires the overview to carry them.
- **The operator's date range bounds period figures only.** Company, station and fleet counts are
  point-in-time and are unaffected by it — this is stated in FR-002 because the current mock applies
  a "from last week" trend caption to all six cards indiscriminately.
- **Order state buckets are fixed by FR-023a**, not by the four Arabic labels the mock hardcodes.
  The dashboard's order-state breakdown (FR-006) uses those same buckets, so the two screens cannot
  disagree about what "in progress" means.
- **The existing fuel-company sub-module is not rebuilt.** Feature 013's wired screens — companies,
  invoices, platform account, billing settings — stay as they are, apart from the type-filter defect
  in Story 2 and the payout addition in Story 8.
- **The fuel-exchange oversight screens are not rebuilt.** Feature 016 wired both; they are already
  real.
- **Session count and last sign-in come from the session records feature 015 already writes.** This
  feature adds a way to read them and changes nothing about how they are written.
- **The station detail screen the operator links to is the fuel company's own**, reused as-is; this
  feature does not build a second one.
- **Tracking and order-tracking screens are shared components already built for the transport
  surface**, reached from the operator's routes. They are in scope only insofar as the operator's
  role must be permitted to reach them.

## Dependencies

- The dashboard repository at `E:\zeyad\web_dashboard_ciro_fuel`, feature branch
  `017-super-admin-dashboard-backend`.
- Feature 015's administrator session model, for Story 7's session count and last sign-in.
- Feature 013's billing and platform-account model, for Story 8's cashback balance and ledger.
- Feature 016's fuel-exchange offers, which the operator's already-wired oversight screens read.

## Out of Scope

- Any change to the mobile applications. The operator has no mobile persona.
- A real push provider. Announcements use the platform's existing in-app notification mechanism.
- A payment provider integration for the cashback payout.
- Per-driver location, trip history or performance analytics for the operator — excluded by decision,
  see FR-043/FR-044.
- A transport company belonging to no fuel company. Excluded by decision after verification (see
  Clarifications); it would require changing the transport administrator's tenant isolation key and
  the routing query that resolves candidate transporters, neither of which this feature touches.
- Retrofitting screens this feature does not touch to full bilingual support.
- Rebuilding the fuel-company and fuel-exchange operator screens that features 013 and 016 already
  wired.

## Risks

- **The operator's transporter onboarding writes into another company's tenant.** It is the only
  capability in this feature that creates a record belonging to a company other than the actor's —
  the operator has no company of their own. The parent named on the form becomes the new company's
  isolation key and its administrator's, so a wrong or absent parent does not fail loudly at
  onboarding; it produces a company whose administrator cannot read their own data (a missing parent
  raises an isolation violation on every scoped read) or whose orders route to the wrong fuel
  company. FR-030's refusal of an unnamed parent and FR-032's prohibition on touching the isolation
  key are what bound this.
- **A genuinely platform-level transport company remains unbuilt and is now explicitly out of scope.**
  Should it be wanted later, it is not a company-record change: it requires a different tenant key for
  the transport administrator and a different transporter-resolution query for routing. Recorded here
  so a future reader does not mistake FR-029's "exactly one parent" for an oversight.
- **The platform overview is the first cross-company aggregate on this platform.** Every existing
  count is scoped to one company. An aggregate that accidentally inherits company scoping would
  produce a plausible, smaller, wrong number with no error — the same class of silent defect this
  codebase has hit before with injected query filters.
- **Announcement fan-out is unbounded in principle.** The number of recipients grows with the
  platform. FR-055 and FR-053 exist because a synchronous, non-idempotent fan-out would fail exactly
  when the platform is largest.
