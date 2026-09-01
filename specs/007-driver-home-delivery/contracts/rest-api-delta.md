# REST API Delta: Driver Home & Active Delivery

**Feature**: 007-driver-home-delivery | **Date**: 2026-08-24

Delta against `specs/001-fuel-delivery-platform/contracts/rest-api.md`. Two new endpoints, two
changed response shapes. Every existing driver handover endpoint is **unchanged** — they already
work; the app simply never called two of them.

---

## New: `GET /drivers/me/summary`

**Auth**: authenticated, `@Roles(UserRole.DRIVER)`. **Requirements**: FR-028, FR-030, FR-031,
FR-032, FR-033, FR-034, FR-035.

Everything the driver's home header needs, in one call (research R9).

**Response `200`**

```json
{
  "ratingAverage": 4.8,
  "ratingCount": 27,
  "deliveriesToday": 3,
  "readyForWork": true
}
```

| Field | Meaning |
|---|---|
| `ratingAverage` | **Absent** when the driver has never been rated. Never `0`, never `null` as a stand-in for a score — absence *is* the "not yet rated" state (FR-031). |
| `ratingCount` | `0` for a never-rated driver. A count of zero is honest; a score of zero is not. |
| `deliveriesToday` | Completed today, by the platform's day boundary — not the device's (FR-033). |
| `readyForWork` | Derived: `isActive && isOnline && isAvailable && !activeOrderId`. Read-only; there is deliberately no endpoint to set it (FR-036). |

**`me`, not `:id`** — there is no identifier to authorise and no way to ask for another driver's
figures, so FR-034 holds structurally rather than by a check that could be forgotten.

---

## New: `POST /orders/:id/rating`

**Auth**: authenticated, `@Roles(UserRole.CLIENT)`. **Requirements**: FR-037–FR-042.

**Request**

```json
{ "score": 5, "review": "Arrived on time and called ahead as asked." }
```

| Field | Rules |
|---|---|
| `score` | Required. Integer, 1–5 inclusive. |
| `review` | Optional. Trimmed, ≤ 500 characters, plain text. |

**Response `201`** — the rating as stored.

**Errors**

| Status | `error` | When |
|---|---|---|
| `404` | `NotFoundException` | The order is not this client's, or does not exist. Same shape for both — never reveal that someone else's order exists (Principle II). |
| `409` | `ORDER_NOT_DELIVERED` | The order has not reached `DELIVERED` (FR-040). |
| `409` | `ALREADY_RATED` | A rating already exists for this order (FR-039). |

`ALREADY_RATED` is returned by **catching the unique-index violation on `orderId`**, not by a
prior existence check. A check-then-insert races: two concurrent submissions both read "no
rating" and both proceed. The index is the only actual guarantee (Principle V).

Both writes — the rating insert and the driver's aggregate bump — run in one `ClientSession`.

---

## Changed: `GET /orders` and `GET /orders/:id`

**Requirements**: FR-003a, FR-003b, FR-041.

Each order gains two optional fields. Response shape is otherwise untouched, and both are absent
on orders that predate this feature — consumers must treat absence as "not available", never as
an error.

```json
{
  "clientSummary": { "fullName": "Ahmed Al-Otaibi", "phone": "+9665XXXXXXX" },
  "deliveredAt": "2026-08-24T13:05:00.000Z"
}
```

- **`clientSummary`** — snapshotted when a driver is assigned, mirroring the existing
  `driverSummary`. A DRIVER receives it only for orders where they are the assigned driver;
  `findOneForUser` already enforces that, and the list query is already scoped by `driverId`.
- **`deliveredAt`** — set once, at the transition into `DELIVERED`.

### Rating on the order detail

`GET /orders/:id` additionally carries the delivery's rating once one exists, so both personas
read it from the delivery it belongs to (FR-041 for the driver, FR-037d for the customer):

```json
{ "rating": { "score": 5, "review": "…", "createdAt": "2026-08-24T14:00:00.000Z" } }
```

Absent when unrated — which the driver's screen renders as an explicit "not yet rated" state
(FR-041a), not as a zero or an empty star row.

---

## Unchanged, and worth stating

These already exist and already work. Two of them have simply never been called by the app,
which is why the handover is broken in the middle rather than at one end:

| Endpoint | Role | Effect |
|---|---|---|
| `POST /orders/:id/arrive` | DRIVER | **Issues the arrival code to the customer.** Never called by the app today. |
| `POST /orders/:id/verify-arrival` | DRIVER | `IN_TRANSIT` → `UNLOADING`. Throttled 5 / 15 min. |
| `POST /orders/:id/request-delivery-otp` | DRIVER | **Issues the delivery code to the customer.** Never called by the app today. |
| `POST /orders/:id/verify-delivery` | DRIVER | `UNLOADING` → `DELIVERED`. Throttled 5 / 15 min. |

The existing `@Throttle({ limit: 5, ttl: 15 * 60_000 })` on both verify endpoints is what
FR-017 ("direct the driver to have a fresh code sent") surfaces to the driver — the app must
render that refusal as guidance rather than as a generic failure.

**`GET /orders/:id/otp/current` stays CLIENT-only.** FR-014 forbids the driver's app ever
seeing a handover code, and this endpoint is the customer's way to display their own. It is
named here only to record that it must not be reused for the driver.
