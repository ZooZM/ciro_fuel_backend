# Client Contract — UI State & Order Lifecycle

Defines which screens exist, which actions each order state enables per role, and how the app reacts to backend-driven transitions. The client renders state and offers actions; it never commits a transition locally (research R7).

## Route contract (`go_router`, role-gated)

| Route | Role | Screen |
|-------|------|--------|
| `/login` | public | sign-in |
| `/client` | CLIENT | order list (home) |
| `/client/orders/new` | CLIENT | create order |
| `/client/orders/:id` | CLIENT | order detail + live map + payment + OTP display |
| `/driver` | DRIVER | active delivery (home) or empty state |
| `/driver/orders/:id` | DRIVER | delivery detail + map + OTP entry |
| `/notifications` | any | notification list |

The router reads `SessionCubit`: `unauthenticated` ⇒ `/login`; `authenticated(role)` ⇒ role home. A CLIENT hitting a `/driver/*` route (or vice-versa) is redirected — role is enforced by the backend regardless (client gating is UX only).

## Order state → enabled actions

| OrderStatus | CLIENT sees / can do | DRIVER sees / can do |
|-------------|----------------------|----------------------|
| pendingApproval | awaiting price; may **cancel** | — |
| approved | final price shown; **Pay** (window countdown) | — |
| assignedToDriver | driver assigned; awaiting payment prompt | job appears; view destination |
| pendingPayment | **Pay** (native SDK) with countdown; **Decline** = `PATCH cancel`; on lapse → back to approved | in transit not yet started |
| inTransit | **live map** of driver; watch via socket | **stream location**; **Arrived** ⇒ `POST /orders/:id/arrive` (generates arrival OTP for CLIENT); then **enter arrival code** ⇒ `verify-arrival` |
| unloading | arrival confirmed; **delivery code** shown to CLIENT (pushed after driver requests it) | **Request delivery code** ⇒ `POST /orders/:id/request-delivery-otp`; then **enter delivery code** ⇒ `verify-delivery` |
| delivered | receipt/summary (terminal) | job complete; freed for next (terminal) |
| rejected | reason shown (terminal) | — |
| cancelled | terminal | released if was assigned |

**OTP display rule**: `order:otp` (arrival, then delivery) renders the code **only** on the CLIENT detail screen at the matching state. The DRIVER build never has a code field and only offers entry inputs (FR-012/017, SC-008).

## Transition reactions (source of truth = backend)

| Trigger | Client reaction |
|---------|-----------------|
| `order:status {to: approved}` | show final price + start payment-window countdown |
| `order:status {to: inTransit}` | `PaymentCubit → confirmed`; start watching live map |
| `order:status {to: unloading}` | CLIENT: reveal delivery OTP; DRIVER: show delivery-code entry |
| `order:status {to: delivered}` | terminal UI; DRIVER stops location stream; socket may close room |
| `order:status {to: approved}` from `pendingPayment` | `PaymentCubit → windowExpired`; disable stale Pay action (edge case) |
| payment-window timer reaches 0 locally | optimistically disable Pay, but wait for backend state before declaring lapse |

## Driver location lifecycle (FR-014/015/024, research R4)

1. Order enters `inTransit` (driver's active order) ⇒ `DeliveryCubit` starts `LocationStreamService` with Android foreground-service notification / iOS background updates.
2. Each fix passes the **> 50 m OR ≥ 3 min** gate before `location:update`; below-threshold fixes are dropped client-side (server also re-enforces).
3. Order reaches `delivered`/`cancelled`/idle ⇒ stream stops; background permission no longer exercised.
4. App backgrounded mid-trip ⇒ stream continues; app killed ⇒ trail resumes on next launch/reconnect (no local queue in v1).

## Empty / loading / error states (FR-025)

Every list/detail screen renders explicit **loading**, **empty**, and **failure(Failure)** states from its Cubit — no silent blanks. `NetworkFailure` offers retry; `ThrottledFailure` shows a cooldown; `NotFoundFailure` shows a uniform "not found"; `AuthFailure` routes to login.
