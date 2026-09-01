# Quickstart: Driver Authentication & Session

Manual verification, one section per user story. Assumes the backend runs against a seeded
database and the app runs against it — see `specs/001-fuel-delivery-platform/quickstart.md`
for base setup.

## Prerequisites

```bash
# Backend
npm run start:dev                 # entry is src/server.ts (constitution)

# Mobile
cd ../mobile_app && flutter run --dart-define=API_BASE_URL=http://localhost:3000/api/v1
```

**SMS_PROVIDER must be `none`.** Recovery codes are read from the `NoopSmsSender` log line,
exactly as spec 005's Story 7 walkthrough does. `validation.ts` rejects `none` in production,
so this is a development-only path.

You need **two driver accounts** in the same transportation company, one with a truck
assigned and one without, plus a handset or simulator with a biometric enrolled.

---

## Phase 0 — the generation check (verify before anything else)

This phase has no user-visible behaviour, which is exactly why it needs its own check.

1. Sign in as any user, client or driver. Confirm the app works normally.
2. Sign in **with a token issued before this deploy** (keep one from the previous build).
   Confirm it still works — `sgen` absent and `sessionGeneration` absent both normalize to
   `0`, so sessions in circulation survive the deploy.
3. Manually `$inc` a signed-in user's `sessionGeneration` in the database.
4. Any authenticated request from that device now returns `401 SESSION_REVOKED`, and the
   socket refuses to reconnect.

If step 2 fails, the migration normalization is wrong and every live session would be dropped
on deploy.

---

## US1 — Driver sees their own identity

1. Sign in as driver A (truck assigned). Open the profile screen.
2. **Expect**: real name, phone, email, photo, company name, plate number and fuel types.
   Nothing reading `5X XXX XXXX` or `mohamed.ahmed@example.com`.
3. Check the notification badge on the driver shell — it reflects the real unread count, not
   a fixed `3`.
4. Sign in as driver B (no truck). **Expect**: the truck row states no truck is assigned; it
   is not blank and shows no invented plate.
5. **The switch test (SC-002)**: sign out from B, sign in as A, and watch the **first frame**
   of every driver screen. No value belonging to B may appear, even momentarily.
6. Kill the network, then pull to refresh the profile. **Expect**: a retryable error, not
   placeholder values.

---

## US2 — Mandatory lock

1. Sign in as a driver. Background the app for **more than 2 minutes**. Return.
   **Expect**: the challenge, before any driver screen is visible.
2. Background for **under** 2 minutes. Return. **Expect**: no challenge.
3. Force-quit and relaunch into the existing session. **Expect**: the challenge (FR-012 covers
   cold launch).
4. **Search every settings screen for a control that disables the lock.** There must be none
   (FR-010). This is the check, not a formality.
5. Fail the biometric three times. **Expect**: still on the lock screen, retry available,
   session intact (FR-015). Sign out is reachable (FR-014).
6. **The lockout test (SC-004a)**: on a device with **no biometric enrolled but a passcode
   set**, confirm the challenge accepts the passcode. A driver must never be locked out of an
   assigned delivery.
7. On a device with **neither** biometric nor passcode: **expect** the blocking screen
   explaining the app requires a device lock (FR-013a).
8. **The duty test (FR-018a)**: with the app locked and a driver on shift, confirm from the
   backend that they are still `isOnline: true` and still appear in
   `GET /dispatch/orders/:id/candidates`. A locked screen must not take a driver off duty.
9. **The route-hole test** — the reason the gate is a `builder:` and not a redirect. Open a
   delivery, push the navigation screen (raw `MaterialPageRoute`), background for 2+ minutes,
   return. **Expect**: the challenge covers it. A redirect-based gate would not.

---

## US3 — Password recovery

Read every code from the backend log: `NoopSmsSender (SMS_PROVIDER=none) Would send to ...`.

1. From login, tap forgot password. Enter driver A's phone. **Expect**: advance to code entry.
2. **The enumeration test (FR-021)**: repeat with a phone number that has no account.
   **Expect**: the identical response and the identical next screen. Compare the two responses
   — status, body and rough timing must not differ. This is the property most easily broken by
   a well-meaning "helpful" error message.
3. Enter a wrong code. **Expect**: one generic invalid-code message. Repeat to 5 attempts.
   **Expect**: refused, resend required (FR-024).
4. Request a new code, then submit the **previous** one. **Expect**: refused — only the most
   recent code works (FR-023).
5. Wait past 5 minutes, submit. **Expect**: refused, resend offered (FR-022).
6. Request 4 codes within 15 minutes. **Expect**: the 4th returns `RESET_RATE_LIMITED` and the
   app **states the wait** — not just "try later" (FR-025).
7. Complete a reset with a valid code and a new password.
   - **Expect**: returned to login, not signed in automatically.
   - Sign in with the new password. Works.
   - **The revocation test (FR-027)**: a session that was live on another device before the
     reset can no longer renew. Confirm it is bounced to login.

---

## US4 — Sign-out actually ends the session

1. Sign in as a driver. Capture the refresh token from the device (debug build).
2. Sign out. Confirm the confirmation dialog appears (FR-033) — a mis-tap must not end a
   shift's session.
3. `POST /auth/refresh` with the captured token. **Expect**: `401`. This is the whole point;
   before this feature it would have succeeded.
4. Relaunch. **Expect**: login screen, phone number prefilled, no session restored (FR-034).
5. **The offline test (FR-031)**: enable airplane mode, sign out. **Expect**: local session
   cleared, login screen reached anyway. The driver must never be trapped.
6. Confirm live location reporting stopped and the driver no longer reads as on duty
   (FR-032).

---

## US5 — Revocation lands promptly

1. **Displacement (FR-042)**: sign in as driver A on handset 1, then as driver A on handset 2.
   **Expect**: handset 1 returns to login within ~5 seconds, saying they signed in elsewhere.
   No tap on handset 1 required — this is the difference between the push and the old
   next-request behaviour.
2. **Deactivation (FR-035)**: with driver A signed in and connected, deactivate them via
   `PATCH /users/:id/deactivate`. **Expect**: signed out within ~5 seconds (SC-008), message
   states the account is not active.
3. **Offline fallback (FR-035a)**: put the device in airplane mode, deactivate the driver,
   then restore connectivity. **Expect**: the socket handshake is refused and the session ends
   immediately, with no driver action.
4. **Sign-in after deactivation (FR-037)**: attempt login. **Expect**: refused with a message
   that does not distinguish a wrong password from an inactive account.
5. **Order release (FR-038)**: deactivate a driver mid-delivery. Confirm the order returns to
   a state an administrator can reassign and the driver is not left believing it is theirs.

---

## Audit trail (FR-043–046)

After running the sections above, inspect the `sessionevents` collection for driver A:

- One `SIGNED_IN` per sign-in.
- One `SIGNED_OUT` for the deliberate sign-out.
- `REVOKED` rows carrying `SIGNED_IN_ELSEWHERE`, `PASSWORD_RESET` and `ACCOUNT_DEACTIVATED`.
- Every row carries `occurredAt`, `userId` and `generation`.
- **No row contains a token, code, password, or anything resumable** (FR-045).
- **No per-request rows** (FR-046) — the count should match the lifecycle events above and
  nothing more.
- Sign in as a *different* company's admin and confirm these rows are not visible (tenant
  scoping).

---

## Regression gates

```bash
npm run test && npm run test:e2e      # backend — must be green
cd ../mobile_app && flutter test      # mobile
```

**Corrected during implementation (Phase 8/T089)**: the pre-existing baseline verified by
actually running the suite, repeatedly, throughout this feature is **two** non-green mobile
tests, not three — `login_screen_golden_test` (pixel diff, still failing, unrelated to this
feature) and `auth_session_test` (still `skip: true`, router-timing gap predating this work).
`order_flow_render_test`'s "cancelled" case passes on its own and inside the full suite; there
is no third pre-existing failure to preserve. This feature's own new tests (backend: logout,
displacement, deactivation, indistinguishable-refusal; mobile: sign-out-offline, session
revocation/connect_error, RTL sweep) all pass. Confirm the count stays at exactly two
non-green tests (that same failure + that same skip) afterwards — a changed failure, a changed
skip reason, or a third non-green test is this work's regression, not the pre-existing gap.

**Phases 0 and 2 must land alone with both suites green** — they change session validation on
the hot path for the CLIENT persona too.
