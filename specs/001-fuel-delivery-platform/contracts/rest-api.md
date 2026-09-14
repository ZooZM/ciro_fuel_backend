# REST API Contract

Base URL: `/api/v1`. All routes require `Authorization: Bearer <JWT>` unless marked **[public]**. All responses JSON. Errors use a uniform envelope `{ statusCode, message, error }`. Cross-tenant access to an existing resource returns **404** (never 403). Rate limiting: global 100 req/min per IP; stricter buckets noted inline.

JWT payload: `{ sub: userId, role, companyId? }` — `companyId` absent only for SUPER_ADMIN (CIRO).

**Roles (spec 004 — multi-tier hierarchy)**: `SUPER_ADMIN` is CIRO, the platform operator,
exempt from tenant isolation. `COMPANY_ADMIN` no longer exists; it split into
`FUEL_COMPANY_ADMIN` (pricing, clients, order approval, invoice/credit administration — the
direct successor of every pre-004 `COMPANY_ADMIN`) and `TRANSPORT_COMPANY_ADMIN` (owns a driver
fleet, picks up orders routed to it, settles deferred invoices). `CLIENT` and `DRIVER` are
unchanged. A `Company` document now carries `type: FUEL | TRANSPORT`; `POST /companies` (below)
always creates a `FUEL` company; Transportation Companies are created under one via
`POST /companies/:id/transporters`.

**Tenant isolation is two mechanisms now.** Single-tenant collections (users, trucks, files,
credit limits, stations, support requests) keep the original `companyId`-equality plugin.
Multi-party collections — orders and invoices, which can have up to four legitimate viewers
(Fuel Company, Transportation Company, client, driver) in three different companies — use a
second, parallel plugin that scopes by role: `FUEL_COMPANY_ADMIN` sees everything under their
`fuelCompanyId`; `TRANSPORT_COMPANY_ADMIN` sees only what's routed to their own
`transportCompanyId`; `CLIENT` and `DRIVER` see only their own `clientId`/`driverId`. Both
mechanisms fail closed and both return 404 (never 403) for a cross-boundary id. Single-tenant,
client-scoped collections (stations, support requests) additionally enforce
`clientId = req.user.sub` on top of the company plugin, since a fuel company routinely has
several clients sharing it.

## Cursor pagination (spec 005 FR-048)

Applies to `GET /orders`, `GET /invoices`, `GET /payments`, `GET /notifications`.

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
not** — the app must distinguish end-of-list from a failed page and cannot do that if the two
look alike.

The cursor is opaque base64 of `{ sortValue, _id }`. Clients must not parse or construct it. A
malformed cursor returns **400**, never an unpaginated result — silently returning page one on a
bad cursor is how an infinite scroll becomes an infinite loop.

Filters are applied server-side across the whole set, never to the loaded pages. Changing a
filter resets the cursor.

## Auth (`/auth`)

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| POST | `/auth/login` **[public]** (10/min) | — | `{ phone, password }` (CLIENT/DRIVER) or `{ email, password }` (admin roles) | `{ accessToken, refreshToken, user: {id, role, companyId, fullName} }` |
| POST | `/auth/login/code/request` **[public]** (10/min) | — | `{ phone, challenge? }` | `202 { expiresInMinutes, attemptsAllowed }` — **spec 015**, identical for every outcome (FR-015) |
| POST | `/auth/login/code/verify` **[public]** (10/min) | — | `{ phone, code }` (6 digits) | same shape as `/auth/login` — **spec 015** |
| POST | `/auth/refresh` **[public]** | — | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| POST | `/auth/logout` | any | — | `204` |
| GET | `/auth/me` | any | — | current user profile, including `station`/`creditLimit` for a CLIENT (`undefined` for every other role) |

`401` on bad credentials or suspended company / deactivated account (same message — no enumeration).

Phone is the login identifier for CLIENT/DRIVER (E.164, unique platform-wide). **Spec 015**: an
administrator's phone is now a login identifier too — for `/auth/login/code/*` only, not for
password `/auth/login`, which stays CLIENT/DRIVER-scoped. `phone` takes precedence when both
identifiers are supplied to `/auth/login`.

**Spec 015 — passwordless administrator sign-in.** `/auth/login/code/request` sends a 6-digit SMS
code **only** when the number resolves to exactly one active account holding an admin role;
every other outcome (driver, client, unknown, inactive, two-or-more) returns the identical `202`
and no SMS. Hardened past the recovery flow: per-phone request rate limit, a self-hosted
proof-of-work `challenge` demanded after repeated rate-limited requests (`400 CHALLENGE_REQUIRED`
carrying `{ seed, difficultyBits }`), a per-code attempt lockout, and a cross-code temporary block
(`429 LOGIN_RATE_LIMITED` with `retryAfterSeconds`, deliberately indistinguishable from the
request-rate `429`). All counters **fail closed** — a Redis outage returns `503`, never `202`.
`/auth/login/code/verify` refuses wrong / expired / superseded / attempt-locked codes with one
`400 LOGIN_CODE_INVALID` and no attempt count.

**Spec 015 — session model, admin roles only.** `/auth/login` (and code verify) **open** an
`ActiveSession` rather than displacing the prior one: an administrator holds up to
`AUTH_MAX_ADMIN_SESSIONS` (default 3) concurrent, independently-revocable sessions; a further
sign-in evicts the oldest, whose next request returns `SESSION_REVOKED` with
`cause: SESSION_LIMIT_EXCEEDED`. **No `session:revoked` socket push and no `disconnectUser`** on an
admin sign-in (the room is per-user). Both tokens carry a `sid` claim for admin roles;
DRIVER/CLIENT payloads are byte-identical to before (no `sid`, `sessionGeneration` still bumped on
every login — displacement unchanged). `/auth/logout` closes **only the calling `sid`** for an
admin (other devices continue); unchanged for DRIVER/CLIENT. `/auth/refresh` additionally refuses
when the presented token's `sid` is no longer in `activeSessions`, and re-issues the pair with the
**same** `sid`. Password reset, deactivation and company suspension end **every** session for any
role.

**Spec 005**: `station` on `/auth/me` is unchanged in shape but now read from the standalone
`Station` collection's client default rather than the embedded field — invisible to the driver
app, which calls this same endpoint.

## Regions (`/regions`)

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/regions` **[public]** | — | the 13 Saudi regions and their governorates (Arabic/English names), reference data for `Company.servedRegions` and `User.station.regionCode` (FR-010) |

## Companies (`/companies`) — SUPER_ADMIN unless noted

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/companies` | SUPER_ADMIN | multipart: company fields + `commercialRegister` file + initial admin `{email, fullName, phone, password}` (FR-018). Always creates `type: FUEL`, with a `FUEL_COMPANY_ADMIN` admin |
| GET | `/companies?type=&status=` | SUPER_ADMIN, FUEL_COMPANY_ADMIN | CIRO sees every company; a `FUEL_COMPANY_ADMIN` sees only their own (spec 004 US1) — not paginated. **spec 017 FR-010/FR-013**: `type` (`FUEL\|TRANSPORT`) and `status` (`ACTIVE\|SUSPENDED`) are now READ — before spec 017 the handler bound no query parameters at all and the dashboard had been sending `?type=FUEL` since spec 013 with no effect (research R2). Absent or empty means every value; an unrecognised value is `400`. Both **intersect** a `FUEL_COMPANY_ADMIN`'s own-tenant narrowing, never widen it (FR-012) |
| GET | `/companies/:id` | SUPER_ADMIN, own FUEL_COMPANY_ADMIN (also its own transporters) | |
| PATCH | `/companies/:id/status` | SUPER_ADMIN | `{ status: ACTIVE\|SUSPENDED }` |
| GET | `/companies/:id/fuel-prices` | own FUEL_COMPANY_ADMIN, own CLIENT | price list for estimates |
| PUT | `/companies/:id/fuel-prices` | own FUEL_COMPANY_ADMIN | `[{ fuelType, basePricePerLiter }]` (FR-008a) |
| GET | `/companies/:id/pricing-config` | own FUEL_COMPANY_ADMIN, own CLIENT | `PricingConfig` — spec 005, see below |
| PUT | `/companies/:id/pricing-config` | own FUEL_COMPANY_ADMIN | `SetPricingConfigDto` → updated `PricingConfig` — spec 005 |
| POST | `/companies/:id/transporters` | own FUEL_COMPANY_ADMIN | `{ name, contactEmail, contactPhone, adminEmail, adminFullName, adminPhone, adminPassword }` → creates a `type: TRANSPORT` company under `:id` plus its `TRANSPORT_COMPANY_ADMIN`, `201 { company, admin }` (spec 004 US2) |
| POST | `/companies/transporters` | SUPER_ADMIN | **spec 017 FR-027/FR-029/FR-030** — the OPERATOR onboarding a transporter. Same body as `/companies/:id/transporters` plus a **required** `parentFuelCompanyId`, which must exist and be of type `FUEL` (`400 INVALID_PARENT_FUEL_COMPANY` otherwise, nothing created). Company + admin are one transaction (FR-028). Declared BEFORE `:id/transporters` so Nest does not capture `transporters` as an `:id`. Deliberately omits that route's post-insert `companyId` correction: a `SUPER_ADMIN` actor takes the tenant plugin's role bypass, so `pre('save')` writes nothing to correct (research R12) |
| PUT | `/companies/:id/regions` | owning FUEL_COMPANY_ADMIN (of the transporter at `:id`) | `{ regionCodes: RegionCode[] }` — replaces `servedRegions` wholesale on a Transportation Company; drives routing (FR-014/FR-015/FR-016) |

### Pricing config (spec 005 D1/FR-011)

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
which belong to a different tenant (FR-017a). Both `/companies/:id/pricing-config` routes reuse
the existing `assertCompanyAccess` guard, so a CLIENT reads their own fuel company's
configuration and nothing else.

## Users (`/users`) — company-scoped automatically

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/users` | FUEL_COMPANY_ADMIN (CLIENT only), TRANSPORT_COMPANY_ADMIN (DRIVER only), SUPER_ADMIN | CLIENT requires `station{regionCode, governorateCode, location, addressText?, name?}` (region/governorate must pair, FR-010/FR-011); DRIVER requires `truck{plateNumber, maxCapacityLiters, fuelTypes[]}` (denormalized onto the driver doc, R8). `phone` MUST be E.164 and is unique platform-wide for CLIENT/DRIVER (it is their login identifier). A Fuel Company may only create CLIENTs; a Transportation Company may only create DRIVERs (FR-004a). Spec 005: also creates the client's first `Station` document |
| GET | `/users?role=&isActive=` | FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN, SUPER_ADMIN | tenant-filtered list |
| GET | `/users/me/credit` | CLIENT | `CreditStanding` — spec 005, see below. Registered ahead of `GET /users/:id` |
| POST | `/users/me/phone/verification` | any | spec 005 phone-change flow, see below |
| POST | `/users/me/phone/verification/confirm` | any | spec 005 phone-change flow, see below |
| GET | `/users/:id` | FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN, SUPER_ADMIN; self | |
| PATCH | `/users/:id` | FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN, SUPER_ADMIN; self (limited fields) | role & companyId immutable; `phone` re-validated as E.164 and must stay unique |
| PATCH | `/users/:id/activate` / `/deactivate` | FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN, SUPER_ADMIN | deactivation of a driver on active delivery: allowed, blocks NEW assignments only (edge case) |
| PATCH | `/users/:id/truck` | TRANSPORT_COMPANY_ADMIN | update truck (`plateNumber`, `maxCapacityLiters`, `fuelTypes[]`) — rewrites the denormalized subdoc atomically |
| PATCH | `/users/:id/profile-picture` | self; FUEL_COMPANY_ADMIN/TRANSPORT_COMPANY_ADMIN/SUPER_ADMIN | multipart `file` — spec 005, sets `profilePictureFileId` |
| PUT | `/users/:id/credit-limit` | own FUEL_COMPANY_ADMIN | `{ creditLimit }`; target must be a CLIENT (spec 004 FR-023) |
| GET | `/users/:id/stations` | own FUEL_COMPANY_ADMIN | spec 005, see Stations below |
| POST | `/users/:id/stations` | own FUEL_COMPANY_ADMIN | spec 005, see Stations below |

`409` when a `phone` or `email` is already registered (both are unique platform-wide);
`400` when `phone` is not E.164.

### Credit standing (spec 005 FR-027)

`GET /users/me/credit` response:

```json
{ "creditLimit": 200000.00, "consumed": 80000.00, "available": 120000.00, "currency": "SAR" }
```

`creditLimit: null` when no facility is assigned — the app says so rather than showing a figure.
Computed live from the same derivation an over-limit CREDIT order is refused against; never
stored.

### Phone verification (spec 005 FR-035)

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| POST | `/users/me/phone/verification` | any | `{ newPhone }` | **202** `{ expiresAt, attemptsRemaining }` |
| POST | `/users/me/phone/verification/confirm` | any | `{ code }` | **201** updated user profile |

**Rate limits**: 3 code requests per user per 15 min; 5 confirm attempts per code — both tracked
per user, not per IP.

**Errors**:

- **409 `PHONE_IN_USE`** — returned *before* any SMS is sent (FR-035e), so a message is never
  spent on a doomed change. Checked platform-wide, across every company.
- **429** — either throttle tripped. Body carries `retryAfterSeconds` so the app can say *when*,
  not just *no*.
- **502 `SMS_SEND_FAILED`** — the provider could not accept the message (FR-035f). The client is
  told the send failed and offered retry. The endpoint **must not** return 202 when the provider
  rejected the send.
- **401** — wrong or expired code. Attempts are counted; the response never reveals whether the
  code was wrong or expired.

The code is never in any response body, any log line, or any push payload (FR-035g). The phone
itself is unchanged until `confirm` succeeds; an abandoned or expired verification leaves the
original in force (FR-035c).

## Geocoding (`/geocoding`)

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/geocoding/reverse` | FUEL_COMPANY_ADMIN | `{ lat, lng }` → `{ addressText }`, a suggestion only — never final, never re-derived on a later read (FR-011/012/013). Never throws: a missing API key, network failure or empty result all return `{ addressText: '' }`. The **only** external address-lookup call in the platform — order reads never make one (SC-007) |

## Stations (`/stations`, spec 005 D2)

Promoted out of the client's embedded `station` field so a client may hold several, registered
by their fuel company.

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| GET | `/stations` | CLIENT | — | `{ items: Station[] }` — the caller's own active stations, default first. Not paginated (bounded, small) |
| PATCH | `/stations/:id/favourite` | CLIENT | `{ isFavourite: boolean }` | Updated `Station` |
| GET | `/users/:id/stations` | FUEL_COMPANY_ADMIN | — | `{ items: Station[] }` for that client |
| POST | `/users/:id/stations` | FUEL_COMPANY_ADMIN | `CreateStationDto` | Created `Station` (**201**) |
| PATCH | `/stations/:id` | FUEL_COMPANY_ADMIN | `UpdateStationDto` | Updated `Station` |
| DELETE | `/stations/:id` | FUEL_COMPANY_ADMIN | — | **204**. Soft delete (`isActive: false`) |

`Station` response shape:

```json
{
  "_id": "66b...",
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
  last active station is refused with **409 `LAST_STATION`** — a client with no station cannot
  order.
- `isActive: false` stations are excluded from `GET /stations` but remain readable through the
  order that references them (FR-036c).
- Where a client has exactly one registered station, the app selects it automatically and never
  offers a choice (FR-036d) — a client-side UI rule, not a different server response.

## Orders (`/orders`)

| Method | Path | Roles | Body / Notes |
|--------|------|-------|--------------|
| POST | `/orders/quote` | CLIENT | `{ fuelType, quantityLiters, stationId }` → `Quote` — spec 005, see below |
| POST | `/orders` | CLIENT | `{ fuelType, quantityLiters, stationId, quoteToken, paymentMethod? }` → 201 with `status: PENDING_APPROVAL`, `estimatedPrice`, `priceBreakdown` (FR-007/008a/011e). `paymentMethod` defaults to `DIRECT` (FR-021). `stationId` and `quoteToken` are both required (spec 005) |
| GET | `/orders?status=&bucket=&orderId=&cursor=` | any (scoped by the multi-party plugin: CLIENT→own, DRIVER→assigned, FUEL_COMPANY_ADMIN→own fuel company, TRANSPORT_COMPANY_ADMIN→own routed orders, SUPER_ADMIN→all) | Paginated (see Cursor pagination above), ordered `statusChangedAt` desc. Each item includes `etaMinutes` (FR-029, `null` until a driver is assigned and has a position on file). **spec 017 FR-016/FR-016a**: `bucket` is one of the six `OrderStatusBucket` values and expands to `status: { $in: [...] }` — **never a `$or`**, which both scoping plugins would silently discard via `Query.where()` (research R4). A `status` outside a supplied `bucket` is `400 ORDER_BUCKET_STATUS_CONFLICT`, never a silently empty page. `orderId` is an exact identifier that overrides both; **search is identifier-only** — `Order` has no human reference field and the platform carries no text index, so free-text search is explicitly out of scope (research R13) |
| GET | `/orders/:id` | as above | includes `statusHistory`, `driverSummary` (FR-028, absent pre-assignment), `etaMinutes`, `deliveryAddressText`, `priceBreakdown` and `station` (spec 005); driver DTO **never** includes `otps` |
| PATCH | `/orders/:id/approve` | FUEL_COMPANY_ADMIN | `{ finalPrice?, transportCompanyId? }` — omitted `finalPrice` ⇒ `finalPrice = estimatedPrice` (the FUEL line; the haul is not priced yet). Approves, then ROUTES, for **every** payment method: exactly one serving Transportation Company → routed automatically; none → `AWAITING_ROUTING` + Fuel Company notified (FR-016); several → `AWAITING_ROUTING` with `routingCandidates` in the response unless `transportCompanyId` was supplied, which routes to that choice (FR-014). Routing prices the delivery leg from the chosen transporter's own `deliveryRates`, re-derives the total, issues the invoice (FR-020) and returns the order to the station owner → `PENDING_PAYMENT` (FR-020a). A transporter that has priced no covering area cannot be routed to (409 `TRANSPORT_PRICE_NOT_SET`). A CREDIT order over the client's available credit, or a company over its commission ceiling, is refused (400/409) and the refusal **undoes the routing**, leaving the order `APPROVED`, un-routed and uninvoiced (FR-020a-i, FR-025) — recoverable via `PATCH /orders/:id/route` once the cause is cleared |
| PATCH | `/orders/:id/route` | FUEL_COMPANY_ADMIN | `{ transportCompanyId }` — resolves an `AWAITING_ROUTING` order manually (FR-014's Fuel-Company choice, or FR-016's later resolution once a transporter gains region coverage); 409 if the order isn't `AWAITING_ROUTING`; 400 if the choice doesn't actually serve the region |
| PATCH | `/orders/:id/reject` | FUEL_COMPANY_ADMIN | `{ reason }` → `REJECTED` |
| PATCH | `/orders/:id/cancel` | CLIENT (pre-assignment, or declining the Final Price while `PENDING_PAYMENT`), FUEL_COMPANY_ADMIN (until `IN_TRANSIT`) | → `CANCELLED`; transactionally releases the driver (if assigned) and voids the order's invoice if one was issued (a voided CREDIT invoice implicitly restores the client's available credit, FR-024/FR-027) |
| POST | `/orders/:id/accept` | CLIENT (the order's own) | The station owner confirms the final total once routing has priced the haul → `PENDING_PAYMENT` → `ROUTED_TO_TRANSPORT`, releasing the order for driver assignment. **DEFERRED and CREDIT only** — they are settled against an invoice and have no gateway payment to make; a DIRECT order is confirmed by PAYING it, and this refuses one with 409 `ORDER_NOT_AWAITING_CONFIRMATION` rather than offering a second way past the same gate. No deadline applies (FR-020b): the order waits indefinitely. Refusing the total is `PATCH /orders/:id/cancel` above |
| POST | `/orders/:id/redispatch` | FUEL_COMPANY_ADMIN, CLIENT (CLIENT blocked once `paymentTimeoutCount ≥ 2` — admin-only thereafter, FR-015a) | only from `APPROVED` (reached only via a DIRECT payment timeout — DEFERRED/CREDIT never expire, FR-020b) — re-opens a fresh payment window; settlement then returns the order to the transporter it is already routed to |
| GET | `/orders/:id/otp/current` | CLIENT (order owner) | `{ purpose, otp, expiresAt }` — the ONLY place plaintext OTP appears (FR-021/022) |
| POST | `/orders/:id/arrive` | DRIVER (assigned) | order must be `IN_TRANSIT`; generates ARRIVAL OTP — idempotent while an unused, unexpired OTP exists; if the active OTP has EXPIRED, issues a fresh record with attempts reset (same rule for `request-delivery-otp`); response contains NO otp |
| POST | `/orders/:id/verify-arrival` (5/15min) | DRIVER (assigned) | `{ otp }` → on match: `UNLOADING`; 422 wrong otp; 429 throttled (FR-021/023) |
| POST | `/orders/:id/request-delivery-otp` | DRIVER (assigned) | order must be `UNLOADING`; generates DELIVERY OTP; response contains NO otp |
| POST | `/orders/:id/verify-delivery` (5/15min) | DRIVER (assigned) | `{ otp }` → on match (txn): `DELIVERED`, driver released (FR-022) |
| PATCH | `/orders/:id/force-complete` | FUEL_COMPANY_ADMIN | `{ reason }` (required, 5–500 chars); order must be `IN_TRANSIT` or `UNLOADING` → (txn) `DELIVERED`, driver released, active OTPs invalidated, statusHistory entry stamped `{manualOverride: true, overrideReason}` (FR-025). 409 from any other state; DRIVER/CLIENT ⇒ 403 |

**Stop events (spec 011 · in-transit stop detection; spec 013 · blocked report).** A stop is an embedded entry on `Order.stopEvents`, returned to the DRIVER and the TRANSPORT_COMPANY_ADMIN, stripped from the CLIENT's shape (`toRoleScopedShape`). `origin` ∈ `DETECTED` (the sweep asked) · `DECLARED` (the driver announced it early — written already resolved + `suppressedUntil`) · `BLOCKED` (spec 013 — the driver cannot reach the destination; written **unresolved**, **no** `suppressedUntil`, `escalatedAt` at creation, transporter notified in the same op).

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/orders/:id/stops/declare` | DRIVER (assigned) | `{ reason, reasonText?, expectedDurationMinutes }` (1–240). Order must be `IN_TRANSIT`; 409 `STOP_ALREADY_OPEN` if one is unresolved; 404 not-yours |
| POST | `/orders/:id/stops/:stopId/reason` | DRIVER (assigned) | `{ reason, reasonText? }` — answers a `DETECTED` stop; a late answer (past the escalation window) is an ordinary success |
| POST | `/orders/:id/stops/blocked` | DRIVER (assigned) | **spec 013.** `{ reason, reasonText? }` (`reasonText` required only for `OTHER`). Appends a `BLOCKED` stop and notifies the transport company's admins (`ORDER_DRIVER_BLOCKED`) immediately — no response window, no escalation job. Order must be `IN_TRANSIT`; 409 `STOP_ALREADY_OPEN`; 404 not-yours (never 403). Detection is **not** suppressed. Closed by the existing resolve endpoint |
| PATCH | `/orders/:id/stops/:stopId/resolve` | TRANSPORT_COMPANY_ADMIN | marks any stop handled, `resolvedBy` stamped; 409 `STOP_ALREADY_RESOLVED` |

Invalid state transition on any route ⇒ `409 { message: "Invalid transition <from> → <to>" }`.

**Order status machine (spec 004 US5 extends US4's routing states with billing):**
`PENDING_APPROVAL` → `APPROVED` → (DIRECT) `PENDING_PAYMENT` → (settled) `APPROVED` again →
`AWAITING_ROUTING` | `ROUTED_TO_TRANSPORT` → `ASSIGNED_TO_DRIVER` → `LOADING` → `IN_TRANSIT` →
`UNLOADING` → `DELIVERED`. **spec 008** inserted `LOADING` and removed the
`ASSIGNED_TO_DRIVER → IN_TRANSIT` edge outright: `ASSIGNED_TO_DRIVER` now means "assigned, awaiting
departure verification", and `IN_TRANSIT` narrowed to "loaded and travelling to the customer". DEFERRED/CREDIT orders skip `PENDING_PAYMENT` entirely, routing immediately off
`APPROVED`. `PENDING_PAYMENT → APPROVED` is one edge shared by two events: a successful
settlement (routing resumes next) and the 30-minute payment-deadline timeout
(`paymentTimeoutCount` increments; `POST /orders/:id/redispatch` re-opens the window).

### Quoting (spec 005 D1/FR-007/FR-011)

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

`POST /orders` errors (in addition to the quote errors above):

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

## Dispatch (`/dispatch`)

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/dispatch/orders/:id/candidates` | TRANSPORT_COMPANY_ADMIN (of the order's routed transporter) | order must be `ROUTED_TO_TRANSPORT`; ranked list of that transporter's own available drivers by **proximity and availability only** — spec 008 R3 moved capacity/grade to the tank, a step downstream of this list. Each candidate carries `suggestedTruck` (their last-operated truck, `null` when they have never driven or it is withdrawn/busy) |
| POST | `/dispatch/orders/:id/assign` | TRANSPORT_COMPANY_ADMIN (of the order's routed transporter) | `{ driverId, truckId, tankId }` (spec 008 FR-009 — all three, selected in that order) — books all three atomically (txn) and stops at `ROUTED_TO_TRANSPORT` → `ASSIGNED_TO_DRIVER`. It **no longer advances to `IN_TRANSIT`**: that edge is gone, and reaching it now requires departure verification plus loading confirmation. Also snapshots `tankSummary` and `warehouseSummary`. 409 `TRUCK_UNAVAILABLE`/`TANK_UNAVAILABLE` if either is withdrawn or committed elsewhere, `TANK_CAPACITY_EXCEEDED`/`TANK_GRADE_UNSUPPORTED` if the tank cannot carry the order, `NO_WAREHOUSE_FOR_GRADE` if no in-service depot supplies the grade (checked **before** anything is booked), `ORDER_ALREADY_ASSIGNED` on a concurrent assignment of the same order. A refusal books nothing — all three resources are released together (FR-018/SC-003/SC-007/SC-024) |

Driver assignment moved from the Fuel Company to the Transportation Company in spec 004 — the
pre-004 single `POST /dispatch/orders/:id` auto-select endpoint no longer exists. A Fuel
Company's own manual-resolution action lives on the order itself (`PATCH /orders/:id/route`).

## Fleet, warehouses and vehicle verification (spec 008)

**Trucks** (`/trucks`) — TRANSPORT_COMPANY_ADMIN, scoped to their own company.

| Method | Path | Notes |
|--------|------|-------|
| POST / GET / GET `:id` / PATCH `:id` | `/trucks` | plate + optional model. A truck carries **no** capacity or fuel grade — those live on the tank (R3). `409 DUPLICATE_PLATE` within a company |
| PATCH | `/trucks/:id/withdraw` / `/restore` | withdrawal never clears `activeOrderId`: an in-progress delivery continues |
| POST | `/trucks/:id/pair-card` | `{ nfcCardUid }`. `409 CARD_ALREADY_PAIRED` (with `heldByPlateNumber`) — both trucks are left unchanged. Pairing a new card **clears** any minted `qrToken` (FR-036e) |
| POST | `/trucks/:id/qr-token` / `/qr-token/rotate` | mints/rotates a random high-entropy token — **the only responses that ever return a raw credential** (FR-042). Coexists with the card |
| PATCH | `/trucks/:id/qr-token/revoke` | revocation is immediate; there is no expiry to wait out |

Every other truck read returns `hasCard`/`hasCode` booleans instead of the credentials themselves.

**Tanks** (`/tanks`) — TRANSPORT_COMPANY_ADMIN. Same CRUD/withdraw/restore shape, carrying `code`
(unique **platform-wide**), `material`, `maxCapacityLiters` and `fuelTypes`. A tank has **no
credential of any kind** — no pairing route, no token route, and neither field on the schema
(FR-048c). `material` is recorded fact and never derives `fuelTypes` (FR-048g).
`409 TANK_CODE_IN_USE`.

**Warehouses** (`/warehouses`) — the one collection with **no tenant scoping at all** (R1): read by
every authenticated role, written only by SUPER_ADMIN.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/warehouses` / `:id` | any authenticated | a driver must be able to read the depot they are sent to |
| POST | `/warehouses` | SUPER_ADMIN | |
| POST | `/warehouses/bulk` | SUPER_ADMIN | idempotent on `externalRef` → `{ created, updated }`; re-running the national dataset updates rather than duplicates |
| PATCH | `/warehouses/:id` / `:id/withdraw` | SUPER_ADMIN | withdrawal affects only deliveries not yet assigned — an order that snapshotted the depot keeps it (FR-035e) |

**Verification** (`/orders/:id/...`)

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/orders/:id/verify-vehicle` (5/15min) | DRIVER (assigned) | `{ credential, method: NFC_CARD\|QR_CODE, driverLocation? }`. **One endpoint, two stages** — which one is derived from the order's own status, never from the request (R7). DEPARTURE (`ASSIGNED_TO_DRIVER`) → `LOADING`, returning `warehouseSummary`. LOADING (`LOADING`) records success without advancing — `confirm-loading` owns that edge — and is additionally **geofenced** against the assigned warehouse, so `driverLocation` is **required** there. `403 VEHICLE_MISMATCH` (one code for "wrong truck" AND "unknown credential", deliberately — Principle II), `403 NOT_AT_WAREHOUSE` (right truck, outside the radius; carries `distanceMeters`/`radiusMeters`), `400 LOCATION_REQUIRED` (no fix — records nothing), `409` out-of-sequence, `429` throttled. Every evaluated attempt, refused included, appends a `VehicleVerification` |
| POST | `/orders/:id/confirm-loading` | DRIVER (assigned) | **empty body — no quantity field exists anywhere in this flow** (FR-028). Requires a matched LOADING verification (`409 VEHICLE_NOT_VERIFIED`) → `IN_TRANSIT`, stamping `loadingConfirmedAt` |
| POST | `/orders/:id/override-verification` | TRANSPORT_COMPANY_ADMIN (own transporter) | `{ reason }` (required). Advances exactly the one outstanding stage and **writes no verification record** — that omission is what keeps "overridden" structurally distinct from "verified" (FR-047c/d). `404` for another carrier's order, `409` when no stage is outstanding |
| PATCH | `/orders/:id/reassign-vehicle` | TRANSPORT_COMPANY_ADMIN (own transporter) | pre-departure correction; valid only at exactly `ASSIGNED_TO_DRIVER` |

`GET /orders/:id` and `GET /orders` return `verifications[]` and `tankSummary` **only** to
DRIVER/FUEL_COMPANY_ADMIN/TRANSPORT_COMPANY_ADMIN/SUPER_ADMIN. A CLIENT gets neither, on either
route — they receive the conclusion (`vehicleVerified`) and never the evidence (FR-041/FR-042).

## Invoices (`/invoices`) — spec 004 US5, paginated in spec 005

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/invoices?method=&state=&cursor=` | FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN, CLIENT | Paginated (see Cursor pagination above). Sorted **outstanding first** (FR-048f — an old unpaid invoice must stay reachable, since it still counts against credit standing), then newest-first within each group. Scoped by the multi-party plugin: a Fuel Company sees every invoice it issued (any method); a Transportation Company sees only DEFERRED invoices routed to them; a CLIENT sees only their own (across all three methods) |
| GET | `/invoices/:id` | as above | one invoice: `{orderId, fuelCompanyId, clientId, transportCompanyId?, amount, method, state, payerRole, settledAt?, paymentReference?, priceBreakdown?}` |
| POST | `/invoices/:id/settle` | TRANSPORT_COMPANY_ADMIN (DEFERRED only), FUEL_COMPANY_ADMIN (CREDIT only) | `{ paymentReference? }` — manual settlement for the two methods the platform never confirms via a payment gateway webhook. 403 for a DIRECT invoice (settled only by the signed Sadad/Mada webhook) or the wrong role for the invoice's method. Idempotent: settling an already-SETTLED or VOIDed invoice is a no-op, never resurrected |

Every order gets exactly one invoice, issued **at routing** with the complete final price
including the delivery leg (FR-020) — the transport company that performs the haul is the one
that prices it, so no total exists before routing resolves one. DIRECT is settled by
`POST /payments/webhook/:gateway` (unchanged contract), which releases the order back to the
transporter it was already routed to; DEFERRED/CREDIT are confirmed by
`POST /orders/:id/accept` instead, with no deadline (FR-020a, FR-020b). Available credit is always derived as `creditLimit − Σ(outstanding ISSUED
credit invoices)` — never an independently mutated counter (FR-024a) — so settling or voiding a
credit invoice restores it implicitly.

`priceBreakdown` (spec 005) is the same shape as the order's, **copied at issuance** — never
re-derived from a later `pricingConfig` change. `priceBreakdown.total` always equals `amount`.
Absent on invoices issued before this feature, exactly as on orders.

## Payments (`/payments`) — spec 005, client-facing history

| Method | Path | Roles | Response |
|--------|------|-------|----------|
| GET | `/payments?cursor=` | CLIENT | Paginated (see Cursor pagination above) `PaymentRecord[]` |

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

## Files (`/files`)

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/files` | any authenticated | multipart `file` + `{ purpose }`; MIME allowlist, ≤ 10 MB; key `sys_storge/{companyId}/…` (FR-020). Request and response unchanged by spec 012 |
| GET | `/files/:id` | same-company roles per purpose; SUPER_ADMIN | **302** to a short-lived single-object location, `Cache-Control: no-store`; 404 cross-tenant |
| GET | `/files/:id/content?token=…` | **`@Public()`** — the token is the authorization | **local storage driver only**; not registered under `STORAGE_DRIVER=gcs` |

**`GET /files/:id` answers a 302, not bytes** (spec 012 FR-039/FR-042a). The tenant-scoped read runs
BEFORE anything is signed, so a signed location is never issued for a document the caller may not
see — a cross-tenant id still 404s and never 403s. The redirect target carries no credential of the
platform's, deliberately: clients differ in whether they forward `Authorization` across a redirect,
and an object store refuses a request bearing both a signed URL and that header (FR-038c).

The status is 302 under **every** driver including local. Had local returned bytes, the redirect
would first have executed in production — the production-only path this hardening work exists to
remove. `storagePath` keeps its name and type in the response; only its content changed, from an
absolute filesystem path to an object key.

## Health (`/health`) — added in spec 012

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/health/live` | **`@Public()`**, `@SkipThrottle()` | Is the process running — **no dependency checks**. Always 200 while the process is up |
| GET | `/health/ready` | **`@Public()`**, `@SkipThrottle()` | Should a proxy send traffic. **200** with both dependencies up; **503** when MongoDB is unreachable or the instance is draining |

**MongoDB is the only disqualifying dependency.** Redis is checked and reported — alongside the
`rateLimiting` and `realtimeFanout` capabilities it backs — but never changes the verdict, so a
**200 with a `down` entry in `error` is correct and deliberate**. Disqualifying on Redis would take
every instance out of rotation at the same instant and leave the proxy with an empty upstream,
converting a partial degradation into a total outage.

Liveness performs no dependency checks on purpose: a liveness probe wired to dependency health makes
an orchestrator restart instances whose own process is fine, turning a database incident into a
restart storm on top of it. Full contract: `specs/012-production-hardening/contracts/health-contract.md`.

## Notifications (`/notifications`) — paginated in spec 005

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/notifications?unread=&cursor=` | any | own notifications only. Paginated (see Cursor pagination above); response gains `unreadCount` — the count across the caller's **whole** set, not the current page, since it backs a badge |
| PATCH | `/notifications/:id/read` | any | own only |
| PATCH | `/notifications/read-all` | any | **spec 013.** Marks every unread notification read for the caller (from the token, never a body/query param). One `updateMany`, idempotent → `{ "updated": <count> }`; a second call returns `{ "updated": 0 }` |

```json
{ "items": [ /* ... */ ], "nextCursor": null, "unreadCount": 3 }
```

## Support (`/support`, spec 005 US9/FR-038/FR-039)

A problem raised from an order, routed to the client's own fuel company. Two states only —
submitted and acknowledged; no threaded reply or resolution workflow.

| Method | Path | Roles | Body | Response |
|--------|------|-------|------|----------|
| POST | `/support/requests` | CLIENT | `{ topic, message, orderId? }` | Created request (**201**) |
| GET | `/support/requests` | CLIENT | — | `{ items: SupportRequest[] }` — caller's own, newest first. Not paginated |
| GET | `/support/requests` | FUEL_COMPANY_ADMIN | — | Requests for their company |
| PATCH | `/support/requests/:id/acknowledge` | FUEL_COMPANY_ADMIN | — | Updated request |

```json
{ "_id": "66b...", "topic": "ORDER_ISSUE", "message": "...",
  "orderId": "66a...", "state": "SUBMITTED", "createdAt": "...", "acknowledgedAt": null }
```

Submission raises a `SUPPORT_REQUEST_RAISED` notification to the client's fuel company admins via
the existing notification path (FR-038b) — no second delivery mechanism. `orderId`, when given,
must belong to the caller — **404** otherwise. State moves `SUBMITTED` → `ACKNOWLEDGED` only,
never back; acknowledging an already-acknowledged request is **409**.

## Fuel company dashboard (spec 013)

Connects the FUEL_COMPANY_ADMIN's dashboard to the platform and adds the business capability four
of its screens were drawn against but which did not exist anywhere on the platform: commission and
cashback with accrual and enforcement, a settlement ledger, supplier-invoice reconciliation with
client litre balances, and inter-company fuel exchange. `FCA` = FUEL_COMPANY_ADMIN, `SA` =
SUPER_ADMIN, `CL` = CLIENT below.

**Changes to existing endpoints**: `GET /orders/summary` now also admits `FCA` (the handler takes
no user parameter — it was already correctly scoped by the multi-party plugin, so this is a
decorator change, not new logic). `GET /orders` and `GET /orders/:id` responses gain
`supplierInvoice` (present only where recorded) and `POST /orders`/`POST /orders/quote` gain
`litreDrawdown` — see Litre balances below. `GET /invoices` now also admits `SA`, and gains an
optional `?fuelCompanyId=` filter meaningful only to `SA` (the owning multi-party plugin overwrites
it for every other role, so accepting it from any caller is a safe no-op for a tenant-scoped one).
`GET /platform-account/movements` gained the identical `?companyId=` pattern. `GET /users` gained
`?companyId=`, and `GET /stations/all` (itself new — see below) gained `?companyId=`, both the same
way. **Fuel company region coverage**: `Company.servedRegions` was TRANSPORT-only; a FUEL-type
company had no field recording the regions it covers itself — `coveredRegions` and its two routes
below are a genuine platform addition, not a pattern-match with an existing mechanism.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/companies/:id/covered-regions` | FCA, SA | Same access rule as `fuel-prices`/`pricing-config` — the owning company and the operator |
| PUT | `/companies/:id/covered-regions` | FCA | Own company only |
| GET | `/companies/exchange-partners` | FCA | Every other active FUEL-type company, for the fuel-exchange recipient picker — excludes the caller's own company |
| PUT | `/companies/:id/commission-ceiling` | SA | Absent ⇒ the platform-wide default ceiling governs (FR-062b) |
| GET | `/stations/all?companyId=` | FCA, SA | Every station of the acting (or, for SA, named) fuel company across all its owners — `GET /stations` bare stays CLIENT-only; Nest cannot bind two role-gated handlers to one path |

**Credit limit requests** — a client requests a raise, their fuel company resolves it.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/users/me/credit-limit-requests` | CL | `409` while one is already `PENDING` |
| GET | `/users/me/credit-limit-requests` | CL | The owner's own history and outcomes |
| GET | `/credit-limit-requests?state=` | FCA | The administrator's queue |
| PATCH | `/credit-limit-requests/:id/resolve` | FCA | `{ accept: boolean, grantedAmount? }`. Conditional on `state: PENDING` → `409` if already resolved. Accepting writes the new limit and the resolution in one transaction |

**Supplier invoices and litre balances** — volume enters the platform from an Aramco invoice, not
from delivery; a driver enters no quantity anywhere. Extraction is a seam that can ship empty
(`extracted` may be null) — FR-073a-iii's manual entry is what makes the feature work with no
extractor at all.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/orders/:id/supplier-invoice/upload` | FCA | Multipart. Stores the document, runs extraction, returns `{ fileId, extracted, orderedQuantityLitres }`. Records nothing and moves no balance |
| POST | `/orders/:id/supplier-invoice` | FCA | `{ fileId, confirmed: {...} }`. Records the invoice and applies the balance movement in one transaction. `409` if already recorded or the order is cancelled/rejected; `400` on grade mismatch |
| PUT | `/orders/:id/supplier-invoice` | FCA | Replace: supersedes the prior invoice and restates the movement — never applies a second |
| GET | `/litre-balances?clientId=` | FCA | The owner's balances across grades |
| GET | `/users/me/litre-balances` | CL | Includes movements, each traceable to its source (an order drawdown, a reconciliation, a correction) |
| POST | `/litre-balances/:id/corrections` | FCA | `{ litres, reason }` — `reason` required, `400` without it |

A litre balance's idempotency is two writes, not one: an upsert that only ensures the document
exists, then a conditional `findOneAndUpdate` filtered on `reconciledOrderIds: { $ne: orderId }`
(a `$addToSet`-style unique index does not catch a duplicate value pushed into one document's own
array — only between separate documents).

**Commission and cashback** — effective-dated records with no update path, so a rate change never
rewrites history; the accrual it governs happens inside the existing order-approval transaction
(commission accrues at approval, not at delivery — the order-approval transaction already exists).

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/billing/commission-terms/current` | FCA, SA | Read-only for FCA |
| PUT | `/billing/commission-terms` | SA | Writes a new effective-dated record; never mutates |
| GET | `/billing/cashback-programme/current` | FCA, SA | |
| PUT | `/billing/cashback-programme` | SA | New effective-dated record |
| GET | `/billing/balances/me` | FCA | Accrued commission, accrued cashback, ceiling, and the 90% warning state |
| GET | `/billing/balances/:companyId` | SA | The operator's per-company drill-down onto the same figures |

Deferred dealing is refused once accrued commission exceeds the ceiling, with a typed error code
naming the ceiling; it resumes automatically once a **confirmed** payment brings it back below —
no operator action required.

**Platform account** — a settlement ledger between a fuel company and the platform. No payment
provider is integrated: the platform displays details to pay elsewhere and records what the payer
reports; it never initiates, takes or receives a payment.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/platform-account/movements?companyId=` | FCA, SA | Cursor-paginated |
| POST | `/platform-account/payments` | FCA | `{ amount, method, reference?, documentFileId? }`. Full or partial. `400` without evidence. Created as `RECORDED` — the balance does not move |
| PATCH | `/platform-account/payments/:id/confirm` | SA | Conditional on `state: RECORDED` — the operator confirms by hand, never automatically |

**Fuel exchange** — the one record type owned by two fuel companies at once, scoped by a third
isolation mechanism (`party-set-scope.plugin.ts`) rather than the tenant or multi-party plugins,
neither of which can express membership in an array. `SA` still bypasses every isolation plugin,
including this one — the operator's own exchange screen renders correctly even when the mechanism
is broken and must never be used as evidence that it works.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/fuel-exchange/requests?direction=incoming\|outgoing\|all` | FCA, SA | `direction` is derived from `raisedByCompanyId` against the viewer, never stored per-viewer |
| POST | `/fuel-exchange/requests` | FCA | `400` if the recipient does not sell the grade, or on invalid quantity/price |
| GET | `/fuel-exchange/requests/:id` | FCA, SA | Includes the counterparty's contact details — only to the two parties |
| PATCH | `/fuel-exchange/requests/:id/respond` | FCA | Recipient only. `{ accept: boolean }`. Conditional on `AWAITING_RESPONSE` → `409` |
| PATCH | `/fuel-exchange/requests/:id/withdraw` | FCA | Raiser only. Same conditional |

Accepting creates no order, delivery or invoice — a fuel exchange settles outside the platform.

**Operator oversight** — almost entirely dashboard work over endpoints that already exist, plus the
`SA`/`?companyId=` additions folded into the sections above: `GET /companies?type=FUEL`,
`POST /companies`, `PATCH /companies/:id/status` were all pre-existing. Controls reserved to the
operator (commission/cashback writes, ceiling, payment confirmation, company status) are **absent**,
not merely disabled, from a `FUEL_COMPANY_ADMIN`'s render of any screen shared with the operator.

## Platform operator dashboard (spec 017)

Five new routes and four changed ones. **No migration**: this feature rewrites nothing and adds no
field to any existing document.

The operator's platform-wide reach on every route below is the **existing** `SUPER_ADMIN` bypass in
both scoping plugins — verified to cover queries, `save`, `insertMany` **and** `aggregate`. No
`runUnscoped`, no second connection, and neither plugin was modified (research R1).

### New

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/platform/overview?from=&to=` | SUPER_ADMIN | The operator's home screen in one response: `period`, `pointInTime` and `breakdown`. **The three period figures do NOT share one basis** (FR-001a): `orderCount` counts orders RAISED in the period (`createdAt`, every state) while `orderValue`/`litresMoved` count DELIVERED orders only (`deliveredAt`) — a delivered-only count would BE the `COMPLETED` bucket and force the other five to zero. `period.basis` states which is which. `pointInTime` is NOT period-bounded. Every numeric field is present and `0` on an empty period, never null. **No trend field at any nesting level** (FR-009) |
| GET | `/platform/transport-company-volumes?companyIds=&from=&to=` | SUPER_ADMIN | Order volume for a whole PAGE of transporters in **one** aggregate (FR-026a/FR-026b), never one query per row. A transporter never routed to reports `orderCount: 0`, not omitted. Period resolves identically to `/platform/overview` |
| GET | `/drivers/roster?isActive=&dutyState=&cursor=` | SUPER_ADMIN | Every driver, their employer, their last operated truck and a three-valued `dutyState`. Sorted `createdAt`/`_id` — fields every driver has — so a never-connected driver cannot be silently dropped (FR-040). `lastOperatedTruck: null` means **never driven** (FR-039b) and is derived from order history in one aggregate projecting `truckId` alone. **Carries no location, trip count, delivery date or order reference of any kind** (FR-043/FR-044, asserted against the serialized body) |
| GET | `/auth/me/account` | SUPER_ADMIN | The operator's own name, email, real sign-in number, `activeSessionCount` and `lastSignInAt`. The last is read from the append-only `SessionEvent` log, not `User.activeSessions`, which empties on sign-out. **No permission list and no account statistic** — the platform records neither (FR-063) |
| POST | `/announcements` | SUPER_ADMIN | **202**, not 201 — the fan-out is enqueued, not performed (FR-055). `{ title, body, targetCompanyIds }`; an **empty** `targetCompanyIds` means every active company (FR-049). Returns `{ announcementId, intendedRecipientCount, state: QUEUED }` |
| GET | `/announcements?cursor=` | SUPER_ADMIN | What was sent, newest first (FR-052) |
| GET | `/announcements/:id` | SUPER_ADMIN | The announcement, its tallies, and the failed deliveries with a **named** `failureReason` each (FR-054) |
| GET | `/platform-account/cashback/:companyId/owed` | SUPER_ADMIN | `{ companyId, owed, currency }` — computed live as confirmed `CASHBACK_CREDITED` minus confirmed `CASHBACK_PAID_OUT`. A **two-kind** derivation: the existing per-kind balance cannot answer this, and reusing it would leave the figure unchanged after every payout (research R11) |
| POST | `/platform-account/cashback/:companyId/payouts` | SUPER_ADMIN | multipart: `amount`, `method`, a **required** `reference`, optional `evidence` file. **One transaction that re-reads the owed balance inside the session** (FR-069). Created already `CONFIRMED` — there is no second party to confirm the operator's own assertion. `409` over balance (nothing recorded) and `409` on a duplicate reference, the latter from a partial unique index, never a prior read (FR-070). **No payment provider is integrated** (FR-073) |

### Changed

| Route | Change |
|-------|--------|
| `GET /companies` | now binds `type` and `status` — see the Companies section |
| `GET /orders` | now binds `bucket` and `orderId` — see the Orders section |
| `GET /orders/summary` | `SUPER_ADMIN` receives a **third shape**, `PlatformSummaryDto` (`{ from, to, buckets, total }`, six buckets, `total` equal to their sum). It previously fell through to the TRANSPORT company's shape — `awaitingAssignment`/`driversOnDuty` computed platform-wide, answering a transporter's questions (research R5). The `FUEL_COMPANY_ADMIN` and `TRANSPORT_COMPANY_ADMIN` responses are byte-for-byte unchanged |
| `PATCH /orders/:id/force-complete` | roles `FUEL_COMPANY_ADMIN` → `FUEL_COMPANY_ADMIN, SUPER_ADMIN` (FR-020). Permitted stages unchanged (`LOADING`, `IN_TRANSIT`, `UNLOADING`) but now read from `FORCE_COMPLETABLE_STATUSES` by both the check and the refusal message, which were previously two independent statements of the same list |
| `GET /platform-account/movements` | every movement gains a derived `direction` (`INBOUND`/`OUTBOUND`). **Response-only, computed from `kind` at serialisation** — no schema field, no migration, no existing field changed (FR-064) |
| `POST /users/me/phone/verification` | the duplicate-holder pre-check now uses a role- and active-agnostic lookup. It previously called a `CLIENT`/`DRIVER`-scoped one, so changing onto another ADMINISTRATOR's number passed the check, **spent an SMS**, and was refused only at confirm by the unique index spec 015 extended to all five roles (FR-061, research R10). Route, throttle, `202` shape and confirm step are unchanged |

### Error codes introduced (spec 017)

| Code | Status | Meaning |
|------|--------|---------|
| `ORDER_BUCKET_STATUS_CONFLICT` | 400 | `status` and `bucket` were both supplied and the status is not a member of that bucket |
| `INVALID_PARENT_FUEL_COMPANY` | 400 | `parentFuelCompanyId` is absent, malformed, names no company, or names one that is not of type `FUEL` |
| `CASHBACK_PAYOUT_EXCEEDS_BALANCE` | 409 | The payout exceeds the owed balance **re-read inside the recording transaction** — not the figure the operator's screen was showing |
| `CASHBACK_PAYOUT_DUPLICATE_REFERENCE` | 409 | A payout with this reference is already recorded for this company; translated from the partial unique index |

## Status codes summary

- `400` validation failure (class-validator details array); a CREDIT order exceeding available credit; an invalid routing/region choice; a malformed pagination cursor
- `401` missing/invalid/expired JWT; suspended company; wrong or expired phone-verification code
- `403` role not permitted for route (same tenant); wrong payer attempting to settle an invoice
- `404` not found OR cross-tenant/cross-role-scope (indistinguishable by design, FR-002) — covers the multi-party plugin's orders/invoices scoping and the single-tenant plugins' stations/support scoping alike
- `409` invalid state transition; driver already booked; `phone`/`email` already registered; `/orders/:id/route` on a non-`AWAITING_ROUTING` order; stale/expired quote; no pricing configured; a phone already in use; a client's last active station; re-acknowledging a support request
- `422` wrong OTP (delivery flow)
- `429` throttled — phone verification and delivery-OTP verification both carry `retryAfterSeconds` in the body
- `502` the SMS provider rejected a verification code send

## Error codes introduced (spec 005)

| Code | Status | Meaning |
|---|---|---|
| `PRICING_NOT_CONFIGURED` | 409 | Fuel company has no `pricingConfig` |
| `QUOTE_STALE` | 409 | Pricing inputs changed; body carries the new breakdown |
| `QUOTE_EXPIRED` | 409 | Quote token past expiry |
| `PHONE_IN_USE` | 409 | Target number belongs to another account |
| `SMS_SEND_FAILED` | 502 | Provider rejected the send |
| `LAST_STATION` | 409 | Cannot remove a client's only active station |

All are named constants (Principle I), never inline strings.

## Error codes introduced (spec 013)

| Code | Status | Meaning |
|---|---|---|
| `LIMIT_REQUEST_ALREADY_RESOLVED` | 409 | A credit-limit request's resolution attempted after it already carries an outcome |
| `COMMISSION_CEILING_EXCEEDED` | 409 | Deferred dealing refused — accrued commission exceeds the ceiling. Carries `ceiling`/`accrued`; never latched, resumes once a confirmed payment clears it |
| `PAYMENT_EVIDENCE_REQUIRED` | 400 | A recorded payment carries neither `documentFileId` nor `reference` |
| `PAYMENT_ALREADY_CONFIRMED` | 409 | The operator confirms a payment that is not `RECORDED` |
| `SUPPLIER_INVOICE_ALREADY_RECORDED` | 409 | An order already carries a supplier invoice — `POST` refuses; `PUT` is the replace path |
| `SUPPLIER_INVOICE_GRADE_MISMATCH` | 400 | A confirmed supplier-invoice fuel grade differs from the order's own |
| `SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE` | 409 | Uploaded or recorded against a `CANCELLED`/`REJECTED` order |
| `BALANCE_CORRECTION_REASON_REQUIRED` | 400 | A litre-balance correction submitted with no `reason` |
| `LITRE_BALANCE_WOULD_GO_NEGATIVE` | — | Advisory, not a refusal — a supplier-invoice excess would take a balance below zero; the movement is still recorded |
| `EXCHANGE_ALREADY_RESOLVED` | 409 | An exchange request's respond/withdraw attempted after it already reached a final outcome |
| `EXCHANGE_GRADE_NOT_SOLD` | 400 | An exchange request named a grade the recipient company does not sell |
| `EXCHANGE_PARTY_INVALID` | — | The party-set plugin's create-time guard: the acting company is absent from `partyCompanyIds`, or the array does not hold exactly the parties the domain defines |

All are named constants (Principle I), never inline strings.
