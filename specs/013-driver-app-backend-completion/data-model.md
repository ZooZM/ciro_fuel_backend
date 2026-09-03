# Data Model: Driver App Backend Completion & Cross-Device Delivery Continuity

**Feature**: 013 | **Date**: 2026-09-03

**No new collection.** Two enums gain a member, one embedded sub-document gains a meaning for that
member, one interface gains a field, and the mobile client gains a representation of data the platform
already sends it.

---

## 1. `StopOrigin` — third member

`src/common/enums/stop-origin.enum.ts`

| Member | Meaning | `resolvedAt` at creation | `suppressedUntil` | Transporter told |
|---|---|---|---|---|
| `DETECTED` | The platform noticed the truck had not moved and asked | `null` | unset | only if unanswered past the window |
| `DECLARED` | The driver said so before anyone asked | **now** | now + stated duration | never |
| **`BLOCKED`** | **The driver cannot reach the destination and is asking for help** | **`null`** | **unset** | **immediately** |

Mirrored in `web_dashboard/src/constants/stop-events.ts` (research R10) and in the mobile app's new
`shared/enums/stop_origin.dart`. Three surfaces, one vocabulary — the dashboard's own header comment
records why a value present on one side and absent on another fails quietly rather than loudly.

### `StopEvent` field values for a `BLOCKED` stop

The sub-schema (`src/modules/orders/schemas/order.schema.ts`) is **unchanged** — no new field. What is
new is the combination:

| Field | Value | Why |
|---|---|---|
| `origin` | `BLOCKED` | FR-039a's distinguishability |
| `detectedAt` | now | When the driver reported |
| `location` | the driver's last known position, if any | Same honesty as the other origins — absent rather than defaulted |
| `reason` | the driver's stated `StopReason` | Reused vocabulary (R5) |
| `reasonText` | required when `reason` is `OTHER` | Existing rule, unchanged |
| `reasonGivenAt` | now | The driver explained at creation; nobody needs to ask |
| `expectedDurationMinutes` | **unset** | It is not a planned pause |
| `suppressedUntil` | **unset** | **FR-039b** — a request for help must not silence detection |
| `escalatedAt` | now | The transporter is told in the same operation; the record must say so |
| `resolvedAt` | `null` | An open problem, closed by the transporter |
| `resolvedBy` | set when the transporter resolves it | Existing resolve path, unchanged |

**Invariant interaction.** `unblockedStopFilter` is `resolvedAt == null OR suppressedUntil > now`. A
`BLOCKED` stop satisfies the first clause, so the detection sweep will not raise a second stop beside
it — correct, and *not* what FR-039b forbids. FR-039b forbids `suppressedUntil`, which would silence
detection after the stop is closed out; the one-open-stop invariant merely prevents a duplicate while
the transporter is already looking at it.

**State transitions**

```
                    driver reports "cannot reach"
                                │
                                ▼
              BLOCKED · unresolved · reason given · escalated
                                │
                                ▼
              transporter resolves (existing PATCH endpoint)
                                │
                                ▼
                        BLOCKED · resolved
```

No escalation job is enqueued: there is no silence to wait out.

---

## 2. `NotificationType` — new member

`src/common/enums/notification-type.enum.ts`, mirrored in
`mobile_app/lib/shared/enums/notification_type.dart`.

| Member | Recipient | Payload |
|---|---|---|
| `ORDER_DRIVER_BLOCKED` | the transport company's admins (`order.transportCompanyId`) | `orderId`, `stopId`, the stated reason |

Addressed exactly as `ORDER_STOP_UNRESOLVED` already is, and deliberately **not** that type: FR-039a
requires the transporter to distinguish "the driver is asking for help" from "the driver was asked and
said nothing."

**The mobile enum is pinned to the backend's wire values by `test/unit/notification_type_test.dart`**
(spec 007's guard, added after the two enums were found to share no values at all). Adding a member
backend-side without adding it in Dart fails that test — which is the guard working, not a problem.

### The driver's reachable notification types (research R7)

| Type | Reaches a driver? |
|---|---|
| `ORDER_ASSIGNED` | **yes** — `dispatch.service.ts:420` |
| `DRIVER_STOP_DETECTED` | **yes** — `stop-detection.service.ts:215` |
| every other member | no — addressed to a client or an admin |

Both are order-related. This is the whole basis for removing the notification screen's category tabs:
a "System" filter has nothing it could ever match.

---

## 3. `AuthenticatedUser` — new field

`src/common/interfaces/jwt-payload.interface.ts`

| Field | Type | Source | Why |
|---|---|---|---|
| `sgen` | `number` (absent normalised to `0`) | the verified token at **handshake / request time** | One half of the per-frame comparison in research R2 |

**Normalisation is load-bearing.** `JwtPayload.sgen` is optional so tokens minted before spec 006 stay
valid, and both sides already normalise absent to `0`. Dropping that here turns every legacy token into
a permanent mismatch — the failure would look exactly like the enforcement working.

**It must be stamped, never re-read.** The comparison is *what the connection claimed at handshake*
versus *what the account holds now*. Reading the account for both sides compares it to itself and always
agrees, which is a silently inert guard — the same shape of defect as R1's null-socket registration.

---

## 4. Mobile representation of stop events

The platform already returns `stopEvents` to a `DRIVER` from `GET /orders/:id`
(`toRoleScopedShape` deletes it for the `CLIENT` only). The mobile app has no field for it.

### New: `shared/entities/stop_event.dart` (freezed)

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | The stop's own `_id` — retained server-side precisely so a stop can be addressed |
| `origin` | `StopOrigin` | `fromWire` in one place, per the no-magic-values rule |
| `detectedAt` | `DateTime` | |
| `reason` | `StopReason?` | |
| `reasonText` | `String?` | |
| `reasonGivenAt` | `DateTime?` | **Absence is what "unanswered" means** — never infer from `reason` |
| `suppressedUntil` | `DateTime?` | |
| `escalatedAt` | `DateTime?` | |
| `resolvedAt` | `DateTime?` | **Absence is what "unresolved" means** |

### Derived, never stored: the outstanding question

```
outstanding  ⇔  resolvedAt == null  ∧  reasonGivenAt == null
```

Both clauses are required. `resolvedAt == null` alone would present a driver's own answered stop as
still asking; `reasonGivenAt == null` alone would re-ask a stop an administrator had already closed. A
`DECLARED` stop arrives with both set and correctly never qualifies.

This mirrors the platform's own guard rather than approximating it. A disagreement between the two
would be invisible on both sides: the app would ask a question the platform considers closed, or stay
silent on one it considers open while the escalation timer runs.

### `Order` gains

| Field | Type | Notes |
|---|---|---|
| `stopEvents` | `List<StopEvent>` | Defaults to empty — a `CLIENT`'s response omits the key entirely, and that must parse cleanly rather than throw |

**The empty default is not cosmetic.** Both personas share one `Order` entity and one parsing path; the
client's response has no `stopEvents` key at all, so a non-nullable field without a default would make
every client order fail to parse.

---

## 5. Notifications — bulk read

No schema change. A new operation marks every unread notification read for the calling user:

```
filter:  { recipientUserId: <from token>, readAt: null }
update:  { $set: { readAt: now } }
```

**Idempotent by construction**: the filter is falsified by the update's own effect, so a repeat matches
nothing — the same property `PresenceService.markSilentDriversOffline` relies on. No transaction needed;
there is no second document whose consistency depends on it.

The recipient comes from the authenticated principal, never from the request — a body-supplied
recipient would be a cross-tenant write dressed as a convenience.

---

## 6. What is deliberately *not* modelled

- **No device identity.** "Which device" is not a platform concept and this feature does not make it
  one. Displacement is expressed entirely through `sessionGeneration`, which already exists. Adding a
  device registry would create a second source of truth about who may act for a driver.
- **No new session audit event.** `AuthService.login` already writes a `REVOKED`
  (`SIGNED_IN_ELSEWHERE`) row and a `SIGNED_IN` row in one transaction, with the generation in force
  after each. FR-021 is satisfied by what exists; a second record of one event that could disagree with
  the first is worse than one (research R11).
- **No local persistence of alerts.** Restoring a missed notification from device storage would
  reintroduce the device-local state this feature exists to remove, and could not help the device that
  never received it.
- **No new stop reason values.** `StopReason`'s seven are shared verbatim by the driver's app and the
  transport dashboard; the blocked-report UI offers the applicable subset rather than forking the
  vocabulary.
