# REST API Contract — Feature 005 Delta

**Feature**: `005-client-backend-integration` | **Date**: 2026-08-15

A delta against `specs/001-fuel-delivery-platform/contracts/rest-api.md`, which remains the base
contract. Conventions carry over unchanged: base URL `/api/v1`, bearer JWT unless marked
**[public]**, uniform error envelope `{ statusCode, message, error }`, and **404 (never 403) for
a cross-boundary id**.

Every endpoint below is CLIENT-facing unless stated. Each one enforces `clientId = req.user.sub`
**in addition to** the tenant plugin — the plugin scopes to the company, and two clients share a
company.

---

## 1. Pagination envelope

Applies to `GET /orders`, `GET /invoices`, `GET /payments`, `GET /notifications` (FR-048).

**Request**: `?cursor=<opaque>&status=<enum>` — `cursor` omitted for the first page. Page size is
fixed by the platform (20) and is **not** client-supplied.

**Response**:

```json
{
  "items": [ /* ... */ ],
  "nextCursor": "eyJzIjoiMjAyNi0wOC0xNVQxMDoxMjozM1oiLCJpIjoiNjZi..."
}
```

`nextCursor` is `null` on the last page. **`null` means the end of the list; a missing field does
not.** The app must distinguish end-of-list from a failed page (FR-048e) and cannot do that if
the two look alike.

The cursor is opaque base64 of `{ sortValue, _id }`. Clients must not parse or construct it. A
malformed cursor returns **400**, never an unpaginated result — silently returning page one on a
bad cursor is how an infinite scroll becomes an infinite loop.

Filters are applied server-side across the whole set, never to the loaded pages (FR-048d).
Changing a filter resets the cursor.

---

## 2. Stations (`/stations`) — new

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| GET | `/stations` | CLIENT | — | `{ items: Station[] }` — the caller's own active stations, default first. Not paginated (bounded, small). |
| PATCH | `/stations/:id/favourite` | CLIENT | `{ isFavourite: boolean }` | Updated `Station` |
| GET | `/users/:id/stations` | FUEL_COMPANY_ADMIN | — | `{ items: Station[] }` for that client |
| POST | `/users/:id/stations` | FUEL_COMPANY_ADMIN | `CreateStationDto` | Created `Station` (**201**) |
| PATCH | `/stations/:id` | FUEL_COMPANY_ADMIN | `UpdateStationDto` | Updated `Station` |
| DELETE | `/stations/:id` | FUEL_COMPANY_ADMIN | — | **204**. Soft delete (`isActive: false`). |

`Station` response shape:

```json
{
  "id": "66b...",
  "name": "محطة الرحاب",
  "regionCode": "MAKKAH",
  "governorateCode": "JEDDAH",
  "location": { "type": "Point", "coordinates": [39.1, 21.5] },
  "addressText": "جدة - طريق مكة القديم - حي البوادي",
  "isDefault": true,
  "isFavourite": false
}
```

**Notes**:

- `PATCH /stations/:id/favourite` accepts `isFavourite` and nothing else. A CLIENT sending `name`
  or `location` gets **400** from DTO whitelisting, not a silent ignore.
- A CLIENT has **no** create, rename or delete route (FR-036b). The absence is the contract.
- Deleting the default station when others exist promotes the next by creation order. Deleting the
  last active station is refused with **409** — a client with no station cannot order.
- `isActive: false` stations are excluded from `GET /stations` but remain readable through the
  order that references them (FR-036c).

---

## 3. Pricing

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| GET | `/companies/:id/pricing-config` | FUEL_COMPANY_ADMIN, CLIENT | — | `PricingConfig` |
| PUT | `/companies/:id/pricing-config` | FUEL_COMPANY_ADMIN | `SetPricingConfigDto` | Updated `PricingConfig` |
| POST | `/orders/quote` | CLIENT | `{ fuelType, quantityLiters, stationId }` | `Quote` |

`PricingConfig` response:

```json
{
  "deliveryFee": 30.00,
  "serviceFeePercent": 1.0,
  "taxRatePercent": 15.0,
  "tankerCapacitiesLiters": [20000, 22000, 32000, 33000, 36000, 42000, 46000]
}
```

`tankerCapacitiesLiters` is what the client's quantity selector steps through (FR-017). It is the
fuel company's own configuration — **never** derived from transport companies' fleet records,
which belong to a different tenant (FR-017a).

Both `/companies/:id` routes reuse the existing `assertCompanyAccess` guard, so a CLIENT reads
their own fuel company's configuration and nothing else (verified: a CLIENT's `companyId` is
their fuel company).

`Quote` response:

```json
{
  "breakdown": {
    "fuelLineTotal": 46600.00,
    "deliveryFee": 30.00,
    "serviceFee": 466.00,
    "tax": 7064.40,
    "total": 54160.40,
    "unitPrice": 2.33,
    "serviceFeePercent": 1.0,
    "taxRatePercent": 15.0,
    "currency": "SAR"
  },
  "quoteToken": "b3f1...",
  "expiresAt": "2026-08-15T10:27:33Z"
}
```

**Errors**:

- **409 `PRICING_NOT_CONFIGURED`** — the fuel company has no `pricingConfig` (FR-011j). The client
  is told pricing is unavailable; no total derived from zeros is ever returned.
- **404** — `stationId` not the caller's, or fuel grade not sold by their supplier.

---

## 4. Orders — changed

| Method | Path | Change |
|--------|------|--------|
| GET | `/orders` | Now paginated (§1). Accepts `?status=`. Ordered `statusChangedAt` desc. |
| GET | `/orders/:id` | Response gains `priceBreakdown` and `station`. |
| POST | `/orders` | Body gains `stationId` (required) and `quoteToken` (required). |

`POST /orders` errors:

- **409 `QUOTE_STALE`** — the pricing inputs changed since the quote (research R10). The response
  body carries the **new** breakdown so the app can re-prompt rather than re-request:

  ```json
  { "statusCode": 409, "error": "QUOTE_STALE",
    "message": "Pricing has changed since this quote",
    "currentBreakdown": { "...": "..." } }
  ```

- **409 `QUOTE_EXPIRED`** — token past `expiresAt`. The app re-quotes silently.
- **409 `CREDIT_LIMIT_EXCEEDED`** — existing behaviour, unchanged. Remains the authoritative
  refusal; the client-side warning (FR-028) is a courtesy, never a gate.

`priceBreakdown` is **absent** on orders placed before this feature (research R2). The app renders
a total-only receipt in that case — it must not treat absence as an error or as zeros.

---

## 4a. Invoices — changed

| Method | Path | Change |
|--------|------|--------|
| GET | `/invoices` | Now paginated (§1). Sorted **outstanding first**, then newest-first within each group. |
| GET | `/invoices/:id` | Response gains `priceBreakdown`. |

The outstanding-first sort is FR-048f: an old unpaid invoice must stay reachable, because it still
counts against the client's credit standing. Newest-first alone would let it fall past the last
page a client ever scrolls to.

`priceBreakdown` is the same shape as the order's, **copied at issuance**. `priceBreakdown.total`
always equals `amount` — if the two could disagree, the client would see two figures for one debt.
Absent on invoices issued before this feature, exactly as on orders.

---

## 5. Payments (`/payments`) — new client-facing route

| Method | Path | Roles | Response |
|--------|------|-------|----------|
| GET | `/payments` | CLIENT | Paginated (§1) `PaymentRecord[]` |

```json
{
  "id": "66b...",
  "orderId": "66a...",
  "amount": 54160.40,
  "currency": "SAR",
  "gateway": "SADAD",
  "outcome": "CONFIRMED",
  "createdAt": "2026-08-14T09:11:02Z"
}
```

**`rawPayload` is never projected.** It holds the gateway's untouched payload and may carry
gateway-side card metadata — projecting it is a Principle II violation. Only terminal outcomes
are listed; in-flight webhook noise is not payment history.

---

## 6. Credit standing

| Method | Path | Roles | Response |
|--------|------|-------|----------|
| GET | `/users/me/credit` | CLIENT | `CreditStanding` |

```json
{ "creditLimit": 200000.00, "consumed": 80000.00, "available": 120000.00, "currency": "SAR" }
```

`creditLimit: null` when no facility is assigned — the app says so rather than showing a figure
(FR-027). Computed live from `InvoicesService.getAvailableCredit`; never stored (research R6).

---

## 7. Phone verification (`/users/me/phone`) — new

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| POST | `/users/me/phone/verification` | any | `{ newPhone }` | **202** `{ expiresAt, attemptsRemaining }` |
| POST | `/users/me/phone/verification/confirm` | any | `{ code }` | Updated user profile |

**Rate limits**: 3 code requests per user per 15 min; 5 confirm attempts per code.

**Errors**:

- **409 `PHONE_IN_USE`** — returned *before* any SMS is sent (FR-035e), so a message is never
  spent on a doomed change.
- **429** — either throttle tripped. Body carries `retryAfterSeconds` so the app can say *when*,
  not just *no*.
- **502 `SMS_SEND_FAILED`** — the provider could not accept the message (FR-035f). The client is
  told the send failed and offered retry. The endpoint **must not** return 202 when the provider
  rejected the send.
- **401** — wrong or expired code. Attempts are counted; the response never reveals whether the
  code was wrong or expired.

The code is never in any response body, any log line, or any push payload (FR-035g).

---

## 8. Support (`/support`) — new

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| POST | `/support/requests` | CLIENT | `{ topic, message, orderId? }` | Created request (**201**) |
| GET | `/support/requests` | CLIENT | — | `{ items: SupportRequest[] }` — caller's own, newest first. Not paginated. |
| GET | `/support/requests` | FUEL_COMPANY_ADMIN | — | Requests for their company |
| PATCH | `/support/requests/:id/acknowledge` | FUEL_COMPANY_ADMIN | — | Updated request |

```json
{ "id": "66b...", "topic": "DELIVERY_DELAY", "message": "...",
  "orderId": "66a...", "state": "SUBMITTED", "createdAt": "...", "acknowledgedAt": null }
```

Submission raises a `SUPPORT_REQUEST_RAISED` notification to the client's fuel company admins via
the existing `NotificationsService.notify` (FR-038b). `orderId`, when given, must belong to the
caller — **404** otherwise.

---

## 9. Notifications — changed

| Method | Path | Change |
|--------|------|--------|
| GET | `/notifications` | Now paginated (§1). Response gains `unreadCount`. |

```json
{ "items": [ /* ... */ ], "nextCursor": null, "unreadCount": 3 }
```

`unreadCount` is the count across the caller's **whole** set, not the current page — it is a
badge, and a per-page count would be meaningless (research R8).

---

## 10. Auth — unchanged shape, changed source

`GET /auth/me` keeps `station` (the client's default) for backward compatibility, now read from
the `Station` collection rather than the embedded field. **The response shape does not change** —
this matters because the driver app also calls this endpoint, and the migration must be invisible
to it.

---

## Error codes introduced

| Code | Status | Meaning |
|---|---|---|
| `PRICING_NOT_CONFIGURED` | 409 | Fuel company has no `pricingConfig` |
| `QUOTE_STALE` | 409 | Pricing inputs changed; body carries the new breakdown |
| `QUOTE_EXPIRED` | 409 | Quote token past expiry |
| `PHONE_IN_USE` | 409 | Target number belongs to another account |
| `SMS_SEND_FAILED` | 502 | Provider rejected the send |
| `LAST_STATION` | 409 | Cannot remove a client's only active station |

All are named constants (Principle I), never inline strings.
