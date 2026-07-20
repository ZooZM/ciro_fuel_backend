# Data Model: Multi-Tenant B2B Fuel Delivery Logistics Platform

**Date**: 2026-07-19 | **Plan**: [plan.md](./plan.md) | **Storage**: MongoDB 7 (replica set), Mongoose 8

All ObjectIds are Mongoose `Types.ObjectId`. Collections marked **[tenant-scoped]** carry `companyId` and are governed by the global tenant plugin (R1). Timestamps (`createdAt`/`updatedAt`) enabled on every schema.

## companies

| Field | Type | Rules |
|-------|------|-------|
| `_id` | ObjectId | |
| `name` | string | required, unique, 2–120 chars |
| `commercialRegisterFileId` | ObjectId → files | required at registration (FR-018) |
| `status` | enum `ACTIVE \| SUSPENDED` | default ACTIVE; SUSPENDED blocks all company users' login (assumption) |
| `fuelPrices` | `[{ fuelType: enum, basePricePerLiter: number }]` | admin-maintained (FR-008a); basePricePerLiter > 0 |
| `contactEmail`, `contactPhone` | string | required |

Indexes: `{name: 1}` unique.
Note: NOT tenant-plugin-scoped (it *is* the tenant); readable by SUPER_ADMIN globally, by own COMPANY_ADMIN via explicit `_id` check.

## users **[tenant-scoped]** (except SUPER_ADMIN docs)

Single collection, discriminated by `role`.

| Field | Type | Rules |
|-------|------|-------|
| `_id` | ObjectId | |
| `companyId` | ObjectId → companies | required for all roles except SUPER_ADMIN (FR-001) |
| `role` | enum `SUPER_ADMIN \| COMPANY_ADMIN \| CLIENT \| DRIVER` | required, immutable after creation |
| `email` | string | required, unique, lowercase |
| `passwordHash` | string | bcrypt, `select: false` |
| `fullName` | string | required |
| `phone` | string | required |
| `profilePictureFileId` | ObjectId → files | optional |
| `isActive` | boolean | default true; false blocks login + dispatch eligibility (FR-019) |
| **CLIENT only** `stationLocation` | GeoJSON Point | required for CLIENT (delivery default) |
| **DRIVER only** `isAvailable` | boolean | default true; false while on an active delivery |
| **DRIVER only** `isOnline` | boolean | default false; set true on any driver signal, false by 60 s presence sweep when `lastSeenAt` > 6 min old (FR-024, R6a) |
| **DRIVER only** `lastSeenAt` | Date | refreshed on every socket handshake / location frame / heartbeat |
| **DRIVER only** `activeOrderId` | ObjectId → orders | set iff on a job; **partial unique index** (R4 backstop) |
| **DRIVER only** `location` | GeoJSON Point | last reported position |
| **DRIVER only** `locationUpdatedAt` | Date | staleness display (edge case) |
| **DRIVER only** `truck` | embedded Truck subdoc | **denormalized truck capabilities** — single-query `$near` dispatch, no `$lookup` (R8); rewritten whenever the truck is assigned/edited |

Embedded **Truck** subdocument: `{ plateNumber: string (required), maxCapacityLiters: number > 0 (required, FR-011), fuelTypes: FuelType[] (required, non-empty — dispatch matches order.fuelType, FR-011), model?: string }`.

Indexes: `{email: 1}` unique; `{companyId: 1, role: 1}`; `{location: '2dsphere'}`; `{activeOrderId: 1}` unique partial (`activeOrderId exists`); `{companyId: 1, role: 1, isActive: 1, isOnline: 1, isAvailable: 1}` (dispatch candidates); `{role: 1, isOnline: 1, lastSeenAt: 1}` (presence sweep).

## orders **[tenant-scoped]**

| Field | Type | Rules |
|-------|------|-------|
| `_id` | ObjectId | |
| `companyId` | ObjectId | required (FR-001) |
| `clientId` | ObjectId → users(CLIENT) | required, immutable |
| `fuelType` | enum (per company price list) | required (FR-007) |
| `quantityLiters` | number | required, > 0 |
| `deliveryLocation` | GeoJSON Point | required; defaults to client's stationLocation |
| `status` | enum — see State Machine | default `PENDING_APPROVAL` |
| `estimatedPrice` | number | system-computed at creation: basePricePerLiter × quantity (FR-008a) |
| `finalPrice` | number | set at approval (defaults to estimatedPrice) (FR-008b); immutable after approval |
| `approvedBy` | ObjectId → users(COMPANY_ADMIN) | set on approval (FR-010) |
| `driverId` | ObjectId → users(DRIVER) | set on assignment |
| `paymentDeadline` | Date | set on entering PENDING_PAYMENT = now + 30 min (FR-015a) |
| `paymentTimeoutCount` | number | default 0; incremented per expired deadline; ≥ 2 ⇒ redispatch is admin-only (FR-015a) |
| `paymentConfirmationId` | ObjectId → payment_events | set on successful payment (FR-014) |
| `statusHistory` | `[{ from, to, actorId, actorRole, at, manualOverride?: boolean, overrideReason?: string }]` | append-only, every transition (FR-010); `manualOverride: true` + required reason on admin force-complete (FR-025) |
| `otps` | `[OtpRecord]` | see below (FR-021–023) |
| `cancelledBy` / `rejectedBy` | ObjectId + reason string | terminal-state audit |

Embedded **OtpRecord**: `{ purpose: 'ARRIVAL' | 'DELIVERY', hash: string, salt: string, expiresAt: Date (+30 min), usedAt?: Date, attempts: number (max 5), createdAt }`. Plaintext never stored (R7). At most one active (unused, unexpired) record per purpose.

Indexes: `{companyId: 1, status: 1}`; `{clientId: 1, createdAt: -1}`; `{driverId: 1, status: 1}`; `{status: 1, paymentDeadline: 1}` (reconciliation safety net behind the BullMQ timeout jobs); `{deliveryLocation: '2dsphere'}`.

### Order State Machine (FR-006)

```
PENDING_APPROVAL ──approve(admin, sets finalPrice)──▶ APPROVED
PENDING_APPROVAL ──reject(admin)────────────────────▶ REJECTED   (terminal)
PENDING_APPROVAL ──cancel(client)───────────────────▶ CANCELLED  (terminal)
APPROVED ──dispatch(system, txn)────────────────────▶ ASSIGNED_TO_DRIVER
APPROVED ──cancel(client or admin)──────────────────▶ CANCELLED  (terminal; client allowed pre-assignment, FR-009)
ASSIGNED_TO_DRIVER ──payment requested(system)──────▶ PENDING_PAYMENT   (stamps paymentDeadline)
ASSIGNED_TO_DRIVER / PENDING_PAYMENT ──cancel(admin)▶ CANCELLED  (terminal, releases driver, txn)
PENDING_PAYMENT ──decline final price(client, txn)──▶ CANCELLED  (terminal, releases driver, removes timeout job, FR-009)
PENDING_PAYMENT ──webhook confirmed(system, txn)────▶ IN_TRANSIT
PENDING_PAYMENT ──deadline expired(system, txn)─────▶ APPROVED   (releases driver; re-dispatch manual; after 2
                                                       consecutive timeouts admin-only, FR-015a)
IN_TRANSIT ──verify ARRIVAL OTP(driver)─────────────▶ UNLOADING  (FR-021)
UNLOADING ──verify DELIVERY OTP(driver, txn)────────▶ DELIVERED  (terminal, releases driver, FR-022)
IN_TRANSIT / UNLOADING ──force-complete(admin, txn)─▶ DELIVERED  (terminal, releases driver, invalidates
                                                       active OTPs, statusHistory flagged
                                                       {manualOverride: true, reason}, FR-025)
```

Any edge not listed ⇒ rejected with 409 (FR-006). Actor column enforced by `RolesGuard` + ownership checks. Transitions marked *txn* run in `ClientSession` transactions (driver + order mutated together).

## payment_events

> Realizes the spec's **"Payment Confirmation"** entity: a `payment_events` record with `outcome: CONFIRMED` is the payment confirmation an order links via `paymentConfirmationId`; other outcomes are the audit trail.

| Field | Type | Rules |
|-------|------|-------|
| `gatewayTransactionId` | string | required, **unique** — idempotency key (FR-015, R5) |
| `gateway` | enum `SADAD \| MADA` | required |
| `orderId` | ObjectId → orders | required |
| `companyId` | ObjectId | denormalized for tenant reads |
| `amount`, `currency` | number, `SAR` | must equal order.finalPrice for CONFIRMED outcome |
| `outcome` | enum `CONFIRMED \| DUPLICATE \| OUT_OF_SEQUENCE \| AMOUNT_MISMATCH \| INVALID_SIGNATURE` | audit trail (FR-015/edge cases) |
| `rawPayload` | object | stored for reconciliation |

Indexes: `{gatewayTransactionId: 1}` unique; `{orderId: 1}`.
Note: written by the `@Public()` webhook path (no tenant context) — schema opts OUT of tenant plugin writes, reads remain tenant-filtered.

## files **[tenant-scoped]**

| Field | Type | Rules |
|-------|------|-------|
| `companyId` | ObjectId | required |
| `ownerUserId` | ObjectId → users | uploader |
| `purpose` | enum `COMMERCIAL_REGISTER \| PROFILE_PICTURE` | drives validation rules |
| `storagePath` | string | always `sys_storge/{companyId}/{uuid}{ext}` — server-generated, never from input (R10) |
| `mimeType` | string | allowlist: jpeg/png/webp/pdf (FR-020) |
| `sizeBytes` | number | ≤ 10 MB (assumption) |
| `originalName` | string | display only, sanitized |

Indexes: `{companyId: 1, purpose: 1}`.

## notifications **[tenant-scoped]**

| Field | Type | Rules |
|-------|------|-------|
| `companyId` | ObjectId | required |
| `recipientUserId` | ObjectId → users | required |
| `type` | enum `ORDER_APPROVED_FINAL_PRICE \| NO_DRIVER_AVAILABLE \| PAYMENT_TIMEOUT \| ORDER_ASSIGNED \| ORDER_STATUS_CHANGED \| OTP_ISSUED` | per FR-008b/013/015a |
| `orderId` | ObjectId → orders | optional |
| `payload` | object | type-specific data (e.g., finalPrice) |
| `readAt` | Date | null = unread |

Indexes: `{recipientUserId: 1, readAt: 1, createdAt: -1}`.

## Relationships summary

```
Company 1 ──▶ N User (all roles but SUPER_ADMIN)
Company 1 ──▶ N Order / File / Notification / PaymentEvent
User(CLIENT) 1 ──▶ N Order (clientId)
User(DRIVER) 1 ──▶ 0..1 active Order (activeOrderId, unique partial)  /  1 embedded Truck
Order 1 ──▶ 0..1 PaymentEvent(CONFIRMED)  /  0..2 active OtpRecords (embedded)
```

## Cross-cutting validation rules

- Every tenant-scoped write MUST receive `companyId` from `TenantContextService`, never from request body (DTOs strip/forbid `companyId`).
- `quantityLiters` and `fuelType` validated against the denormalized truck capabilities again at dispatch time (data may have changed since approval); truck edits rewrite the embedded subdoc atomically on the driver document.
- `PENDING_PAYMENT` entry enqueues a BullMQ `payment-timeout` job (`jobId = orderId`, delay 30 min); payment success or cancellation removes the job (R6).
- DTO validation via class-validator with `whitelist: true, forbidNonWhitelisted: true` global pipe.
- Driver-facing Order response DTO excludes `otps` entirely (FR-023); client-facing DTO exposes only the active plaintext OTP via the dedicated endpoint, never persisted.
