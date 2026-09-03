# Quickstart: Driver App Backend Completion & Cross-Device Delivery Continuity

**Feature**: 013 | **Date**: 2026-09-03

How to verify this feature by hand. Parts 0–2 need a running backend and one device. **Part 3 needs two
devices and is the only way to verify the feature's headline claim** — no automated test can prove a
driver picks up a second handset and carries on.

---

## Prerequisites

```bash
# Backend — repo root
npm install && npm run start:dev          # MongoDB replica set + Redis must be up

# Seed the actors (transport admin, driver, client, warehouse, truck, tank)
npx ts-node scripts/seed-dashboard-actors.ts
npx ts-node scripts/approve-and-route-order.ts   # gets an order to ROUTED_TO_TRANSPORT
```

```bash
# Mobile — mobile_app/
flutter run --dart-define=API_BASE_URL=http://<your-lan-ip>:3000
```

Use your **LAN IP**, not `localhost` — the second device in Part 3 must reach the same backend, and
`localhost` on a handset is the handset.

---

## Part 0 — Slice 0: the push that has never worked

The point of this part is that it fails on `main` and passes after Slice 0.

1. Sign in as the driver. Leave the app on the **notifications** tab.
2. From the dashboard (or `scripts/`), assign this driver an order.
3. **Expected**: the assignment notification appears in the list within 5 seconds, with no refresh and
   no navigation (SC-008).

**On `main` this does not happen**, for either persona, and never has — `NotificationsCubit` registers
its socket handler from its constructor, before any socket exists, and the registration is a silent
no-op. If it still does not happen after Slice 0, the registry is not being flushed on `connect()`.

Repeat as the **client** persona with any client-facing notification. Its working is the one intended
client-visible change in this feature (SC-014).

---

## Part 1 — The notification centre (Slice 3)

1. As the driver, open the notifications tab.
2. **Expected**: real notifications, newest first, unread ones distinguished. **No tabs** — the three
   category tabs are gone (research R7). No row mentions an order you did not create.
3. Sign in with a driver who has none. **Expected**: a stated empty state, not sample rows.
4. Stop the backend and reopen the tab. **Expected**: a stated error with a retry — not fabricated rows,
   and not a blank screen.
5. Open an unread notification. **Expected**: the nav-bar badge drops by one, and the item is no longer
   unread. Kill the app, reopen: still read (it is server-side, not device-local).
6. Press **mark all read**. **Expected**: badge empty, nothing unread. Press again — nothing happens and
   no error (idempotent).

---

## Part 2 — Continuity groundwork on one device (Slice 2)

1. Take an order to `IN_TRANSIT` (verify vehicle → confirm loading → depart).
2. Park the truck — leave the device stationary past the stop-detection window.
3. **Expected**: the stop alert arrives as a device-level notification.
4. **Now dismiss it without tapping**, then open the delivery from the orders list.
5. **Expected**: the outstanding question is visible **on the delivery**, and answering it there works.
   This is the whole of FR-005/FR-006 — on `main` the question is unreachable once the alert is gone.
6. Answer it. Reopen the delivery. **Expected**: no outstanding question shown.

### The untracked indicator (FR-011)

7. Revoke location permission for the app in OS settings, then reopen an active delivery.
8. **Expected**: the screen states the delivery is not being tracked. On `main` it looks completely
   normal while the platform receives nothing — `DeliveryActive.streaming` is computed and read by
   nothing (research R9).

---

## Part 3 — Two devices. The headline claim.

**Needs two real devices** (or one device plus one simulator) signed in as the **same driver**, and a
third surface — the dashboard or the client app — watching the delivery.

### 3a. Resume (US1)

1. On **device A**, take a delivery to `IN_TRANSIT`. Confirm the truck is moving on the customer's map.
2. Put device A aside — **do not sign out**. That is the whole point: a dead battery does not sign out.
3. On **device B**, sign in as the same driver.
4. **Expected**: the delivery appears at `IN_TRANSIT`, and the driver is **not** asked to verify the
   vehicle or confirm loading again.
5. Grant location permission on B and move.
6. **Expected**: the customer's map resumes live movement within one reporting interval. During the gap
   it showed the position as **stale with its age** — never a frozen dot presented as current (FR-012).
7. Complete the handover with the code the customer **already holds** from device A's stage.
   **Expected**: it works, and the customer was never sent a second code (FR-004).

### 3b. The outstanding question survives (US1, FR-006)

1. On device A, get a stop alert. **Do not answer it.** Put A aside.
2. Sign in on device B and open the delivery.
3. **Expected**: the question is there and answerable — on a device that never received the alert.

### 3c. The displaced device goes quiet (US2) — the part that fails silently

**This is the check that a passing test suite cannot substitute for.**

1. With B signed in, pick device A back up. Its app is still open, its socket still connected.
2. **Carry device A somewhere measurably different** — a few hundred metres at least.
3. **Expected**: the truck's position on the customer's map does **not** move to where A is. Device A
   signs the driver out and states why.
4. On device A, attempt any delivery action. **Expected**: refused, stating the session has ended — not
   a generic failure (FR-015).
5. Restart device A's app. **Expected**: the handshake is refused and the driver is told why (FR-018).

> **Why the different location matters.** Reporting from the *same* place proves nothing — the
> displacement threshold would have rejected that frame anyway, so the test passes whether or not the
> enforcement exists. This is the exact trap research R12 flags, and it is the same shape as spec 012's
> Redis adapter, which was silently dead while every single-instance suite passed.

### 3d. A parked truck does not "resume" (edge case)

1. Switch devices while the truck is **stationary and already stalled**.
2. **Expected**: the stall is still a stall. B's first position is not treated as movement — whether the
   truck moved is a property of the truck, not of the handset (FR-010).

---

## Part 4 — The blocked-driver report (Slice 4)

1. As the driver on an `IN_TRANSIT` delivery, open the navigation sheet and press **I cannot reach**.
2. Pick a reason (`ROAD_CLOSURE`, say) and submit.
3. **Expected on the dashboard, immediately** — no waiting for any response window: the transport
   administrator sees the report with the driver's reason, presented distinctly from a detected stop and
   from a declared one (FR-039a).
4. **Now leave the truck parked** past the stop-detection window.
5. **Expected**: detection is **not** suppressed. The report did not silence anything — it is a call for
   help, not a request to stop being asked (FR-039b). This is the check that would have caught filing
   the report as a declaration, which would have told nobody *and* switched detection off (research R5).
6. Resolve the stop from the dashboard. **Expected**: it clears on both surfaces.
7. Press **I cannot reach** again while a stop is already open. **Expected**: a stated message, not a
   crash and not a second open stop.

---

## Part 5 — Identity and dead controls (Slice 5)

1. Open the driver's **more** tab. **Expected**: your own name. No "محمد أحمد". **No station** — a driver
   does not have one.
2. Sign out; sign in as a different driver; reopen. **Expected**: none of the first driver's details.
3. Press every control on every driver screen — profile, more, navigation, notifications, delivery
   detail. **Expected**: each does something. Specifically: about shows the real running version, terms
   opens driver terms, the support call button actually dials, and the navigation view has **no** map
   controls and does not present a fixed image as a live map (FR-041).
4. Press **Start Navigation**. **Expected**: the device's own maps app opens on the destination. That
   remains the design, not a stopgap (FR-041a).

---

## Automated verification

```bash
# Backend — repo root
npm run lint:check && npm run build
npm run test                                  # unit
npm run test:e2e                              # e2e, --runInBand

# Mobile — mobile_app/
flutter test        # exactly TWO known non-green: login_screen_golden_test, auth_session_test

# Dashboard — web_dashboard/
tsc -b --force      # same pre-existing TS6133/TS6192 set as 011/012 — confirm it has not grown
vitest run          # 49 passing; same 2 pre-existing load failures
```

**Record the counts before starting.** Every one of the three baselines has known non-green items, and
this repo's own history shows a stale baseline count being trusted and being wrong. Confirm, do not
assume.

---

## Results

**Automated verification — 2026-09-03 (implementation session).**

| Suite | Result |
|---|---|
| Backend `npm run lint:check` / `npm run build` | clean |
| Backend `npm run test` (unit) | 187 / 187, 22 suites |
| Backend `npm run test:e2e` | green except the pre-existing `request-logging.e2e-spec.ts` (spec 012 US5 — fails identically on an unmodified tree here: 0 captured log records). All 013 suites pass |
| Mobile `flutter test` | 444 passing, exactly the two documented non-green (`login_screen_golden_test` pixel diff, `auth_session_test` `skip:true`) |
| Dashboard `tsc -b --force` | unchanged pre-existing set (56 `TS6133`/`TS6192` + 1 `TS2307`) |
| Dashboard `vitest run` | 50 passing (+1 `StopAlertCard` BLOCKED case), same 2 pre-existing load failures |

**Manual walkthroughs — NOT yet run** (need a running backend and, for Part 3, two real devices):
Part 0 (T009), Parts 1/2/4/5 (T088) on one device, and **Part 3 (T089) on two devices** — the only
place the headline claim (a delivery resumes on a replacement handset; a displaced device carried to a
**different location** stops speaking for the truck) can be observed. Time Part 3a against SC-002's
2-minute target when walked.

> Fill in the manual sections when walked. Note the date, the build, and anything that behaved
> differently from the above — particularly Part 3.
