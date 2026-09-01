# Dashboard Integration Contract — Feature 009

**Repository**: `/Volumes/Zeyad/Documents/work/Ciro/web_dashboard` (separate from the platform)

How each transport screen is wired, and the rules that hold across all of them. Layering follows
the dashboard's established `api/` → `hooks/` → `components/` split per feature folder; functional
components only (Constitution IV).

---

## Rules that hold everywhere

1. **No fabricated values.** Once a screen is wired, every figure, row and label traces to a
   platform record (FR-062, SC-005). No sample arrays, no placeholder ratings, no invented counts.
2. **Three distinct states.** Loading, empty and failed must be visibly different on every list
   and figure (FR-064, SC-011). An empty list must never be indistinguishable from a failed load.
3. **Absence is not zero.** A missing rating is "not yet rated"; a missing `suggestedTruck` is
   "none pre-selected". Neither renders as `0` or a blank.
4. **Bilingual from the start.** Every string through the translation layer, both languages
   populated, correct in both layout directions — including error, empty and loading states
   (FR-074, FR-075). Screens this feature does not touch are not retrofitted (FR-076).
5. **The platform decides.** No screen advances a delivery, judges trackability, or evaluates a
   capacity or grade rule on its own (FR-072).
6. **Refusals are specific.** A refusal names the rule that failed and corrects the view to the
   order's true state.
7. **Never render an isolation key.** `fuelCompanyId`, `transportCompanyId`, `clientId`,
   `driverId` are for scoping, not display.

---

## Slice 0 — Session

### `constants/roles.ts` — rewrite

Five platform roles; `COMPANY_ADMIN` removed. `DASHBOARD_LOGIN_ROLES` becomes
`[SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN]` — `CLIENT` and `DRIVER` are mobile
personas and must not hold a dashboard session.

### `auth/bootstrap-session.ts` — rewrite

**Delete the bypass.** These lines admit a fabricated session:

```ts
if (accessToken === 'dummy-token' && existingUser) { setSession(existingUser, accessToken); return; }
```

Replace with: real credential login → `/auth/me` → role checked against `DASHBOARD_LOGIN_ROLES` →
session established. **`RoleSelectionPage.tsx` is deleted**, not hidden — while it exists, any
visitor can fabricate an administrator session for any role.

`api.client.ts` refresh is corrected to send the token in the body (see rest-api-delta Part 5).

### `app/router.tsx` — guards re-derived

`/admin` → `[SUPER_ADMIN]` · `/petrolCompany` → `[FUEL_COMPANY_ADMIN, SUPER_ADMIN]` ·
`/transport` → `[TRANSPORT_COMPANY_ADMIN, SUPER_ADMIN]`.

Today a `DRIVER` reaches both admin surfaces and a `CLIENT` reaches a fuel company's. Guards run
before any data hook renders, so no out-of-scope request is ever issued (FR-068).

---

## Slice 1 — Vocabulary

`constants/order-status.ts` gains the four missing stages. Every stage-dependent rendering is
driven from one exhaustive mapping (`ORDER_STATUS_LABEL`, `_TONE`, `IS_ASSIGNABLE`,
`IS_TRACKABLE`, `IS_TERMINAL`). An unrecognised value renders as explicit unknown — never blank,
never the nearest neighbour (FR-011).

Every `api/*.ts` moves from `{ items, total, page }` to `{ items, nextCursor }`.

---

## Slice 2 — Assignment

`transport_company/orders/`

| Layer | Contents |
|---|---|
| `api/dispatch.api.ts` | **NEW** — `getCandidates`, `assignDriver` |
| `api/orders.api.ts` | Remove `approve`/`reject`/`forceComplete` (403 for this role, FR-070); cursor paging |
| `hooks/useCandidates.ts` | **NEW** — candidates for a routed order |
| `hooks/useAssignDriver.ts` | **NEW** — mutation; invalidates order + list + candidates |
| `components/assign-driver/` | Sequential driver → truck → tank |

**`OrdersListPage`** — live, cursor-paged, filterable by stage. `ROUTED_TO_TRANSPORT` is the work
queue and must be reachable in one step (FR-009).

**`OrderAssignPage`** (route exists) —

- Candidates ranked as the platform returns them. **Do not re-sort**; the ranking is the
  platform's judgement.
- On selecting a driver, pre-select `suggestedTruck`. **`null` means pre-select nothing** — never
  fall back to "first available", which would silently pick a truck the operator did not choose.
- Tank list shows capacity and permitted grades, so an invalid choice is visible before it is
  refused.
- Refusals name the failing rule with its numbers.
- An already-assigned refusal **refreshes the order** and shows its true state.
- Under 60 seconds of operator time, without leaving the screen to look anything up (SC-002).

---

## Slice 3 — Progress and tracking

**`OrderDetailPage`** — stage, full history with timestamps, customer, driver, tractor, trailer,
destination, ETA. Departure provenance read from `statusHistory`'s
`manualOverride`/`overrideReason`; **an override is never rendered as verified** (FR-013).

**`TrackingPage`** — `lib/realtime/use-order-position.ts` owns the connection. Seed the map from
`driverLocation` so it draws immediately. `NOT_TRACKABLE` renders the explicit not-trackable state
(FR-017). Staleness stated with its age (FR-018). Connection closes on unmount.

---

## Slice 4 — Fleet and card pairing

`transport_company/trucks/` — `trucks.api.ts`, `tanks.api.ts`, `useTrucks`, `useTanks`,
`usePairCard`, `useQrToken`; `TrucksAndTanksPage`, `AddTruckForm`, `AddTankForm` wired.

**Trailer form**: `capacityLiters` and `allowedFuelTypes` are **required** — they are what make
the assignment guards real, not optional detail.

**Fleet list** shows per truck whether a card is paired and a credential live, so an unverifiable
vehicle is visible before assignment rather than at the gate (FR-053).

### `PairCardDialog` — the one genuinely new interaction

Two input paths converge on one confirmation. Detect; never ask which (FR-046).

**Reader presenting as a keyboard** (always available, so never absent):

- Capture at the dialog level — the operator must not have to click a field first (FR-045).
- Discriminate by **inter-keystroke timing plus a terminating newline**. A machine-speed burst is
  a scan; slower input is a person and must be submitted deliberately, marked `manual` (FR-047).
- **Armed only while this dialog is mounted and awaiting a card; disarmed on unmount** (FR-048).
  This is what prevents a stray read reaching another field — by construction, not by operator
  discipline. Test it with a reader attached on every transport screen (SC-020).

**Device reading the card itself**: feature-detect; subscribe on an explicit gesture; fall back
silently to the keyboard path where unavailable (FR-046, FR-047).

**Both paths then**: show what was captured and which tractor it will bind to; require explicit
confirmation (FR-049). A second read **replaces** the pending value — a repeating reader binds
once. A read arriving before a tractor is chosen is **held**, not discarded. Already bound
elsewhere ⇒ refused, naming the holding tractor (FR-050).

**The identifier is never logged** (FR-051). Nor is `qrToken`.

**Credential**: issue, rotate, revoke — effective immediately, with no stale window (SC-022).
Displayable for the driver to capture.

---

## Slice 5 — Stalled deliveries

Override with a required reason, from the order detail, offered only while
`ASSIGNED_TO_DRIVER`. Reassign vehicle before departure. Both record what changed; an override
**writes no verification record**, which is exactly why it can never later read as verified.

---

## Slice 6 — Overview

`dashboard/api/summary.api.ts` + `useSummary` → `TransportDashboard`. **One request** for the whole
home (FR-067). Every remaining hardcoded figure on every wired transport screen is removed
(SC-005). Empty company shows an explicit empty state, not zeros presented as achievement.

`constants/polling.ts` gains per-surface intervals, each the longest that meets its bound; nothing
refreshes while the tab is hidden (FR-022).

---

## Test contract

**Playwright** (`tests/e2e/`) — assignment success and each refusal (capacity, grade, committed
vehicle, already-assigned); tracking's live, not-trackable and stale states; a card presented
while the pairing dialog is closed is absorbed by no field on any screen (SC-020); scanned versus
hand-typed discrimination across ≥20 trials each (SC-021).

**Component** — the exhaustive stage mapping covers all twelve values and renders an unknown for
anything else; loading/empty/failed are distinct; both languages and both directions render.

**Not covered here**: the mobile legs of the walkthrough. Those are manual, by the procedure in
[quickstart.md](../quickstart.md).
