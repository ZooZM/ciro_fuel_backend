# Phase 0 Research: Client Mobile App — Backend Integration

**Feature**: `005-client-backend-integration` | **Date**: 2026-08-15

Every unknown carried into planning is resolved below. Findings are grouped by the decision they
unblock. Where an existing platform mechanism already solves a problem, the decision is to reuse
it — the constitution's Principle IV and the spec's FR-046c both push that way, and it is also
where most of the schedule saving in this feature lives.

---

## R1 — Station cardinality: how to go from one to many

**Context**: `Station` is an embedded, single-valued sub-document on the user record
(`src/modules/users/schemas/user.schema.ts`), surfaced through `GET /auth/me`. D2 requires
several per client, registered by the fuel company, with client-marked favourites.

**Decision**: Promote `Station` to its own tenant-scoped collection, keyed by `clientId`, and
retain `user.station` as a **derived default** during a transition window rather than deleting it
in the same change.

**Rationale**:

- A Mongoose array of embedded stations would work, but favourites are client-written while the
  station itself is company-written. Two writers on one embedded array invites lost updates on
  concurrent `$set`, and the constitution (Principle V) wants concurrency safety at the data
  layer rather than assumed from ordering. Separate documents give each station its own `_id` to
  target with a conditional update.
- An order must reference the station it was delivered to and keep that readable after the
  station is withdrawn (FR-036c). An embedded array offers no stable identifier to reference; a
  collection does.
- The collection is single-tenant (one `companyId`, one `clientId`), so it uses the **original**
  `companyId`-equality plugin via `markTenantScoped`, not the multi-party plugin. No new isolation
  mechanism is introduced.

**Migration**: a one-shot script copies each client's existing embedded `station` into the new
collection as their default. `test/e2e/migration.e2e-spec.ts` already exists as a precedent for
this pattern and should be extended rather than duplicated.

**Alternatives considered**:

- *Embedded array on the user document* — rejected on the concurrent-writer and stable-reference
  grounds above. Cheaper to build, more expensive to get right.
- *Rename to `DeliveryLocation` while restructuring* — explicitly rejected by clarification Q5;
  the name stays `Station` across schema, API and app.

---

## R2 — Itemised pricing: derivation, storage and retention

**Context**: D3 and FR-011a–j. The order schema carries only `estimatedPrice` and `finalPrice`.
`Company` carries `fuelPrices: FuelPrice[]` but no fee or tax configuration.

**Decision**: Add a `pricingConfig` sub-document to `Company` (flat delivery fee, service fee
percentage, tax rate) alongside the existing `fuelPrices`, and add a `priceBreakdown`
sub-document to `Order` that stores the four computed components **plus the three input rates in
force at pricing time**.

**Rationale**:

- FR-011i requires an order's breakdown to be immune to later configuration changes. Storing only
  the computed components satisfies the letter of that, but storing the rates too makes an order
  auditable — you can show a client *why* their fee was what it was, which matters for a
  financial-adjacent record and costs three extra numbers.
- Putting `pricingConfig` on `Company` beside `fuelPrices` means the existing
  `assertCompanyAccess` check on `GET /companies/:id/fuel-prices` extends to it unchanged, and a
  CLIENT can already read their own fuel company's prices through that path (verified: a CLIENT's
  `companyId` is their fuel company, so `assertCompanyAccess` passes).
- Derivation order is fixed by FR-011g: `fuel = unitPrice × litres`, `delivery = flat`,
  `service = pct × fuel`, `tax = rate × (fuel + delivery + service)`. Tax compounds on the fees,
  which is the ordinary treatment and must be stated explicitly or it will be implemented three
  different ways.

**Rounding**: all components round half-up to 2 decimal places, and the total is the **sum of the
rounded components**, never the rounded sum of unrounded components. Without this rule FR-011b
(components must sum to the total) fails intermittently by one halala, and it fails in
production rather than in tests.

**Existing orders**: back-fill is **rejected**. An order priced before this feature has no
recorded rates, and inventing them would fabricate a financial record — exactly what this feature
exists to eliminate. Instead `priceBreakdown` is optional, and the app renders a total-only
receipt when it is absent. This is the one place a client sees less detail, and it is
self-healing: every new order has a breakdown.

**Alternatives considered**:

- *Separate `PricingRule` collection* — more flexible (per-region, per-client overrides), but
  nothing in the spec asks for that and it adds a join to the quote path. Rejected as speculative.
- *Compute the breakdown on read* — rejected outright; it violates FR-011i, since a config change
  would silently rewrite historical orders.

---

## R3 — Cursor pagination over Mongoose

**Context**: FR-048–048g across four collections. No endpoint in the platform paginates today;
all return full arrays.

**Decision**: Opaque cursor encoding `{ sortValue, _id }` — base64 of the sort key plus the
document id as a tiebreaker — with a platform-fixed page size of 20, sorting `createdAt` (or
`statusChangedAt` for orders) descending, `_id` descending as the tiebreaker.

**Rationale**:

- Skip/limit is the obvious alternative and is wrong here for a specific reason: FR-048c requires
  that a record inserted mid-scroll must not cause a repeat or a skip. Newest-first ordering plus
  inserts at the head is precisely the case where skip/limit duplicates rows. A keyset cursor is
  immune because it anchors on a value, not an offset.
- The `_id` tiebreaker is not optional. Several orders can share a `statusChangedAt` to the
  millisecond (a bulk transition, a seeded dataset), and a cursor on the timestamp alone would
  either drop or repeat the ties.
- Page size fixed by the platform (FR-048) rather than client-supplied — it removes a
  denial-of-service lever and keeps the contract honest.

**Indexes required** — this is the part that decides whether SC-004a holds. Each paginated
collection needs a compound index whose prefix matches its scoping filter and whose suffix
matches the sort:

| Collection | Index |
|---|---|
| orders | `{ clientId: 1, statusChangedAt: -1, _id: -1 }` |
| orders (filtered) | `{ clientId: 1, status: 1, statusChangedAt: -1, _id: -1 }` |
| invoices | `{ clientId: 1, state: 1, createdAt: -1, _id: -1 }` — `state` in the prefix because FR-048f sorts outstanding before settled |
| paymentevents | `{ clientId: 1, createdAt: -1, _id: -1 }` |
| notifications | `{ recipientUserId: 1, createdAt: -1, _id: -1 }` |

Without these, SC-004a ("a client with 500 orders reaches their list no slower than one with 5")
fails — and it fails invisibly on a seeded dev database, then visibly for the largest customer.

**Filtering** (FR-048d): the status filter goes into the query, not into the app. The app must
send the filter and reset the cursor; it must never filter a loaded page client-side, or a
filtered list silently means "matches among the 40 rows I happen to hold".

**Alternatives considered**:

- *Skip/limit* — rejected on FR-048c.
- *Client-supplied page size* — rejected; no requirement needs it, and it is an abuse lever.

---

## R4 — Phone verification and the SMS provider

**Context**: FR-035–035g. The platform has a mature OTP implementation
(`src/modules/orders/services/otp.service.ts`) but it is order-bound: every method takes an
`orderId`, records live in `order.otps[]`, and the plaintext cache key is
`otp:{orderId}:{purpose}`.

**Decision**: Extract the OTP primitives — generate, salt, hash, cache plaintext with TTL,
verify with attempt counting, invalidate — into a **subject-agnostic** service keyed by an
arbitrary subject string rather than an order id, then have both the order flow and phone
verification depend on it. Phone verification records live in their own short-lived collection,
not on the user document.

**Rationale**:

- FR-035a requires reuse of "the same mechanism", and the security properties worth reusing are
  exactly the primitives: hashed at rest, single-use, expiring, attempt-throttled. Copying them
  into a second service would duplicate the one piece of code in the platform where a subtle bug
  is a security incident.
- Records go in their own collection rather than on the user document because FR-035c requires
  the user's phone to stay untouched until verification succeeds. Writing pending state onto the
  record you are trying not to modify invites exactly the bug the requirement guards against.
- The refactor is behaviour-preserving and `test/unit/order-state.service.spec.ts` plus the
  existing OTP e2e coverage act as the regression gate. **The extraction must land as its own
  change with the existing tests green before phone verification is built on top** — otherwise a
  regression in delivery OTP hides inside a phone-verification feature.

**Provider**: **NEEDS DECISION — external, not resolvable here.** The platform has no SMS
integration and no credentials in `src/config/`. This is a procurement decision (Unifonic and
Twilio are the usual candidates for Saudi delivery, and local sender-ID registration has lead
time). The design decision that *can* be made now: define an `SmsSender` port with a single
`send(phone, message)` method, implement a logging no-op for development, and keep the provider
behind it. Nothing else in the feature blocks on the choice, and the port keeps the eventual
selection from touching any business logic.

**Rate limits**: 5 verify attempts per code (matching `MAX_ATTEMPTS` in the existing service, and
`AppLimits.otpMaxAttempts` in the app) and 3 code requests per phone per 15 minutes. The second
limit is the one that matters commercially — every request costs money and an unthrottled
endpoint is a way to spend it.

**Alternatives considered**:

- *A parallel OTP implementation for phones* — rejected; duplicates security-critical code.
- *Generalise in place by making `orderId` nullable* — rejected; it leaves phone OTP records
  inside the order collection, which is both a modelling lie and a tenant-scoping hazard.

---

## R5 — Payment history

**Context**: FR-023. The `payments` module exposes only `POST /payments/webhook/:gateway`.

**Decision**: Expose the client's own history by reading the existing `PaymentEvent` collection,
filtered to confirmed and terminal outcomes. **No new collection.**

**Rationale**: `PaymentEvent` already records `orderId`, `companyId`, `amount`, `currency`,
`gateway`, `outcome` and timestamps — everything FR-023 asks for. It is written inside the
webhook transaction, so it is exactly as authoritative as the payment itself.

**Two things to get right**:

- `PaymentEvent` has no `clientId`; it has `orderId` and `companyId`. Scoping a client to their
  own payments therefore means resolving through the order. Adding a denormalised `clientId` at
  write time is the cheaper read path and makes the index in R3 possible — take that, and
  back-fill it in the same migration as R1.
- `rawPayload` holds the gateway's untouched payload and **must never** be projected into a
  client response — it can carry gateway-side card metadata. This is a Principle II concern and
  an explicit response-shaping requirement, not a "remember not to" note.

**Alternatives considered**: a purpose-built `Payment` read model — rejected as a second source
of truth for money, which is the last place to want one.

---

## R6 — Credit standing

**Context**: FR-026–028.

**Decision**: Reuse `InvoicesService.getAvailableCredit` unchanged and expose limit, consumed and
available through a single read endpoint.

**Rationale**: The calculation already exists and is already the authority the order path uses to
refuse over-limit orders (`invoices.service.ts`, `creditLimit − Σ(still-ISSUED credit invoices)`).
Any second calculation would eventually disagree with the one that actually blocks orders, and
FR-026 explicitly requires the dashboard and the credit screen to agree. Exposing the existing
function is the only way to guarantee that; deriving "available" in the app from limit minus a
separately-fetched invoice sum is precisely the drift FR-026 forbids.

FR-028's pre-submission warning reads the same endpoint. It is a **courtesy check, not a gate** —
the server-side refusal inside the order transaction remains the authority (Principle V), because
a client-side check races against concurrent orders by definition.

---

## R7 — Support requests

**Context**: FR-038–039b. No support concept exists in the platform.

**Decision**: A new tenant-scoped `SupportRequest` collection with exactly two states, routed to
fuel company admins through the existing `NotificationsService.notify`, plus a new
`NotificationType` member.

**Rationale**: `NotificationsService.notify` already handles the cross-tenant recipient case and
already pushes over the realtime gateway. Routing support through it (FR-038b) means the fuel
company admin's future dashboard inbox gets support requests for free, with no second delivery
path to maintain.

**Scope discipline**: two states, no threading, no replies (FR-039a). The temptation to add a
`resolvedAt` or an admin note is real and should be resisted — the spec deliberately drew that
line, and the moment there is a reply there is a conversation to model, notify on and paginate.

---

## R8 — Unread notification count

**Decision**: Add a count to the existing notifications list response rather than a separate
endpoint.

**Rationale**: The badge (FR-030) is shown on screens that are usually already loading something
else. A dedicated endpoint means a second round trip on every screen that shows a badge; folding
`unreadCount` into the list response the app already makes costs nothing. `findForUser` already
supports an `unreadOnly` filter, so the count is a `countDocuments` on the same filter.

---

## R9 — Mobile: mounting what already exists

**Context**: `OrdersCubit`, `OrderDetailCubit`, `PaymentCubit`, `TrackingCubit`,
`NotificationsCubit` and `FinanceCubit` are all built, registered in
`lib/core/di/injector.dart`, and unit-tested — but the screens bypass them.
`order_detail_screen.dart:36` says so explicitly.

**Decision**: Mount the existing cubits. Do not rewrite the data layer. Delete
`order_mock_data.dart` and `mock_order_state.dart`, and drive the order detail screen's status
cards from `OrderStatus` (the real enum, already in `lib/shared/enums/`) instead of
`MockOrderState`.

**The mapping that has to be got right**: `MockOrderState` has members like `waitingPayment`,
`failedPayment`, `deferred` that do not map one-to-one onto `OrderStatus`. `deferred` is a
*payment method*, not a status, and `failedPayment` is a status plus an event. So the status card
selection is a function of `(status, paymentMethod)`, not of status alone — FR-006 says "derive
from that status alone", which is very nearly right but under-specifies the deferred case. The
implementation should be a single exhaustive `switch` over `OrderStatus` with `paymentMethod`
consulted only where the status genuinely does not disambiguate. Dart's exhaustiveness checking
on a sealed enum makes this verifiable at compile time, which is the point.

**Pagination in cubits**: `OrdersState` currently has `OrdersLoaded(orders)`. Cursor pagination
needs `OrdersLoaded(orders, nextCursor, isLoadingMore, loadMoreFailed)`. This is a Freezed state
change and touches `orders_state.dart` plus its generated file — mechanical, but it invalidates
the existing cubit tests, which must be updated rather than deleted.

**Caching (FR-047)**: `get_it` registers cubits as factories today, so navigating away and back
refetches. FR-047 wants reuse within a session. The narrow fix is to hold list cubits as
lazy singletons for the client shell's lifetime and refresh on pull-to-refresh — not to introduce
a caching layer, which nothing here needs.

---

## R10 — Price change between quote and confirmation

**Context**: The spec's edge case: "the client must be shown the new total and asked to confirm
again rather than being charged either figure silently."

**Decision**: The quote endpoint returns a **quote token** — the computed breakdown plus a hash
of the inputs (fuel price, all three config rates) and a short expiry. Order creation submits it.
If the inputs no longer hash the same, creation is refused with a distinguishable error carrying
the new breakdown, and the app re-prompts.

**Rationale**: The alternative — honour whatever the client was shown — lets a stale or tampered
client dictate price, which is unacceptable for a financial record. Recomputing silently and
charging the new figure violates the edge case directly. A token makes the staleness detectable
server-side and turns it into an explicit re-confirmation, which is what the spec asks for.

The token is a hash, not a signed price: the server always recomputes from its own configuration
and never trusts a number from the app.

---

## R11 — Ordering the work so the tree stays green

Not a technical unknown, but the sequencing decision that most affects delivery risk.

**Decision**: Backend capability lands before the app screen that consumes it, and the two
shared-surface changes — the OTP extraction (R4) and the station migration (R1) — land first and
alone.

**Rationale**: Both touch ground the driver app depends on. The station migration alters the user
record that `GET /auth/me` returns to *every* role, and the OTP extraction alters delivery
handover codes. The spec's assumption that "the existing backend suites stay green" is a
regression gate on exactly these two. Bundling either into a larger change is how a driver-side
regression gets discovered late and attributed to the wrong commit.

---

## Open item carried forward

| Item | Status | Owner | Blocks |
|---|---|---|---|
| SMS provider selection and credentials | **Unresolved — external** | Product / procurement | Story 7 completion only. The `SmsSender` port, the verification flow, and its tests can all be built and tested against the development no-op implementation without it. |

Nothing else remains unresolved. Every other NEEDS CLARIFICATION raised during planning is
answered above.
