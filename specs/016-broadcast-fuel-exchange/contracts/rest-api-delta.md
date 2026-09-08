# REST API Delta: Broadcast Fuel Exchange Offers

**Feature**: 016-broadcast-fuel-exchange | Base: `/api/v1`

Roles: **FCA** = `FUEL_COMPANY_ADMIN`, **SA** = `SUPER_ADMIN`.

## Removed

| Method | Path | Reason |
|---|---|---|
| `POST` | `/fuel-exchange/requests` | Replaced by `POST /fuel-exchange/offers` (FR-040). |
| `GET` | `/fuel-exchange/requests`, `/fuel-exchange/requests/:id` | Replaced by the offer routes; historical records reachable as migrated offers. |
| `PATCH` | `/fuel-exchange/requests/:id/respond`, `/withdraw` | Replaced by propose / award / withdraw. |
| `GET` | `/companies/exchange-partners` | Sole consumer was the recipient selector (R10). |

## Added

### `POST /fuel-exchange/offers` — FCA

Raise one offer to the market (FR-001 – FR-005).

```jsonc
// request
{
  "fuelType": "PETROL_95",
  "quantityLitres": 20000,
  "deliveryAt": "2026-09-20T08:00:00.000Z",
  "city": "JEDDAH",            // GovernorateCode
  "district": "Al Rawdah",     // optional
  "locationUrl": "https://…",  // optional, http/https only
  "notes": "…"                 // optional
}
```

No `recipientCompanyId`. **No `unitPrice`** (FR-005a).

- `201` → the offer, `state: OPEN`, `openToMarket: true`.
- `400 EXCHANGE_NO_ELIGIBLE_COMPANY` — no other fuel company sells the grade (FR-005).
- `400` — quantity ≤ 0, delivery time in the past, unknown city, non-`http(s)` location link (FR-004, FR-028).

### `GET /fuel-exchange/offers?direction=incoming|outgoing|all&state=…` — FCA, SA

Cursor-paginated, `{ items, nextCursor }`. Direction is **derived** per viewer from `raisedByCompanyId`, never stored (FR-008). `incoming` additionally applies the grade relevance filter (FR-007, R2) and excludes the viewer's own offers (FR-009).

Each item carries the offer's terms, destination, state, and — **only when the viewer raised it** — `proposalCount` and a separate `declineCount` (FR-021a: two counts, so the raiser can tell "no answers yet" from "everybody said no"; neither carries an identity). A viewer who did not raise it receives no proposal field at all (FR-011b, FR-021).

Offers whose **raising company is suspended** are excluded from `incoming` (FR-010).

### `GET /fuel-exchange/offers/:id` — FCA, SA

Full terms and destination. Payload varies by viewer, and the variation is the contract:

| Viewer | Receives |
|---|---|
| Raiser, while open | Terms + every proposal (company, unit price, currency, total) + each proposer's contact details (FR-020) |
| Raiser, after award | The above + `agreed*` figures + the awarded company's contact details |
| A recipient, while open | Terms + destination + **its own** proposal if any. No rival proposal, no count, no rival name |
| The awarded company | The above + `agreed*` figures + the raiser's contact details (FR-019a) |
| A non-awarded recipient | Terms + `state: AWARDED`, and nothing identifying the winner or the winning price (FR-015) |
| SA | Everything, read-only (FR-023) |

- `404` when the viewer is not entitled to the offer — never `403`, and never distinguishable from absence (FR-022, Constitution II/III).

### `POST /fuel-exchange/offers/:id/proposals` — FCA (recipients only)

```jsonc
{ "unitPrice": 2.18 }              // propose
{ "decline": true }                // decline (FR-013)
```

- `201` → the caller's own proposal only.
- `400 EXCHANGE_GRADE_NOT_SOLD` — the proposing company does not sell the grade (R2 moves this guard here from raising).
- `400` — price ≤ 0 (FR-011a).
- `409 EXCHANGE_ALREADY_ANSWERED` — this company already answered; also the response to a duplicate submission, which is what makes FR-018 hold at the database rather than in the UI.
- `409 EXCHANGE_OFFER_NOT_OPEN` — the offer is awarded or withdrawn, **or its raising company is suspended** (FR-010).
- `403` — the raiser attempting to answer its own offer (FR-009).

### `POST /fuel-exchange/offers/:id/award` — FCA (raiser only)

```jsonc
{ "proposalId": "…" }
```

Transactional (R4, Constitution V). Stamps the offer, the winning proposal (`AWARDED`) and every other proposal (`NOT_SELECTED`) in one session.

- `200` → the awarded offer with `agreed*` figures and the counterparty's contact details.
- `409 EXCHANGE_ALREADY_RESOLVED` — already awarded or withdrawn, **including the simultaneous case**, decided by `modifiedCount` on the conditional update and not by a prior read (FR-014a).
- `404` — the proposal does not belong to this offer, or the caller did not raise it.

### `PATCH /fuel-exchange/offers/:id/withdraw` — FCA (raiser only)

Same conditional-update idiom.

- `200` → `state: WITHDRAWN`; every company that proposed is notified (FR-016).
- `409 EXCHANGE_ALREADY_RESOLVED` — already awarded.

### `GET /fuel-exchange/offers/summary` — FCA

```jsonc
{ "incomingAwaitingAnswer": 3, "outgoingOpen": 1, "awardedThisMonth": 9 }
```

Counts over the whole scoped set, not a page (FR-033, R9). `awardedThisMonth` is the current calendar month in the platform's timezone.

## Unchanged and load-bearing

- Every response above is scoped by the plugin layer before any service code runs; no handler adds a company filter of its own (Constitution II).
- All refusals travel through the existing global exception filter in the platform's standard `{ error, message }` shape (Constitution III).
