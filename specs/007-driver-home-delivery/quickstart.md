# Quickstart: Driver Home & Active Delivery

**Feature**: 007-driver-home-delivery | **Date**: 2026-08-24

Manual verification, one section per user story. Assumes the base setup in
`specs/001-fuel-delivery-platform/quickstart.md`.

## Prerequisites

```bash
# Backend
npm run start:dev                 # entry is src/server.ts (constitution)

# Mobile
cd ../mobile_app && flutter run --dart-define=API_BASE_URL=http://localhost:3000/api/v1
```

You need **two driver accounts** in the same transportation company, **two client accounts**,
and the ability to drive an order through to `IN_TRANSIT` (create → approve → settle → assign).

---

## Phase 0 — the two invisible breaks (verify before anything else)

Neither has user-visible symptoms until the rest is wired, which is exactly why they are checked
first. If either is wrong, everything above it looks correct and silently does nothing.

1. **The driver reaches `order:status` at all.** With a driver signed in and carrying a
   delivery, change that order's status from another client (or an admin). Confirm the driver's
   device receives an `order:status` frame. Before this feature it could not: a driver is refused
   `order:watch` with `FORBIDDEN_ROLE`, so the event only ever went to a room they cannot join.
2. **Handlers attach after connect.** Sign out and back in. Confirm the active delivery still
   updates on a status change. A handler attached before `trackingSocket.connect()` binds to a
   null socket, and a fresh socket is created per connect — so this specifically catches a
   handler that worked once and is now orphaned.

---

## US1 — A driver sees their assigned job

1. Assign a delivery to driver A. Open the app as A. **Expect**: the real customer, fuel type,
   quantity, destination and ETA — no `ORD-2024-256`, no `Al Rehab Station` sample rows.
2. Open the app as driver B (no assignment). **Expect**: an explicit "no active delivery" state.
3. Kill the network, cold-start. **Expect**: a retryable error — *not* an empty state, and not
   stale values presented as current. These three must look different (FR-044).
4. **The switch test (SC-006)**: sign out from A, sign in as B, and watch the **first frame** of
   every driver screen. No value belonging to A may appear, even momentarily.
5. **The live-assignment test**: with A signed in and idle on the home screen, assign them a
   delivery from the transporter admin. **Expect**: it appears without touching the app. This is
   the `ORDER_ASSIGNED` notification path, and it only works once the app's `NotificationType`
   enum matches the backend's.
6. **The terminal test (SC-007)**: cancel A's delivery from an admin. **Expect**: it stops being
   shown as active within ~5 seconds, no driver action.

---

## US2 — A driver completes a delivery

The whole sequence, which was impossible before this feature.

1. With A carrying a delivery, tap **arrived**. **Expect**: the *customer's* device shows an
   arrival code. Before this feature `/arrive` was never called, so no code was ever issued and
   the flow could not begin.
2. Read the code from the customer's device, enter it on the driver's. **Expect**: the delivery
   advances to unloading.
3. Tap **request delivery code**. **Expect**: the customer receives a second code.
4. Enter it. **Expect**: the delivery completes and A is released for new work.
5. **The wrong-code test**: enter a wrong code. **Expect**: refused, delivery unchanged, retry
   offered.
6. **The lockout test (FR-017)**: fail 5 times within 15 minutes. **Expect**: the app tells the
   driver to have a **fresh code sent** — not a generic error. The throttle already exists
   server-side; this checks the app renders it as guidance.
7. **The offline test (FR-016)**: airplane mode, then attempt a handover step. **Expect**: the
   step reports failure and the delivery is **visibly unchanged**. Nothing may advance locally.
8. **The code-secrecy test (FR-014)**: search the driver build for any request to
   `/orders/:id/otp/current`, and confirm no code is displayed or logged on the driver's device
   at any point.

---

## US3 — A driver reviews their deliveries

1. Give A several deliveries across stages. Open the list. **Expect**: only A's deliveries.
2. **Expect** exactly four tabs: All · In progress · Completed · Cancelled — and **no**
   "Deferred", "Paid" or "Failed". Those are invoice states and were on this screen by
   copy-paste from `InvoicesKeys`.
3. Give A more than 20 deliveries; scroll to the end. **Expect**: older entries load with no
   duplicates and no gaps.
4. Give B none. **Expect**: an explicit empty state.
5. Tap an entry. **Expect**: that delivery's detail, not a fixed sample.

---

## US4 — Delivery detail reflects reality

1. Open a delivery at each stage. **Expect**: the displayed stage matches the platform's.
2. **The tap test (FR-025)**: tap everything on the screen that is not a delivery action —
   including the app-bar button that used to cycle the mock state. **Expect**: the stage never
   changes. Before this feature that button advanced the progress indicator freely.
3. Change the stage from elsewhere while the detail is open. **Expect**: it updates.
4. **The inert-control test (FR-027)**: press every control. **Expect**: each does something.
   Nine handlers were `onPressed: () {}` before this work.
5. **The call test**: press call on a delivery with a `clientSummary`. **Expect**: the dialer
   opens with the customer's number. On an order assigned *before* this feature (no
   `clientSummary`), **expect** the call action to be **absent**, not present and failing.

---

## US5 — The header states only what is true

1. **Expect** no `4.8` and no `5` unless they are that driver's real figures.
2. Sign in as a **never-rated** driver. **Expect** an explicit "not yet rated" — not `0`, not an
   empty star row, not a placeholder. This is the single most likely thing to regress.
3. Complete a delivery. **Expect** the day's count increments.
4. **The midnight test (FR-033)**: complete a delivery near the day boundary, then change the
   *device* timezone. **Expect** the count does not move — the boundary is the platform's.
5. **The duty test**: confirm the indicator reflects real state, and **search every driver
   screen for a control that changes it**. There must be none (FR-036).
6. **The isolation test (FR-034)**: confirm there is no way to request another driver's figures.
   The endpoint is `me`-scoped, so this is structural.

---

## US6 — A customer rates the driver

1. As the customer, open a **delivered** order. **Expect** a rating control on that screen.
2. Open an order that is **not** delivered. **Expect** no rating control.
3. Submit a score with no review. **Expect** accepted; the driver's screen renders cleanly with
   no empty quote block.
4. Submit a score with a review. **Expect** accepted, and visible to the driver on that
   delivery's detail (FR-041).
5. **The rate-once test (FR-039)**: reopen the order. **Expect** the rating shown and no further
   submission accepted. Then attempt the call directly — **expect** `ALREADY_RATED`.
6. **The wrong-customer test (FR-040)**: attempt to rate another client's delivered order.
   **Expect** `404`, indistinguishable from a non-existent order (Principle II).
7. **The aggregate test**: confirm the driver's `ratingAverage` and `ratingCount` moved
   consistently — a rating stored without its aggregate bump, or vice versa, means the
   transaction is not holding.
8. **The no-nagging test (FR-037c)**: complete a delivery while the customer is in the app.
   **Expect** no dialog, sheet or prompt interrupts them.

---

## Cross-cutting

- **RTL sweep (FR-043, SC-008)**: every screen this feature touches, in Arabic, with a long
  customer name and a long review. No clipped or overflowing text.
- **Deactivation (FR-042)**: deactivate a rated driver, reactivate them. **Expect** their rating
  is unchanged — not lost, not recomputed.

---

## Regression gates

```bash
npm run test && npm run test:e2e      # backend — must be green
cd ../mobile_app && flutter test      # mobile
```

**Baseline going in** (verified at the end of spec 006): backend 122 unit + 147 e2e green;
mobile **294 passing with exactly two non-green** — `login_screen_golden_test` (pixel diff,
failing) and `auth_session_test` (`skip: true`, router timing). Confirm the count is still
exactly two afterwards.

**Two changes touch the CLIENT persona and must land with both suites green**: the
`NotificationType` enum correction (research R10 — it is shared, and today every client
notification degrades to `unknown`), and the rating control added to the client's order detail.
