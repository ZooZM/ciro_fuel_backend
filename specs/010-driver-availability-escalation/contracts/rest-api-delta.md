# REST API Delta: Driver Availability & Assignment Escalation

All changes are to the existing `ciro_fuel` platform API (`/api/v1`). No new service, no versioning
change.

## 1. `GET /dispatch/orders/:id/candidates` — response shape change

**Role**: `TRANSPORT_COMPANY_ADMIN` (unchanged).

**Before**: array of eligible-only candidates.

**After**: array of **every** active driver belonging to the acting transporter, each item gaining:

```ts
interface DriverCandidate {
  // ...existing fields unchanged (id, name, distanceMeters, suggestedTruck, ...)
  eligibility: 'ELIGIBLE' | 'BUSY' | 'OFFLINE' | 'INACTIVE';
  lastSeenAt: string | null; // ISO 8601; null = never been online
}
```

Ordering: `ELIGIBLE` (nearest-first, as today) then `BUSY`/`OFFLINE`/`INACTIVE` (nearest-first among
those with a recorded location, then those without one, in no particular further order). **A
suspended/deactivated driver now IS included** (corrected during implementation — the original
draft of this contract wrongly carried over the old exclusion). Of the three ineligible states,
only `OFFLINE` is ever assignable at all (with a reason) — `BUSY` and `INACTIVE` are shown for
visibility only and are refused unconditionally at assignment, for different reasons each (see #2).

**Empty array** now means, unambiguously: this company has zero driver accounts (FR-006). It no
longer means "zero currently online."

## 2. `POST /dispatch/orders/:id/assign` — request body addition

**Role**: `TRANSPORT_COMPANY_ADMIN` (unchanged).

```ts
interface AssignDriverDto {
  driverId: string;
  truckId: string;
  tankId: string;
  reason?: string; // NEW — required only when driverId's eligibility is OFFLINE
}
```

**New refusal**: if the resolved driver's eligibility is `OFFLINE` and `reason` is missing or
blank, the request is refused with `400` (a validation-shaped refusal, not a `409` — this is a
well-formed-request problem, not a state-conflict one) naming that a reason is required. An
eligible driver's assignment is completely unaffected — `reason` is not accepted or stored for one
(mirrors how `overrideReason` only ever applies to an actual override, spec 008 precedent).

**`BUSY` and `INACTIVE` are refused unconditionally — no reason makes either assignable**
(corrected during implementation, FR-007): a `BUSY` driver's `activeOrderId` already points to a
delivery they hold, and the existing `activeOrderId: { $exists: false }` guard inside
`assignDriver`'s conditional update refuses them exactly as it always has — unchanged by this
feature, not a new check. An `INACTIVE` driver is refused the same way via the existing
`isActive: true` guard in the same update.

## 3. `POST /orders/:id/acknowledge-assignment` — new endpoint

**Role**: `DRIVER` only, and only for the order currently assigned to them (`order.driverId ===
user.userId`, same ownership check `verify-vehicle`/`confirm-loading` already use).

**Request**: no body.

**Behavior**:
- Sets `assignmentAcknowledgedAt` to now, if not already set (idempotent — a second call is a
  harmless no-op, not an error).
- Cancels the pending escalation job for this order (`AssignmentEscalationQueueService.cancel`),
  same discipline `PaymentTimeoutQueueService.cancel` already follows on early resolution.
- Returns the updated order (role-scoped shape, same as every other order-mutating endpoint).

**Refusals**: `404` if the order isn't found or doesn't belong to this driver (same
indistinguishable-from-absent discipline the rest of the platform already applies, feature 009
FR-069) — never a distinct "not yours" message.

## 4. `GET /orders/:id` — response addition (driver/operator-scoped shapes only, never the client's)

```ts
interface Order {
  // ...existing fields unchanged
  assignmentAcknowledgedAt: string | null;
  assignmentEscalationSmsAt: string | null;
  assignmentEscalationSkippedReason: 'NO_PHONE' | 'SEND_FAILED' | null;
  assignedWhileIneligible: boolean;
  assignedWhileIneligibleReason: string | null;
}
```

Follows the same role-scoping `toRoleScopedShape` already strips other operator-only detail through
(spec 008's own fix for exactly this kind of leak) — these fields are never present in the
`CLIENT`-scoped shape.

## New configuration (environment)

| Variable | Meaning | Default (planning-level, not a spec decision) |
|---|---|---|
| `ASSIGNMENT_ACK_WINDOW_MINUTES` | Delay before an unacknowledged assignment escalates to SMS | Low single digits |
| `ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_MAX` | BullMQ worker `limiter.max` for the escalation queue | Operationally tuned, not user-facing |
| `ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_DURATION_MS` | BullMQ worker `limiter.duration` | Operationally tuned, not user-facing |

## Unchanged

`ORDER_ASSIGNED` notification creation/emit (`NotificationsService.notify`) — this feature adds a
consequence *after* it (the acknowledgment/escalation track), it does not change how or when that
notification itself is sent.
