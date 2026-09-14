# Research: Platform Operator (Super Admin) Dashboard — Backend Integration

**Feature**: `017-super-admin-dashboard-backend` | **Date**: 2026-09-12 | **Phase**: 0

Every decision below was verified against the code as it exists on branch
`017-super-admin-dashboard-backend`, not inferred from the spec. Where a finding contradicts
something the spec asserts, that is stated explicitly — the code wins, and the spec text is
corrected in this document rather than silently worked around.

---

## R1 — The operator already bypasses BOTH isolation plugins, including aggregates

**Decision**: Build the platform overview (Story 1) and the platform-wide order list (Story 3) on
the ordinary models with **no new unscoped query mechanism**, relying on the existing `SUPER_ADMIN`
bypass. Add **no** `runUnscoped` wrapper, no second connection, no raw collection access.

**Rationale**: The spec's own Risks section calls the overview "the first cross-company aggregate on
this platform" and warns it "would produce a plausible, smaller, wrong number with no error" if it
inherited company scoping. Verification shows the bypass is already structural and already covers
the aggregation pipeline, which is the case that would have been easy to miss:

- `tenant-scope.plugin.ts` — `resolveCompanyId()` returns `undefined` for `SUPER_ADMIN`
  (`return undefined; // explicit global bypass`). Every one of the 12 `SCOPED_QUERY_OPS`, plus
  `save`, `insertMany` and **`aggregate`**, early-returns on that `undefined`.
- `multi-party-scope.plugin.ts` — `resolveFuelCompanyId()` has the identical `SUPER_ADMIN` branch,
  and `resolveFilter()` returns `undefined` whenever it does. Its `pre('aggregate')` hook returns
  before unshifting any `$match`.

So `Order`, `Invoice`, `AccountMovement`, `User`, `Station`, `Notification` and `SessionEvent` are
all already readable platform-wide by this role, through `find`, `countDocuments` **and**
`aggregate`. The risk the spec names is real in principle and already closed in practice.

**What this does NOT license**: the bypass is keyed on `ctx.role === SUPER_ADMIN`. A background job
or script has **no context at all**, which reaches the *same* bypass by the `!ctx?.role` branch.
That is correct for a platform-wide aggregate but it means **the announcement fan-out processor
(Story 6) writes with no tenant stamping** — `pre('save')` will not set `companyId` on a
`Notification` created inside the worker. Story 6's processor MUST set `companyId` explicitly. See
R9.

**Alternatives considered**: an explicit `runUnscoped()` wrapper around every overview query
(rejected — it would be inert for this role, and its presence would wrongly imply the bypass is not
already guaranteed, inviting someone to remove the real one); a dedicated read-only aggregate
connection (rejected outright — a second connection would not carry the plugins at all, which
removes the guarantee for every *other* role that shares the code path).

---

## R2 — `GET /companies` accepts no query parameters at all; the filter is not "ignored", it was never read

**Decision**: Add `type` and `status` query parameters to `CompaniesController.findAll` and thread
them through `CompaniesService.findAll`, which currently takes only an optional id.

**Rationale**: The spec describes the defect as "the platform accepts that request, ignores the
filter". The stronger, verified fact is that the parameter is not merely unhonoured — the handler
has **no `@Query` binding whatsoever**:

```ts
@Roles(UserRole.SUPER_ADMIN, UserRole.FUEL_COMPANY_ADMIN)
@Get()
findAll(@CurrentUser() user: AuthenticatedUser) {
  if (user.role === UserRole.SUPER_ADMIN) {
    return this.companiesService.findAll();
  }
  ...
  return this.companiesService.findAll(user.companyId);
}
```

and the service is `findAll(id?: string)` → `this.companyModel.find(id ? { _id: id } : {})`.

The dashboard side confirms the other half. `src/admin/petrol_companies/api/fuel-companies.api.ts`
sends the filter and carries a comment asserting the backend honours it:

```ts
// Feature 013 T235/FR-087: the operator's fuel companies list — `GET /companies?type=FUEL`
// already exists (SA-scoped to every company on the platform).
export async function listFuelCompanies(): Promise<FuelCompany[]> {
  const { data } = await apiClient.get<FuelCompany[]>(apiRoutes.companies.list, { params: { type: 'FUEL' } });
```

That comment is false and has been since feature 013 shipped. This matters for sequencing: the fix
is one parameter, but the **stale comment is what would stop a reader from finding the bug**, so it
is corrected in the same change.

**FR-012 (the filter must narrow, never widen)** is satisfied structurally without a new guard. The
`FUEL_COMPANY_ADMIN` branch already passes `user.companyId` as the `_id` filter; adding a `type`
predicate to that same query can only ever intersect. The one thing the implementation must not do
is let `type` *replace* the id narrowing — so the service takes them as separate fields of one
filter object, never as a merged `Record` a caller could overwrite.

**Alternatives considered**: a separate `GET /companies/transport` route (rejected — it duplicates
the role-branching in `findAll` and leaves the original defect live for anyone still calling it);
defaulting an absent `type` to `FUEL` (rejected outright — FR-011 forbids it, and it would silently
break the `FUEL_COMPANY_ADMIN` self-read for a transport-company admin).

---

## R3 — The platform has **twelve** order states, not thirteen; the FR-023a buckets are exhaustive

**Decision**: Implement the six buckets of FR-023a as a single named, exported mapping and derive
both the summary counts (FR-023) and the list filter (FR-016) from it. Correct the spec's "thirteen"
to twelve.

**Rationale**: `src/common/enums/order-status.enum.ts` defines exactly 12 members. The spec said
"the platform's thirteen states" once, in Clarification 3. That is a miscount, not a missing state,
and it matters because FR-023d makes exhaustiveness a testable requirement — a test written against
"thirteen" would look for a state that does not exist. **The spec has since been corrected to
twelve.**

The mapping is total and disjoint, which is what FR-023d demands:

| Bucket | States | Count |
|---|---|---|
| `NEW` | `PENDING_APPROVAL`, `APPROVED`, `ROUTED_TO_TRANSPORT`, `PENDING_PAYMENT` | 4 |
| `IN_PROGRESS` | `ASSIGNED_TO_DRIVER`, `LOADING`, `IN_TRANSIT`, `UNLOADING` | 4 |
| `COMPLETED` | `DELIVERED` | 1 |
| `REJECTED` | `REJECTED` | 1 |
| `CANCELLED` | `CANCELLED` | 1 |
| `NEEDS_ATTENTION` | `AWAITING_ROUTING` | 1 |
| | **total** | **12** |

Every state appears exactly once; the buckets sum to the platform's whole order set. FR-023d is
therefore satisfiable and MUST be asserted by a test that enumerates `Object.values(OrderStatus)`
and fails when a future state joins the enum without joining a bucket — the exhaustiveness must
break loudly, not drift.

**Constitution I** forbids the four hardcoded Arabic labels the mock uses as the source of truth
(`AdminDashboard.tsx`'s `DOUGHNUT_LEGEND_ORDERS`). The bucket enum is the named value; the labels
are presentation.

**Alternatives considered**: folding `AWAITING_ROUTING` into `NEW` (rejected by Clarification 3 —
it is the one state that cannot progress without a human, which is the screen's whole purpose);
folding `CANCELLED` into `REJECTED` (rejected by FR-023b — different actors, different acts).

---

## R4 — `GET /orders` already returns every order to the operator; only the bucket filter is missing

**Decision**: Extend the existing `GET /orders` with a `bucket` query parameter alongside the
existing `status`. Do **not** add an operator-specific order list route.

**Rationale**: Three things are already true and were verified:

1. `OrdersService.findForUser` adds a `clientId`/`driverId` narrowing only for `CLIENT`/`DRIVER`.
   For `SUPER_ADMIN` it builds `{}` and the multi-party plugin bypasses — so **FR-015 already
   works today**.
2. `OrdersController.toRoleScopedShape` already treats `SUPER_ADMIN` as a full-visibility role
   (`isOperatorOrDriver` includes it), so the verification trail, tank summary, stop events and
   dispatch fields are already returned — **FR-018 already works**.
3. `buildSupplierInvoiceView` already admits `SUPER_ADMIN` and already **omits the key entirely**
   when nothing is confirmed — which is FR-019's "absent rather than showing zeros", already built
   and already correct.

So Story 3's backend work is much smaller than the spec implies. What is genuinely missing is the
bucket filter (FR-016) and the operator's summary counts (FR-023, see R5).

**The filter must be `status: { $in: [...] }`, never a `$or`.** `paginate()` composes a cursor
boundary as `$and: [filter, keyset]`, which is safe, but the scoping plugins inject via
`Query.where()`, which **replaces** a top-level key of the same name rather than merging it — the
exact defect feature 016 hit, where every service-layer `$or` on `ExchangeOffer` was silently
discarded. A `status` `$in` collides with nothing the plugins inject (`fuelCompanyId`,
`transportCompanyId`, `clientId`, `driverId`), so it is safe **for every role, not only the
operator**. Had the bucket been expressed as a `$or`, it would have been silently dropped for a
`FUEL_COMPANY_ADMIN` and worked fine for the operator — a defect no operator-only test could see.

**Alternatives considered**: a new `GET /orders/all` for the operator (rejected — `findMine`'s
`toRoleScopedShape` and station-hydration would have to be duplicated, and the leak feature 008
found came from exactly that kind of second door); accepting a raw comma-separated status list
instead of a named bucket (rejected — FR-016 requires *both*, and the bucket must be named so the
dashboard and the summary cannot disagree about what "in progress" means).

---

## R5 — The operator currently receives the **transport company's** summary shape

**Decision**: Add a third summary shape, `PlatformSummaryDto`, returned for `SUPER_ADMIN`. Do not
reshape `getSummary`.

**Rationale**: `OrdersController.summary` branches two ways over three roles:

```ts
if (user.role === UserRole.FUEL_COMPANY_ADMIN) {
  return this.ordersService.getFuelCompanySummary(start, end);
}
return this.ordersService.getSummary(start, end);
```

`getSummary` is the **transport** shape — `awaitingAssignment`, `inProgress`, `completedInPeriod`,
`driversOnDuty`, `outstandingSettlements`. The operator falls into it by default. Its figures are
not *wrong* for a platform-wide reader (the plugin bypass makes them platform-wide counts), but they
are the wrong **questions**: `awaitingAssignment` names a decision that belongs to a transporter,
and none of the six FR-023a buckets is present.

This is the same call feature 013 already made when it added `getFuelCompanySummary` rather than
branching inside one method — its own comment says the role needs "a real, different shape, not the
same fields with the meaningless ones zeroed out". The operator is the third such role.

`getSummary`'s `from`/`to` defaulting (current calendar month) is reused verbatim, which is exactly
FR-005. FR-004 adds one thing the existing endpoint does not do: **echo the resolved period back**,
so the reader can tell which figures the dates apply to.

**Alternatives considered**: adding the buckets to `getSummary` and letting the operator ignore the
transport fields (rejected — it would put `driversOnDuty` on a platform summary where it silently
means something different, and FR-009 forbids carrying a figure the screen must not show).

---

## R6 — Story 1's period/point-in-time split is the whole of the dashboard defect

**Decision**: `GET /platform/overview` returns two clearly separated groups — `period` (order count,
order value, litres) and `pointInTime` (fuel companies, transport companies, stations) — plus the
resolved `from`/`to` and the two breakdowns. No trend field of any kind.

**Rationale**: `AdminDashboard.tsx` hardcodes six figures and attaches
`date: 'من الأسبوع الماضي'` and a `trend` to **all six**, including the three company/station counts
that are point-in-time facts. FR-002 and FR-009 exist because of exactly this. The platform computes
no period-over-period comparison anywhere, so every `trend` string in that file
(`'شركتان جديدتان'`, `'16.30%'`) is fabricated and must be removed, not recomputed — FR-078's
"removed and the removal recorded" precedent.

Sources, all verified to exist:

| Figure | Source | Bounded by |
|---|---|---|
| order count | `orderModel.countDocuments`, **every state** | `createdAt` |
| order value | `$sum` of `finalPrice` over **delivered** orders | `deliveredAt` |
| litres moved | `$sum` of `quantityLiters` over **delivered** orders | `deliveredAt` |
| fuel companies | `companyModel.countDocuments({ type: FUEL })` | no |
| transport companies | `companyModel.countDocuments({ type: TRANSPORT })` | no |
| stations | `stationModel.countDocuments({})` | no |

**Trading volume and litres count DELIVERED orders only**, per the spec's own Assumptions, bounded
by `deliveredAt` — not `createdAt` and not `updatedAt`. `deliveredAt` exists (spec 007 added it
precisely because `updatedAt` drifts when invoices and payments touch a delivered order afterwards)
and is indexed. Using `updatedAt` would make a period figure change retroactively every time an
invoice settled, which is the silent-wrongness class this feature exists to remove.

**The order count does NOT share that basis, and an earlier draft of this decision got it wrong.**
Extending "delivered orders only" from the value and the volume to the count as well is the obvious
reading of the Assumptions, and it is wrong in a way that produces no error: an order count
restricted to delivered orders is by definition equal to the `COMPLETED` bucket, so the other five
buckets of FR-006 would be structurally zero and the six-segment chart could never sum to the card
above it. The count is bounded by `createdAt` across **every** state — orders *raised* in the period.

This is why the overview carries a `basis` object (FR-001a, `PeriodFigureBasis`). Two figures on one
screen, under one date range, answering questions with different bases is exactly the sort of thing a
reader will otherwise assume is a bug in one of them. Stating it is cheaper than explaining it.

**Caught by the post-task consistency pass, not by this decision as first written** — the contract,
the data model and the task list all had to change. Worth recording because the mistake was not a
slip: it came from applying one line of the spec's Assumptions more widely than that line claims.

**`StationsService.countForCompany()` already returns the platform-wide count for this role** — its
`countDocuments({})` is scoped by the plugin, which bypasses for `SUPER_ADMIN`. The method name is
then actively misleading at this call site. It is reused (not reimplemented) and given a sibling
name rather than being called under a name that says the opposite of what it does for this caller.

---

## R7 — The operator cannot force-complete an order today; it is a one-role change plus a named constant

**Decision**: Add `UserRole.SUPER_ADMIN` to `forceComplete`'s `@Roles`, and lift the three
permitted stages out of the inline `if` into an exported `FORCE_COMPLETABLE_STATUSES` constant.

**Rationale**: `@Roles(UserRole.FUEL_COMPANY_ADMIN)` is the current decorator — FR-020 ("at the same
stages a fuel company administrator may") is unimplemented. The stage guard is three inline literal
comparisons:

```ts
if (order.status !== OrderStatus.LOADING &&
    order.status !== OrderStatus.IN_TRANSIT &&
    order.status !== OrderStatus.UNLOADING) {
  throw new ConflictException('Force-complete only allowed from LOADING, IN_TRANSIT or UNLOADING');
}
```

The message repeats the list a fourth time in prose. FR-021 requires the refusal to state a reason,
which it does; Constitution I requires the set to be a named value, which it is not. One constant
serves the guard, the message and the test.

`forceComplete` calls `ordersService.findById(id)`, not `findOneForUser` — for `SUPER_ADMIN` the
plugin bypass makes that resolve any order on the platform, which is what FR-020 wants. No change
needed there.

**Alternatives considered**: a separate operator force-complete route (rejected — two routes onto
one transition is how the two stage-lists drift apart).

---

## R8 — `getSuggestedTruck` is the right query and the wrong function to call

**Decision**: Derive the roster's last-operated truck with the **same query shape** as
`DispatchService.getSuggestedTruck`, backed by the same existing index, but **without its
availability filter**, and as **one aggregate for the whole page** rather than per driver.

**Rationale**: The spec's Clarification 2 treats this derivation as new ground requiring a narrowed
exclusion. The derivation already exists and is already indexed:

```ts
// spec 008 (research R4): backs the last-operated-truck lookup ... so it stays derived
// from order history rather than a stored `lastTruckId` field on `User`.
OrderSchema.index({ driverId: 1, truckId: 1, createdAt: -1 },
                  { partialFilterExpression: { truckId: { $exists: true } } });
```

`DispatchService.getSuggestedTruck` reads it. But it is a **pick-list suggestion**, and it
deliberately suppresses the answer:

```ts
return this.truckModel.findOne({ _id: lastOrder.truckId, isActive: true,
                                 activeOrderId: { $exists: false } }).exec();
```

Calling it from the roster would be a subtle, plausible bug: a driver whose truck is **on a job
right now** would show "no truck", and FR-039b makes "never driven" and "truck unknown" a
distinction the screen must render differently. The roster states a historical fact; availability is
irrelevant to it. So the query is reused, the function is not.

**FR-039a forbids adding a stored field**, and the existing schema comment independently says the
same thing for the same reason. Agreement confirmed, nothing to change.

**FR-044a's boundary is enforced by the projection, not by discipline.** The aggregate groups
orders by `driverId` and projects **`truckId` alone** — no `createdAt`, no count, no order id, no
customer, nothing positional. The sort that finds "most recent" happens inside the pipeline and its
sort key is never emitted. This is what makes SC-014's "verified by inspecting what the platform
actually sends" checkable: the response shape has no field that could carry a delivery fact.

**Alternatives considered**: one `getSuggestedTruck`-shaped query per driver row (rejected — N+1
across a platform-wide roster, and it inherits the availability filter); adding `lastTruckId` to
`User` (rejected by FR-039a and by spec 008's own recorded decision — a stored value drifts from the
deliveries that are the evidence).

---

## R9 — Announcements: a new collection, BullMQ fan-out, and idempotency carried by a unique index

**Decision**: An `Announcement` document recording one send, plus a BullMQ queue that fans out into
the existing `Notification` collection. Per-recipient idempotency is a **unique compound index**, not
an application check.

**Rationale**: FR-052 (one announcement distinct from its deliveries), FR-053 (safe to retry, no
duplicate delivery), FR-054 (record who could not be reached and why) and FR-055 (do not block the
operator's request) together describe the shape feature 010's assignment-escalation queue already
has, and CLAUDE.md names that as the precedent to follow. `BullModule` is registered in
`app.module.ts` with three existing queue consumers.

**BullMQ is at-least-once and `Worker.close()` deliberately releases an unfinished job for
redelivery** — feature 012 corrected FR-062's "exactly once" for exactly this reason. So FR-053
cannot rest on the queue. It rests on a unique index over (announcement, recipient), so a redelivered
job's second insert fails as a duplicate key and is caught and skipped. This is Constitution V's
"concurrency safety at the data layer, not assumed from application ordering", and it mirrors the
`DeliveryRating` unique-on-`orderId` decision from spec 007 and feature 009's `isDuplicateKeyError`
idiom.

**FR-054's "could not reach, and why" needs its own named reason enum**, not a boolean. The spec's
edge cases name at least two distinct causes — a suspended company and a deactivated administrator
account — and feature 010 already learned this lesson when `EscalationSkipReason` had to gain
`SEND_FAILED` to keep "attempted and failed" distinguishable from "never attempted".

**The processor must stamp `companyId` explicitly.** `Notification` is `markTenantScoped`, and a
BullMQ worker runs with no request context, so `pre('save')` takes the `!ctx?.role` bypass and
stamps nothing. A notification written without `companyId` would be invisible to its recipient's own
tenant-scoped list query — the fan-out would report success and deliver nothing. This is the single
easiest thing in Story 6 to get wrong and it is invisible to any test that reads the notification
back as `SUPER_ADMIN` (who bypasses scoping and would see it regardless). **The delivery test must
read as the recipient administrator**, not as the operator.

**Alternatives considered**: synchronous fan-out inside the request (rejected by FR-055, and the
spec's own Risks section notes it "would fail exactly when the platform is largest"); an application
-level "already delivered?" read before each insert (rejected — a read-then-write under redelivery
is the same race feature 009 hit on concurrent assignment, where the collision only appeared at
commit).

---

## R10 — Story 7 is almost entirely already built; the one real gap is a duplicate check that cannot see administrators

**Decision**: Reuse `POST /users/me/phone/verification` and `.../confirm` unchanged in shape, and
**widen only the duplicate-holder lookup** to be role-agnostic and active-agnostic. Derive session
count from `User.activeSessions` and last sign-in from the `SessionEvent` audit log. Add no new
stored field.

**Rationale**, point by point:

- **FR-060 (change the number)**: already exists, already admits every authenticated role (no
  `@Roles` decorator), already per-user throttled at 3 per 15 minutes, already sends the code to the
  **new** number and leaves the user's phone untouched until `confirm` succeeds.
- **FR-062 (must not sign the operator out)**: `confirm` ends with
  `this.usersService.update(userId, { phone })`. It does **not** touch `sessionGeneration` and does
  not clear `activeSessions`. Already satisfied — and worth an explicit regression test, because a
  future "changing your number should re-authenticate you" instinct would break feature 015's
  deliberate concurrent-session capability.
- **FR-059 (session count)**: `User.activeSessions` is an array of `{ sid, createdAt }`, populated
  only for `SESSION_CAPPED_ROLES` (which includes `SUPER_ADMIN`). `.length` is the count.
- **FR-058 (last sign-in)**: `ActiveSession` has **deliberately no `lastSeenAt`** — feature 015's
  research R1 refused it because it would mean a `User` write on every authenticated request. But
  `createdAt` per session exists, and the durable answer is better: `SessionEvent` is append-only,
  has **no TTL by design**, and carries the index `{ userId: 1, occurredAt: -1 }` — precisely the
  "most recent `SIGNED_IN` for this user" query. Using the audit log rather than
  `max(activeSessions[].createdAt)` is what keeps the answer correct after a sign-out, when the
  array is empty but the fact is not.

**The one genuine defect — FR-061.** `requestVerification`'s holder check is:

```ts
const holder = await this.tenantContext.runUnscoped(() =>
  this.usersService.findByPhoneForAuth(newPhone));
```

and `findByPhoneForAuth` is **deliberately scoped to CLIENT and DRIVER**:

```ts
.findOne({ phone: phone.trim(), role: { $in: [UserRole.CLIENT, UserRole.DRIVER] } })
```

Feature 015 extended the partial unique phone index to cover **all five roles**. So when the operator
changes their number to one held by **another administrator**, the pre-check finds nothing, an SMS is
spent, the operator enters a valid code, and the write fails on the unique index. `UsersService.update`
catches it and converts it to a 409 — so this is not a crash, but it violates FR-061's timing and the
service's own documented contract, which states: *"FR-035e: checked before anything is sent — a
message is never spent on a doomed change."* That guarantee is currently false for three of the five
roles.

Neither existing helper is correct as a replacement:

| Helper | Why it fails FR-061 |
|---|---|
| `findByPhoneForAuth` | excludes all three administrator roles |
| `findSingleActiveAdminByPhone` | requires `isActive: true`, and returns `null` on 2+ matches |

FR-061 says "already held by **any** account", and the spec's edge case adds that a **deactivated**
account still holds its identifier. So the fix is a new, narrow existence check — any role, any
active state — used **only** by this pre-check. `findByPhoneForAuth` and
`findSingleActiveAdminByPhone` are load-bearing for sign-in and MUST NOT be widened; feature 015's
notes record that their scoping is intentional and commented as such.

- **FR-063 (no invented permissions or statistics)**: `AdminProfilePermissions.tsx` and
  `AdminProfileStats.tsx` render fixed lists. The platform has no permission model beyond
  `UserRole` — there is nothing to fetch. These are FR-078 removals, not wiring tasks.

---

## R11 — The cashback payout needs a new kind AND a new two-kind balance; the existing balance is per-kind

**Decision**: Add `AccountMovementKind.CASHBACK_PAID_OUT`, a `getCashbackOwed()` that nets it
against `CASHBACK_CREDITED`, a partial unique index on `(companyId, kind, reference)` for FR-070,
and a derived `direction` field on the movement **response** rather than on the schema.

**Rationale**: `getConfirmedBalance` filters by a single `kind`:

```ts
.find({ companyId: ..., kind, state: AccountMovementState.CONFIRMED })
.select('amount reversalOfId');
return movements.reduce((sum, m) => sum + (m.reversalOfId ? -m.amount : m.amount), 0);
```

This is the trap in Story 8. A payout recorded under a **new** kind leaves
`getConfirmedBalance(companyId, CASHBACK_CREDITED)` **completely unchanged** — the accrual total is
still the accrual total. FR-067 ("reduce the owed balance by exactly the amount recorded") would
then be violated while every existing method still returned a correct-looking number. The owed
balance is a *derived, two-kind* figure and must be its own method:

```
owed = confirmed(CASHBACK_CREDITED) − confirmed(CASHBACK_PAID_OUT)
```

**Why not model the payout as a reversal.** `reversalOfId` already nets out of the sum, so it looks
like a free ride. It is wrong twice: it points at **one specific movement** and nets it *entirely*,
which cannot express FR-003's partial payout; and semantically a payout is not a reversal — FR-063
of feature 013 reserves reversals for correcting an accrual that should not have happened. A payout
is a real, new, opposite-direction event.

**Why `direction` belongs on the response, not the schema.** Story 8's scenario 6 requires the
direction to be "unambiguous on its face". `amount` is `min: 0` platform-wide and every other money
field follows that convention, so a signed amount is out. Direction is already *implicit* in `kind`
— but only to a reader who knows that `COMMISSION_CHARGED` and `PAYMENT_RECORDED` point one way and
`CASHBACK_CREDITED`/`CASHBACK_PAID_OUT` the other. Deriving an explicit `direction` in the response
serves FR-064 without migrating existing rows or changing the payload shape feature 013's dashboard
already reads.

**FR-070 (duplicate reference refused) is a unique index**, partial on
`{ kind: CASHBACK_PAID_OUT, reference: { $exists: true } }` — Constitution V again, and the same
reasoning as R9. An application-level "has this reference been used?" read is a read-then-write race.

**FR-069 (evaluated at the moment it is recorded, never against the screen's figure)** makes the
whole payout one transaction: re-read the owed balance **inside** the session, compare, insert. This
is Principle V's stated scope — "any operation where a partial write could double-charge or corrupt".
`getConfirmedBalance` already accepts an optional `ClientSession`, so the session threads through
without a new signature.

**A payout is created already `CONFIRMED`.** `PAYMENT_RECORDED` starts `RECORDED` and awaits the
operator's confirmation because a *company* asserted it. A payout is asserted by the operator
themselves — there is no second party to confirm it, and leaving it `RECORDED` would mean it did not
reduce the balance, contradicting FR-067. This matches how `CASHBACK_CREDITED` is already created
confirmed.

---

## R12 — Operator transporter onboarding: reuse the transaction, drop the tenant-correction step

**Decision**: A new `POST /companies/transporters` (operator-level, parent named in the body),
reusing `createTransporter`'s exact two-write transaction. **Omit** the post-insert `companyId`
correction, which exists only for a `FUEL_COMPANY_ADMIN` actor.

**Rationale**: The existing route is `POST /companies/:id/transporters` with
`@Roles(UserRole.FUEL_COMPANY_ADMIN)` and `:id` meaning *the acting admin's own company*. That shape
cannot express the operator's case — the operator has no company, and the parent is a choice
(FR-030), not the actor's identity. So this is a new route, not a widened `@Roles`.

Everything else is reused verbatim, because FR-028 and FR-031 are already solved there:

- The company and its first administrator are created in **one `session.withTransaction`**, with a
  comment recording the exact failure this prevents — a committed, admin-less company squatting a
  platform-unique name. That is FR-028.
- `createTransportCompany` sets `type: TRANSPORT` and `parentFuelCompanyId` itself. Nothing records
  *who* onboarded the company, so FR-031's "indistinguishable afterwards" holds by construction —
  there is no field that could differ.

**The one step that must NOT be copied.** The existing route ends with:

```ts
// `User` is tenant-scoped: the plugin's `pre('save')` hook unconditionally overwrites a new
// document's companyId with the ACTING user's own tenant ...
admin = await this.usersService.update(String(admin._id), { companyId: transporter._id }, session);
```

That correction exists because a `FUEL_COMPANY_ADMIN` actor has a `companyId` and the hook clobbers
the new admin's with it. **For a `SUPER_ADMIN` actor the hook returns early** (R1) and never writes,
so the `companyId` passed to `create` survives. The correction is therefore a no-op on this path.
Copying it is harmless but misleading; omitting it and stating why in a comment is the honest
version, and the comment is what stops a future reader from "fixing" the operator path by removing
the hook bypass.

**FR-030's refusal of an unnamed parent is a DTO concern** — a required, `ObjectId`-validated
`parentFuelCompanyId`. It must additionally be verified to name a company that exists **and is of
type `FUEL`**, because the spec's Risks section is explicit that a wrong parent "does not fail
loudly at onboarding" — it produces a transporter whose orders route to the wrong fuel company. A
merely-present id satisfies FR-030's letter and none of its purpose.

**FR-032 is a prohibition, and its test is a negative one.** Nothing in this feature touches
`multi-party-scope.plugin.ts`'s `resolveFuelCompanyId` or the routing query. SC-006 is verified by
exercising an operator-onboarded transporter and a parent-onboarded one through the same journey and
observing no difference — the same shape of "both paths, one journey" check feature 016 used.

---

## R13 — Order search is by identifier only, because nothing else on `Order` is searchable

**Decision**: `GET /orders` accepts an `orderId` query parameter and returns that order alone.
Free-text search over station, company or customer names is **out of scope and recorded as such**
(FR-016a).

**Rationale**: Story 3's narrative says the operator can "filter by state, search, page through",
and SC-003 requires them to locate any order on the platform in under 30 seconds. No functional
requirement covered search, so it had no design and no task — found by the consistency pass.

Verification decided the scope. `Order` has **no `orderNumber` or human reference field** — the only
identifier is `_id`. Its human-facing fields are snapshots (`clientSummary`, `driverSummary`,
`warehouseSummary`, `deliveryAddressText`), none of which carries a text index, and the platform has
no text index anywhere. Free-text search would therefore mean either a new text index over embedded
snapshot documents or a regex scan of every order on the platform — the first is a schema change
with its own migration, the second is a full collection scan on the operator's most-used list.

Searching by identifier needs **no new index at all** (`_id` is indexed by construction) and answers
exactly the question SC-003 asks. The narrower capability is the honest one, and FR-016a records the
exclusion rather than leaving a future reader to assume search was forgotten.

**Alternatives considered**: a regex scan over `clientSummary.fullName` and the station name
(rejected — an unindexed scan over every order on the platform, growing without bound, on the screen
the operator opens most); a Mongo text index over the snapshot sub-documents (rejected as a separate
feature — it is a schema and migration change, and the spec asks for none of it).

---

## R14 — Per-transporter order volume is one batched aggregate, not a figure per row

**Decision**: A new operator route returns order volumes for a set of transport companies in one
aggregate. The period is the operator's own selected range, resolved identically to the overview.

**Rationale**: FR-026 requires each listed transport company to carry the orders it carried in the
period. The original contract deferred this to "implementation time" with an unstated fallback,
which left a stated MUST with no design — found by the consistency pass.

Two things had to be settled. **Which period**: FR-026a now binds it to the same range the overview
uses, defaulting the same way, so the two screens cannot disagree about what "this period" means —
the same reasoning that made `OrderStatusBucket` a single shared mapping in R3. **How many queries**:
FR-026b forbids one per company. `Order` already carries `transportCompanyId` with an index
(`{ transportCompanyId: 1, status: 1 }`), so one `$match` + `$group` over a page's company ids
resolves every row at once.

The volume counts orders **raised** in the period, on the same basis as the overview's order count
(FR-001a) — a transporter's workload is what it was given, not only what it finished.

**Alternatives considered**: folding the count into `GET /companies?type=TRANSPORT` (rejected — it
would put a period-bounded order figure on a company listing every role calls, changing a shared
payload for one screen); omitting the figure under FR-037's "absent rather than invented" rule
(rejected — FR-037 covers figures with **no source**, and this one has a source and an index).

---
## Cross-cutting: what is already true and must not be rebuilt

Verified present and correct for `SUPER_ADMIN`, requiring **no backend work**:

| Capability | Route | Status |
|---|---|---|
| Read own notifications, paged, unread filter | `GET /notifications` | role-agnostic, cursor-paged, works |
| Mark one read / mark all read | `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` | works |
| Full order record incl. restricted fields | `GET /orders/:id` | `toRoleScopedShape` admits the operator |
| Supplier invoice + litre balance, absent when none | `GET /orders/:id` | `buildSupplierInvoiceView` admits the operator, omits the key |
| Every order on the platform, cursor-paged | `GET /orders` | plugin bypass, no narrowing added |
| Cross-company ledger and invoices | `GET /platform-account/movements`, `GET /invoices` | `companyId` filter already SA-load-bearing |
| Suspend / reinstate any company | `PATCH /companies/:id/status` | already `SUPER_ADMIN`, type-agnostic — covers FR-033 |
| Read a company's drivers / station owners | `GET /users?role=…&companyId=…` | `companyId` already SA-load-bearing |

FR-033 deserves note: `setStatus` is already operator-only and takes any company id regardless of
type, so suspending a **transport** company already works. The sign-in refusal it produces is
feature 013's existing `getScopingInfo` check, unchanged.

## Cross-cutting: the driver roster is the one list that needs its own route

`GET /users?role=DRIVER` returns `this.userModel.find(query).exec()` — an **unbounded array**, no
cursor, no employer name, no truck. FR-038 is platform-wide, the spec's edge cases require
cursor-stable paging ("no record shown twice and none skipped"), and FR-039 requires the employing
company and the derived truck on each row. Three joins onto an unpaged array is not a filter
addition; it is a different endpoint. It reuses `paginate()` and the R8 aggregate.

**FR-040's never-connected driver is the failure mode to test for.** The spec names it and points at
feature 010's precedent, where `$geoNear` silently dropped any driver missing the field it sorted
by. The roster must sort on a field **every** driver document has — `createdAt`/`_id`, never
`lastSeenAt` or `isOnline` — or a driver who has never connected vanishes from the list rather than
appearing with an unknown duty state.
