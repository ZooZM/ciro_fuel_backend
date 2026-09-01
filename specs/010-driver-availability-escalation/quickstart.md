# Quickstart: Driver Availability & Assignment Escalation

## Prerequisites

- Backend running with Redis available (already required for BullMQ — the existing payment-timeout
  queue already depends on it, so any environment that already runs this platform has it).
- A transportation company with: one driver online+available (`driver.isOnline &&
  driver.isAvailable`), one driver never connected (no `location`, `isOnline: false`), and one
  routed order awaiting assignment.
- In local/dev, `SMS_PROVIDER=none` uses `NoopSmsSender`, which logs the message instead of
  sending it — verify the escalation fires by reading the log line, not a real phone, unless a real
  SMS provider is configured.

## Walkthrough

### 1. See every driver, hinted (US1)

Open the routed order's assignment screen. Both drivers appear — the online one ready to pick, the
never-connected one visibly marked offline ("never online"). Confirm the "no drivers" empty state
does **not** appear (the company has drivers on file).

### 2. Assign the offline driver, with a reason (US1/FR-008)

Select the offline driver, proceed through truck/tank selection as usual, and attempt to confirm
without a reason — refused, reason field focused. Enter a short reason and confirm. The order
becomes `ASSIGNED_TO_DRIVER`; a subsequent view of the order shows the recorded
`assignedWhileIneligibleReason`.

### 3. Skip acknowledgment and watch the escalation fire (US2)

Do **not** trigger the driver app's acknowledgment call (simplest: don't run the mobile app's
active-delivery load for this order at all). Wait past `ASSIGNMENT_ACK_WINDOW_MINUTES`. Confirm:
- `NoopSmsSender`'s log line appears, addressed to the driver's phone, containing only an order
  reference and an instruction to open the app — no customer name/address (FR-011a).
- The order's `assignmentEscalationSmsAt` is now set.

### 4. Acknowledge after the fact (edge case)

Call the acknowledge endpoint for the same order (directly, or by running the mobile app's active-
delivery load). Confirm this succeeds normally — no error, `assignmentAcknowledgedAt` is now set,
and this is **not** treated as contradicting the SMS that already went out (spec Acceptance
Scenario US2.4).

### 5. Cancel before escalation fires (correctness)

Repeat steps 1-2 for a second order, assigned to the eligible online driver this time. Before the
window elapses, cancel the order (or reassign it to a different driver). Confirm no SMS is ever
sent for the original assignment (FR-014a) — check the log/queue directly, since by definition
nothing observable happens.

### 6. See the state on the order detail (US3)

For each of the orders above, open the order detail and confirm it plainly states one of:
"waiting for acknowledgment," "SMS sent at `<time>`," or "acknowledged at `<time>`" — never a stale
state after the fact (spec Acceptance Scenario US3.3).

## Out of scope for this walkthrough

- Real SMS delivery to a physical phone (needs a configured, non-`none` `SMS_PROVIDER` and a real
  carrier — a live-environment concern, same caveat as feature 009's own quickstart).
- Burst/rate-cap behavior (FR-013a) — needs many simultaneous assignments; verified by an automated
  test, not a manual walkthrough step.
