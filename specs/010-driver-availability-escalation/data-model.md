# Data Model: Driver Availability & Assignment Escalation

## Driver eligibility (derived, not stored)

Not a new field on `User` — a value computed at read time in `DispatchService`, from fields that
already exist on `User` (`isActive`, `isOnline`, `isAvailable`, `activeOrderId`, `lastSeenAt`,
`location`):

| Value | Computed when | What the administrator sees |
|---|---|---|
| `ELIGIBLE` | `isActive && isOnline && isAvailable && !activeOrderId` | Ranked first, nearest-first, directly selectable |
| `BUSY` | `isActive && isOnline && !isAvailable` (or `activeOrderId` set) | Shown, marked "already committed" — **never assignable, no reason override** (FR-007 correction: their `activeOrderId` is a one-to-one pointer to a delivery they already hold; force-reassigning would violate that or orphan it) |
| `OFFLINE` | `isActive && !isOnline` | Shown, marked "offline" with `lastSeenAt` (or "never online"), selectable only with a reason (FR-008) |
| `INACTIVE` | `!isActive` (suspended/deactivated) | Shown per FR-001's "every driver," **never selectable at all — no reason override exists for this one**, matching spec Edge Cases exactly |

**Correction found during implementation**: the original draft of this table marked `!isActive` as
"(excluded)" while its own description said "shown" — a self-contradiction. `isActive` is not part
of either underlying query's filter at all (dropped from both, alongside `isOnline`/`isAvailable`);
`INACTIVE` is computed and shown exactly like the other three states, just never selectable.

This mirrors `VerificationStage`/`OrderStatus`-style enums already in `common/enums/` — a new
`DriverEligibility` enum, not a raw string.

## `Order` schema additions

All four fields snapshotted/set at the same points `driverSummary`/`manualOverride` already are —
no new collection, no change to tenant scoping (the multi-party plugin already covers `Order`).

| Field | Type | Set when | Cleared when |
|---|---|---|---|
| `assignmentAcknowledgedAt` | `Date?` | The driver calls the new acknowledge endpoint (R2) | Never — permanent once the assignment is acknowledged (the platform has no path to reassign an order's driver once assigned, only to cancel the order outright, so there is no "someone else now holds this" case to clear it for) |
| `assignmentEscalationSmsAt` | `Date?` | The escalation processor successfully sends the SMS | Never, same reasoning |
| `assignmentEscalationSkippedReason` | `'NO_PHONE' | 'SEND_FAILED' | undefined` | The escalation window elapses and the driver has no valid phone on file (FR-015) — an enum of one value today, typed as an enum (not a free string) so a second reason can be added later without a shape change | Never, same reasoning |
| `assignedWhileIneligible` | `boolean?` | `assignDriver` commits with a driver whose eligibility was `OFFLINE` at selection time (FR-007/FR-008 — `BUSY`/`INACTIVE` never reach this point at all, refused outright) | Never — permanent fact about how this particular assignment was made |
| `assignedWhileIneligibleReason` | `string?` | Same transaction as above, from the administrator's required input | Never, same as above |

**Cancellation note** (ties to spec Edge Cases, FR-014a — narrowed during implementation): the
platform has no "reassign this order's driver" capability at all — `reassignVehicle` (feature 009)
changes truck/tank only and never touches `driverId`. The only real "no longer applies" case is
order **cancellation**, which already releases the driver (`OrdersService.cancel` →
`releaseDriverIfAssigned`) — `AssignmentEscalationQueueService.cancel` is called from the same
place `PaymentTimeoutQueueService.cancel` already is, guarded the same way.

**Existing fields reused as-is, unchanged**: `driverId`, `driverSummary` (assignment identity),
`status`/`statusHistory` (unaffected — acknowledgment/escalation are a parallel track, not a new
`OrderStatus` value; the order can be `ASSIGNED_TO_DRIVER`, acknowledged or not, independently of
anything else about it).

## Assignment-escalation job payload (BullMQ, not persisted separately)

The job scheduled per assignment carries only `{ orderId: string }` — mirroring
`PaymentTimeoutQueueService`'s own `{ orderId }` payload exactly. The processor re-reads the order
fresh (R3) rather than trusting anything else in the payload, so there is no second source of truth
to keep in sync.

## `GET /dispatch/orders/:id/candidates` response shape (delta)

Before (today): an array of drivers already filtered to eligible-only, each with `suggestedTruck`.

After: the same array, now including every active driver, each additionally carrying:

```text
{
  ...existing candidate fields (unchanged),
  eligibility: 'ELIGIBLE' | 'BUSY' | 'OFFLINE' | 'INACTIVE',
  lastSeenAt: string | null   // null only for a driver who has never come online at all
}
```

`suggestedTruck` continues to be computed the same way for every driver regardless of eligibility
(a driver's last-operated truck is a fact about them, not about whether they're currently online).

## `Order` detail response shape (delta, for US3)

```text
{
  ...existing order fields (unchanged),
  assignmentAcknowledgedAt: string | null,
  assignmentEscalationSmsAt: string | null,
  assignmentEscalationSkippedReason: 'NO_PHONE' | 'SEND_FAILED' | null
}
```
