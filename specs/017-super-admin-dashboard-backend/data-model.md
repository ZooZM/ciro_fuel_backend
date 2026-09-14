# Data Model: Platform Operator (Super Admin) Dashboard — Backend Integration

**Feature**: `017-super-admin-dashboard-backend` | **Date**: 2026-09-12 | **Phase**: 1

This feature is overwhelmingly **read-side**. Six of the eight stories add no persisted state at
all — they compute, filter or expose facts the platform already stores. Two collections are new
(`Announcement`, `AnnouncementDelivery`), one enum gains a member, and one existing collection gains
an index. Nothing is migrated and nothing is dropped.

**Legend**: NEW = created by this feature · CHANGED = existing, modified here · READ = existing,
consumed unchanged.

---

## 1. Derived, never stored

These are the feature's main output. Each is computed per request; none has a collection, a
document, or a cached value that could drift from its source.

### 1.1 Platform Overview (READ-derived) — Story 1

| Field | Type | Source | Period-bounded |
|---|---|---|---|
| `period.from` / `period.to` | `Date` | resolved from the query, echoed back (FR-004) | — |
| `period.isDefault` | `boolean` | `true` when neither bound was supplied (FR-005) | — |
| `period.orderCount` | `number` | `Order.countDocuments` over **every state**, bounded by `createdAt` | yes — raised |
| `period.orderValue` | `number` | `$sum: '$finalPrice'` over **DELIVERED** orders, bounded by `deliveredAt` | yes — delivered |
| `period.litresMoved` | `number` | `$sum: '$quantityLiters'` over the same delivered set | yes — delivered |
| `period.basis` | `Record<string, PeriodFigureBasis>` | which basis each figure above uses (FR-001a) | — |
| `pointInTime.fuelCompanies` | `number` | `Company.countDocuments({ type: FUEL })` | no |
| `pointInTime.transportCompanies` | `number` | `Company.countDocuments({ type: TRANSPORT })` | no |
| `pointInTime.stations` | `number` | `Station.countDocuments({})` | no |
| `breakdown.byCompanyType[]` | `{ type, count }` | the two counts above | no |
| `breakdown.byOrderBucket[]` | `{ bucket, count }` | §2.1's mapping over `Order` | yes |

**Invariants**

- `breakdown.byCompanyType` sums to `fuelCompanies + transportCompanies` (FR-006).
- `breakdown.byOrderBucket` sums to `period.orderCount` exactly, with every state in exactly one
  bucket (FR-006, FR-023d). **This is why `orderCount` cannot be delivered-only**: restricted to
  delivered orders it would equal the `COMPLETED` bucket and force the other five to zero, making the
  six-segment chart meaningless and FR-006 unsatisfiable. The two share one basis by construction —
  both are computed from the same `createdAt`-bounded match.
- Every numeric field is present and `0` on an empty period — **never absent, never `null`**
  (FR-008). Absence is reserved for "the platform does not compute this", which is why there is no
  trend field of any kind (FR-009, research R6).
- The two `period` money/volume figures count **`DELIVERED` orders only**, bounded by `deliveredAt`
  — not `createdAt`, not `updatedAt` (research R6). The order count is bounded by `createdAt` across
  every state. The two bases are different on purpose and the response states both (FR-001a).

**Why derived**: a stored daily rollup would be a second figure that could disagree with the orders
it summarises, and the operator's whole purpose is reconciling against the underlying records
(SC-001).

### 1.2 Driver Roster Entry (READ-derived) — Story 5

| Field | Type | Source |
|---|---|---|
| `driverId` | `ObjectId` | `User._id` |
| `fullName`, `phone` | `string` | `User` |
| `isActive` | `boolean` | `User.isActive` |
| `dutyState` | `ON_DUTY \| OFF_DUTY \| UNKNOWN` | `User.isOnline`; **`UNKNOWN` when the field is absent** (FR-040) |
| `transportCompany` | `{ id, name } \| null` | `Company` via `User.companyId` |
| `lastOperatedTruck` | `{ id, plateNumber } \| null` | research R8's aggregate; `null` means never driven (FR-039b) |

**The forbidden fields are forbidden by shape, not by discipline** (FR-043, FR-044, SC-014). This
entry carries no `location`, no `lastSeenAt`, no `lastMovedAt`, no trip count, no delivery dates, no
stop history. The truck derivation reads `Order` and projects **`truckId` alone** — the pipeline's
sort key (`createdAt`) never reaches the projection stage's output, so there is no field on this
shape through which a delivery fact could travel (FR-044a).

`dutyState` is a three-valued enum precisely because a never-connected driver must be *listed with
an unknown state* rather than omitted or shown as off-duty. Collapsing it to a boolean is how
feature 010's dispatch listing silently dropped exactly these drivers.

### 1.3 Cashback Owed (READ-derived) — Story 8

```
owed(company) = Σ amount[CASHBACK_CREDITED, CONFIRMED, not reversed]
              − Σ amount[CASHBACK_PAID_OUT,  CONFIRMED, not reversed]
```

Never stored (FR-065, and consistent with feature 013's FR-068/SC-012, which forbids a stored
running total anywhere in this ledger). Computed **inside the payout transaction** so FR-069 holds —
the figure the operator's screen displayed has no authority.

### 1.4 Operator Account View (READ-derived) — Story 7

| Field | Source |
|---|---|
| `fullName`, `email`, `phone` | `User` |
| `activeSessionCount` | `User.activeSessions.length` |
| `lastSignInAt` | most recent `SessionEvent` with `type: SIGNED_IN` for this `userId` |

No new field on `User`. `lastSignInAt` deliberately comes from the append-only, TTL-free audit log
rather than `max(activeSessions[].createdAt)`, so it stays correct after a sign-out empties the
array (research R10).

---

## 2. Named values (NEW enums / constants)

### 2.1 `OrderStatusBucket` (NEW) — Story 1, Story 3

```ts
export enum OrderStatusBucket {
  NEW             = 'NEW',
  IN_PROGRESS     = 'IN_PROGRESS',
  COMPLETED       = 'COMPLETED',
  REJECTED        = 'REJECTED',
  CANCELLED       = 'CANCELLED',
  NEEDS_ATTENTION = 'NEEDS_ATTENTION',
}

export const ORDER_STATUS_BUCKETS: Readonly<Record<OrderStatusBucket, readonly OrderStatus[]>>;
```

The mapping is research R3's table. It is the **single** source for the summary counts (FR-023) and
the list filter (FR-016), which is what makes it impossible for the dashboard's two screens to
disagree about what "in progress" means.

**Exhaustiveness is a tested invariant, not a convention** (FR-023d). One unit test asserts that the
union of the six bucket arrays equals `Object.values(OrderStatus)` exactly — same length, no
duplicates. A thirteenth state added later fails that test rather than silently becoming
unreachable from every bucket.

### 2.2 `FORCE_COMPLETABLE_STATUSES` (NEW constant) — Story 3

`[LOADING, IN_TRANSIT, UNLOADING]`, lifted out of `OrdersController.forceComplete`'s inline
three-way comparison, which currently repeats the list a fourth time inside its own error message
(Constitution I; research R7).

### 2.3 `AccountMovementKind.CASHBACK_PAID_OUT` (CHANGED enum) — Story 8

Added to the existing three. Money the platform paid **to** a company. Distinct from
`PAYMENT_RECORDED` (money a company paid the platform), which is what makes Story 8's scenario 6
satisfiable — the two are never indistinguishable (FR-064).

### 2.4 `AccountMovementDirection` (NEW enum, response-only) — Story 8

```ts
export enum AccountMovementDirection { INBOUND = 'INBOUND', OUTBOUND = 'OUTBOUND' }
```

`INBOUND` = the platform received; `OUTBOUND` = the platform paid. Derived from `kind` at
serialisation. **Deliberately not a schema field** — adding one would require migrating every
existing `AccountMovement` row and would change a payload feature 013's dashboard already reads
(research R11).

### 2.5 `NotificationType.PLATFORM_ANNOUNCEMENT` (CHANGED enum) — Story 6

Every recipient is a company administrator, and administrators have **no mobile persona** — the
dashboard is the only surface that renders this type. This is feature 016's reasoning for its four
exchange types, applied unchanged.

> **Pre-deploy gate.** Spec 007 installed a parity test in the **mobile** repository pinning the
> Flutter `NotificationType` enum to the backend's wire values. That repository is not present on
> this machine. Feature 013 added `CREDIT_LIMIT_REQUEST_RESOLVED` under the same conditions and
> recorded that an unrecognised value degrades to the existing `unknown` fallback. `flutter test`
> MUST still be run before this deploys (SC-013), for the same reason features 015 and 016 each
> carried that gate forward.

### 2.6 `AnnouncementDeliveryFailureReason` (NEW enum) — Story 6

```ts
export enum AnnouncementDeliveryFailureReason {
  COMPANY_SUSPENDED   = 'COMPANY_SUSPENDED',
  ADMIN_DEACTIVATED   = 'ADMIN_DEACTIVATED',
  NO_ACTIVE_ADMIN     = 'NO_ACTIVE_ADMIN',
}
```

A named reason, never a boolean (FR-054). The spec's edge cases name the first two distinctly, and
the third covers a company with no administrator at all — which the spec's edge cases require be
displayed as such rather than silently counted. Feature 010's `EscalationSkipReason` needed exactly
this widening after the fact; this starts with it.

---

### 2.7 `PeriodFigureBasis` (NEW enum, response-only) — Story 1

```ts
export enum PeriodFigureBasis {
  RAISED_IN_PERIOD    = 'RAISED_IN_PERIOD',    // bounded by createdAt, every state
  DELIVERED_IN_PERIOD = 'DELIVERED_IN_PERIOD', // bounded by deliveredAt, DELIVERED only
}
```

The overview's three period figures do not share one basis (FR-001a), and the response says which
each uses rather than leaving a reader to infer it from a field name. A named enum rather than a
prose note, because Constitution I forbids the alternative and because the dashboard renders the
distinction — an order count and a trading volume over the same dates genuinely answer different
questions.

Not a schema field: like `AccountMovementDirection` (§2.4) it is computed at serialisation.

---
## 3. `Announcement` (NEW collection) — Story 6

One row per send. **Distinct from the deliveries it produces** (FR-052) — that separation is the
whole reason this is a collection rather than a burst of notifications with no record above them.

| Field | Type | Notes |
|---|---|---|
| `_id` | `ObjectId` | |
| `title` | `string` | required, trimmed |
| `body` | `string` | required, trimmed |
| `sentBy` | `ObjectId → User` | required, immutable — the operator |
| `targetCompanyIds` | `ObjectId[] → Company` | **empty array means "every active company"** (FR-049/FR-050) |
| `intendedRecipientCount` | `number` | resolved at enqueue |
| `deliveredCount` | `number` | incremented by the processor |
| `failedCount` | `number` | incremented by the processor |
| `state` | `AnnouncementState` | `QUEUED \| COMPLETED` |
| `createdAt` / `updatedAt` | `Date` | `timestamps: true` |

**Scoping marker: NONE.** An announcement belongs to the platform, not to a company — the operator
has no tenant. This follows `Company`'s and `Warehouse`'s precedent for platform-level records
(spec 008 made the same call for `Warehouse`, with the same reasoning). Marking it
`markTenantScoped` would make it **unreadable by its own author**, since a `SUPER_ADMIN` has no
`companyId` to match. Access is enforced by `@Roles(SUPER_ADMIN)` on the routes (FR-056).

**Empty `targetCompanyIds` means all.** The alternative — a `targetsAllCompanies: boolean` beside
the array — is the shape feature 013 used for `CashbackProgramme`. It is rejected here because it
permits two contradictory states (`targetsAll: true` with a non-empty list) that the code would then
have to arbitrate. One field, one meaning.

---

## 4. `AnnouncementDelivery` (NEW collection) — Story 6

One row per intended recipient. This is what makes FR-053 (retry-safe) and FR-054 (who was missed,
and why) answerable, and it is where the idempotency guarantee actually lives.

| Field | Type | Notes |
|---|---|---|
| `announcementId` | `ObjectId → Announcement` | required, immutable |
| `recipientUserId` | `ObjectId → User` | required, immutable |
| `companyId` | `ObjectId → Company` | the recipient's company, stamped explicitly (see below) |
| `notificationId` | `ObjectId → Notification` | set on success; absent on failure |
| `failureReason` | `AnnouncementDeliveryFailureReason` | set on failure; absent on success |
| `createdAt` | `Date` | |

**Scoping marker: NONE**, for the same reason as `Announcement` — the operator must be able to read
the delivery record of a send that targeted companies they do not belong to.

### 4.1 The idempotency index is the FR-053 guarantee

```ts
AnnouncementDeliverySchema.index({ announcementId: 1, recipientUserId: 1 }, { unique: true });
```

BullMQ is **at-least-once**, and `Worker.close()` deliberately releases an unfinished job for
redelivery — feature 012 corrected an "exactly once" claim in its own spec for precisely this
reason. So a redelivered job re-runs the insert, the unique index refuses it, and the processor
catches the duplicate-key error and skips. FR-053 rests on the database, not on the queue and not
on a prior read.

This is Constitution V ("concurrency safety MUST be guaranteed at the data layer — conditional
updates + unique indexes — not assumed from application ordering"), and it is the same idiom
`ratings.service.ts` and `dispatch.service.ts` already use via `isDuplicateKeyError`.

An application-level "have I already delivered this?" read before each insert is rejected: under
redelivery it is a read-then-write race whose collision only appears at commit — exactly the defect
feature 009 hit on concurrent assignment.

### 4.2 `companyId` must be stamped by hand

The fan-out processor runs in a BullMQ worker with **no request context**, so both scoping plugins
take their `!ctx?.role` bypass and `pre('save')` writes nothing. `Notification.companyId` is
`required: true`, so an unstamped write fails outright — but the subtler hazard is the recipient's
own read: `Notification` is `markTenantScoped`, so a notification carrying the wrong `companyId`
would be **invisible to the administrator it was addressed to**, while the operator (who bypasses
scoping) would see it and count the delivery a success.

**This is the single most likely silent defect in Story 6**, and it is invisible to any test that
reads the notification back as the operator. The delivery test MUST authenticate as the **recipient
administrator** (research R9).

---

## 5. `AccountMovement` (CHANGED) — Story 8

No field is added. Two changes:

**5.1 A new permitted `kind`** — `CASHBACK_PAID_OUT` (§2.3). It reuses the existing optional
`method`, `reference`, `documentFileId`, `confirmedBy` and `confirmedAt` fields, all of which
`PAYMENT_RECORDED` already populates. `amount` stays `min: 0`; direction is carried by `kind`, never
by a sign (research R11).

**5.2 A new partial unique index** enforcing FR-070:

```ts
AccountMovementSchema.index(
  { companyId: 1, kind: 1, reference: 1 },
  { unique: true,
    partialFilterExpression: {
      kind: AccountMovementKind.CASHBACK_PAID_OUT,
      reference: { $exists: true },
    } },
);
```

Partial on both clauses. Without the `kind` clause it would constrain `PAYMENT_RECORDED` rows that
have never been unique on `reference` and may already collide in existing data. Without the
`reference` clause, two accrual rows (which carry none) would collide on `null`.

> **Deploy note.** `autoIndex` is on, so this index builds at boot. It is new and narrow, so it
> cannot collide with existing rows — no `CASHBACK_PAID_OUT` row exists yet, by construction. Unlike
> feature 015's phone index, **no migration script is required**. This is stated explicitly because
> the opposite assumption is the expensive one.

**5.3 A payout is created already `CONFIRMED`.** `PAYMENT_RECORDED` starts `RECORDED` and awaits the
operator's confirm because a *company* asserted it; a payout is asserted by the operator, and there
is no second party to confirm it. Leaving it `RECORDED` would mean it did not reduce the owed
balance, contradicting FR-067. `CASHBACK_CREDITED` is already created confirmed for the same reason.

---

## 6. Unchanged, and required to stay unchanged

FR-032 and FR-075 are prohibitions. These are named here so a reviewer can check the diff against a
list rather than a memory:

| Artifact | Why it must not change |
|---|---|
| `multi-party-scope.plugin.ts` `resolveFuelCompanyId` | the transport administrator's tenant key (FR-032) |
| the transporter-resolution query used by order routing | an unparented transporter is never routed to, silently (FR-032) |
| `Company.parentFuelCompanyId` optionality | every transport company has exactly one parent (FR-029) |
| `findByPhoneForAuth` | CLIENT/DRIVER scoping is deliberate and commented; it guards sign-in (research R10) |
| `findSingleActiveAdminByPhone` | feature 015's "exactly one active administrator" guarantee |
| `User.sessionGeneration`, `User.activeSessions` | this feature **reads** session state and never writes it (FR-062) |
| `OrderStatus` | no state is added, removed or renamed |
| `getConfirmedBalance` | still per-kind; the owed figure is a **new** two-kind method beside it (research R11) |

---

## 7. Entity relationships

```
Company (1) ──parentFuelCompanyId──> (0..1) Company          unchanged (FR-029)
   │
   └─(1..*) User [TRANSPORT_COMPANY_ADMIN | DRIVER]           unchanged

Announcement (1) ──> (0..*) AnnouncementDelivery ──> (0..1) Notification
   │                          unique(announcementId, recipientUserId)
   └─sentBy──> User [SUPER_ADMIN]

AccountMovement (0..*) ──companyId──> Company
   kind ∈ { COMMISSION_CHARGED, CASHBACK_CREDITED, PAYMENT_RECORDED, CASHBACK_PAID_OUT }
                                                                      ^^^^^ new

Order ──driverId,truckId──> (roster derivation, projects truckId ONLY)
```

---

## 8. Summary of persisted change

| Change | Kind | Migration needed |
|---|---|---|
| `Announcement` collection | NEW | no — empty at first boot |
| `AnnouncementDelivery` collection + unique index | NEW | no — empty at first boot |
| `AccountMovementKind.CASHBACK_PAID_OUT` | enum member | no — widens an allowed set |
| `AccountMovement` partial unique index | NEW index | no — matches zero existing rows |
| `NotificationType.PLATFORM_ANNOUNCEMENT` | enum member | no — but see §2.5's mobile gate |
| Everything else | derived / read-only | — |

**No migration script.** This feature adds nothing to an existing document and rewrites nothing.
That is a deliberate contrast with features 015 and 016, each of which had an irreversible
pre-deploy migration, and it is stated here so nobody goes looking for one.
