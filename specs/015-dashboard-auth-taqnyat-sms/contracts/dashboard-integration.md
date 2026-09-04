# Dashboard Integration Contract

**Feature**: `015-dashboard-auth-taqnyat-sms` | **Date**: 2026-09-03
**Repository**: `E:\zeyad\web_dashboard_ciro_fuel`

What changes in the dashboard, and — just as important — what does not.

---

## 1. Already correct: do not rebuild

Inspection of the dashboard found the session machinery already implemented and already agreeing
with the platform. These files are **extended, not replaced**, and a plan that rewrites them is
doing unnecessary work and risking regressions:

| File | Status |
|---|---|
| `src/stores/session.store.ts` | Correct. Zustand + persist, `user`/`status` only. |
| `src/lib/api/api.client.ts` | Correct. Single-flight refresh (FR-055), 403/404 never refresh (FR-057), `SESSION_REVOKED` short-circuits to the expiry handler with its `cause` preserved (FR-059). |
| `src/auth/bootstrap-session.ts` | Correct. Restores via `me()`, refuses non-dashboard roles, surfaces revocation causes. |
| `src/constants/roles.ts` | Correct. Platform's five roles; `COMPANY_ADMIN` already deleted; `isDashboardRole` refuses CLIENT/DRIVER. |
| `src/constants/session.ts` | Correct mirror of the platform enum — **gains one value** (§4). |
| `src/routing/ProtectedRoute.tsx`, `RoleGate.tsx` | Correct. Guard runs before the element renders (FR-050/051). |
| `src/auth/hooks/useLogin.ts` | Correct. Per-role landing map with no catch-all `else`; refuses non-dashboard roles before establishing a session. **Reused as-is by the code flow.** |
| `src/auth/api/auth.api.ts` | Correct. `login`, `me`, `logout`. **Gains two functions** (§3). |

FR-049's requirements (no demo picker, no placeholder credential) are **already satisfied** —
`RoleSelectionPage` does not exist and no `'dummy-token'` path remains. Two dead navigations to
`/select-role` and `/role-selection` survive in `VerifyPage.tsx` and are removed with that file's
rewrite.

---

## 2. `LoginPage.tsx` — rewire (keep the design)

The visual design, RTL layout, background, feature cards and copy stay. The behaviour changes.

**Today**: collects a phone, and `handleSendCode` does nothing but `navigate('/verify')`. It sends
no request. It also imports `zod`, `toast` and `useSessionStore` and uses none of them, and declares
a `loginSchema` over `email`/`password` that nothing reads.

**Required**:
- Submitting calls `POST /auth/login/code/request` with the phone in E.164 (the `+966` prefix shown
  in the UI is composed with the typed digits — the platform validates E.164 and the screen must not
  send the local `05…` form it displays).
- On `202`, navigate to `/verify` with the phone in route state, as today.
- On `429 LOGIN_RATE_LIMITED`, show the platform's `retryAfterSeconds` — **never** a locally invented
  interval (FR-047).
- On `400 CHALLENGE_REQUIRED`, solve the proof-of-work (§5) and resubmit, showing a "verifying you're
  not a robot" state. The user is not asked to do anything.
- The "remember me" checkbox becomes real and is carried to `/verify` in route state (§6).
- Dead imports and `loginSchema` removed.

---

## 3. `VerifyPage.tsx` — rewire and correct the code length

**Today it is broken in a way that cannot work**: it renders **4** boxes and calls
`loginMutation.mutate({ email: phone, password: code })` — the phone in the email field and the code
in the password field, against `POST /auth/login`. The platform can only refuse this.

**Required**:
- **6 input boxes**, not 4 (FR-043 — the platform's `OtpPrimitivesService.generateCode` produces a
  6-digit zero-padded code and that primitive is shared with order-handover OTPs).
- Calls `POST /auth/login/code/verify` with `{ phone, code }`.
- Reuses `useLogin`'s existing success handling — the response shape is identical to `/auth/login`
  (FR-016), so the role check, the landing-screen map and `setSession` are unchanged. Extract that
  `onSuccess` body so both flows share it rather than duplicating it.
- The resend button calls `POST /auth/login/code/request` again (today it only resets a local
  countdown, sending nothing).
- The 45-second countdown stays as presentation, but a resend refused with `429` shows the
  platform's `retryAfterSeconds` (FR-028 — the countdown is not the enforcement point).
- `LOGIN_CODE_INVALID` renders one message for all four failure states, with **no** attempt counter
  (FR-034).
- The two dead `navigate('/select-role')` / `navigate('/role-selection')` branches are removed.

**New in `auth.api.ts`**

```
requestLoginCode(input: { phone, challenge? }): Promise<{ expiresInMinutes, attemptsAllowed }>
verifyLoginCode(input: { phone, code }): Promise<LoginResponse>
```

**New in `api-routes.ts`** under `auth`: `loginCodeRequest: '/auth/login/code/request'`,
`loginCodeVerify: '/auth/login/code/verify'`, plus the three password-reset paths (§7). Literal
paths at the point of use are prohibited (Principle I / feature 013 FR-097).

---

## 4. `constants/session.ts` — one new value

```
SESSION_LIMIT_EXCEEDED: 'SESSION_LIMIT_EXCEEDED'
```

and a message in `REVOCATION_MESSAGES` in `bootstrap-session.ts`. Unlike `SIGNED_IN_ELSEWHERE` —
which that file deliberately leaves unexplained, because it is the user's own action elsewhere —
this one **must** be shown: an administrator being signed out because they exceeded a device limit
they may not know exists has no way to work out why otherwise.

Arabic: تم إنهاء هذه الجلسة لأنك سجّلت الدخول من عدد أجهزة أكبر من المسموح.

---

## 5. Proof-of-work — new, small, no dependency

A `src/lib/auth/proof-of-work.ts` helper: given `{ seed, difficultyBits }`, iterate a counter until
`SHA-256(seed + nonce)` has the required leading zero bits, using `crypto.subtle.digest` (available
in every browser the dashboard targets — no library, and nothing to add to `package.json`).

Runs in a `Web Worker` so the sign-in screen does not freeze while searching. At the default 18 bits
this is a fraction of a second on a laptop and materially expensive to run thousands of times, which
is the entire point (research R7).

**Never gates a first request** — only a resubmission after `CHALLENGE_REQUIRED`. Ordinary sign-in
never sees it.

---

## 6. `token-store.ts` — invert the two storage decisions

Today the **access** token is persisted to `localStorage` and the **refresh** token is memory-only —
exactly backwards, and the file's own header comment admits the first half of it. The consequence is
a live defect: after a reload with an expired access token, `runRefresh()` finds nothing and the
administrator is thrown back to sign-in (research R9), which now costs an SMS.

**Required**:

| Credential | After |
|---|---|
| Access token | memory only — no `localStorage` read at module load, no write in `set()` |
| Refresh token | `localStorage` when "remember me" was checked; `sessionStorage` otherwise |

`clear()` removes both from both stores. Every read is wrapped so a browser with site data blocked
degrades to memory-only rather than throwing at module load.

`tests/unit/api-client.refresh.test.ts` asserts the current memory-only refresh behaviour ("the
memory-only store starts empty on every reload") and **must be updated** with this change — it is
encoding the defect.

---

## 7. Password recovery screens — new

Three screens the dashboard does not have, reachable from a "forgot password?" link on
`LoginPage`. All three call existing, unchanged platform endpoints (FR-074).

| Screen | Endpoint | Notes |
|---|---|---|
| Request | `POST /auth/password-reset/request` | Neutral confirmation on `202` regardless of outcome (FR-068). Never says whether the number is registered. |
| Verify code | `POST /auth/password-reset/verify` | **6 boxes.** One message for all four failure states, no attempt counter (FR-070). Returns a `resetToken` held in component state only. |
| New password | `POST /auth/password-reset/complete` | On `204`, return to sign-in with a success notice. All the account's sessions have ended (FR-072). |

Visual language matches `LoginPage`/`VerifyPage`; fully bilingual with RTL (FR-052).

---

## 8. Copy corrections — three screens assert something this feature makes false

Features 013/014 concluded, correctly at the time, that the platform had no passwordless OTP sign-in
and wrote that into the code. After this feature all four statements below are wrong (research R11):

| File | What it says |
|---|---|
| `src/admin/petrol_companies/components/AddPetrolCompanyPage.tsx:12` | "a FUEL_COMPANY_ADMIN signs in with email+password, not phone+OTP" |
| `src/petrol_company/companies/components/AddTransporterPage.tsx:14` | "The 'no password, OTP-only login' copy is corrected…" |
| `src/petrol_company/stations/components/AddStationOwnerPage.tsx:8` | "'password needed, OTP-only login' copy described a login flow this platform does not [support]" |
| `src/petrol_company/stations/api/owners.api.ts:44` | "`/auth/login` is the sole login route" |

These are comments and helper copy, not logic — nothing breaks, which is exactly why they would
survive and mislead. `CreateUserDto` still requires a password (min 8) and that does **not** change,
so the corrected copy reads: an administrator signs in **either** with their mobile number and a
code **or** with their email and password. The password field stays required on all three forms.

**Also required**: an administrator's phone becomes a login identifier, so these creation forms must
collect a valid E.164 mobile number and stop accepting a placeholder.

---

## 9. Testing

| Layer | Coverage |
|---|---|
| Vitest | `proof-of-work` solves a known seed; `token-store` persists the refresh token per remember-me and never the access token; `LoginPage` sends E.164 and surfaces `retryAfterSeconds`; `VerifyPage` renders 6 boxes, posts to the verify route, and shows one message for every refusal; `SESSION_LIMIT_EXCEEDED` renders its message. |
| Vitest (regression) | `api-client.refresh.test.ts` updated for the new storage; existing session/guard suites unchanged and still green. |
| Playwright | The full phone → code → dashboard journey per role, against a mocked platform; the rate-limited and challenge paths; the recovery journey. |

**Baseline to preserve**: `vitest run` currently passes 49 with two pre-existing suites that fail to
*load* (`accessibility.test.tsx`, `orders.mutations.test.tsx` — both import `@/features/*` paths
feature 009 deleted), and `tsc -b --force` reports pre-existing unused-import errors across ~30
files. Neither is this feature's to fix; both must be no worse afterwards.
