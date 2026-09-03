# REST API Delta — Feature 013

**Baseline**: `specs/001-fuel-delivery-platform/contracts/rest-api.md`, as amended by specs 004–012.

Two new endpoints. Two existing responses gain nothing (the field the driver needs is already sent).

---

## 1. `POST /api/v1/orders/:id/stops/blocked` — the driver cannot reach the destination

**New.** Roles: `DRIVER` (the driver assigned to this order, enforced inside the service's conditional
write, not by a guard — a report racing the detection sweep must not be able to leave two open stops).

### Request

```json
{
  "reason": "ROAD_CLOSURE",
  "reasonText": "Bridge closed, no diversion signposted"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `reason` | `StopReason` | yes | The shared seven-value vocabulary. Required at creation — unlike a detected stop, a blocked report exists *because* the driver has something to say |
| `reasonText` | `string` | only when `reason` is `OTHER` | Same rule the existing reason endpoint applies |

### Response — `200`

The role-scoped order, exactly as `POST /orders/:id/stops/declare` returns it, with the new stop present
in `stopEvents`.

### Refusals

| Status | Code | When |
|---|---|---|
| `400` | validation | `reason` absent, not a known value, or `OTHER` without `reasonText` |
| `404` | — | Not this driver's order, or no such order. **Never 403** — Constitution II forbids revealing existence |
| `409` | `STOP_ALREADY_OPEN` | The delivery already carries an unresolved stop. One open stop is an invariant of the existing model, and the conditional write is what enforces it |
| `422` | invalid state | The order is not `IN_TRANSIT`. Same requirement the declare path enforces |

### Effects — all in one conditional write

1. Appends a `StopEvent` with `origin: BLOCKED`, `reasonGivenAt: now`, `escalatedAt: now`,
   `resolvedAt: null`, and **no** `suppressedUntil` (see data-model §1 for the full field table and why
   each value is what it is).
2. Notifies the transport company's administrators with the new `ORDER_DRIVER_BLOCKED` type, addressed
   by `companyId: order.transportCompanyId` — the identical lookup `ORDER_STOP_UNRESOLVED` already uses.
3. Enqueues **no** escalation job. There is no silence to wait out; the driver has already spoken.

**Closed by**: the existing `PATCH /orders/:id/stops/:stopId/resolve` (`TRANSPORT_COMPANY_ADMIN`),
unchanged. No new resolution path.

---

## 2. `PATCH /api/v1/notifications/read-all` — mark every notification read

**New.** Roles: any authenticated user. Scope is the caller, taken from the token.

### Request

No body.

### Response — `200`

```json
{ "updated": 7 }
```

`updated` is the count actually transitioned, so a second call returns `0` rather than an error.

### Notes

- One conditional `updateMany` on `{ recipientUserId: <token>, readAt: null }`. Idempotent by
  construction — the update falsifies its own filter.
- **The recipient is never a parameter.** A body- or query-supplied recipient would be a cross-tenant
  write wearing a convenience.
- Chosen over a client-side loop because the loop is N rate-limited requests, is not atomic, and
  flickers the unread badge downward N times — which would put the badge and the list in disagreement,
  and FR-026 requires them to agree (research R6).

---

## 3. `GET /api/v1/orders/:id` — unchanged, and that is the point

`stopEvents` is **already** returned to a `DRIVER`. `OrdersController.toRoleScopedShape` deletes it for
the `CLIENT` only, as a deliberate privacy boundary recorded in spec 011.

No delta is needed here. The gap FR-005/FR-006 describe is entirely on the mobile side, which has never
had a field to receive it — see `contracts/mobile-integration.md`.

Stated explicitly because the obvious first move when "the driver cannot see their stops" is to add an
endpoint, and that would create a second source of truth for data already in the response the screen
fetches anyway.

---

## 4. Authenticated requests from a displaced session — already correct

`UsersService.validateActiveSessionWithScoping` already compares the presented token's `sgen` against
the account's `sessionGeneration` on **every** authenticated request, and already throws the structured
`SESSION_REVOKED` shape with the specific `cause`.

So FR-015 (a displaced device's delivery actions are refused, and the refusal says the session ended) is
satisfied by the platform as it stands. **This feature adds a test, not an implementation.**

The hole is on the socket, not on REST — see `contracts/realtime-contract.md`.
