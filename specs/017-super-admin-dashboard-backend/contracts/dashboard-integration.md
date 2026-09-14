# Dashboard Integration Contract: Platform Operator Module

**Feature**: `017-super-admin-dashboard-backend` | **Phase**: 1
**Repository**: `E:\zeyad\web_dashboard_ciro_fuel`, branch `017-super-admin-dashboard-backend`

> **The feature branch does not exist yet.** The dashboard is on `main` as of planning. Creating it
> is the first dashboard task.

Every screen below lives under `src/admin/`. Feature 013 wired the fuel-company sub-module and
feature 016 wired the fuel-exchange pair; **neither is rebuilt** (spec Assumptions). What follows is
the rest.

---

## 0. Two stale comments that must be corrected in this feature

Both assert the platform cannot do something this feature makes it do, or already did something it
never did. Left in place, each is a trap for the next reader.

**`src/admin/petrol_companies/api/fuel-companies.api.ts`**

```ts
// Feature 013 T235/FR-087: the operator's fuel companies list — `GET /companies?type=FUEL`
// already exists (SA-scoped to every company on the platform).
```

False since feature 013. The handler binds no query parameters at all. This comment is the reason
the defect survived a review — correct it in the same change that adds the filter (Story 2).

**`src/admin/payment/components/AdminPaymentPage.tsx`**

```ts
// This SUPER_ADMIN screen ("pay a fuel company its cashback") is a pre-existing mock with no
// real submit action and no backend capability behind it (out of this feature's scope —
// the platform never pays a company out through this flow)
```

True when written; false after Story 8. The capability is exactly what this feature builds.

---

## 0a. Named constants come FIRST (Constitution I)

Every dashboard API client on this platform addresses routes through `apiRoutes.*` and caches through
`queryKeys.*`. Constitution I forbids magic strings for **routes, statuses, roles and keys** in the
web repository exactly as in the backend, so these land **before** any `api/` file in this feature is
written:

| File | Addition |
|---|---|
| `<dashboard>/src/constants/api-routes.ts` | `platform.overview`, `platform.transportCompanyVolumes`, `drivers.roster`, `announcements.list/create/detail`, `auth.meAccount`, `platformAccount.cashbackOwed(companyId)`, `platformAccount.cashbackPayouts(companyId)`, `companies.transporters` |
| `<dashboard>/src/constants/order-status.ts` | `OrderStatusBucket` and its Arabic/English label maps |
| `<dashboard>/src/constants/query-keys.ts` | one key per new hook |

**The bucket labels are presentation over `OrderStatusBucket`, never the source of truth.** The mock
currently hardcodes four Arabic strings and treats them as the vocabulary; that is the thing being
replaced.

Without this, every task in §1–§8 writes a string literal that a later task has to find and undo.

---

## 1. Operator home dashboard — Story 1

**File**: `src/admin/dashboard/components/AdminDashboard.tsx`
**Source**: `GET /platform/overview?from&to`

### 1.1 Wire

| Card | Field | Bounded by the date range |
|---|---|---|
| شركات البترول | `pointInTime.fuelCompanies` | **no** |
| الشركات الناقلة | `pointInTime.transportCompanies` | **no** |
| إجمالي المحطات | `pointInTime.stations` | **no** |
| طلبات / شهر | `period.orderCount` | yes — orders **raised** |
| حجم التداول (GMV) | `period.orderValue` | yes — **delivered** only |
| الكميات المتداولة | `period.litresMoved` | yes — **delivered** only |

The three period cards do **not** share a basis, and the response says so in `period.basis`
(FR-001a). The order count is every order raised in the range; the value and the volume count only
what was delivered in it. Render that distinction — a reader comparing 612 orders against a GMV that
covers 450 of them will otherwise assume one of the two is wrong.

`DateRangePopup` already exists on the screen and currently drives nothing. It now sets `from`/`to`
and must re-fetch. **Changing it must visibly change the bottom three cards and visibly not change
the top three** — this is Story 1's acceptance scenario 2 and the single clearest way to see the
wiring is real.

### 1.2 Remove — FR-009, FR-078

`STAT_CARDS` attaches `date: 'من الأسبوع الماضي'` and a `trend` to **all six** cards, including the
three point-in-time counts. The platform computes no period-over-period comparison anywhere, so
every one of these is fabricated:

- `trend: 'شركتان جديدتان'`, `trend: 'شركة جديدة'`, `trend: '16.30%'` (×4)
- `trendUp: true` (×6)
- `date: 'من الأسبوع الماضي'` (×6)

Delete the `trend` / `trendUp` / `date` props and the markup that renders them. **Do not** replace
them with a computed trend — that is a different feature with its own storage question.

### 1.3 Doughnut charts

`DOUGHNUT_CHARTS`, `DOUGHNUT_LEGEND_COMPANIES` and `DOUGHNUT_LEGEND_ORDERS` are hardcoded. Replace
with `breakdown.byCompanyType` and `breakdown.byOrderBucket`.

The order chart currently shows **two** segments (مكتمل / قيد التنفيذ). It must show all six
buckets, because the segments are required to sum to the order total the card above states
(acceptance scenario 3, FR-006). Two segments over six buckets cannot.

Arabic labels for the six buckets are **presentation over `OrderStatusBucket`**, never the source of
truth (Constitution I).

### 1.4 Quick actions

`ACTION_CARDS` has four entries with no handlers. Wire:

| Card | Destination |
|---|---|
| عرض الفواتير | existing `/admin/invoices` |
| إضافة شركة نقل | Story 4's onboarding form |
| إضافة مالك محطة | existing fuel-company flow |
| إرسال إشعار للمنصة | Story 6's announcement composer |

### 1.5 Imported mocks — decide, then record

The screen imports `MapTrackingCard`, `InvoicesSection` and `DoughnutSection` from
`@/transport_company/home/`. Feature 009 **deleted** `InvoicesSection` and `DoughnutSection` from
the transport composition as unwired mocks, and stripped `MapTrackingCard`'s fabricated four-way
legend. Any of these still rendering invented figures here is an FR-078 removal, on the precedent
that feature already set.

---

## 2. Fuel companies list — Story 2

**Files**: `AdminPetrolCompaniesPage.tsx`, `AdminPetrolCompaniesStats.tsx`,
`api/fuel-companies.api.ts`

No client change is needed — `listFuelCompanies` **already sends** `?type=FUEL`. The fix is entirely
backend (§2 of the REST delta). What changes here:

- correct the false comment (§0);
- confirm `AdminPetrolCompaniesStats`'s count card is computed from the now-genuinely-filtered
  result, not from a second unfiltered call (FR-014);
- add `useTransportCompanies` reading `?type=TRANSPORT` for Story 4.

**This is the cheapest and highest-value change in the feature.** It is a live defect on the
operator's most-used screen and it gates Story 1's company-type chart.

---

## 3. Orders — Story 3

**Files**: `AdminOrdersPage.tsx`, `AdminDesktopOrdersTable.tsx`, `AdminMobileOrdersList.tsx`,
`AdminOrderDetailPage.tsx`, `order-details/*`

### 3.1 List and summary

- Rows: `GET /orders?bucket=…&status=…&cursor=…` (FR-015, FR-016).
- Summary cards: `GET /orders/summary` → `PlatformSummaryDto`.

**Five cards, not four.** The mock has four; FR-023a requires six buckets and Clarification 3 adds
`NEEDS_ATTENTION` explicitly as its own card. `REJECTED` and `CANCELLED` must be rendered as
separate figures and must never be summed in the UI (FR-023b).

The filter must reach **both** a bucket and a single real state beneath it (FR-016).

### 3.1a Search — identifier only

The search box sends `?orderId=` and returns that order alone (FR-016a). **It does not search names,
stations or customers** — no such field is indexed on this platform (research R13). Label and
placeholder must say what it accepts, so a search for a company name that returns nothing reads as
"this box takes an order number" rather than "that order does not exist".

### 3.2 Detail cards

| Component | Source | Action |
|---|---|---|
| `AdminOrderHeader` | `GET /orders/:id` | wire |
| `AdminOrderDataCard` | same | wire |
| `AdminTransportCompanyCard` | same (`transportCompanyId`) | wire |
| `SupplierDataCard` | same | wire |
| `AdminLinkedInvoicesCard` | `GET /invoices?orderId=` | wire |
| `AramcoInvoiceCard` | `supplierInvoice` | wire — **omit the whole card when the key is absent** (FR-019) |
| `AdminAvailableBalanceCard` | litre balance | wire, or remove if no source (FR-024) |

`AramcoInvoiceCard` is the one to get right: the backend **omits the `supplierInvoice` key
entirely** when nothing is confirmed, rather than sending a zero-filled shape. The card must key off
key-absence, not off `=== 0` — a genuine supplied quantity of zero is a different fact from no
supplier invoice.

### 3.3 Remove — FR-024

Any element with no source: a street-level distance, a per-order commission the platform never
computed. Absent, not zero, not a placeholder.

### 3.4 Force-complete

Wire to `PATCH /orders/:id/force-complete` with a required reason. A `409` renders as the platform's
stated refusal and **the row must not move** (FR-021).

---

## 4. Transport companies — Story 4

**Files**: `AdminTransportCompaniesPage.tsx`, `AdminTransportCompaniesStats.tsx`,
`AdminTransportCompanyListItem.tsx`, `AdminTransportCompanyDetailsPage.tsx`,
`AdminTransportCompanyInfoCard.tsx`, `AdminCompanyDriversCard.tsx`, `AddTransportCompanyPage.tsx`

| Element | Source |
|---|---|
| list, status, joining date | `GET /companies?type=TRANSPORT` (FR-025) |
| covered-area count | `servedRegions.length` from the same payload (FR-026) |
| order volume | `GET /platform/transport-company-volumes?companyIds=…` — **one call per page**, never per row (FR-026, FR-026b) |
| administrator | `GET /users?role=TRANSPORT_COMPANY_ADMIN&companyId=` (FR-034) |
| drivers | `GET /users?role=DRIVER&companyId=` (FR-035) |
| suspend / reinstate | `PATCH /companies/:id/status` (FR-033) |
| onboarding | `POST /companies/transporters` (FR-027) |

### 4.1 The onboarding form

`parentFuelCompanyId` is a **required select**, populated from `GET /companies?type=FUEL` (FR-030).
The form must refuse submission with none chosen — client-side as UX, with the server refusing
independently (Constitution: RBAC and validation client-side are a layer over, never a replacement
for, the server).

This is the feature's one genuinely cross-tenant write. The spec's Risks section is explicit that a
wrong parent fails **silently** — the transporter's administrator cannot read their own data, or its
orders route to the wrong fuel company. The select must therefore show enough to pick correctly
(company name, not an id), and the screen should state that the parent cannot be changed afterwards.

### 4.2 Remove — FR-037

A performance rating and an average delivery time. Neither has a source. Absent, not invented.

---

## 5. Driver roster — Story 5

**Files**: `AdminDriversPage.tsx`, `AdminDriverDetailsPage.tsx`,
`AdminDriverTransportCompanyCard.tsx`
**Source**: `GET /drivers/roster` (FR-038)

### 5.1 `MOCK_DRIVERS` is where the privacy boundary is decided

```ts
const MOCK_DRIVERS = Array(8).fill({
  id, name, avatar, phone,
  truck: 'أ ب ت - 1234',
  capacity: '20,000',      // belongs to the TANK, not the driver — no source
  rating: '4.1',
  tripsMonth: '38',        // per-driver trip aggregate — FORBIDDEN by FR-044
  lastShipment: 'اليوم، 04:30 م',  // per-driver trip history — FORBIDDEN by FR-044
  status: 'نشط'
});
```

| Column | Disposition |
|---|---|
| name, phone, status | wire (FR-039) |
| truck | wire to `lastOperatedTruck` — **`null` renders as "never driven", never blank** (FR-039b) |
| employer | wire to `transportCompany.name` (FR-039) |
| `capacity` | **remove** — a tank attribute, not a driver's; no source (FR-024) |
| `tripsMonth` | **remove** — per-driver trip aggregate (FR-044) |
| `lastShipment` | **remove** — per-driver trip history (FR-044) |
| `rating` | **remove** unless read from `User.ratingAverage`; absent when unrated, never `0` |

### 5.2 The shared-table hazard

`AdminDriversPage` imports `DriversStats`, `DesktopDriversTable` and `MobileDriversList` from
`@/transport_company/drivers/`. If those components render trip counts or last-shipment columns,
reusing them verbatim **reintroduces exactly the fields FR-044 forbids**, through a component the
operator's own file never mentions.

Resolve by making the shared table's columns configurable and having the operator's screen omit the
excluded ones — **not** by changing the transport company's own screen, which FR-075 puts out of
scope.

SC-014 is verified against **what the platform sent**, not only what rendered. The roster endpoint
carries no such field at all (§5 of the REST delta), so a leak here could only come from a component
inventing one.

### 5.3 Filters

`FILTERS = ['الكل', 'نشط', 'غير نشط', 'في رحلة']` maps to `isActive` and `dutyState` (FR-041).
`'في رحلة'` is a duty state, not an order lookup.

### 5.4 Detail screen — FR-042 and FR-045

**Two changes, and the order matters.** Wire first, then remove.

1. **Wire** (FR-042): `AdminDriverDetailsPage.tsx` reads the driver's own record from
   `GET /users/:id` and their employer from `GET /companies/:id`, feeding
   `AdminDriverTransportCompanyCard.tsx`. Both routes are unchanged and already admit the operator.
2. **Remove** (FR-045): drop the cards rendering excluded data rather than rendering them empty.

Removing first would leave a screen with nothing on it and no obvious signal that the wiring step was
still outstanding.

---

## 6. Notifications and announcements — Story 6

**Files**: `AdminNotificationsPage.tsx`, plus a new announcement composer

The notification half needs **no backend work** — `GET /notifications`,
`PATCH /notifications/:id/read` and `PATCH /notifications/read-all` are role-agnostic and already
cursor-paged (FR-046, FR-047). This is a wiring task only.

The unread count must **stay fallen across a reload** (acceptance scenario 2), which it does — the
state is server-side.

The composer posts to `POST /announcements` and handles **`202`, not `201`** (FR-055): the response
means queued, not delivered. Render `intendedRecipientCount`, and offer the delivery outcome via
`GET /announcements/:id` rather than blocking on it.

---

## 7. Profile — Story 7

**Files**: `AdminProfilePage.tsx`, `AdminProfileHeader.tsx`, `AdminProfileAccountCard.tsx`,
`AdminProfileSecurity.tsx`, `AdminChangePhoneModal.tsx`, `AdminProfileStats.tsx`,
`AdminProfilePermissions.tsx`, `AdminProfileAdditionalData.tsx`

| Element | Source |
|---|---|
| name, email, sign-in number | `GET /auth/me/account` (FR-057) — replaces the masked placeholder |
| last sign-in | `lastSignInAt` (FR-058) |
| active sessions | `activeSessionCount` (FR-059) |
| change number | existing `POST /users/me/phone/verification` + `/confirm` (FR-060) |

`AdminChangePhoneModal` must render `409 PHONE_IN_USE` as a stated refusal. After the backend fix
(§7 of the REST delta) this arrives **before** any code is sent, so the modal's second step is never
reached for a number already in use.

### Remove — FR-063

`AdminProfilePermissions.tsx` renders a fixed permission list. **The platform has no permission
model beyond `UserRole`** — there is nothing to fetch, now or later without a new feature. Remove
the component.

`AdminProfileStats.tsx` and `AdminProfileAdditionalData.tsx`: keep only fields
`GET /auth/me/account` returns. Everything else is removed, not zeroed.

---

## 8. Cashback payout — Story 8

**File**: `AdminPaymentPage.tsx`

| Element | Source | Change |
|---|---|---|
| `TOTAL_AMOUNT = 299060.50` | `GET …/cashback/:companyId/owed` | **hardcoded — replace** (FR-065) |
| full / partial | `amount` in the body | wire |
| method | `method` | wire |
| `reference` | `reference` — now **required** | wire |
| `file` | `evidence` | wire |

The `no-op state` comment (§0) is corrected, and the submit becomes real:
`POST /platform-account/cashback/:companyId/payouts`.

**Refusals must render as refusals.** A payout exceeding the balance and a duplicate reference both
return `409` and record nothing (FR-068, FR-070). The screen must not optimistically decrement the
displayed balance — the authoritative figure is re-read server-side inside the transaction, and the
number the screen was showing has no authority (FR-069).

Direction is read from the response's derived `direction` field (FR-064). In the company's own
ledger the payout renders as **money received from the platform** and must never look like a payment
the company made (FR-071, Story 8 scenario 6).

---

## 9. Cross-cutting

**FR-076 — three states plus retry.** Every screen this feature wires distinguishes loading, empty
and failed, and offers a retry on failure. An empty list and a failed fetch must never render
identically. Zero and "not computed" must never render identically (Story 1 edge case).

**FR-077 — bilingual.** Every screen rebuilt or newly wired here is fully bilingual (Arabic default)
with correct RTL, using `t()` and keeping `ar.json`/`en.json` key parity for `i18n-rtl.test.tsx`.
Screens this feature does not touch are **not** retrofitted.

> Feature 015 deferred exactly this on its two sign-in screens and recorded the deferral. Deciding
> mid-implementation to do the same here is acceptable **only if recorded the same way**.

**Constitution (Web)** — typed functional components and hooks only; fetching and state separated
from UI via custom hooks (`useTransportCompanies`, `useDriverRoster`, `usePlatformOverview`, …);
roles, statuses, routes and query keys as named constants, never literals.

**FR-075 — the negative guarantee.** No change in this module may alter the fuel-company,
transport-company or client surfaces. `vitest run` must show the pre-existing baseline unchanged:
the same 2 suites failing to *load* (`accessibility.test.tsx`, `orders.mutations.test.tsx`) and no
new failures. `tsc -b --force` must show no errors beyond the ~33 pre-existing `TS6133`/`TS6192`
unused-import errors features 009 and 011 disclosed, in files this feature does not touch.
