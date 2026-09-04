# REST API Delta: Web Dashboard Authentication & Taqnyat SMS Provider

**Feature**: `015-dashboard-auth-taqnyat-sms` | **Date**: 2026-09-03

Delta against `specs/001-fuel-delivery-platform/contracts/rest-api.md`. Base path `/api/v1`.

**Three new endpoints. Two existing endpoints change behaviour without changing their payloads.**

---

## 1. `POST /auth/login/code/request` — NEW

Requests a sign-in code for a mobile number. `@Public()`.

**Request**

```json
{ "phone": "+9665XXXXXXXX", "challenge": { "seed": "…", "nonce": "…" } }
```

- `phone` — required, E.164 (`E164_PATTERN`, the same validator `LoginDto` uses).
- `challenge` — optional. Required **only** after `LOGIN_OTP_CHALLENGE_AFTER` rate-limited requests
  for this number (FR-023); see §3.

**Response — `202 Accepted`**

```json
{ "expiresInMinutes": 5, "attemptsAllowed": 5 }
```

> **This response is returned for every outcome** (FR-015): the number belongs to an administrator, to
> a driver, to a client, to nobody, to an inactive account, or to more than one account; and whether
> the SMS send succeeded or failed. Constant status, constant body. Any branch on the lookup result
> that reaches the caller is a defect — `PasswordResetService.requestReset` is the precedent to
> follow, including its comment forbidding exactly that.

**A code is created and sent only when** the number resolves to **exactly one** account that is
`isActive` and holds SUPER_ADMIN, FUEL_COMPANY_ADMIN or TRANSPORT_COMPANY_ADMIN (FR-014). Zero
matches, two or more matches, an inactive account, or a DRIVER/CLIENT match all produce the response
above and **no** SMS.

**Error responses**

| Status | `error` | When | Body |
|---|---|---|---|
| `400` | `CHALLENGE_REQUIRED` | a challenge is now required, or the one supplied was absent/invalid/replayed | `{ error, challenge: { seed, difficultyBits }, message }` |
| `429` | `LOGIN_RATE_LIMITED` | per-phone request limit exceeded (FR-021/022) | `{ error, retryAfterSeconds, message }` |
| `429` | `LOGIN_RATE_LIMITED` | the number is temporarily blocked (FR-025) | same shape — **deliberately indistinguishable from the line above** |
| `503` | — | the counter store is unavailable (FR-030, fail closed) | generic |

Both 429 cases must be identical to a caller. Distinguishing "you are rate limited" from "you are
blocked" tells an attacker which wall they hit, the same reasoning `RESET_CODE_INVALID` applies to
its four states.

Also subject to the existing global IP throttle. `@Throttle({ default: { limit: 10, ttl: 60_000 } })`
matches `/auth/login`'s decoration.

---

## 2. `POST /auth/login/code/verify` — NEW

Exchanges a phone and a code for a session. `@Public()`.

**Request**

```json
{ "phone": "+9665XXXXXXXX", "code": "123456" }
```

- `code` — required, exactly 6 digits (FR-012).

**Response — `200 OK`** — byte-identical in shape to `POST /auth/login` (FR-016):

```json
{
  "accessToken": "…",
  "refreshToken": "…",
  "user": { "id": "…", "role": "FUEL_COMPANY_ADMIN", "companyId": "…", "fullName": "…", "email": "…" }
}
```

Both tokens carry `sid` in addition to `sub`, `role`, `companyId`, `sgen`.

**Side effects** — all inside one transaction (Principle V):
1. The `LoginCode` record is marked `consumedAt`.
2. A new `ActiveSession` is pushed onto the user; if the cap is exceeded the oldest is removed.
3. A `SIGNED_IN` `SessionEvent` is written; if a session was evicted, a `REVOKED` event with
   `cause: SESSION_LIMIT_EXCEEDED` is written for it.
4. `login-otp:rate:{phone}` and `login-otp:fails:{phone}` are cleared (FR-029).

**No `session:revoked` socket push is emitted, and `disconnectUser` is not called** (research R3) —
the room is per-user, so either would sign the administrator out of the devices this feature exists
to keep working.

**Error responses**

| Status | `error` | When |
|---|---|---|
| `400` | `LOGIN_CODE_INVALID` | wrong code, expired, superseded, or attempt-locked-out — **one refusal for all four** (FR-017). No attempt count in the body. |
| `429` | `LOGIN_RATE_LIMITED` | the number is temporarily blocked (FR-025) |
| `503` | — | counter store unavailable (FR-030) |

---

## 3. Proof-of-work challenge

Issued in the `400 CHALLENGE_REQUIRED` body of §1 and returned on the next request.

```
seed            32 random bytes, hex. Single-use, held in Redis with a TTL.
difficultyBits  leading zero bits required of sha256(seed || nonce). 0 in the test environment.
```

The client searches for a `nonce` (a decimal string) satisfying the condition and resends the request
with `challenge: { seed, nonce }`. The platform verifies the hash, then **deletes the seed** — a
solved challenge is not replayable.

An expired, unknown, already-consumed, or unsatisfying pair is refused with the same
`CHALLENGE_REQUIRED` and a **fresh** seed.

---

## 4. `POST /auth/login` — behaviour changed, payload unchanged

Request and response are untouched (FR-064). What changes is what happens to prior sessions:

| Caller role | Before | After |
|---|---|---|
| DRIVER, CLIENT | every prior session displaced; `session:revoked` pushed; sockets disconnected | **unchanged** |
| Admin roles | same as above | a session is **opened**; prior sessions survive up to the cap; oldest evicted beyond it; **no push, no disconnect** |

Both tokens now carry `sid` for admin roles.

---

## 5. `POST /auth/logout` — behaviour changed, payload unchanged

`204` on success, as today.

| Caller role | Before | After |
|---|---|---|
| DRIVER, CLIENT | `sessionGeneration` bumped — the one session ends | **unchanged** |
| Admin roles | all sessions ended | **only the calling `sid` is closed**; other devices continue (FR-035) |

The `sid` is read from the authenticated request's own token — carried on `AuthenticatedUser`, which
`JwtStrategy.validate` stamps from the verified payload (`data-model.md` §4). There is no request
body and no way to sign another device out. A "manage my devices" surface is explicitly out of scope.

> Without `sid` on `AuthenticatedUser` this endpoint cannot name the session it is ending and FR-035
> cannot be built. This is the one place a handler is permitted to read it.

---

## 6. `POST /auth/refresh` — behaviour changed, payload unchanged

Additionally refuses when the presented refresh token's `sid` is no longer in `activeSessions`
(FR-039), with the existing structured shape:

```json
{ "error": "SESSION_REVOKED", "cause": "SESSION_LIMIT_EXCEEDED", "message": "Your session has ended" }
```

`cause` may now be `SESSION_LIMIT_EXCEEDED` in addition to the four existing values. The dashboard's
interceptor already routes any `SESSION_REVOKED` straight to the session-expired handler without
attempting a refresh, so no client-side change is needed for the new value beyond its message.

> **The renewed token pair MUST carry the SAME `sid` the presented refresh token carried.** Refresh
> re-issues a credential for an existing session; it does not open a new one. If `issueTokenPair`
> generates a fresh `sid` here, that value is not in `activeSessions`, so the very next request with
> the renewed token is refused — every administrator session would die silently one access-token
> lifetime after sign-in, and the symptom (periodic forced re-login) looks nothing like its cause.
> `sid` is therefore an explicit input to `issueTokenPair`, never something it invents.

---

## 7. Every authenticated endpoint — one added check

`UsersService.validateActiveSessionWithScoping` — reached by `JwtStrategy.validate` and by
`authenticateSocket` — gains, **after** its existing `sgen` comparison:

```
if the payload carries a role in { SUPER_ADMIN, FUEL_COMPANY_ADMIN, TRANSPORT_COMPANY_ADMIN }:
    the payload's `sid` MUST be present and MUST appear in user.activeSessions
```

Refusal reuses the existing `SESSION_REVOKED` + `cause` response. **The check is skipped entirely for
DRIVER and CLIENT**, whose payloads carry no `sid` — that skip is what makes FR-033 structural.

`TrackingGateway`'s per-frame `sgen` comparison is **not** changed (research R4): its only caller is
`location:update`, a driver-only handler.

---

## 8. Password recovery — unchanged

`POST /auth/password-reset/request`, `/verify`, `/complete` keep their existing contracts entirely
(FR-074). Two behaviours around them change:

- The code now actually arrives, because Taqnyat is live.
- Completing a reset clears `activeSessions` in addition to bumping `sessionGeneration`, so an
  administrator's every device ends (FR-036/FR-072).

---

## 9. Not added

- No endpoint to list or end an administrator's other sessions.
- No endpoint that reports whether a phone number belongs to an account — that is the property §1
  exists to deny.
- No endpoint that returns a code. `NoopSmsSender`'s development log line remains the only way to
  read one, and only when `SMS_PROVIDER=none`.
