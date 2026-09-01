# Contract: UI State, Query Keys & i18n/RTL

Defines the client-state boundaries: what lives in Zustand vs TanStack Query, the query-key
registry, and the localization/direction contract. Keeps fetching/state decoupled from UI
(Constitution IV).

## State ownership

| Concern | Owner | Notes |
|---------|-------|-------|
| Session (user, role, companyId, access token, status) | **Zustand** `session.store` | in-memory; token never persisted |
| Language preference (`ar`/`en`) | **Zustand** + `localStorage` | non-sensitive; drives `<html dir lang>` |
| All server data (orders, companies, users, fuel-prices, notifications) | **TanStack Query** | cache/dedupe/poll; single source for server state |
| Ephemeral UI (dialog open, table filters) | local `useState` / component | not global |

No server data is copied into Zustand; components read it via feature query hooks.

## Query-key registry (typed factory — Constitution I)

```ts
// constants/query-keys.ts
export const queryKeys = {
  auth: { me: ['auth', 'me'] as const },
  companies: {
    all: ['companies'] as const,
    detail: (id: string) => ['companies', id] as const,
    fuelPrices: (id: string) => ['companies', id, 'fuel-prices'] as const,
  },
  orders: {
    list: (params: OrderListParams) => ['orders', params] as const,
    detail: (id: string) => ['orders', id] as const,
  },
  users: { list: (params: UserListParams) => ['users', params] as const, detail: (id: string) => ['users', id] as const },
  notifications: (unread?: boolean) => ['notifications', { unread }] as const,
} as const;
```

- Mutations invalidate the narrowest matching key(s): e.g. `approve` invalidates
  `orders.detail(id)` + `orders.list(*)`.

## Loading / empty / error states (every data view)

| State | Contract |
|-------|----------|
| Loading | Skeleton or spinner; never a blank flash; polling refetches are silent (no spinner) |
| Empty | Explicit localized empty state with the primary action (e.g., "Onboard your first company") |
| Error | Uniform non-technical message from `ApiError.message`; `404`/cross-tenant → generic not-found (FR-019, FR-002) |
| Mutating | Disable the submit control + inline pending indicator; optimistic updates only for non-lifecycle UI, never for money/dispatch transitions (FR-016) |

## i18n & RTL contract (FR-021/022, SC-009)

- **Languages**: `ar` (default) and `en`; every user-facing string is an i18next key — CI/lint
  fails on hard-coded display strings in `features/**` and `components/**`.
- **Direction**: derived from language (`ar → rtl`, `en → ltr`), applied to `<html dir lang>`
  and a Radix `DirectionProvider`; components use Tailwind **logical** utilities
  (`ms/me`, `ps/pe`, `text-start/text-end`, `start-0/end-0`) so one class set mirrors.
- **Switch**: `LangSwitcher` toggles language → updates store, `localStorage`, `<html>`
  attributes, and Radix direction atomically; no reload required.
- **Formatting**: dates/times/numbers/currency via `Intl.*` bound to the active locale.
- **Acceptance**: switching AR↔EN flips the entire layout with no untranslated strings and no
  mirrored-icon or alignment defects on any screen (SC-009).

## Toasts & notifications

- Mutation success/failure → shadcn toast with a localized message.
- The `/notifications` feed is polled; unread count shown in the topbar; mark-as-read mutation
  invalidates the notifications key.
