# Quickstart: Web Dashboard Authentication & Taqnyat SMS Provider

**Feature**: `015-dashboard-auth-taqnyat-sms` | **Date**: 2026-09-03

A walkthrough that proves each slice, in the order the slices land. Parts 0–3 need only a local
stack. **Part 4 needs a real Taqnyat account and a real handset** and is the one part that cannot be
faked.

**Prerequisites**: MongoDB replica set + Redis (`docker compose up -d`), backend at
`e:\zeyad\ciro_fuel_backend`, dashboard at `E:\zeyad\web_dashboard_ciro_fuel`.

---

## Part 0 — Baseline before touching anything

Record these numbers. Every later part is judged against them.

```bash
cd e:/zeyad/ciro_fuel_backend
npm run lint:check && npm run build
npm run test                       # expect 187/187 across 22 suites
npm run test:e2e                   # expect 346/346 across 62 suites
```

```bash
cd E:/zeyad/web_dashboard_ciro_fuel
npm run test                       # expect 49 passing; 2 suites fail to LOAD (pre-existing)
npx tsc -b --force                 # expect the pre-existing unused-import errors, ~30 files
```

Mobile is untouched by this feature; `flutter test` should stay at 418 passing with the two
documented non-green tests. **Run it at the end of Part 1, not now** — Part 1 is the only slice that
could break it.

---

## Part 1 — Slice 0: the session model (the risky one)

The correctness condition here is a **negative**: nothing about DRIVER or CLIENT sessions changed.

### 1.1 An administrator can hold three sessions

```bash
# Sign in three times as the same fuel company admin, from three "devices"
for i in 1 2 3; do
  curl -s -X POST localhost:3000/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"fca@example.com","password":"Password123"}' \
    | jq -r '.accessToken' > /tmp/tok$i
done

# All three must still work
for i in 1 2 3; do
  curl -s -o /dev/null -w "device $i: %{http_code}\n" \
    localhost:3000/api/v1/auth/me -H "Authorization: Bearer $(cat /tmp/tok$i)"
done
```

**Expected**: `200`, `200`, `200`. Before this slice, only device 3 would have worked.

### 1.2 A fourth sign-in evicts the oldest, and only the oldest

```bash
curl -s -X POST localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fca@example.com","password":"Password123"}' | jq -r '.accessToken' > /tmp/tok4

curl -s localhost:3000/api/v1/auth/me -H "Authorization: Bearer $(cat /tmp/tok1)" | jq
```

**Expected**: device 1 refused with
`{"error":"SESSION_REVOKED","cause":"SESSION_LIMIT_EXCEEDED",...}`. Devices 2, 3, 4 still `200`.
`cause` must be `SESSION_LIMIT_EXCEEDED`, **not** `SIGNED_IN_ELSEWHERE`.

### 1.3 Sign-out ends one device only

```bash
curl -s -X POST localhost:3000/api/v1/auth/logout -H "Authorization: Bearer $(cat /tmp/tok2)"
curl -s -o /dev/null -w "device2 %{http_code}\n" localhost:3000/api/v1/auth/me -H "Authorization: Bearer $(cat /tmp/tok2)"
curl -s -o /dev/null -w "device3 %{http_code}\n" localhost:3000/api/v1/auth/me -H "Authorization: Bearer $(cat /tmp/tok3)"
```

**Expected**: device 2 → `401`, device 3 → `200`. A refresh with device 2's refresh token must also
be refused.

### 1.4 Password reset ends everything

Complete a password reset for that admin, then re-check devices 3 and 4. **Expected**: both `401`.

### 1.5 The negative condition — drivers are untouched

```bash
# Sign in twice as the same driver
curl -s -X POST localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"phone":"+966500000001","password":"Password123"}' | jq -r '.accessToken' > /tmp/drv1
curl -s -X POST localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"phone":"+966500000001","password":"Password123"}' | jq -r '.accessToken' > /tmp/drv2

curl -s localhost:3000/api/v1/auth/me -H "Authorization: Bearer $(cat /tmp/drv1)" | jq -r '.error // "OK"'
```

**Expected**: `SESSION_REVOKED` — the first driver session is still displaced, exactly as before.
Decode `/tmp/drv1` and confirm the payload has **no `sid` claim**.

### 1.6 Gate

```bash
npm run test && npm run test:e2e          # backend: no regressions vs Part 0
cd ../mobile_app && flutter test          # 418 passing, same two documented failures
```

**Do not start Slice 1 until 1.5 and 1.6 both pass.** They are the whole reason this slice lands
alone (research R12).

---

## Part 2 — Slice 1: Taqnyat activation

### 2.1 The validation holes are closed

```bash
NODE_ENV=production SMS_PROVIDER=taqnyat SMS_API_KEY= SMS_SENDER_ID=ciro npm run start:prod
```

**Expected**: refuses to start, naming `SMS_API_KEY`. If it starts, `.invalid('')` was omitted and
the bug from `CORS_ALLOWED_ORIGINS`/`GCS_BUCKET` has shipped a third time (research R6).

Repeat with `SMS_SENDER_ID=` → must name `SMS_SENDER_ID`. Repeat with `SMS_PROVIDER=none` → must
still refuse (existing rule). With both set → must start.

### 2.2 Nothing changed for development

```bash
SMS_PROVIDER=none npm run start:dev
```

Trigger a password reset; the code appears in the `NoopSmsSender` log line as before. All e2e suites
still run without a provider.

---

## Part 3 — Slices 2–3: phone integrity and code sign-in

### 3.1 Placeholder phones are gone

```bash
mongosh "$MONGO_URI" --eval '
  db.users.find({ role: { $in: ["SUPER_ADMIN","FUEL_COMPANY_ADMIN","TRANSPORT_COMPANY_ADMIN"] },
                  phone: { $not: /^\+[1-9]\d{7,14}$/ } }, { email:1, phone:1 })'
```

**Expected**: empty. If not, the index extension will fail at boot — normalise first (research R5).

### 3.2 The neutral response really is neutral

Run all five and diff the bodies **and** the status codes:

```bash
for p in "+966500000099" "+966500000001" "+966500000002" "+966599999999" "+966500000003"; do
  curl -s -w '\n%{http_code}\n' -X POST localhost:3000/api/v1/auth/login/code/request \
    -H 'Content-Type: application/json' -d "{\"phone\":\"$p\"}"
done
```

Where the numbers are, in order: a real admin · a driver · a client · nobody · an inactive admin.

**Expected**: five identical `202` responses with identical bodies. Then confirm in the `LoginCode`
collection that **only one** record exists — for the admin. If a record exists for the driver or the
client, FR-014 is broken.

### 3.3 Sign in with a code

```bash
# SMS_PROVIDER=none, so read the code from the server log
curl -s -X POST localhost:3000/api/v1/auth/login/code/request \
  -H 'Content-Type: application/json' -d '{"phone":"+966500000099"}'
# → NoopSmsSender logs: "Would send to +966500000099: Your CIRO Fuel sign-in code is 123456..."

curl -s -X POST localhost:3000/api/v1/auth/login/code/verify \
  -H 'Content-Type: application/json' -d '{"phone":"+966500000099","code":"123456"}' | jq
```

**Expected**: `200` with `accessToken`, `refreshToken`, `user`. Decode the access token: it carries
`sid`. Replay the same code → `400 LOGIN_CODE_INVALID` (single use).

### 3.4 The four refusals are one refusal

Request a fresh code, then submit: a wrong code · wait past expiry · request a newer code then use
the older · exceed the attempt limit. **Expected**: four identical `400 LOGIN_CODE_INVALID` bodies.
None carries an attempt count.

### 3.5 Rate limit, then challenge, then block

```bash
for i in $(seq 1 6); do
  curl -s -w ' %{http_code}\n' -X POST localhost:3000/api/v1/auth/login/code/request \
    -H 'Content-Type: application/json' -d '{"phone":"+966500000099"}' | tail -c 120
done
```

**Expected**: `202` ×3, then `429 LOGIN_RATE_LIMITED` with `retryAfterSeconds`, then
`400 CHALLENGE_REQUIRED` carrying `{ seed, difficultyBits }`. **Count the SMS log lines: exactly 3.**

Then run the same six against an unregistered number and diff — the sequences must be
indistinguishable (FR-027).

Drive `LOGIN_OTP_FAIL_THRESHOLD` wrong codes and confirm the number is blocked, and that the block's
`429` is byte-identical to the rate-limit `429`.

### 3.6 Fail closed

```bash
docker compose stop redis
curl -s -w '\n%{http_code}\n' -X POST localhost:3000/api/v1/auth/login/code/request \
  -H 'Content-Type: application/json' -d '{"phone":"+966500000099"}'
docker compose start redis
```

**Expected**: `503`. **Not** `202`. A `202` here means the counters failed open and a six-digit code
is unguarded (FR-030).

---

## Part 4 — Slices 4–7: the dashboard, end to end

Run the backend with `SMS_PROVIDER=taqnyat` and a real token, and `npm run dev` in the dashboard.

| # | Step | Expected |
|---|---|---|
| 1 | Open `/`, enter a real admin mobile number, submit | A real SMS arrives from sender **ciro** with a 6-digit code |
| 2 | The `/verify` screen | **6** input boxes, not 4 |
| 3 | Enter the code | Lands on the correct home screen per role — `/admin`, `/petrolCompany`, `/transport` |
| 4 | Reload the browser | Still signed in, no new code (this is the FR-060 fix — it fails today) |
| 5 | Enter a wrong code | One message, no attempt counter |
| 6 | Request codes until refused | Platform's `retryAfterSeconds` shown, not a locally invented one |
| 7 | Keep requesting | Challenge solves itself in a worker; no user interaction; sign-in proceeds |
| 8 | Sign in on 4 browser profiles | Profiles 2–4 keep working; profile 1 shows the device-limit message in Arabic |
| 9 | Sign out on profile 2 | Profiles 3–4 unaffected |
| 10 | "Forgot password" → code → new password | New password works; every profile signed out |
| 11 | Sign in with a DRIVER's number | Identical neutral screen; **no SMS arrives** |
| 12 | Toggle to English | Every new screen fully translated, LTR correct |

### 4.1 Final gate

```bash
cd e:/zeyad/ciro_fuel_backend && npm run lint:check && npm run build && npm run test && npm run test:e2e
cd E:/zeyad/web_dashboard_ciro_fuel && npm run test && npx tsc -b --force && npm run test:e2e
cd ../ciro_fuel_backend/../mobile_app && flutter test
```

Against Part 0's baseline: backend and dashboard counts up (new suites), **mobile unchanged**.

---

## What cannot be verified without the real thing

- **Part 4 steps 1 and 11** need a live Taqnyat account with the `ciro` sender approved and a real
  handset. Everything else runs against `SMS_PROVIDER=none`.
- **A recipient rejection** (FR-004) — insufficient balance, a blocked prefix — is verified against a
  simulated provider response, not by exhausting a real account's balance.
- **SC-014's 8-hour continuous session** is not a walkthrough step; it is an observation over a
  working day.

---

## Results

| Part | Date | Result | Notes |
|---|---|---|---|
| 0 | 2026-09-03 | PARTIAL | Backend `npm run build` **clean**; full `tsc --noEmit` **clean**. `npm run test` (unit) **250/253** — 3 failures are `assignment-escalation-queue.service.spec.ts`, which needs a live Redis the build machine lacks (Docker Desktop unresponsive), not a regression. `npm run lint:check` **not usable** on this Windows checkout: `core.autocrlf=true` + no `.gitattributes` → eslint-plugin-prettier flags `␍` on every line repo-wide (~38.9k errors), pre-existing; git normalises the index to LF so diffs/commits are clean. `npm run test:e2e` **not run** (no Redis, no `MongoMemoryReplSet`). Dashboard `vitest run` **92 passing / 19 files** (76 before this feature) + the 2 documented load failures; `tsc -b --force` reports only the ~30 pre-existing unused-import errors. Mobile `flutter test` **not run** — the mobile repo is not present on this machine. |
| 1 | — | NOT RUN | Needs a running server + Redis. Behaviours are covered by `test/e2e/admin-multi-session.e2e-spec.ts` and `test/e2e/mobile-session-unchanged.e2e-spec.ts` (written, not executed here). The Slice 0 `flutter test` gate (§1.6) **must** run before deploy per research R12 — the backend diff touches no mobile path. |
| 2 | — | NOT RUN | Needs a production boot + a real Taqnyat account. The start-up failure matrix (§2.1) is asserted directly against the Joi schema by `test/unit/sms-config-validation.spec.ts` (9/9), including the `SMS_API_KEY=''` case that `.invalid('')` exists for. |
| 3 | — | NOT RUN | Needs a running server + Redis + mongosh. Covered by `test/e2e/login-code.e2e-spec.ts` (enumeration parity, sid, single-use, four-refusals-one-refusal, cap participation) and `test/e2e/login-abuse.e2e-spec.ts` (rate limit → challenge, per-code lockout, cross-code block byte-identical to rate-limit 429, self-expiring block, registered/unregistered indistinguishable, **fail-closed 503**, counters cleared on success). §3.1 (`normalize-admin-phones.ts`) must be run per-environment before deploy. |
| 4 | — | NOT RUN | Needs the dashboard dev server + a real Taqnyat account + a handset. Dashboard behaviours are covered by Vitest (`login-signin`, `token-store`, `proof-of-work`, `bootstrap-session` SESSION_LIMIT_EXCEEDED, `api-client.refresh` 5-way burst) and a mocked-platform Playwright journey (`tests/e2e/signin-code.spec.ts`, not executed here). |

### T041a — deployment runbook step (per-environment, before the schema deploy)

`scripts/normalize-admin-phones.ts` MUST run against **each** target environment **before** the
code carrying the extended partial unique phone index (T044) is deployed there. `autoIndex` is on,
so the index builds at boot and **fails** while any admin document's `phone` is not E.164 (the
seeded SUPER_ADMIN's literal `'N/A'`), which stops the service starting.

```bash
# 1. dry run — list every admin with a non-E.164 phone (exit 1 if any)
npm run normalize:admin-phones
# 2. assign real numbers and/or deactivate the rest, then re-check
npm run normalize:admin-phones -- --map '{"owner@example.com":"+9665XXXXXXXX"}' --deactivate-unmapped
# 3. only when it reports 0 offenders remaining → deploy the code with T044's index
```

`scripts/seed-super-admin.ts` now requires `SUPER_ADMIN_PHONE` in E.164 form.
