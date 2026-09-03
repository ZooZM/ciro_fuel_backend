# Dashboard Integration Contract — Feature 013

**Root**: `web_dashboard/` · **Surface**: the transport administrator's order detail
**Scope**: the smallest change in this feature — and one that is required rather than optional.

---

## Why the dashboard changes at all

The spec's scope boundary (FR-042/FR-042a) is driver-persona work with dashboard behaviour unchanged.
There is exactly one necessary exception, and it was found in Phase 0 rather than during implementation
(research R10).

`web_dashboard/src/constants/stop-events.ts` mirrors the platform's `StopOrigin` as a two-member const
map. Its own header comment states the failure mode:

> These matter more than most: the transport administrator is reading back exactly what the driver
> picked from the *same* list in the mobile app, so a value invented on either side does not fail
> loudly — it renders as a missing translation key next to a real stop on a real delivery.

Introducing `BLOCKED` server-side without touching the dashboard produces precisely that, on the one
surface FR-039a requires the transporter to read the report from. And FR-039a's distinguishability
requirement — the transporter must tell "the driver is asking for help" from "the driver was asked and
said nothing" from "the driver said they would be stopping" — cannot be met by a notification alone,
because `StopAlertCard.tsx` is where a stop is actually read and resolved.

---

## 1. `src/constants/stop-events.ts`

```ts
export const StopOrigin = {
  DETECTED: 'DETECTED',
  DECLARED: 'DECLARED',
  /** The driver reported they cannot reach the destination and is asking for help. */
  BLOCKED: 'BLOCKED',
} as const;
```

`StopReason` is **unchanged** — the blocked report reuses the same seven values, so `stopReasonKey`
needs nothing (research R5).

---

## 2. `src/transport_company/orders/components/order-details/StopAlertCard.tsx`

A third presentation branch. What it must convey, and what distinguishes it from the existing two:

| Origin | What happened | Urgency |
|---|---|---|
| `DETECTED`, unanswered | The platform asked; the driver has not answered | escalates after the window |
| `DECLARED` | The driver said in advance they would stop | informational, already resolved |
| **`BLOCKED`** | **The driver cannot reach the destination and said why** | **immediate — already escalated at creation** |

A blocked report **always** arrives with a reason and with `escalatedAt` set, so the card shows the
driver's stated reason directly and must not render an "awaiting the driver's answer" treatment for it.

Add the translation key for the new origin in both locales — the dashboard is fully bilingual on rebuilt
surfaces (spec 009), and Arabic is the default.

---

## 3. `useStopAlert` / `stop-alert.api.ts` — unchanged

`PATCH /orders/:id/stops/:stopId/resolve` already admits `TRANSPORT_COMPANY_ADMIN` and already works for
any stop regardless of origin. `useResolveStop` already invalidates both the detail and the list.

**No new mutation, no new query key.** The close-out path for a blocked report is the one that already
exists — which is the substance of the "reuse the stop machinery" decision, and the reason this contract
is one const-map member and one card branch rather than a feature.

---

## 4. Verification

- `tsc -b --force` — expect the **same pre-existing** unused-import errors (`TS6133`/`TS6192`) features
  011 and 012 already disclosed, in the same ~30 files. Do not fix them here; that would bury this
  diff. Confirm the set has not grown.
- `vitest run` — 49 passing, with the same **two** pre-existing suites that fail to *load*
  (`accessibility.test.tsx`, `orders.mutations.test.tsx`, both importing `@/features/*` paths feature
  009 deleted). Unchanged by this feature.
- A rendering test for the third origin, asserting it shows the driver's reason and does **not** show
  the awaiting-answer treatment.
