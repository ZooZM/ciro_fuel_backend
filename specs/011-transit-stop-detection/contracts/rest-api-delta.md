# REST API Delta: In-Transit Stop Detection & Driver Check-In

All changes extend the existing platform API (`/api/v1`). No new service, no versioning change.

## 1. `POST /orders/:id/stops/declare` — new endpoint (driver)

**Role**: `DRIVER`, and only for the order currently assigned to them, only while `IN_TRANSIT`.

```ts
interface DeclareStopDto {
  reason: StopReason;              // fixed list; OTHER requires reasonText
  reasonText?: string;             // required when reason === 'OTHER'
  expectedDurationMinutes: number; // the driver's own estimate — bounds suppression (FR-008d)
}
```

**Behavior**: creates a `StopEvent` with `origin: DECLARED`, already carrying its reason and
`reasonGivenAt` — which is precisely why it never prompts and never escalates. `suppressedUntil` is
set to now + `expectedDurationMinutes`.

**Refusals** (error codes added during implementation, so the app can tell them apart without
matching on message text — the platform's standing rule for statuses that repeat):
- `409 STOP_ALREADY_OPEN` if this order already has an open stop, **or** a declared stop whose
  suppression window has not yet lapsed (FR-016, FR-008d) — the driver should answer the open one
  rather than declaring over it.
- `409 STOP_NOT_IN_TRANSIT` if the order is not `IN_TRANSIT` — declaring a stop is meaningless
  outside the leg this feature covers (FR-002).
- `404` if the order is not found or not assigned to this driver — indistinguishable from absent,
  the platform's existing discipline.

All three are decided inside a single conditional write, not by a prior read: a declaration racing
the detection sweep must not be able to leave the delivery with two open stops. The follow-up read
that decides *which* of the three refusals to report is taken only on the failure path.

## 2. `POST /orders/:id/stops/:stopId/reason` — new endpoint (driver)

**Role**: `DRIVER`, same ownership check.

```ts
interface SubmitStopReasonDto {
  reason: StopReason;
  reasonText?: string; // required when reason === 'OTHER'
}
```

**Behavior**: records `reason`/`reasonText`/`reasonGivenAt` on the named stop event, cancels the
pending escalation job, and sets `resolvedAt` — a detected stop the driver has explained needs no
administrator action.

**Explicitly not a refusal**: submitting after the response window has already escalated. FR-010
makes a late answer a normal resolution — it is recorded, `escalatedAt` is left in place as a
truthful record that the transporter *was* alerted, and no error is returned. This is the one case
most likely to be implemented as an error by reflex; it must not be.

**Refusals**: `404` for an unknown `stopId` or an order not assigned to this driver;
`409 STOP_ALREADY_ANSWERED` only if that stop event already carries a reason (a genuine duplicate
submission, not a late one).

## 3. `PATCH /orders/:id/stops/:stopId/resolve` — new endpoint (transport admin)

**Role**: `TRANSPORT_COMPANY_ADMIN`, scoped to their own orders by the multi-party plugin.

**Request**: no body.

**Behavior**: sets `resolvedAt`/`resolvedBy` (FR-012). The stop event remains on the delivery's
record — resolving means "I have dealt with this," never "delete it."

**Refusals**: `404` (unknown/not theirs); `409` if already resolved.

## 4. `GET /orders/:id` — response addition

```ts
interface Order {
  // ...existing fields unchanged
  stopEvents: StopEvent[]; // operator + driver shapes ONLY — stripped for CLIENT
}
```

Stripped from the `CLIENT` shape by `toRoleScopedShape`, alongside `verifications`/`tankSummary`
(data-model.md's closing note explains why this is a privacy boundary here, not just scoping).

## 5. Notifications (no new endpoint — existing path, new types)

| Type | To | When |
|---|---|---|
| `DRIVER_STOP_DETECTED` | the driver | A stop is detected (FR-004). Carries `orderId` + `stopId` so the app can open the reason prompt directly. **This is the type the mobile app raises a device-level alert for** (FR-004a) |
| `ORDER_STOP_UNRESOLVED` | the transport admin(s) | The response window elapses with no reason given (FR-009) |

Both ride the existing `NotificationsService.notify` path — a stored notification plus a
`notification:new` socket emit to the `user:{id}` room. No new transport is introduced.

## New configuration (environment)

| Variable | Meaning | Default |
|---|---|---|
| `STOP_DETECTION_WINDOW_MINUTES` | How long without meaningful movement before a stop is raised | 10 |
| `STOP_DETECTION_MOVEMENT_METERS` | What counts as having moved | 50 (matches the existing tracking threshold) |
| `STOP_RESPONSE_WINDOW_MINUTES` | How long the driver has to answer before the transporter is told | 5 |
| `STOP_DETECTION_SWEEP_SECONDS` | How often the sweep runs | 60 |

## Unchanged

The `location:update` socket contract, the `order:location` broadcast, and every existing tracking
behaviour. This feature adds bookkeeping *alongside* the accepted-fix path (`lastMovedAt`), it does
not change what the device sends or what the tracking map receives.
