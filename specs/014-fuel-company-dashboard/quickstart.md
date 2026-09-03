# Quickstart: Fuel Company Admin Dashboard

**Feature**: `013-fuel-company-dashboard` | **Date**: 2026-09-03

A walkthrough that proves each slice works, in slice order. Parts 0–2 need only a local backend and
the dashboard. Part 3 needs two fuel companies. Record results at the foot of this file.

## Prerequisites

```bash
# Platform
cd e:/zeyad/ciro_fuel_backend
npm install && npm run start:dev          # requires MongoDB replica set + Redis

# Dashboard
cd E:/zeyad/web_dashboard_ciro_fuel
npm install && npm run dev
```

Seed actors with `scripts/seed-dashboard-actors.ts`. It was already extended for feature 009's
walkthrough; this feature needs it to additionally produce a **second fuel company** (Part 3) and a
station owner holding a **credit limit** and at least one **approved order**.

---

## Part 0 — The session (Slice 0) · blocks everything

| # | Step | Expected |
|---|---|---|
| 0.1 | Sign in as the seeded fuel company administrator | Accepted; lands on the fuel company dashboard |
| 0.2 | Reload the page | Still signed in — the session survives |
| 0.3 | Sign in as a **client**, then navigate to `/petrolCompany/orders` | **Refused.** Before this slice, admitted. |
| 0.4 | Sign in as a **transport company administrator**, navigate to any `/petrolCompany` route | Refused |
| 0.5 | Navigate to `/select-role` | No such screen |
| 0.6 | `grep -r "dummy-token" src/` in the dashboard | **No matches** |
| 0.7 | Watch the network tab through a full sign-in | Every request carries a platform-issued token |

**If 0.3 still admits a client, stop.** Everything below is meaningless.

---

## Part 1 — Connecting what exists (Slices 1–8)

### Orders (Slice 2)

| # | Step | Expected |
|---|---|---|
| 1.1 | Open the orders list | Real orders; no sample rows; stage filter uses the platform's full vocabulary |
| 1.2 | Page to the end while a client places a new order | No row duplicated or skipped |
| 1.3 | Approve an order with a final price | Advances; the recorded price is the one entered; the client sees it change without reloading |
| 1.4 | Reject another with a reason | Rejected; reason retained |
| 1.5 | Route an approved order to a transporter | Visible to that transporter only |
| 1.6 | Open an order in `IN_TRANSIT` and check the actions offered | No driver verification, loading confirmation, vehicle reassignment, override, stop resolution, assignment or cancellation (FR-017) |
| 1.7 | Approve the same order from two browser sessions at once | One succeeds; the other gets a **conflict message**, not a 500 (SC-008) |

### Owners, stations, credit (Slice 3)

| # | Step | Expected |
|---|---|---|
| 1.8 | Onboard a station owner | They can sign in as a client of this fuel company |
| 1.9 | Register two stations for them | Available to them when placing an order |
| 1.10 | Open the stations list | **Every** station of the company, across all owners (R5) |
| 1.11 | Set a credit limit; check the drawn portion | Matches the platform's accounting |
| 1.12 | As the owner, request a higher limit; accept it at a **lower** amount | The granted amount becomes the limit; the owner is told what was granted |
| 1.13 | Resolve the same request twice | Second attempt refused as already resolved (FR-031) |

### Transporters, pricing, invoices (Slices 4–6)

| # | Step | Expected |
|---|---|---|
| 1.14 | Onboard a transporter | Selectable when routing |
| 1.15 | Change a grade's price; request a quote as an owner | Quote uses the new price |
| 1.16 | Open an order placed **before** the change | Still shows the price in force when placed (FR-039) |
| 1.17 | Open the invoices screen | The invoice for the order approved at 1.3 is listed — **approval issues it, not delivery** (R4) |
| 1.18 | Settle it | Recorded settled; the counterparty sees it settled |

### Home, notifications, support (Slices 7–8)

| # | Step | Expected |
|---|---|---|
| 1.19 | Open the dashboard home | Every count matches the corresponding list screen (SC-009) |
| 1.20 | Look for trend percentages | **None anywhere** (FR-047) |
| 1.21 | Hide the browser tab for two minutes, watch the network tab | **Zero requests** (SC-010) |
| 1.22 | Raise a support request as an owner | Appears in the administrator's support inbox; acknowledging it shows as acknowledged to the owner |

**Slices 0–8 complete here.** This is the natural feature boundary (plan Complexity Tracking).

---

## Part 2 — New capability (Slices 9–11)

### Commission and cashback (Slice 9)

| # | Step | Expected |
|---|---|---|
| 2.1 | As the operator, set a commission rate as a percentage | Recorded as a new effective-dated term |
| 2.2 | Approve an order | Commission accrues at that rate (accrual is at **approval**, R4) |
| 2.3 | Change the rate; check the earlier accrual | **Unchanged** (FR-058, SC-011) |
| 2.4 | As the fuel company administrator, open the commission terms | **Read-only** — no edit control present, not merely disabled (FR-056, FR-091) |
| 2.5 | Activate cashback for named companies only; pay an invoice as a company not named | No cashback accrues (FR-060) |
| 2.6 | Set a low ceiling; accrue past 90% | Warning states the accrued amount and the ceiling (FR-062c) |
| 2.7 | Accrue past the ceiling; attempt deferred dealing | Refused, ceiling named (FR-062d) |
| 2.8 | Record and **confirm** a payment bringing it below | Dealing resumes with no operator action |

### Platform account (Slice 10)

| # | Step | Expected |
|---|---|---|
| 2.9 | Record a partial payment **without** evidence | Refused, naming the requirement (FR-067) |
| 2.10 | Record it with a document attached | Appears as `RECORDED`; **balance unchanged** (FR-068, SC-012) |
| 2.11 | Confirm it as the operator | Balance falls by exactly the amount paid; remainder still owed |
| 2.12 | Open the attached document as a second fuel company | Refused (FR-070) |

### Supplier invoices and litre balances (Slice 11)

Use the real invoice as the reference case: **31,501.100 L supplied against 33,000 L ordered**.

| # | Step | Expected |
|---|---|---|
| 2.13 | Upload a supplier invoice against a 33,000 L order | Extracted values shown **beside the ordered quantity**, awaiting confirmation (FR-073a-v) |
| 2.14 | Abandon at the confirmation step | Nothing recorded; **no balance movement** (SC-014c) |
| 2.15 | Upload again, correct the extracted quantity, confirm | Corrected value is recorded; what was extracted is retained (SC-014d) |
| 2.16 | Check the owner's balance | Credited **1,498.90 L** for that grade |
| 2.17 | Retry the same upload / repeat the confirm | Balance moves **once**, never twice (FR-073e) |
| 2.18 | Upload an invoice whose grade differs from the order's | Refused, naming the mismatch (FR-073g) |
| 2.19 | Place a later order for that grade as the owner | Balance drawn down automatically; amount drawn and remainder shown **before** placing (FR-074) |
| 2.20 | Request a quote only, then abandon it | Balance **unchanged** — a quote consumes nothing (R9) |
| 2.21 | Cancel the order from 2.19 | Draw-down returned to the balance |
| 2.22 | Adjust a balance without a reason | Refused (FR-075) |
| 2.23 | As the owner, open your own balance | Matches; every movement traces to its order or correction (FR-075a) |

---

## Part 3 — Fuel exchange (Slice 12) · needs two fuel companies

**This part is the whole point of the party-set isolation mechanism. A single-company run proves
nothing** — see `contracts/isolation-contract.md`.

| # | Step | Expected |
|---|---|---|
| 3.1 | As company A, raise a request to company B | Appears in A's **outgoing** |
| 3.2 | **As company B, open incoming requests** | **The request is there.** If empty, the isolation mechanism is wrong (R3) — and note that A's screen looked perfectly healthy at 3.1 |
| 3.3 | As the platform operator, open the exchange screen | Shows it — **this screen shows it even when 3.2 is broken**, so it proves nothing on its own |
| 3.4 | As a third fuel company, list requests | Not present (FR-079) |
| 3.5 | As B, accept it | Both parties see it accepted, supplier and receiver identified |
| 3.6 | Check both parties' orders lists | **No order or delivery was created** (FR-086a) |
| 3.7 | Raise another; accept as B and withdraw as A at the same moment | One outcome; both parties see the **same** one (FR-082) |
| 3.8 | Raise a request naming a grade B does not sell | Refused at submission (FR-085) |
| 3.9 | As a non-party company, open the request by its address | Refused, without revealing whether it exists |

---

## Part 4 — Operator oversight (Slice 13)

| # | Step | Expected |
|---|---|---|
| 4.1 | As the operator, list fuel companies | All of them, with real figures |
| 4.2 | Onboard one | Its administrator can sign in |
| 4.3 | Open it; compare against that company's own administrator's view | Figures match |
| 4.4 | Open a shared screen as each role | Operator-only controls **absent** for the administrator, not disabled (FR-091) |
| 4.5 | Suspend a company | Its administrator is refused sign-in and told why |

---

## Regression gates (every slice)

```bash
# Platform
npm run lint:check && npm run build && npm run test
npx jest --config test/jest-e2e.json --runInBand

# Dashboard
npx tsc -b --force && npx vitest run

# Clients — MUST be unchanged except Slice 11's two client-facing additions
cd mobile_app && flutter test    # 418 passing, 2 documented pre-existing non-green
```

Known pre-existing baseline, not caused by this feature: mobile
`login_screen_golden_test` (pixel diff) and `auth_session_test` (`skip: true`); dashboard
`accessibility.test.tsx` and `orders.mutations.test.tsx` fail to load, and `tsc -b --force` reports
unused-import errors in files feature 009's deletions left behind.

---

## Results

*(record dates, who walked it, and outcomes per part)*

| Part | Date | Result |
|---|---|---|
| 0 | 2026-09-03 | **PASS** (T029) — see notes below. No interactive browser session was available this pass; steps needing one are covered by automated tests instead and named explicitly. |
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |

### Part 0 detail (T029, 2026-09-03)

| # | Verified via | Result |
|---|---|---|
| 0.1 | Live `POST /auth/login` against the running backend (seeded fuel admin, `fuel@dash00505150.test`) | **PASS** — `201`, response carries `accessToken`, `refreshToken`, `user.role: "FUEL_COMPANY_ADMIN"`. |
| 0.2 | Live `GET /auth/me` with 0.1's access token | **PASS** — `200`, same identity returned; this is the exact call `bootstrapSession()` makes on reload (`tests/unit/bootstrap-session.test.ts` exercises the function itself against a mocked backend). No interactive browser reload performed. |
| 0.3 | Live login as the seeded client (`+966540005150`) + `PUT /users/:id/credit-limit` with that token | **PASS** — `403`. Also covered exhaustively server-side by `test/e2e/fuel-company-rbac.e2e-spec.ts` (57 assertions) and dashboard-side by `tests/unit/router-guards.test.ts` (`/petrolCompany` admits `FUEL_COMPANY_ADMIN` only) and `tests/unit/protected-route.test.tsx`. |
| 0.4 | `test/e2e/fuel-company-rbac.e2e-spec.ts` (`TRANSPORT_COMPANY_ADMIN` refused every fuel-company-only endpoint) + `tests/unit/router-guards.test.ts` | **PASS** — no live interactive check performed for this specific role; the same guard mechanism verified for 0.3 applies identically. |
| 0.5 | `tests/unit/router-guards.test.ts`: `'the former demo role-selection route no longer exists'` | **PASS** — asserts `/select-role` is absent from `router.routes`; `RoleSelectionPage.tsx` itself is deleted (T019/T028 correction). |
| 0.6 | `grep -rn "dummy-token" web_dashboard/src/` | **PASS** — zero matches (T028). |
| 0.7 | `tests/unit/api-client.refresh.test.ts` (single-flight refresh, body-based token) | **PASS** by construction — `apiClient`'s request interceptor attaches `Authorization: Bearer <tokenStore.get()>` to every request; no interactive network-tab observation performed. |

**Not verified this pass** (needs a live browser/dev-server session): the actual rendered dashboard UI after sign-in, a real page reload's visual continuity, and watching real browser network traffic. The underlying mechanisms for all of these are unit-tested against the real functions (`bootstrapSession`, the axios interceptors, the router's guard configuration), which is what makes 0.1–0.7 a **PASS** here — but an interactive walkthrough remains the way to catch anything a mocked-backend unit test cannot (rendering, real timing, real browser storage behavior).
