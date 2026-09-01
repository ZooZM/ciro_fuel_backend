# Dashboard Integration: In-Transit Stop Detection & Driver Check-In

## 1. `StopAlertCard` — rebuilding the deleted mock (US4)

Feature 009 deleted `UrgentNotificationCard.tsx` because nothing behind it was real. This feature
supplies the data, so the card returns — as `StopAlertCard.tsx` in
`src/transport_company/orders/components/order-details/`, composed into `OrderDetailPage`.

**What the original mock showed vs. what is now genuinely available**:

| Mock element | Status |
|---|---|
| "Driver stopped moving for more than 10 minutes" | ✅ Real — `StopEvent.detectedAt` + the configured window |
| Time since ("6 minutes ago") | ✅ Real — derived from `detectedAt` |
| Driver name | ✅ Real — `order.driverSummary.fullName` |
| Truck plate | ✅ Real — `order.driverSummary.plateNumber` |
| Driver phone | ✅ Real — `order.driverSummary.phone` |
| Current location | ⚠️ **Coordinates only** — `StopEvent.location` is a point; the mock showed a street name ("طريق مكة القديم - جدة"). No reverse-geocoding exists on this path. Render the point on the existing map rather than inventing a street name |
| Remaining distance ("0.8 km") | ❌ **Not available** — no distance-to-destination is computed for a stopped driver. Omit it rather than fabricate; same discipline as feature 009's dropped legend |
| "Share location" button | ❌ **Out of scope** — no sharing capability exists. Omit |
| "Handled" button | ✅ Real — `PATCH /orders/:id/stops/:stopId/resolve` (FR-012) |

The two ❌ rows matter: reinstating the mock wholesale would reintroduce exactly the fabricated
values feature 009 spent effort removing. Only what the platform can answer honestly is rendered.

**States**:
- **Unanswered, not yet escalated** — "stopped for N minutes, waiting for the driver to explain."
- **Escalated (driver never answered)** — the loud state, and the one the card exists for.
- **Answered** — shows the driver's own reason (and their words for `OTHER`). FR-011/US4.2 require
  the driver's words, never a generic "stopped."
- **Declared by the driver** — visibly distinct from a detected stop (FR-008c): this is an expected
  stop, not an incident, and must not be styled as an alarm.
- **Resolved** — remains on the record, no longer demanding attention (FR-012).

**Absent state**: an order with no stop events renders **no card at all** — not an empty state, not
a "no alerts" placeholder (FR-013).

## 2. Stale-position treatment on the order detail (FR-017a)

`TrackingMapCard.tsx` (feature 009) already implements exactly this on the tracking screen: when
position updates stop arriving it states staleness with an age rather than presenting the last point
as current. The order detail's own `MapCard.tsx` does **not** currently do this — so a silent device
there reads as a live position frozen in place, which is precisely the confusion FR-017a exists to
prevent.

Apply the same treatment, reusing the existing `tracking.stalePosition` i18n key rather than
inventing a second phrasing for the same fact.

## 3. Polling

Stop events arrive on the order detail, which already background-refreshes at
`ORDER_POLL_INTERVAL_MS` (feature 009 FR-020). No new polling and no live connection is added — an
alert appearing within one refresh interval is well inside SC-004's bound, and the tracking screen's
live connection remains reserved for the truck's position alone.

## 4. i18n

New keys in both `en.json` and `ar.json` (new/rebuilt screens are fully bilingual from the start):
the four card states, each `StopReason` label, the "handled" action, and the declared-vs-detected
distinction. The `StopReason` labels are shared vocabulary with the driver app — the same seven
values must read consistently in both places, since the transporter is reading what the driver
picked.
