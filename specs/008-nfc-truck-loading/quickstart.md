# Quickstart: NFC Truck Verification & Warehouse Loading

**Feature**: 008-nfc-truck-loading | **Date**: 2026-08-24

Manual verification, one section per user story. Assumes the base setup in
`specs/001-fuel-delivery-platform/quickstart.md`.

## Prerequisites

```bash
# Backend
npm run start:dev                 # entry is src/server.ts (constitution)

# Mobile
cd ../mobile_app && flutter run --dart-define=API_BASE_URL=http://localhost:3000/api/v1
```

You need: a `SUPER_ADMIN`, one transportation company with an admin and **two drivers**, one client
with a station, and at least **two physical 13.56 MHz cards**. An **Android device** is strongly
preferred for the NFC path — see the iOS note below.

> **iOS**: NFC tag reading needs a paid-account entitlement, shows a system sheet per scan, and
> cannot reliably read MIFARE Classic. On iOS, expect to verify the whole feature through the **QR
> path**, which is exactly why that path exists (research R5). An iOS-only test run is a valid
> verification of everything except the NFC tap itself.

---

## Phase 0 — the cutover (do this first, verify nothing else until it passes)

The embedded per-driver truck is **deleted**, not migrated. This is a flag day.

1. Confirm `User` documents no longer carry a `truck` field, and that `PATCH /users/:id/truck`
   returns 404.
2. Confirm `npm run test` and `npm run test:e2e` are fully green after fixtures were rewritten to
   create `Truck`/`Tank` records.
3. Confirm a transportation company with **no** registered trucks cannot accept an order, and is told
   its fleet needs registering rather than shown an empty picker (FR-043c).

If any of these fail, stop — everything below assumes the cutover landed cleanly.

---

## US1 — Registering a fleet

1. As the transport admin, register two trucks (plate only) and two tanks (code, material, capacity,
   permitted grades). **Expect**: four records, trucks with no capacity or grade fields of their own.
2. Pair a card with truck A by focusing the pairing field and holding the card to the USB reader.
   **Expect**: the identifier is typed in for you; the truck shows as paired.
3. Offer the **same** card for truck B. **Expect**: refused, `CARD_ALREADY_PAIRED`, both trucks
   unchanged (FR-005).
4. Register a tank reusing an existing code. **Expect**: refused, `TANK_CODE_IN_USE`.
5. **The isolation test**: as an admin of a *different* transportation company, request truck A by
   id. **Expect**: 404 — indistinguishable from not existing, never 403 (FR-003).
6. Generate a QR code for truck A. **Expect**: a token returned once, for rendering.
7. **Re-pair** truck A with a different card. **Expect**: the previously generated code is
   invalidated (FR-036e) — the response reports no code present.
8. Confirm no endpoint anywhere returns `nfcCardUid`, and only the mint endpoint ever returns a token
   (FR-042).

---

## US2 — Assigning driver, truck and tank

1. Drive an order to `ROUTED_TO_TRANSPORT`. Open the candidate list. **Expect**: drivers ranked by
   proximity, each with `suggestedTruck` — `null` for a driver who has never driven.
2. Assign driver A + truck A + tank A. **Expect**: the order records all three and lands on
   `ASSIGNED_TO_DRIVER` — **not** `IN_TRANSIT` (FR-046a). This is the behaviour change; if the order
   jumps to in-transit, the departure gate is not wired.
3. Complete that delivery, then start a second order and select driver A again. **Expect**: truck A
   is pre-filled (FR-009b).
4. Withdraw truck A, then select driver A on a third order. **Expect**: **no** suggestion, rather
   than an unusable one (FR-009d).
5. Attempt to assign a tank whose capacity is below the order quantity. **Expect**: it was never
   offered in the list at all (FR-016a) — and if forced by id, refused with
   `TANK_CAPACITY_EXCEEDED`.
6. Same for a tank that cannot carry the grade → `TANK_GRADE_UNSUPPORTED`.
7. **The concurrency test (SC-007/SC-024)**: fire two assignment requests for the same truck at the
   same instant. **Expect**: exactly one succeeds; the other gets `TRUCK_UNAVAILABLE`. Repeat for a
   tank.
8. As the client, view the order. **Expect**: the vehicle shown is truck A's plate.
9. As the driver, open the delivery. **Expect**: tank A's **code and material** are visible before
   anything has started (FR-033b).

---

## US3 — The departure gate

1. As driver A, open the assigned delivery. **Expect**: presented as not started; verifying is the
   only way to begin; loading, arrival and handover are all unavailable (FR-020).
2. Tap **truck B's** card. **Expect**: refused, "not the assigned vehicle", delivery unchanged, retry
   offered (FR-018/FR-019).
3. Tap **truck A's** card. **Expect**: the delivery starts, status becomes `LOADING`, and the next
   destination shown is a **warehouse** — not the customer.
4. **The QR-equivalence test**: on a second order, verify by scanning the generated code instead.
   **Expect**: identical outcome (FR-036a).
5. **The code-scoping test**: scan truck A's code against an order assigned to truck B. **Expect**:
   refused exactly as a mismatched card is (FR-036b).
6. **The revocation test**: revoke truck A's code, then scan it. **Expect**: refused immediately
   (FR-036g).
7. **The stored-image test (FR-036i)**: screenshot the QR, then try to verify from the gallery.
   **Expect**: no such affordance exists anywhere in the app. There should be no way to attempt it.
8. **The offline test**: airplane mode, then attempt to verify. **Expect**: fails, says the platform
   could not be reached, and **nothing is recorded** — reconnect and confirm no attempt was logged
   (FR-021/FR-021a).
9. **The rate-limit test**: fail repeatedly in a short window. **Expect**: throttled (FR-023), and the
   attempts visible to the operator (FR-040).
10. **The out-of-sequence test**: verify again after the trip has started. **Expect**: refused as
    out-of-sequence; nothing re-runs or advances (FR-025).

---

## US4 — Warehouse and loading

1. On a `LOADING` delivery, check the destination. **Expect**: the warehouse's name, address and a
   **Navigate to the depot** action that opens the device's maps app on those coordinates — and that
   the warehouse **supplies the order's grade** (SC-017, FR-027).
2. **The no-quantity test (FR-028)**: walk every screen of the loading flow. **Expect**: no quantity,
   volume or numeric field anywhere. Confirming loading is a button, not a form.
3. Attempt to mark arrival at the customer before confirming loading. **Expect**: unavailable
   (FR-031).
4. **At the depot**, verify the truck again (loading stage), then confirm loading. **Expect**: status
   becomes `IN_TRANSIT` and routing switches to the customer's station (FR-032).
5. Attempt a loading verification with truck B's credential. **Expect**: refused, same rule as
   departure (FR-030).
6. **The geofence test (FR-030a)** — the point of the second read. From several kilometres away, tap
   **truck A's own card**. **Expect**: refused; the message says you are not at the depot and roughly
   how far off; it is worded differently from the wrong-vehicle refusal in step 5; loading stays
   unconfirmable. Then drive to the depot and tap the same card. **Expect**: accepted. Both attempts
   are visible to the operator afterward, with their distances (FR-030d).
7. **The no-position test (FR-030c)**: at the depot, turn the phone's location off and tap the card.
   **Expect**: refused, naming the *phone* rather than the truck; reconnect and confirm **no attempt
   was recorded** (unlike step 6, which is recorded). The operator override remains available here
   (FR-047).
8. **The stale-position test**: sit parked away from the depot long enough for the tracking stream to
   go quiet, then tap the card. **Expect**: still refused — the geofence reads a fresh fix, never the
   last streamed position (FR-030c).
9. **The no-warehouse test**: temporarily withdraw every warehouse supplying a grade, then assign an
   order of that grade. **Expect**: the assignment is refused with `NO_WAREHOUSE_FOR_GRADE` and the
   **operator** is told — the driver is never sent nowhere (FR-035f).
10. **The frozen-warehouse test**: with a delivery mid-loading, withdraw its warehouse. **Expect**: the
    delivery continues to that warehouse unchanged (FR-035e), and the geofence is measured against
    that recorded point, not the withdrawn record (FR-030b).

---

## US5 + override — visibility and honesty

1. As the operator, review a completed delivery. **Expect**: both verifications listed with time,
   driver location, and **which method** was used (FR-039, FR-036c).
2. Confirm failed attempts appear alongside successful ones (FR-040).
3. As a driver of another transportation company, request that verification history. **Expect**:
   indistinguishable from not existing (FR-041).
4. **The override test**: on a fresh delivery, have the operator override the departure step with a
   reason. **Expect**: the stage advances, and the record shows an **override** with its reason and
   author — *not* a verification (FR-047b/c).
5. **The honesty test (FR-047d — the one most likely to regress)**: as the **client**, view that
   overridden order. **Expect**: the vehicle is **not** presented as verified. An overridden delivery
   must never claim proof it does not have.
6. **The scope test**: as an admin of a different transportation company, attempt the same override.
   **Expect**: refused (FR-047e).
7. **The skip test**: attempt to override a stage that has not been reached. **Expect**: refused —
   an override advances exactly one outstanding step (FR-047g).

---

## Regression gates

Both suites must be green, with only the **known** pre-existing failures:

```bash
npm run test        # backend unit
npm run test:e2e    # backend e2e
cd ../mobile_app && flutter test
```

**Mobile baseline carried from spec 007**: exactly **two** non-green tests —
`login_screen_golden_test` (pixel diff, fails) and `auth_session_test` (skipped). A third is this
work, not the pre-existing gap.

**Additional checks specific to this feature:**

- `flutter analyze` clean of new issues.
- The `image_picker`-absence assertion passes for the verification flow (FR-036i/j).
- The RTL sweep covers the verification screen and the tank-details row, in Arabic, with a long tank
  code — the same sweep found two real overflow bugs in specs 006 and 007.
- Every exhaustive `OrderStatus` switch compiles — Dart will refuse to build until `loading` is
  handled everywhere, which is the point (FR-046c).
