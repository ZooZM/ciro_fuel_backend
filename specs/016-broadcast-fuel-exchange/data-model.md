# Data Model: Broadcast Fuel Exchange Offers

**Feature**: 016-broadcast-fuel-exchange | **Date**: 2026-09-06

Two new collections, one retained read-only, two new enums, three new error codes, four new notification types.

---

## `ExchangeOffer` (new collection)

Marked `markPartySet`. Scoped by the amended `party-set-scope.plugin.ts` (research R1).

| Field | Type | Rules |
|---|---|---|
| `partyCompanyIds` | `ObjectId[]` ref `Company` | **The isolation field.** Exactly `[raiser]` when `openToMarket`, exactly `[raiser, recipient]` when not. Multikey index required — the plugin fails at registration without it. |
| `openToMarket` | `boolean` | Required, immutable. `true` for every offer this feature raises; `false` only on migrated records (FR-039a). |
| `raisedByCompanyId` | `ObjectId` ref `Company` | Required, immutable. |
| `raisedByUserId` | `ObjectId` ref `User` | Required, immutable. |
| `fuelType` | `FuelType` | Required, immutable. |
| `quantityLitres` | `number` | Required, immutable, `> 0` (FR-004). |
| `deliveryAt` | `Date` | Required, immutable, must be future **at creation only** — a passed date makes an offer stale, never invalid (spec Assumptions). |
| `city` | `GovernorateCode` | Required (FR-024). |
| `district` | `string` | Optional, length-capped (FR-025). Free text — the neighbourhood, not `RegionCode` (R8). |
| `locationUrl` | `string` | Optional. `http`/`https` only, validated server-side (FR-028). |
| `notes` | `string` | Optional, length-capped. |
| `state` | `ExchangeOfferState` | Default `OPEN`. |
| `awardedProposalId` | `ObjectId` ref `ExchangeProposal` | Set only on award. |
| `awardedCompanyId` | `ObjectId` ref `Company` | Set only on award (FR-014c). |
| `agreedUnitPrice` / `agreedTotal` / `agreedQuantityLitres` / `currency` | `number` / `string` | Frozen at award (R7). Absent while open — absence *is* "no price agreed", never zero. |
| `resolvedBy` / `resolvedAt` | `ObjectId` / `Date` | Set on award or withdrawal. |
| `migratedFromRequestId` | `ObjectId` | Optional. Unique **sparse** index — the migration's idempotency key (R5). |

**Indexes**: `{ partyCompanyIds: 1 }` (isolation, mandatory) · `{ openToMarket: 1, state: 1, fuelType: 1, createdAt: -1, _id: -1 }` (the market listing with its grade relevance filter) · `{ raisedByCompanyId: 1, state: 1, createdAt: -1, _id: -1 }` (outgoing) · `{ migratedFromRequestId: 1 }` unique sparse.

### `ExchangeOfferState`

`OPEN` → `AWARDED` | `WITHDRAWN` | `CLOSED_NO_AWARD`

- `OPEN → AWARDED` — the raiser awards one proposal. Conditional on `state: OPEN` (R4).
- `OPEN → WITHDRAWN` — the raiser withdraws (FR-016). Same conditional.
- `OPEN → CLOSED_NO_AWARD` — reached only by migration of a `DECLINED` directed request. Nothing in the live flow closes an offer without an award; an unanswered offer simply stays open (spec Assumptions).
- Every other transition is refused with `EXCHANGE_ALREADY_RESOLVED` (FR-012, FR-014a).

---

## `ExchangeProposal` (new collection)

Scoped by the new `proposal-scope.plugin.ts` (research R3).

| Field | Type | Rules |
|---|---|---|
| `offerId` | `ObjectId` ref `ExchangeOffer` | Required, immutable. |
| `offerRaisedByCompanyId` | `ObjectId` ref `Company` | Required, immutable. **Denormalised** so the scope filter needs no join (R3). |
| `proposingCompanyId` | `ObjectId` ref `Company` | Required, immutable. |
| `proposingUserId` | `ObjectId` ref `User` | Required, immutable. |
| `outcome` | `ProposalOutcome` | Default `PROPOSED`. |
| `unitPrice` | `number` | Required when `PROPOSED`, `> 0` (FR-011a). Absent on a decline. |
| `currency` | `string` | Required with a price (FR-037). |
| `respondedAt` | `Date` | Required. |
| `resolvedAt` | `Date` | Set when the parent offer resolves. |

**Indexes**: `{ offerId: 1, proposingCompanyId: 1 }` **unique** — the one-answer-per-company guarantee (FR-011c, FR-018), DB-enforced per Constitution V · `{ proposingCompanyId: 1, createdAt: -1, _id: -1 }` · `{ offerRaisedByCompanyId: 1, offerId: 1 }`.

### `ProposalOutcome`

`PROPOSED` | `DECLINED` | `AWARDED` | `NOT_SELECTED`

`DECLINED` is set by the proposing company and is final for it (FR-013, FR-015 of the spec's answering section). `AWARDED` and `NOT_SELECTED` are set by the raiser's award transaction, never by the proposer.

---

## `ExchangeRequest` (existing — retained read-only)

Not deleted by this feature. After migration it has no live reader; it is kept until the migration is verified in each environment (R5), then removable by a later feature. Its `markPartySet` marker stays valid under the amended plugin because every one of its documents has exactly two parties.

---

## New error codes

| Code | HTTP | Meaning |
|---|---|---|
| `EXCHANGE_NO_ELIGIBLE_COMPANY` | 400 | No other fuel company sells the grade (FR-005). |
| `EXCHANGE_ALREADY_ANSWERED` | 409 | This company has already proposed or declined (FR-011c). |
| `EXCHANGE_OFFER_NOT_OPEN` | 409 | Answering, awarding or withdrawing a resolved offer (FR-012, FR-014a, FR-016). |

Reused unchanged: `EXCHANGE_GRADE_NOT_SOLD` (now guards *proposing*, not raising — R2), `EXCHANGE_ALREADY_RESOLVED`, `EXCHANGE_PARTY_INVALID`.

## New notification types

`EXCHANGE_OFFER_AVAILABLE` · `EXCHANGE_PROPOSAL_RECEIVED` · `EXCHANGE_OFFER_AWARDED` · `EXCHANGE_OFFER_CLOSED`

`EXCHANGE_OFFER_CLOSED` reaches non-winners and MUST carry no company name and no price (FR-015, FR-031).

---

## Relationships

```text
Company ──raises──> ExchangeOffer ──has 0..N──> ExchangeProposal <──makes── Company
                          │                            ▲
                          └──── awards exactly 0..1 ────┘
```

One `ExchangeOffer` per submission (FR-018). At most one `ExchangeProposal` per `(offer, company)` pair, enforced by unique index. At most one proposal per offer carries `AWARDED`, enforced by the offer's own conditional state transition rather than by an index on the proposal — the offer is the single point at which "resolved once" is decided.

## What deliberately does not exist

- **No `eligibleCompanyIds` on the offer.** Freezing the audience breaks FR-006a (R1).
- **No embedded proposals array.** Blindness would then depend on a projection at every call site (R3).
- **No price on the offer.** Absence is the model, not a nullable field (R7, FR-005a).
- **No delivery, order, assignment or balance movement of any kind** downstream of an award (FR-017).
