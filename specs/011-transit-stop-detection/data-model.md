# Data Model: In-Transit Stop Detection & Driver Check-In

## `User` additions (driver movement bookkeeping)

Two fields, maintained by `tracking.gateway.ts` on accepted location fixes. Deliberately **separate
from `lastSeenAt`**: that field answers "is this device talking to us at all" (presence), these
answer "has this truck actually gone anywhere" — the distinction FR-017 rests on.

| Field | Type | Set when | Notes |
|---|---|---|---|
| `lastMovedAt` | `Date?` | An accepted fix is farther than the movement threshold from `lastMovedLocation` | A heartbeat from a parked truck advances `lastSeenAt` but **never** this |
| `lastMovedLocation` | `GeoPoint?` | Same moment as above | The baseline the next fix is measured against — not the same as `location`, which every accepted fix updates |

**Why both**: comparing a new fix against `location` (which the heartbeat also updates) would make a
slowly-drifting parked truck look like it is moving, one sub-threshold step at a time. Measuring
against the last *movement* baseline is what makes drift genuinely non-accumulating.

## `Order` additions

| Field | Type | Notes |
|---|---|---|
| `stopEvents` | `StopEvent[]` | Embedded array, default `[]` — mirrors `Order.verifications` exactly (research R5) |

### `StopEvent` (embedded sub-document)

**`_id` is retained — a deliberate departure from every other embedded sub-schema on `Order`.**
`PriceBreakdown`, `StatusHistoryEntry`, `OtpRecord`, `DriverSummary`, `ClientSummary`,
`TankSummary`, `WarehouseSummary` and `VehicleVerification` all declare `@Schema({ _id: false })`,
because none of them is ever addressed on its own. `StopEvent` is the first that is: the
reason-submission and resolve endpoints both take a `:stopId`, the escalation job uses it as its
`jobId`, and the driver's notification payload carries it so the app can open the right prompt.
Following the precedent literally here would leave nothing able to identify a single stop.

| Field | Type | Set when | Notes |
|---|---|---|---|
| `_id` | `ObjectId` | On creation (Mongoose default) | The `stopId` every stop-addressing path uses — see above |
| `origin` | `StopOrigin` | On creation | `DETECTED` (the sweep noticed) or `DECLARED` (the driver said so first) — FR-008c requires these be visibly distinct |
| `detectedAt` | `Date` | On creation | For a declared stop, when the driver declared it |
| `location` | `GeoPoint?` | On creation | The driver's last known position — absent if none has ever been recorded |
| `reason` | `StopReason?` | When the driver answers, or immediately for a declared stop | One of the fixed list; `OTHER` pairs with `reasonText` |
| `reasonText` | `string?` | Same | The driver's own words — required when `reason` is `OTHER`, optional otherwise |
| `reasonGivenAt` | `Date?` | Same | Absent means unanswered; this is what the escalation checks |
| `expectedDurationMinutes` | `number?` | On a declared stop only | The driver's own estimate; bounds suppression (FR-008d) |
| `suppressedUntil` | `Date?` | On a declared stop only | `detectedAt + expectedDurationMinutes`; once past, ordinary detection resumes |
| `escalatedAt` | `Date?` | The response window elapses with no reason given | Presence of this is what the transporter was alerted about |
| `resolvedAt` | `Date?` | An administrator marks it handled (FR-012), the driver answers a detected stop, **or** a stop is declared (set at creation) | The single field that makes a stop "unresolved" — see the invariant below |
| `resolvedBy` | `ObjectId?` | Same, when an administrator did it | Absent when resolution came from the driver answering |

**The one invariant**: at most one stop event per order may have `resolvedAt == null` (FR-016).
Enforced at the write with a conditional update, never by a prior read (research R6).

**Suppression is not the same thing as being open** (clarified during implementation). A declared
stop is created *resolved* — it arrives carrying its own answer, so there is nothing left for anyone
to do about it. What it carries instead is `suppressedUntil`, and the sweep's guard therefore has
two clauses, not one: an existing stop blocks a new one if it is unresolved **or** still within its
suppression window. Leaving a declaration open instead would have looked equivalent and broken the
invariant above the moment its window lapsed, since the sweep is required to raise a *new* detected
stop at that point (see the diagram) — the delivery would then carry two unresolved stops at once.
Both clauses live in one shared `unblockedStopFilter` in `stop-detection.service.ts`, used by the
sweep and the declare path alike, because a disagreement between them is exactly how two open stops
would appear.

**State transitions**:

```text
                 ┌──────────────── driver answers ─────────────┐
                 │                                             ▼
(sweep) ──> DETECTED, unanswered ──(response window)──> ESCALATED ──> resolved
                                                            │            ▲
                                                            └─ driver    │
                                                               answers   │
                                                               late ─────┘
(driver) ──> DECLARED, answered, suppressed ──(suppressedUntil passes,
                                               still stopped)──> a NEW detected stop
```

A declared stop is created already-answered and already-resolved — `reason`, `reasonGivenAt` and
`resolvedAt` are all set at creation (`resolvedBy` stays absent, the platform's marker for "the
driver, not an administrator"),
which is exactly why it never prompts and never escalates (FR-008b). When its `suppressedUntil`
passes and the truck is still stationary, the sweep raises a **new** `DETECTED` event rather than
reopening the declared one, so the driver's original declaration stays a truthful record of what
they said at the time.

## Enums

- **`StopOrigin`**: `DETECTED` | `DECLARED`.
- **`StopReason`**: a fixed, translated list — `TRAFFIC`, `VEHICLE_PROBLEM`, `REST_OR_PRAYER`,
  `REFUELLING`, `ROAD_CLOSURE`, `ACCIDENT`, `OTHER`. Fixed so a roadside driver can answer in one
  tap (SC-003) and so the transporter reads a consistent vocabulary rather than free text.
- **`NotificationType`** gains two values: `DRIVER_STOP_DETECTED` (to the driver — the one the
  mobile app raises a device-level alert for) and `ORDER_STOP_UNRESOLVED` (to the transport admin,
  on escalation).

## Config keys (research R7)

| Key | Default | Backs |
|---|---|---|
| `STOP_DETECTION_WINDOW_MINUTES` | 10 | FR-001 |
| `STOP_DETECTION_MOVEMENT_METERS` | 50 | FR-003 (matches the existing tracking threshold) |
| `STOP_RESPONSE_WINDOW_MINUTES` | 5 | FR-009 |
| `STOP_DETECTION_SWEEP_SECONDS` | 60 | Detection latency; overridable so tests need not wait |

## Indexes

One compound index supporting the sweep's only query — in-transit orders with a driver:
`{ status: 1, driverId: 1 }`. `Order` already indexes `{ driverId: 1, status: 1 }`; the sweep's
access pattern leads with `status`, so this is a genuine addition rather than a duplicate.

## Response shape additions

`GET /orders/:id` gains `stopEvents` in the **operator and driver** shapes only — stripped from the
`CLIENT` shape by `toRoleScopedShape`, alongside `verifications`/`tankSummary`. A customer has no
business reading why their driver stopped, and the spec's safety framing makes that a privacy
boundary, not just a scoping detail.
