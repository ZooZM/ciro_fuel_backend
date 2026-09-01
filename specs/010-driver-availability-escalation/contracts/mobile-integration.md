# Mobile Integration: Driver Availability & Assignment Escalation

Touches only the existing driver active-delivery flow (feature 007,
`mobile_app/lib/features/delivery/`) — no new screen, no new UI state for the driver to see.

## Where the acknowledgment fires

`DeliveryCubit.load()` (`presentation/cubit/delivery_cubit.dart`) already calls
`GetActiveOrder()` and, on success, emits `DeliveryState.active(order, streaming: streaming)` —
this is the existing moment the driver's device has genuinely displayed the assigned delivery, and
is therefore exactly where the new acknowledgment call belongs (per spec Clarification/R2: an
explicit in-app action, tied to the screen that actually shows the assignment, never inferred from
connectivity alone).

**New behavior**: immediately after emitting `DeliveryState.active(...)` for an order whose
`assignmentAcknowledgedAt` is not already set, call the new `acknowledge-assignment` endpoint
(contracts/rest-api-delta.md #3) through a new use case, following the same Clean Architecture
layering `GetActiveOrder` already establishes (domain use case → repository interface → remote data
source, `ApiClient` under the hood).

**Idempotency**: the call fires every time `load()` succeeds for an order not yet acknowledged
(e.g., a cubit reload from a socket-triggered status refresh) — safe because the backend endpoint
is itself idempotent (contracts/rest-api-delta.md #3: a second call is a no-op). No new local
"have I already sent this" state needs to be tracked on the mobile side; the source of truth is the
order's own `assignmentAcknowledgedAt`, already present in the fetched order.

**Failure handling**: if the acknowledgment call itself fails (network blip), it is **not** treated
as a `DeliveryState.failure` for the whole screen — the driver still sees their active delivery
either way. The call is fire-and-forget with respect to the cubit's own state machine; a
persistently-failing acknowledgment simply means the platform-side escalation proceeds as if it
never happened, which is the correct fallback behavior this whole feature exists to provide, not a
new failure mode to design around.

## Not touched

- No new mobile screen, banner, or notification-handling change — the driver's experience of
  *receiving* the assignment (push/socket notification) is completely unchanged by this feature.
- No mobile-side awareness of the SMS escalation at all — the SMS is a fallback delivered through
  the phone's native messaging app, outside this app entirely, by design (it exists precisely for
  the case where the app-side signal never arrived).
- No mobile changes at all for US1 (driver visibility) or the "reason for assigning an ineligible
  driver" behavior — both are dashboard-only.
