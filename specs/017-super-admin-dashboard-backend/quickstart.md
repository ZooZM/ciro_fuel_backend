# Quickstart: Platform Operator Dashboard — Backend Integration

**Feature**: `017-super-admin-dashboard-backend` | **Phase**: 1

A walkthrough that proves each story against a running platform. Parts 1–8 map to Stories 1–8;
Part 0 is setup and Part 9 is the non-regression gate.

**Record results at the foot of this file** as they are walked, following feature 012's precedent.

---

## Part 0 — Setup

```bash
# backend
cd E:\zeyad\ciro_fuel_backend
git checkout 017-super-admin-dashboard-backend
npm install
npm run build

# dashboard — the branch does not exist yet
cd E:\zeyad\web_dashboard_ciro_fuel
git checkout -b 017-super-admin-dashboard-backend
npm install
```

Requires MongoDB as a **replica set** (transactions) and Redis (BullMQ, throttler counters).

Seed a platform that makes the assertions below meaningful:

```bash
cd E:\zeyad\ciro_fuel_backend
npx ts-node scripts/seed-dashboard-actors.ts
```

**The seed must produce a known mix**, because Story 2's whole point is a count:

| Records | Why |
|---|---|
| 3 fuel companies, 5 transport companies | Story 2's acceptance scenario 1 states these exact numbers |
| ≥ 1 station per fuel company | Story 1's station count |
| orders across **all six** buckets | Story 1 chart, Story 3 summary, FR-023d |
| ≥ 1 order `AWAITING_ROUTING` | the `NEEDS_ATTENTION` card exists for this |
| 1 `REJECTED` and 1 `CANCELLED` order | FR-023b — counted separately |
| ≥ 1 delivered order with a confirmed supplier invoice, and ≥ 1 without | FR-019's present/absent pair |
| a driver who has **never connected** | FR-040 |
| a driver who has **never been assigned a truck** | FR-039b |
| a driver with deliveries on ≥ 2 different trucks | FR-039a — the most recent must win |
| orders raised in the period but **not** delivered | FR-001a — the count includes them, the value and litres do not |
| a fuel company with an accrued cashback balance | Story 8 |

Write down the seeded counts. Every figure below is checked against them, not against itself.

---

## Part 1 — Story 1: the home screen states the platform's real numbers

1. Sign in as the operator. Open the dashboard.
2. **Reconcile all six cards** against the seed. Fuel companies, transport companies and stations
   must equal the seeded counts exactly.
3. Change the date range.
   - **Order count, trading volume and litres change.**
   - **The three company/station cards do not.** (FR-002, acceptance scenario 2 — this is the
     clearest single signal that the wiring is real.)
4. Set the range to a period with no activity. The three period cards read **`0`**, not blank and
   not the previous period's figures (FR-008).
4a. **The two bases (FR-001a).** Seed a period containing orders raised but not yet delivered, then
   confirm the order count includes them while the trading volume and the litres do not, and that
   `period.basis` reports `RAISED_IN_PERIOD` for the count and `DELIVERED_IN_PERIOD` for the other
   two. An order count restricted to delivered orders would equal the completed bucket and force the
   other five to zero — the failure this check exists to catch.
5. Read the order-state chart. It has **six** segments and they sum to the order card above it
   (FR-006).
6. Read the company chart. Two segments summing to the two company cards.
7. **Confirm no trend caption appears anywhere on the screen** — no percentage, no "من الأسبوع
   الماضي", no arrow (FR-009). The platform computes none.

```bash
curl -s "$API/api/v1/platform/overview?from=2026-09-01&to=2026-09-30" -H "Authorization: Bearer $SA" | jq
# then, checking the default:
curl -s "$API/api/v1/platform/overview" -H "Authorization: Bearer $SA" | jq '.period.isDefault, .period.from, .period.to'
```

`isDefault` must be `true` and the range the current calendar month (FR-005).

8. Repeat step 7's call as a `FUEL_COMPANY_ADMIN` → **403** (FR-007).

---

## Part 2 — Story 2: the fuel-company list stops counting transporters

This is the live defect. Check it **before** the fix to see it.

```bash
# before: returns all 8 companies despite the filter
curl -s "$API/api/v1/companies?type=FUEL" -H "Authorization: Bearer $SA" | jq 'length'
```

After the fix:

1. `?type=FUEL` → **3**. `?type=TRANSPORT` → **5**. No overlap (scenarios 1, 2).
2. No `type` at all → **8** — every company, not a silent default to one (scenario 3, FR-011).
3. `?type=` (empty, which is what an unset UI filter sends) → **8**, same as absent.
4. As a `FUEL_COMPANY_ADMIN`, with **any** `type` → **their own company only**, never widened
   (scenario 4, FR-012). Try `?type=TRANSPORT` as a fuel admin: their own company or nothing, never
   a transporter.
5. On screen: the list shows 3 rows and the count card reads **3** (FR-014).
6. Invalid value `?type=BANANA` → **400**.

---

## Part 3 — Story 3: the platform-wide order list and one order in full

1. As the operator, list orders. **Every seeded order appears**, across all companies (FR-015,
   scenario 1).
2. Read the summary cards. Bucket counts **sum to the platform total**, nothing double-counted,
   nothing unbucketed (scenario 2a, FR-023d).
3. The `AWAITING_ROUTING` order is under **needs attention**, not in progress (scenario 2b).
4. The rejected order and the cancelled order are counted **separately** (scenario 2c).
5. Filter by a bucket, then by a single real state beneath it. Both work; the paging total reflects
   the filter (scenario 2, FR-016).
6. Page to the end. **No order appears twice and none is skipped** (edge case). Create an order
   mid-paging and page again to confirm.
7. Open the order **with** a confirmed supplier invoice → supplied-vs-ordered quantity and litre
   balance shown. Open one **without** → that card is **absent**, not zero-filled (scenario 4,
   FR-019).
8. Force-complete an `IN_TRANSIT` order with a reason → completes, reason recorded (scenario 5).
9. Force-complete a `PENDING_APPROVAL` order → **409**, order unmoved (scenario 6, FR-021).
10. Confirm the detail screen shows no street-level distance and no commission figure. `Order`
    carries **no commission field at all**, so FR-022's element is always absent rather than
    conditionally hidden (scenario 7, FR-022, FR-024).
11. **Search (FR-016a).** Paste an order identifier into the search box; that order alone is
    returned. Search an unknown identifier; the list is empty and says so. Search a company name;
    the empty result must read as "this box takes an order identifier", because free-text search is
    deliberately out of scope — no field on `Order` is indexed for it (research R13).

**The `$or` check (isolation contract §3)** — run the bucket filter as a `FUEL_COMPANY_ADMIN`:

```bash
curl -s "$API/api/v1/orders?bucket=IN_PROGRESS" -H "Authorization: Bearer $FCA" | jq '.items | length'
```

Must return that company's in-progress orders **and no other company's**. A silently-dropped scope
filter here is invisible to every operator-side check above.

---

## Part 4 — Story 4: transport companies

1. List transport companies. Each shows name, status, covered-area count and order volume
   (scenario 1, FR-025/FR-026).
2. A transporter no fuel company has ever routed to appears with **zero orders and zero areas**, not
   absent (edge case).
2a. **One call, not one per row (FR-026b).** With the network tab open, load a page of transport
   companies and confirm the order volumes arrive in a **single** request carrying every rendered
   company id, not one request per company.
2b. **One period, not two (FR-026a).** Change the date range and confirm the order-volume column
   moves with it, on the same range the operator's overview uses.
3. Onboard one through the form, naming a parent fuel company → company **and** its administrator
   created together (scenario 2, FR-028).
4. **Sign in as that new administrator.** They reach their own transport surface with an empty
   fleet, and **every data screen loads without an isolation failure** (scenario 4). This is the step
   that proves the parent was set correctly — a missing one throws on every scoped read.
5. Submit the form with **no parent** → refused, **nothing created** (scenario 3, FR-030). Confirm
   the company count is unchanged.
6. Submit naming a **transport** company as the parent → refused (FR-030's purpose).
7. Force a failure on the administrator half (reuse an existing admin email) → **neither** company
   nor admin exists afterwards (FR-028).
8. **SC-006, the important one**: have the parent fuel company's admin onboard a second transporter
   through their own route. Drive **both** through the same journey — the parent lists both, an order
   routes to each, regions assign to each. **No observable difference** (FR-031).
9. Suspend the operator-onboarded company → status changes and its administrator is refused sign-in
   with the stated reason (scenario 6, FR-033).
10. Suspend a company while one of its drivers is mid-delivery → **the delivery continues** (edge
    case). Suspension governs sign-in, not an in-flight order.
11. Confirm no performance rating and no average delivery time appear (scenario 7, FR-037).

---

## Part 5 — Story 5: the driver roster

1. List drivers. Every driver across every transport company appears, each naming its employer
   (scenario 1, FR-038).
2. The **never-connected** driver is **present**, with duty state unknown — not omitted (scenario
   from FR-040, and feature 010's precedent).
3. The **never-assigned-a-truck** driver shows no truck, rendered distinctly from "unknown" — not
   blank, not placeholder text (scenario 6, FR-039b).
4. The driver with deliveries on two trucks shows **the most recent** (scenario 5, FR-039a).
5. Take that driver's truck and put it on another active order, then reload. **The truck is still
   named** — the roster states a historical fact, not availability (research R8's failure mode).
6. Filter by active and by duty state (scenario 2, FR-041).
7. Open one driver → their record and employing company (scenario 3, FR-042).

**SC-014 — check the payload, not the screen:**

```bash
curl -s "$API/api/v1/drivers/roster" -H "Authorization: Bearer $SA" \
  | jq 'tostring | test("location|lastSeenAt|lastMovedAt|tripsMonth|lastShipment|deliveredAt|orderId|stopEvents")'
```

Must print **`false`**. The truck's identity reaches the screen; **no** delivery record, count or
date accompanies it (scenario 5, FR-044a). A rendering check cannot see a field the screen merely
chose not to draw.

---

## Part 6 — Story 6: notifications and announcements

1. Trigger a notification for the operator → it appears, newest first, with real content and time
   (scenario 1, FR-046).
2. Mark one read, then mark all read. The unread count falls and **stays fallen across a reload**
   (scenario 2, FR-047).
3. Send an announcement to the whole platform. The request returns **`202`** promptly and does not
   block on delivery (FR-055).
4. **Sign in as a fuel company administrator and as a transport company administrator.** Both have
   it (scenario 3, FR-049). *This is the assertion that matters — reading it back as the operator
   proves nothing, because the operator bypasses tenant scoping and would see a wrongly-stamped
   notification the recipient cannot* (research R9).
5. Sign in as a **client** and as a **driver**. Neither has it (scenario 3, FR-051, SC-008).
6. Send one addressed to a subset of companies → only those companies' administrators receive it
   (scenario 4, FR-050).
7. Send to a platform including a **suspended** company and a **deactivated** administrator → both
   skipped, each recorded with its own named reason, neither counted as delivered (edge cases,
   FR-054).
8. **Retry the send.** Zero duplicate deliveries (scenario 5, FR-053, SC-009). Re-run the recipient
   check from step 4 and confirm each administrator still has exactly one.
9. `GET /announcements/:id` shows what was sent, to whom, who was reached and who was not (FR-052).
10. Attempt to send as a `FUEL_COMPANY_ADMIN` → **403** (FR-056).

---

## Part 7 — Story 7: the operator's own account

1. **Sign in from two devices**, then open the profile. It reports **two** active sessions and the
   time of the most recent sign-in (scenario 2, FR-058/FR-059, SC-010).
2. Real name, email and the **real** sign-in mobile number are shown — not a mask (scenario 1,
   FR-057).
3. Change the number; confirm the code sent to the **new** number → it becomes the sign-in
   identifier (scenario 3, FR-060). Sign in with it; the old number is refused.
4. **Confirm the other session still works** — the operator is not signed out anywhere (FR-062).
   This is feature 015's concurrent-session capability and a change here would silently destroy it.
5. Attempt a change to a number held by **another administrator**. Refused with a stated reason,
   existing number unchanged (scenario 4, FR-061).
   **Confirm no SMS was sent** — the refusal must arrive at the *request* step, not at confirm. This
   is the defect research R10 identified: the current holder-check cannot see administrator accounts.
6. Attempt a change to a **deactivated** account's number → refused (edge case — a deactivated
   account still holds its identifier).
7. Confirm no permission list and no invented statistic appear (scenario 5, FR-063).

---

## Part 8 — Story 8: settling a cashback

1. Open the payment screen for the fuel company with an accrued balance. **The amount owed is the
   platform's own computed figure**, not typed in and not hardcoded (scenario 1, FR-065). Check it
   against the seeded accrual.
2. Record a **partial** payout with method, reference and evidence → the balance falls by exactly
   that amount and the remainder stays owed (scenario 3, FR-067).
3. Record a payout for the remainder → balance reaches **zero** (scenario 2).
4. Attempt a payout **greater than** the balance → refused, **nothing recorded** (scenario 4,
   FR-068). Confirm the movement count is unchanged.
5. Re-submit a payout with a **reference already used** → refused, not applied twice (edge case,
   FR-070).
6. **Sign in as that fuel company's own administrator** and open their platform account. The payout
   appears in their ledger as **money received from the platform** (scenario 5, FR-071).
7. Read a payout beside a payment the company made. **The direction is unambiguous on its face** —
   the two are never indistinguishable (scenario 6, FR-064).
8. Attempt to record a payout as a `FUEL_COMPANY_ADMIN` → **403**. A company can never record money
   as having been paid to it (FR-072).

**FR-069 — the balance the screen showed has no authority.** Open the payment screen, then in
another session accrue more cashback for the same company, then submit from the first screen. The
payout is evaluated against the balance **at the moment it is recorded** (edge case).

---

## Part 9 — Non-regression (FR-075, SC-013)

```bash
cd E:\zeyad\ciro_fuel_backend
npm run build          # clean
npx tsc --noEmit       # clean
npm run test           # unit — baseline + new suites
npm run test:e2e       # e2e  — baseline + new suites
```

> `npm run lint:check` is **unusable on this Windows checkout** — `core.autocrlf=true` with no
> `.gitattributes` makes eslint-plugin-prettier flag `␍` on every line repo-wide. Pre-existing
> environment condition, documented by feature 015. Git still normalises to LF, so commits are clean.

> Some e2e suites fail on any given full run from sequential `MongoMemoryReplSet` resource pressure
> — a shifting set, documented by feature 011. Confirm any failure is in that known set and passes
> in isolation before calling it a regression.

```bash
cd E:\zeyad\web_dashboard_ciro_fuel
npx tsc -b --force     # only the ~33 pre-existing TS6133/TS6192 unused-import errors
npx vitest run         # baseline + new; same 2 suites failing to LOAD, no new failures
```

**Mobile — the gate this feature cannot skip**:

```bash
cd <mobile_app>
flutter test
```

Required because this feature adds `NotificationType.PLATFORM_ANNOUNCEMENT` and spec 007 installed a
parity test pinning the Flutter enum to the backend's wire values. The mobile repository is **not
present on this machine**, so this MUST run elsewhere before deploy (SC-013). No administrator has a
mobile persona, so no mobile client will ever receive this type — the runtime risk is nil and the
test risk is real.

**Also confirm**: the fuel-company and transport-company dashboard surfaces are untouched, and the
backend's other roles behave identically (isolation contract §5).

---

## Results

> Fill in as Parts are walked. Record what was **not** verified and why, rather than leaving a blank.

| Part | Story | Date | Result | Notes |
|---|---|---|---|---|
| 0 | Setup | 2026-09-12 | PARTIAL | `scripts/seed-dashboard-actors.ts` extended (T002) and seeds three fuel + five transport companies over HTTP, the transporters through this feature's own `POST /companies/transporters`. The rest of the Part 0 mix — orders parked in AWAITING_ROUTING/REJECTED/CANCELLED, orders raised-but-undelivered, the three driver cases, an accrued cashback balance — cannot be produced through any route and is seeded directly by the e2e suites that assert it. The script prints exactly that. |
| 1 | Overview | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/platform-overview.e2e-spec.ts` (24 tests), including the FR-001a two-basis case. |
| 2 | Company filter | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/company-type-filter.e2e-spec.ts` (15 tests), including the FR-012 intersection case. |
| 3 | Orders | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/order-buckets.e2e-spec.ts` (29 tests), including the research-R4 scoping guard. |
| 4 | Transport companies | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/transport-onboarding.e2e-spec.ts` (20 tests), including the SC-006 both-routes equivalence case. |
| 5 | Driver roster | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/driver-roster.e2e-spec.ts` (20 tests), including the research-R8 busy-truck guard and the SC-014 payload assertion. |
| 6 | Announcements | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/announcements.e2e-spec.ts` (21 tests), including the research-R9 read-as-the-recipient guard. |
| 7 | Profile | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/operator-profile.e2e-spec.ts` (15 tests), including the FR-061 no-SMS-spent case. Part 4 steps needing a real handset and a live Taqnyat account remain unverifiable here, as they were for spec 015. |
| 8 | Cashback | 2026-09-12 | NOT WALKED — no running server in the implementing session (T157). The automated suite named alongside it covers the same guarantees against a real MongoMemoryReplSet. Covered by `test/e2e/cashback-payout.e2e-spec.ts` (16 tests), including the research-R11 balance-actually-falls guard. |
| 9 | Non-regression | 2026-09-12 | PARTIAL | Backend and dashboard halves done: `npm run test` 330/330, dashboard `vitest run` 127/127 and `tsc -b --force` at 28 pre-existing errors (down from 31), plus `test/e2e/operator-authorization.e2e-spec.ts` (65 tests) asserting every CHANGED route still admits the roles it already admitted. **`flutter test` NOT run — T158, that repository is not on this machine, and it is a deploy gate.** |
