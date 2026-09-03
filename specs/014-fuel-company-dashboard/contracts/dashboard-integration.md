# Contract: Dashboard Integration

**Feature**: `013-fuel-company-dashboard`
**Repository**: `E:/zeyad/web_dashboard_ciro_fuel` (separate from the platform; see R12)

## Slice 0 — the session (blocking)

Nothing else in this feature is verifiable until all of this lands.

### Role vocabulary

`src/constants/roles.ts` MUST carry the platform's five roles:

```
SUPER_ADMIN · FUEL_COMPANY_ADMIN · TRANSPORT_COMPANY_ADMIN · CLIENT · DRIVER
```

`COMPANY_ADMIN` is **deleted**, not aliased. Five files currently use `FUEL_COMPANY_ADMIN` as an
inline string literal because the constant does not exist — that is how the type system missed the
gap (R1). Every one of those MUST reference the constant afterwards (Principle I).

`DASHBOARD_LOGIN_ROLES` becomes `[SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN]`.
`CLIENT` and `DRIVER` are platform roles the dashboard recognises but never admits.

### Guards

| Route group | Admits | Currently |
|---|---|---|
| `/petrolCompany/*` | `FUEL_COMPANY_ADMIN` | `[CLIENT, COMPANY_ADMIN]` — **a station owner passes the guard for the screen that sets their own credit limit** |
| `/transport/*` | `TRANSPORT_COMPANY_ADMIN` | `[COMPANY_ADMIN, DRIVER, SUPER_ADMIN]` — admits a driver |
| `/admin/*` | `SUPER_ADMIN` | correct |

The client-side guard is a UX layer over server-side authorization, never a replacement
(Constitution, Web constraints).

### Deletions

| Path | Reason |
|---|---|
| `src/auth/components/RoleSelectionPage.tsx` | Fabricates a session |
| The `/select-role` route | Same |
| `bootstrap-session.ts:21` placeholder branch | Honours a credential the platform never issued |
| `lib/api/api.client.ts:72` placeholder branch | Same |
| `src/api/apiClient.ts` | Dead duplicate — 0 consumers (canonical: `lib/api/api.client.ts`, 19) |
| `src/store/sessionStore.ts` | Dead duplicate — 0 consumers (canonical: `stores/session.store.ts`, 15) |

**Verification**: no occurrence of `dummy-token` anywhere in `src/`; no request leaves the dashboard
without a platform-issued token.

## Module shape (slices 2–13)

Follow `transport_company/`, which already has 11 such modules:

```
petrol_company/<domain>/
├── api/<domain>.api.ts      # typed request functions; no React
├── hooks/use<Domain>.ts     # TanStack Query; no JSX
├── types.ts                 # shared with the platform's vocabulary
└── components/              # render + interaction only
```

Business rules never live in components (Principle IV). Fetching never lives in components.

## Query configuration

| Screen kind | Refetch | Rationale |
|---|---|---|
| Lists, detail, counts | Interval per screen, longest that meets its need (FR-049) | R11 |
| Any screen, hidden tab | **None** (FR-050, SC-010) | Global config, not per-screen |
| Live vehicle position | Existing socket, unchanged | The one exception the transport surface established |

No screen this feature adds subscribes to a socket. Nothing it adds is position data (R11).

## Screens and their resolution

| Screen group | Resolution | Slice |
|---|---|---|
| `orders/` | Wire; already has two live files | 2 |
| `stations/` (owners, stations, credit) | Wire; add limit-request cards | 3 |
| `companies/` (transporters) | Wire | 4 |
| `fuel_prices/` | Wire; **delete `data.ts`** (local mock) | 5 |
| `invoices/` | Wire; commission and cashback controls become **read-only** for this role (FR-056) | 6, 9 |
| `dashboard/` | Wire; **remove every trend figure** (FR-047) | 7 |
| `notifications/`, `profile/` | Wire | 8 |
| *Support inbox* | **New screen** — backend exists, no screen does | 8 |
| `platform_account/` | Wire to the new ledger | 10 |
| `payment/` | Wire; both methods offline, evidence required | 10 |
| `fuel_exchange/` | Wire to the new domain | 12 |
| `live_tracking/`, `settings/` | **Out of scope** — empty folders, no route | — |

## Figures that must not be rendered

Per FR-047 and FR-048, and following the precedent by which the transport dashboard's invented
legend was removed rather than faked:

- Week-over-week trend percentages (`"16.30% من الأسبوع الماضي"`) — **every occurrence**. No
  historical baseline exists to compute them from.
- Per-station and per-owner monthly volumes and order counts, unless served by a real count.
- The home screen's activity-breakdown charts, unless served by real counts.

A figure the platform does not supply is **absent**, never zero-filled and never estimated.

## Localisation

New and rebuilt screens are fully bilingual — Arabic default with RTL, and English (FR-095).
Untouched screens are not retrofitted. Text from any company, owner or driver is never rendered as
markup (FR-096).

## Repository arrangement

The dashboard gets `SPEC-POINTER.md` for feature 013 and **no** `specs/013-…` directory — a parallel
spec would fork the source of truth the two repositories share (R12). Dashboard tasks are prefixed
`web_dashboard/` in `tasks.md`.
