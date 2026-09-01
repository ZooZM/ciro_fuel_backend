# Quickstart & Walkthrough — Feature 009

**Feature**: 009 | **Phase**: 1

Two things: how to stand the environment up, and **the walkthrough** — the written procedure that
carries one order the whole chain and is this feature's acceptance test (FR-025, SC-001).

The walkthrough is a P1 deliverable, not a closing formality. Two repositories with no shared
branch and three separately built surfaces mean nothing mechanically proves the halves agree.
This procedure is the only thing that does.

> **Write it as the slices land, never from memory.** Begin at slice 2 and grow it with each
> slice. A procedure reconstructed afterwards omits exactly the steps that gave trouble.

---

## Part 1 — Environment

### Repositories

| Repository | Role |
|---|---|
| `ciro_fuel` | Platform. Branch `009-transport-dashboard-order-lifecycle` |
| `web_dashboard` | Dashboard. Matching branch + a pointer to this spec, no spec of its own |
| `mobile_app` | Customer and driver. **Not modified** — participates as it stands |

### Services

MongoDB **as a replica set** — the platform uses transactions and assignment depends on one.
Redis. Platform on `:3000` serving `/api/v1` and the `/tracking` namespace. Dashboard on Vite,
`VITE_API_BASE_URL=http://localhost:3000/api/v1`. Mobile pointed at the same host — a physical
device or emulator reachable on the LAN, not `localhost`.

**Card pairing needs**: programmed cards; a reader attached to the operator machine presenting as
a keyboard; and, for the second path, a browser able to read cards directly (secure context and a
deliberate gesture). The keyboard path must work with no card-reading browser present — it is the
path that is never absent.

---

## Part 2 — Seed data

Everything the walkthrough needs, and why.

| # | Record | Notes |
|---|---|---|
| 1 | Fuel company | The tenant everything hangs from |
| 2 | Transport company | With `parentFuelCompanyId` → (1). **Mandatory** — the isolation plugin fails closed without it |
| 3 | Fuel company admin | Approves and routes, **by script** — no screen exists |
| 4 | **Transport company admin** | The persona under test |
| 5 | Client | Places the order |
| 6 | Client's station | Destination, with an address so lists name it |
| 7 | Driver | Belongs to (2), active, **with a location** — `$geoNear` omits any driver without one, so a driver with no position is never a candidate |
| 8 | Warehouse | The loading stop. Platform-level, `SUPER_ADMIN`-written |
| 9 | **Truck** | Registered through the dashboard once slice 4 lands; seeded before then |
| 10 | **Tank** | Capacity **≥** the ordered volume, permitting the ordered grade |
| 11 | **A second tank** | Capacity **<** the volume, or not permitting the grade — this is what proves the guards (SC-007) |
| 12 | Pricing config | On (1). Approval prices the order; without it approval cannot complete |
| 13 | Region coverage | Linking (2) to the station's region, or routing lands in `AWAITING_ROUTING` |

Records 11 and 13 are the ones most often forgotten. Without 11 the guards are never exercised;
without 13 the order never reaches the transporter and the walkthrough stalls at step 2 with a
confusing symptom.

---

## Part 3 — The walkthrough

Three surfaces open at once: dashboard (transport admin), mobile as customer, mobile as driver.
**Every step names what each participant should then see** — that is the point.

### 1. The customer places an order

*Customer, mobile.* Choose station, grade, volume; place.

- **Customer**: order appears, `PENDING_APPROVAL`, itemised cost.
- **Transport admin**: **nothing.** Not yet theirs. If it appears here, isolation is broken.

### 2. The fuel company approves and routes — *by script*

No screen exists for this persona (FR-035). The script signs in as (3) and calls the real
approval and routing endpoints under that role's real authorization. **It must not write stored
data directly or use any auto-advance setting** (FR-036) — the platform's genuine pricing and
routing behaviour has to run.

- **Customer**: `APPROVED`, then routed.
- **Transport admin**: **the order appears in the work queue**, `ROUTED_TO_TRANSPORT`. First
  moment it is theirs.
- **Notification**: `ORDER_ROUTED_TO_TRANSPORT` reaches the transport admin.

> Landing in `AWAITING_ROUTING` instead means seed 13 is missing.

### 3. The transport admin assigns — **the step that did not previously exist**

*Dashboard.* Open the order → candidates ranked, nearest and most available first, each with a
suggested tractor.

**3a — prove the guards first** (SC-007). Choose the deliberately wrong tank (seed 11):

- Refused, **naming which rule failed** — capacity with both numbers, or the grade.
- Order **stays** `ROUTED_TO_TRANSPORT`.

**3b — assign properly.** Driver → suggested tractor (or another) → valid tank → commit.

- **Transport admin**: `ASSIGNED_TO_DRIVER`, driver and vehicle named.
- **Driver**: **the delivery arrives on the phone without reopening the app.**
- **Customer**: driver and vehicle now named on their tracking view.
- **Notification**: `ORDER_ASSIGNED` reaches the driver.

> If the suggested tractor is absent, that is correct when it is withdrawn or already committed
> (FR-003). Nothing should be pre-selected in its place.

**3c — concurrency** (SC-008). Two admins, or two tabs, assign simultaneously: exactly one wins;
the loser is told it is already assigned and **the view corrects itself**.

### 4. The driver verifies the tractor

*Driver, mobile.* Present the card paired in the dashboard, or the credential.

- **Driver**: verified; proceeds toward the warehouse.
- **Transport admin**: **`LOADING`** — the stage the dashboard could not previously express.
  Appears **without reloading**, within 15 seconds (SC-003).
- **Customer**: sees the delivery is being prepared.

**4-alt — the override path** (SC-012). Instead, leave it unverifiable and override from the
dashboard with a reason:

- Proceeds to `LOADING` in under 2 minutes.
- **Everywhere afterwards it reads as overridden — never verified** (FR-055). Check all three
  surfaces. This is the single most important negative check in the walkthrough.

### 5. Loading, then departure

*Driver.* Confirm loading.

- **Transport admin**: `IN_TRANSIT`. **Tracking becomes available** — before this it must have
  said "not currently trackable", not shown an empty map (FR-017).
- **Customer**: tracking opens.

### 6. The truck moves

*Driver.* Move the device, or simulate movement.

- **Transport admin**: position updates on the map **without reloading**, never more than 60
  seconds behind (SC-004).
- **Customer**: the same movement.
- **Then stop updates** (aeroplane mode): both surfaces must **state the position is stale and how
  old it is** (FR-018) — not keep presenting the last point as current.

### 7. Arrival and handover

*Driver.* Arrive → request the handover code.

- **Customer**: receives the code. **Notification**: `OTP_ISSUED`.
- **Transport admin**: `UNLOADING`. **The code is never shown here** (FR-071). Confirm it is
  absent from the screen, from network responses, and from logs.

*Driver.* Enter the customer's code → complete.

- All three: `DELIVERED`.

### 8. The customer rates

*Customer, mobile.* Submit a rating.

- **Customer**: recorded; cannot rate twice.
- **Transport admin**: appears against the delivery and in the driver's aggregate.

> Before this step, every rating display must read **not yet rated** — never zero (FR-077).

### 9. Overview

*Dashboard home.* Counts match the lists exactly; the completed count includes this delivery.
Opening the home issues **one** summary request, not one per figure (FR-067).

---

## Part 4 — Checks that are not a single step

Run once, anywhere in the walkthrough.

| Check | Requirement |
|---|---|
| Every stage named correctly on every transport screen at each stage | SC-006 |
| Every notification recognised by its recipient — **observed arriving**, not compared by eye | FR-037, SC-001 |
| A second company's order, driver, truck: **404, indistinguishable from absent** | SC-009, FR-069 |
| No approve / reject / force-complete offered anywhere on this surface | FR-070 |
| Loading, empty and failed visibly distinct on every list and figure | SC-011 |
| Both languages, both layout directions, on every new or rebuilt screen | SC-006 range, FR-074/075 |
| Idle 10 minutes with a screen open ⇒ no requests beyond the open connection | SC-013 |
| Several deliveries observed ⇒ exactly **one** connection | SC-014 |
| Tab hidden ⇒ no background refresh | FR-022 |
| **A card presented while the pairing dialog is closed is absorbed by no field on any screen** | SC-020 |
| Scanned vs hand-typed discrimination, ≥20 trials each | SC-021 |
| Rotated credential refused immediately, no stale window | SC-022 |
| Session lapses mid-walkthrough ⇒ back to sign-in, destination preserved, no stale data | FR-073 |

---

## Part 5 — Done

- One order reached delivered and rated, **no step advanced by direct data manipulation**
  (SC-001, FR-027).
- All three surfaces named the same stage at the same time throughout (FR-028).
- The platform's full-lifecycle test passes with **no human operating a mobile device** (SC-016).
- Playwright covers assignment and tracking, including refusals and the not-trackable and stale
  states (SC-017).
- Platform, dashboard and mobile suites green, with any pre-existing failures named in advance
  (SC-018) — today those are the mobile app's `login_screen_golden_test` pixel diff and the
  skipped `auth_session_test`.
- **A second tester completes this procedure from the document alone, asking nothing** (SC-010).
  Until that has actually happened, the walkthrough is not finished.
