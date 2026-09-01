# Quickstart: In-Transit Stop Detection & Driver Check-In

## Prerequisites

- Backend running with Redis (already required — the escalation queue reuses it).
- A delivery driven as far as **IN_TRANSIT** — `scripts/seed-dashboard-actors.ts` +
  `npm run approve-route -- <orderId>` gets you to assigned; the driver app then verifies the
  vehicle and confirms loading to reach in-transit.
- For the timing steps, set short windows so the walkthrough does not take half an hour:
  `STOP_DETECTION_WINDOW_MINUTES=1`, `STOP_RESPONSE_WINDOW_MINUTES=1`,
  `STOP_DETECTION_SWEEP_SECONDS=10`.
- A **real device or simulator with mock location**, not a unit test — the whole point of steps 3-5
  is that the alert reaches a backgrounded app.

## Walkthrough

### 1. Moving driver raises nothing (SC-002)

Drive (or simulate movement past 50 m repeatedly) with the delivery in transit. Confirm: no prompt,
no stop event on the order, `lastMovedAt` advancing.

### 2. Stop, and get asked (US1, SC-001)

Hold position past the stop window. Within one sweep, confirm:
- a `DETECTED` stop event on the order,
- the driver's device raises a **device-level alert** — with the app **backgrounded and the screen
  locked**, which is the assertion that matters (SC-010). An alert only visible with the app open is
  the failure this feature exists to prevent.

### 3. Answer it (US2, SC-003)

Tap the alert → the reason prompt opens on that stop. Pick a common reason without typing; time it
(under 15 seconds is the bar). Confirm on the transport dashboard's order detail: the card shows the
driver's own reason, and no escalation ever fires.

### 4. Stay silent, and watch it escalate (US3, SC-004)

Repeat step 2 on a fresh delivery, ignore the alert. Past the response window, confirm:
- the transport admin receives `ORDER_STOP_UNRESOLVED`,
- the order detail's card shows the loud unanswered state within a minute of the window elapsing.

Then answer it **late**. Confirm the reason is recorded normally and nothing errors (FR-010) — this
is the case most likely to have been implemented as a rejection by reflex.

### 5. Declare a stop in advance (US2.6-8, SC-009)

While moving, declare a stop with a reason and a short duration. Stop. Confirm: **no prompt** while
inside the stated duration, and the dashboard shows it as an *expected* stop, visually distinct from
an incident. Then stay stopped past the stated duration and confirm ordinary detection resumes and
you are prompted — the guard against one declaration silencing the rest of the journey.

### 6. Kill the app mid-stop (FR-017, FR-017a)

With the delivery in transit, force-quit the driver app. Confirm:
- **no** stop event is raised (no positions are arriving — this is silence, not stillness),
- the dashboard's order detail shows the last position as **stale, with its age**, rather than as a
  live point frozen in place.

### 7. Handle it (US4)

On an escalated stop, use the card's "handled" action. Confirm it stops demanding attention but
remains on the delivery's record, and that an order with no stop events shows **no card at all** —
not an empty placeholder (FR-013).

### 8. Out-of-leg silence raises nothing (FR-002)

Park the truck during `LOADING` or `UNLOADING` well past the window. Confirm no stop is ever raised
— a stationary truck at the warehouse or the customer's gate is expected, not an incident.

## Out of scope for this walkthrough

- **Notification-permission refusal** on either platform: worth testing manually once
  (the driver is never prompted; the escalation covers it), but it is a permissions-dialog path
  rather than a feature step.
- **The sweep's behaviour under many concurrent deliveries** — an automated concern, not a manual
  one.
