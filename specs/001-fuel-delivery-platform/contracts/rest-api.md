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
| POST | `/auth/refresh` **[public]** | — | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| GET | `/auth/me` | any | — | current user profile, including `station`/`creditLimit` for a CLIENT (`undefined` for every other role) |

`401` on bad credentials or suspended company / deactivated account (same message — no enumeration).

Phone is the login identifier for CLIENT/DRIVER (E.164, unique platform-wide) and is never
resolved for admin roles, so an admin placeholder phone can never authenticate. `phone` takes
precedence when both identifiers are supplied.

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
| GET | `/companies` | SUPER_ADMIN, FUEL_COMPANY_ADMIN | CIRO sees every company; a `FUEL_COMPANY_ADMIN` sees only their own (spec 004 US1) — not paginated |
| GET | `/companies/:id` | SUPER_ADMIN, own FUEL_COMPANY_ADMIN (also its own transporters) | |
| PATCH | `/companies/:id/status` | SUPER_ADMIN | `{ status: ACTIVE\|SUSPENDED }` |
| GET | `/companies/:id/fuel-prices` | own FUEL_COMPANY_ADMIN, own CLIENT | price list for estimates |
| PUT | `/companies/:id/fuel-prices` | own FUEL_COMPANY_ADMIN | `[{ fuelType, basePricePerLiter }]` (FR-008a) |
| GET | `/companies/:id/pricing-config` | own FUEL_COMPANY_ADMIN, own CLIENT | `PricingConfig` — spec 005, see below |
| PUT | `/companies/:id/pricing-config` | own FUEL_COMPANY_ADMIN | `SetPricingConfigDto` → updated `PricingConfig` — spec 005 |
| POST | `/companies/:id/transporters` | own FUEL_COMPANY_ADMIN | `{ name, contactEmail, contactPhone, adminEmail, adminFullName, adminPhone, adminPassword }` → creates a `type: TRANSPORT` company under `:id` plus its `TRANSPORT_COMPANY_ADMIN`, `201 { company, admin }` (spec 004 US2) |
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
| GET | `/orders?status=&cursor=` | any (scoped by the multi-party plugin: CLIENT→own, DRIVER→assigned, FUEL_COMPANY_ADMIN→own fuel company, TRANSPORT_COMPANY_ADMIN→own routed orders, SUPER_ADMIN→all) | Paginated (see Cursor pagination above), ordered `statusChangedAt` desc. Each item includes `etaMinutes` (FR-029, `null` until a driver is assigned and has a position on file) |
| GET | `/orders/:id` | as above | includes `statusHistory`, `driverSummary` (FR-028, absent pre-assignment), `etaMinutes`, `deliveryAddressText`, `priceBreakdown` and `station` (spec 005); driver DTO **never** includes `otps` |
| PATCH | `/orders/:id/approve` | FUEL_COMPANY_ADMIN | `{ finalPrice?, transportCompanyId? }` — omitted `finalPrice` ⇒ `finalPrice = estimatedPrice`. Issues the order's invoice using `finalPrice` (FR-020) — a CREDIT order over the client's available credit is refused (400, no invoice issued, FR-025). Then: a **DIRECT** order → `PENDING_PAYMENT` (routing deferred until settlement, FR-020a); **DEFERRED/CREDIT** route immediately — exactly one serving Transportation Company → `ROUTED_TO_TRANSPORT`; none → `AWAITING_ROUTING` + Fuel Company notified (FR-016); several → `AWAITING_ROUTING` with `routingCandidates` in the response unless `transportCompanyId` was supplied, which routes immediately to that choice (FR-014) |
| PATCH | `/orders/:id/route` | FUEL_COMPANY_ADMIN | `{ transportCompanyId }` — resolves an `AWAITING_ROUTING` order manually (FR-014's Fuel-Company choice, or FR-016's later resolution once a transporter gains region coverage); 409 if the order isn't `AWAITING_ROUTING`; 400 if the choice doesn't actually serve the region |
| PATCH | `/orders/:id/reject` | FUEL_COMPANY_ADMIN | `{ reason }` → `REJECTED` |
| PATCH | `/orders/:id/cancel` | CLIENT (pre-assignment, or declining the Final Price while `PENDING_PAYMENT`), FUEL_COMPANY_ADMIN (until `IN_TRANSIT`) | → `CANCELLED`; transactionally releases the driver (if assigned) and voids the order's invoice if one was issued (a voided CREDIT invoice implicitly restores the client's available credit, FR-024/FR-027) |
| POST | `/orders/:id/redispatch` | FUEL_COMPANY_ADMIN, CLIENT (CLIENT blocked once `paymentTimeoutCount ≥ 2` — admin-only thereafter, FR-015a) | only from `APPROVED` (reached only via a DIRECT payment timeout — DEFERRED/CREDIT never expire, FR-020b) — re-opens a fresh payment window; routing itself resumes once that window is paid, exactly like the original approval |
| GET | `/orders/:id/otp/current` | CLIENT (order owner) | `{ purpose, otp, expiresAt }` — the ONLY place plaintext OTP appears (FR-021/022) |
| POST | `/orders/:id/arrive` | DRIVER (assigned) | order must be `IN_TRANSIT`; generates ARRIVAL OTP — idempotent while an unused, unexpired OTP exists; if the active OTP has EXPIRED, issues a fresh record with attempts reset (same rule for `request-delivery-otp`); response contains NO otp |
| POST | `/orders/:id/verify-arrival` (5/15min) | DRIVER (assigned) | `{ otp }` → on match: `UNLOADING`; 422 wrong otp; 429 throttled (FR-021/023) |
| POST | `/orders/:id/request-delivery-otp` | DRIVER (assigned) | order must be `UNLOADING`; generates DELIVERY OTP; response contains NO otp |
| POST | `/orders/:id/verify-delivery` (5/15min) | DRIVER (assigned) | `{ otp }` → on match (txn): `DELIVERED`, driver released (FR-022) |
| PATCH | `/orders/:id/force-complete` | FUEL_COMPANY_ADMIN | `{ reason }` (required, 5–500 chars); order must be `IN_TRANSIT` or `UNLOADING` → (txn) `DELIVERED`, driver released, active OTPs invalidated, statusHistory entry stamped `{manualOverride: true, overrideReason}` (FR-025). 409 from any other state; DRIVER/CLIENT ⇒ 403 |

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

Every order gets exactly one invoice, issued at approval with the final price (FR-020). DIRECT
is settled by `POST /payments/webhook/:gateway` (unchanged contract, now also resuming routing
on success — FR-020a). Available credit is always derived as `creditLimit − Σ(outstanding ISSUED
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
| POST | `/files` | any authenticated | multipart `file` + `{ purpose }`; MIME allowlist, ≤ 10 MB; stored under `sys_storge/{companyId}/` (FR-020) |
| GET | `/files/:id` | same-company roles per purpose; SUPER_ADMIN | streams file; 404 cross-tenant |

## Notifications (`/notifications`) — paginated in spec 005

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/notifications?unread=&cursor=` | any | own notifications only. Paginated (see Cursor pagination above); response gains `unreadCount` — the count across the caller's **whole** set, not the current page, since it backs a badge |
| PATCH | `/notifications/:id/read` | any | own only |

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
