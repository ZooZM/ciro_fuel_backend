# Configuration Contract

**Feature**: `015-dashboard-auth-taqnyat-sms` | **Date**: 2026-09-03

Every setting this feature adds or changes, and the exact Joi shape each needs.

---

## 1. Taqnyat — activation and the two validation holes

### What the deployment supplies, and what it maps to (FR-009)

| Supplied name | Platform setting | Value |
|---|---|---|
| `SMS_SENDER` | `SMS_SENDER_ID` | `ciro` |
| `SMS_BEARER_TOKEN` | `SMS_API_KEY` | *(secret)* |
| `SMS_ENDPOINT_URL` | `SMS_ENDPOINT_URL` | `https://api.taqnyat.sa/v1/messages` |
| *(implied)* | `SMS_PROVIDER` | `taqnyat` |
| *(the message field)* | — | already `body` in `TaqnyatSmsSender`; no setting |

No rename, no new secret, no new IAM binding, no manifest change — `SMS_API_KEY` is already in the
secrets manifest, which is the whole reason `validation.ts` chose that name over a provider-specific
one.

### The change

`SMS_API_KEY` and `SMS_SENDER_ID` are today unconditional and empty-permitting:

```ts
SMS_API_KEY:   Joi.string().allow('').default(''),
SMS_SENDER_ID: Joi.string().allow('').default(''),
```

so `SMS_PROVIDER=taqnyat` with either blank starts cleanly and every send then fails. Required shape:

```ts
SMS_API_KEY: Joi.string()
  .allow('')
  .default('')
  .when('SMS_PROVIDER', { is: 'taqnyat', then: Joi.string().min(1).invalid('').required() }),

SMS_SENDER_ID: Joi.string()
  .allow('')
  .default('')
  .when('SMS_PROVIDER', { is: 'taqnyat', then: Joi.string().min(1).invalid('').required() }),
```

> **`.invalid('')` is load-bearing and is NOT redundant with `.min(1)`.** Joi keeps the base schema's
> `.allow('')` when it merges the conditional one, and an explicitly-permitted value short-circuits
> every other rule — so `.min(1).required()` alone is silently satisfied by an empty string. This
> exact defect shipped twice in this repository (`CORS_ALLOWED_ORIGINS`, then `GCS_BUCKET`), and both
> carry comments in `validation.ts` warning about it. Writing the naive version here makes it three.

`SMS_PROVIDER` itself needs no change: it already validates against
`('none','taqnyat','unifonic','twilio')` and already `.invalid('none').required()` in production.

### `.env.example`

```
SMS_PROVIDER=taqnyat
SMS_API_KEY=                       # Taqnyat bearer token (SMS_BEARER_TOKEN)
SMS_SENDER_ID=ciro                 # must be an approved sender on the Taqnyat account
SMS_ENDPOINT_URL=https://api.taqnyat.sa/v1/messages
```

Development and every e2e suite keep `SMS_PROVIDER=none`; the two conditional rules do not apply and
nothing about the existing test environment changes.

---

## 2. Session cap

| Setting | Type | Default | Requirement |
|---|---|---|---|
| `AUTH_MAX_ADMIN_SESSIONS` | integer ≥ 1 | `3` | FR-032, FR-042 |

```ts
AUTH_MAX_ADMIN_SESSIONS: Joi.number().integer().min(1).default(3),
```

A default is correct here — unlike `TRUSTED_PROXY_HOPS` (spec 012), guessing wrong is a UX
inconvenience, not a silently wrong security posture, and `1` remains a valid value that reproduces
today's displacement behaviour for administrators.

Surfaced as `auth.maxAdminSessions`.

---

## 3. Sign-in code and abuse controls

| Setting | Type | Default | Requirement |
|---|---|---|---|
| `LOGIN_OTP_EXPIRY_MINUTES` | number > 0 | `5` | FR-013 |
| `LOGIN_OTP_MAX_ATTEMPTS` | integer ≥ 1 | `5` | FR-024 |
| `LOGIN_OTP_MAX_REQUESTS` | integer ≥ 1 | `3` | FR-021 |
| `LOGIN_OTP_WINDOW_MINUTES` | number > 0 | `15` | FR-021 |
| `LOGIN_OTP_CHALLENGE_AFTER` | integer ≥ 1 | `2` | FR-023 |
| `LOGIN_OTP_FAIL_THRESHOLD` | integer ≥ 1 | `10` | FR-025 |
| `LOGIN_OTP_BLOCK_MINUTES` | number > 0 | `60` | FR-025, FR-026 |

The first four **deliberately mirror the `PASSWORD_RESET_*` defaults** already in `validation.ts`
(5 / 5 / 3 / 15). One security posture across both anonymous code flows; two sets that drift apart
is how one of them quietly becomes the weak one.

Surfaced under `loginOtp.*`.

---

## 4. Proof-of-work

| Setting | Type | Default | Requirement |
|---|---|---|---|
| `LOGIN_POW_DIFFICULTY_BITS` | integer 0–32 | `18` | R7, FR-023 |
| `LOGIN_POW_SEED_TTL_SECONDS` | integer ≥ 30 | `300` | R7 |

**`0` disables the search** (any nonce satisfies zero leading zero bits) and is what the e2e
environment sets, so no suite spends CPU solving a challenge and no suite becomes timing-flaky.
`0` must remain reachable in production too — it is the escape hatch if the challenge ever proves
to be the thing keeping a legitimate administrator out.

Surfaced under `loginOtp.pow.*`.

---

## 5. Super-admin seeding — changed (research R5)

`SUPER_ADMIN_PHONE` becomes required and E.164-validated where `scripts/seed-super-admin.ts`
currently hardcodes `phone: 'N/A'`. A placeholder administrator phone is no longer acceptable,
because an administrator's phone is now a login identifier and the extended unique index cannot be
created while placeholders collide.

Existing `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_FULL_NAME` are unchanged.

---

## 6. Dashboard

| Setting | Change |
|---|---|
| `VITE_API_BASE_URL` | unchanged |

No new dashboard environment variable. The proof-of-work is self-hosted, so there is no site key and
no vendor origin to add to any CSP (research R7) — one of the reasons it was chosen over a
third-party CAPTCHA.

---

## 7. Start-up failure matrix

What must refuse to boot, and what must not:

| `NODE_ENV` | `SMS_PROVIDER` | `SMS_API_KEY` | `SMS_SENDER_ID` | Outcome |
|---|---|---|---|---|
| production | `none` | — | — | **fails** — existing rule, must remain |
| production | `taqnyat` | *unset* | `ciro` | **fails**, naming `SMS_API_KEY` |
| production | `taqnyat` | `""` | `ciro` | **fails** — this is the case `.invalid('')` exists for |
| production | `taqnyat` | *set* | *unset* or `""` | **fails**, naming `SMS_SENDER_ID` |
| production | `taqnyat` | *set* | `ciro` | starts |
| development / test | `none` | *unset* | *unset* | starts — unchanged |
| development | `taqnyat` | `""` | `""` | **fails** — the conditional keys on `SMS_PROVIDER`, not on `NODE_ENV`, so a developer pointing at the real provider is told immediately rather than sending nothing |

The last row is a deliberate choice: conditioning on the provider rather than the environment means
the failure is loud wherever someone believes they configured Taqnyat.
