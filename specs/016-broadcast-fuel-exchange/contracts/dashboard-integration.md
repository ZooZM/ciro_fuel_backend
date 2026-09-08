# Dashboard Integration: Broadcast Fuel Exchange Offers

**Repository**: `E:\zeyad\web_dashboard_ciro_fuel` | Feature folder: `src/petrol_company/fuel_exchange/`

## Screen composition (the approved Figma)

```text
┌─ تبادل الوقود بين الشركات ─────────────────────────────┐
│  title + subtitle                                       │
│  ┌─ dashed panel, ALWAYS EXPANDED ────────────────────┐ │
│  │ موعد التسليم        │ نوع الوقود                    │ │
│  │ الكمية  [ − 20,000 لتر + ]  full width             │ │
│  │ المدينة (GovernorateCode) │ الحي (free text)        │ │
│  │ رابط الموقع                                         │ │
│  │ ملاحظات إضافية (textarea)                           │ │
│  │ ملخص الطلب: 20,000 لتر — بنزين 95   ← NOT a total   │ │
│  │ [أرسل الطلب]  [إلغاء]                               │ │
│  └────────────────────────────────────────────────────┘ │
│  [واردة بانتظار الرد 3] [صادرة مفتوحة 1] [تم الترسية 9] │
│  filter: الكل | صادرة | واردة                            │
│  offer list                                              │
└─────────────────────────────────────────────────────────┘
```

Four departures from the shipped screen, each traceable:

| Shipped | Becomes | Why |
|---|---|---|
| Recipient selector (`اختر شركة`) | **Removed** | FR-040 |
| `سعر اللتر` input | **Removed** | FR-005a — price is proposed, not set |
| `الإجمالي التقديري 0 SAR` | Quantity + grade summary | FR-032a — no price exists at creation, so a total could only ever read zero |
| Form gated behind a `طلب جديد` button; stats hidden while it is open | Panel always visible, stats beside it | FR-032, FR-033 |

Two departures from the Figma, both deliberate:

- **`المنطقة` is labelled `الحي`** — the platform already uses المنطقة for its 13 administrative regions (research R8). Two meanings of one word in one panel is the defect being avoided.
- **The total row states quantity and grade** rather than a currency amount, for the reason above.

## Data layer

`hooks/useFuelExchange.ts` — every query and mutation; components stay presentational (Constitution IV).

| Hook | Endpoint | Notes |
|---|---|---|
| `useOffersList(direction, state?, cursor?)` | `GET /fuel-exchange/offers` | Cursor paging, `{ items, nextCursor }` |
| `useOffer(id)` | `GET /fuel-exchange/offers/:id` | Payload varies by viewer — see the API delta's table |
| `useOfferSummary()` | `GET /fuel-exchange/offers/summary` | Feeds the three cards; **replaces counting the loaded page** |
| `useCreateOffer()` | `POST /fuel-exchange/offers` | |
| `useProposeOnOffer(id)` | `POST /fuel-exchange/offers/:id/proposals` | Price or decline |
| `useAwardOffer(id)` | `POST /fuel-exchange/offers/:id/award` | |
| `useWithdrawOffer(id)` | `PATCH /fuel-exchange/offers/:id/withdraw` | |

**Deleted**: `useExchangePartners` and its endpoint (R10).

## Components

| File | Status |
|---|---|
| `NewOfferForm.tsx` | Replaces `NewFuelRequestForm.tsx` |
| `OfferProposalsPanel.tsx` | **New** — the raiser's review + award. Rendered only when `viewerIsRaiser` |
| `ProposeDialog.tsx` | **New** — the responder's price entry |
| `FuelExchangePage.tsx` | Rebuilt to the layout above |
| `FuelExchangeStats.tsx` | Retained; fed by `useOfferSummary` |
| `FuelExchangeListItem.tsx`, `FuelExchangeDetailPage.tsx`, `FuelExchangeContactInfo.tsx` | Rebuilt for offer states and the disclosure rules |
| `admin/fuel_exchange/*` | Rebuilt read-only for the operator (FR-023) — no raise, answer, award or withdraw control |

**`OfferProposalsPanel` must never mount for a non-raiser**, and that is a UX layer only: the payload contains no proposals for a non-raiser in the first place (isolation contract). A component test asserting the panel is hidden proves nothing about FR-011b — the backend suite does.

## Error surfacing

`toApiError` already carries `error`, `message`, `cause`, `retryAfterSeconds` and `challenge` (feature 015). New codes to surface with their own copy:

| Code | Arabic surface |
|---|---|
| `EXCHANGE_NO_ELIGIBLE_COMPANY` | No company on the platform sells this grade |
| `EXCHANGE_GRADE_NOT_SOLD` | Your company does not sell this grade |
| `EXCHANGE_ALREADY_ANSWERED` | You have already answered this offer |
| `EXCHANGE_OFFER_NOT_OPEN` / `EXCHANGE_ALREADY_RESOLVED` | This offer is already closed |

Every one is a state the platform decides; none is pre-validated client-side (the pattern feature 014 set for `EXCHANGE_GRADE_NOT_SOLD`).

## Bilingual

New keys in `lib/i18n/ar.json` and `en.json` with **key parity preserved** — `i18n-rtl.test.tsx` asserts it. The two screens feature 015 left with hard-coded Arabic are not in this feature's path; every string this feature adds goes through `t()` (FR-036).

## Tests

- Vitest: `new-offer-form` (no recipient field, no price field, summary row is not a currency), `offer-proposals-panel` (award disabled once resolved), `use-offer-summary`.
- Playwright: raise → two companies propose → award → non-winner sees a closed offer with no winner named.
- Pre-existing baseline: `accessibility.test.tsx` and `orders.mutations.test.tsx` still fail to *load* (feature 009 deletions), and `tsc -b --force` still reports ~30 `TS6133`/`TS6192` unused-import errors. Neither is this feature's to fix; both must be no worse.
