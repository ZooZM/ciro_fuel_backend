# Dashboard Integration: Driver Availability & Assignment Escalation

Extends `web_dashboard/src/transport_company/orders/components/assign-driver/` (feature 009's
existing driver → truck → tank sequential-selection flow, `AssignmentContext.tsx` + its
components) and `order-details/` (US3).

## Candidate list rendering (US1)

- The driver-picker list renders **every** item the API now returns (contracts/rest-api-delta.md
  #1), not a filtered subset — the dashboard performs no client-side eligibility filtering.
- `ELIGIBLE` rows render exactly as today (fully interactive, no visual change).
- `BUSY`/`OFFLINE` rows are visually muted (reduced-emphasis styling, consistent with how a
  withdrawn truck/tank is already shown elsewhere in this same feature area) and carry an explicit
  badge — "Offline" with `lastSeenAt` (relative time, e.g. "last seen 2h ago" / "never online"), or
  "Already assigned" for `BUSY` — never a single generic "unavailable" label (FR-004).
- `INACTIVE` rows render with no click target at all (not merely muted like `BUSY`/`OFFLINE`) — a
  suspended/deactivated driver is shown, per FR-001's "whole roster," but there is no override path
  for them, unlike the other two ineligible states.
- The existing "no drivers" empty state is now shown **only** when the array itself is empty
  (FR-006) — its copy should be revisited to say "no drivers registered" rather than "no drivers
  available," since "available" no longer describes what an empty result means.

## Selecting an ineligible driver (US1, FR-007/FR-008)

- Selecting an `OFFLINE` row proceeds through the existing truck/tank selection exactly as for an
  `ELIGIBLE` one — ineligibility does not block reaching that step.
- **`BUSY` and `INACTIVE` rows offer no path to assignment at all** (corrected during
  implementation — see FR-007): `BUSY` is shown and clearly marked but is not clickable toward
  assignment; `INACTIVE` likewise. Only `OFFLINE` has an override path, because only `OFFLINE`
  doesn't conflict with the platform's one-active-order-per-driver invariant.
- The final confirmation step (where `AssignmentContext` currently just commits) gains a required,
  visually distinct reason field **only when the selected driver's eligibility is `OFFLINE`** — for
  an eligible driver, confirmation is unchanged. Submitting with a blank reason is blocked
  client-side (and refused server-side regardless, contracts/rest-api-delta.md #2 — the client
  check is a UX courtesy, not the actual guarantee).
- On the `400` "reason required" refusal (should the client-side check somehow be bypassed), the
  reason field is focused with an inline error — the same pattern this feature area already uses
  for the capacity/grade refusals (FR-005 in spec 009).

## Order detail — acknowledgment/escalation state (US3)

New card or section, composed alongside the existing `StalledDeliveryCard`/`TrackingTimelineCard`
in `order-details/`:

- **Unacknowledged, no escalation yet**: "Waiting for the driver to acknowledge."
- **Escalated**: "SMS sent to the driver at `<time>`" — distinct wording from "acknowledged," never
  conflated.
- **Acknowledged**: "Acknowledged by the driver at `<time>`" — once true, this state is permanent
  for the display (the order detail never reverts to "waiting" after the fact, per spec Acceptance
  Scenario US3.3).
- If `assignedWhileIneligible` is true, the order detail also states the recorded reason
  (`assignedWhileIneligibleReason`) — visible to the administrator investigating later, not just at
  the moment of assignment.

## i18n

New keys needed, both `en.json`/`ar.json` (project convention: new/rebuilt screens are fully
bilingual from the start): eligibility badges (`ELIGIBLE`/`BUSY`/`OFFLINE` labels, "last seen"/
"never online" phrasing), the reason-required field's label/placeholder/validation message, and
the three acknowledgment-state strings above. No existing key is repurposed with a new meaning
(avoids the terminology drift this repo's own analysis passes have flagged before).
