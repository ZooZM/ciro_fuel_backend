# REST API Delta — Driver Authentication & Session

Additions to `specs/001-fuel-delivery-platform/contracts/rest-api.md`. Every response uses
the platform's existing error envelope, produced by `HttpExceptionFilter`; application-level
cases are distinguished by the `error` field (an `ErrorCode`), never by message text.

Base path: `/api/v1`.

---

## Changed: `GET /users/:id`

**Auth**: the caller viewing their own profile, or an admin scoped to view it — the existing
`findOne` authorization is unchanged.

**Not `/auth/me`.** An earlier draft of this contract targeted `/auth/me`, on the assumption
that it was the app's one identity source. It is a session-identity source; `AuthUser` — the
type it populates — has no `email`, `phone`, or photo field at all, so it cannot carry what
FR-001 needs. `GET /users/:id` is the endpoint the app's own `ProfileRemoteDataSource` already
calls for exactly this data (see research R6 for how this was caught during implementation).
`/auth/me` is untouched by this feature.

Adds one field. `truck` **already appears in this response today** — the endpoint returns the
raw user document with no projection, so an embedded subdocument like `truck` costs nothing
new; only `companyName` is genuinely added.

```jsonc
{
  "_id": "...", "role": "DRIVER", "companyId": "...",
  "fullName": "...", "email": "...", "phone": "...", "isActive": true,
  "truck": {                                // already present today; undefined if unassigned (FR-003)
    "plateNumber": "ABC 1234",
    "maxCapacityLiters": 30000,
    "fuelTypes": ["DIESEL", "PETROL_95"],
    "model": "Volvo FH16"                   // optional
  },

  // NEW — present only when role === DRIVER, undefined for every other role
  "companyName": "شركة النقل السريع"
}
```

`companyName` costs one `CompaniesService.findById(user.companyId)` lookup, mirroring how
`/auth/me`'s `resolveStation` already does one extra lookup for CLIENT. `CompaniesService` is
already available: `UsersModule` imports `CompaniesModule`.

**Client-app impact**: none for the CLIENT persona — `companyName` is undefined for every
non-DRIVER role, and every existing field this endpoint returns is unchanged.

---

## New: `POST /auth/logout`

**Auth**: any authenticated role. **Requirements**: FR-029, FR-030, FR-031, FR-043.

Ends the caller's session at the server by incrementing `sessionGeneration`, which
invalidates both the access and the refresh token issued against the previous value.

**Request**: no body.

**Response `204 No Content`.**

Runs in a `ClientSession`: the generation bump and the `SIGNED_OUT` audit row commit together
or not at all (Principle V).

**FR-031 — offline sign-out.** The app calls this endpoint but **must not** await it as a
precondition for clearing local state. A network failure is logged and ignored client-side;
local credentials are cleared regardless, and the driver lands on the login screen. The
server-side session then expires naturally. A driver must never be trapped in a session they
cannot leave because they are out of coverage.

---

## New: `POST /auth/password-reset/request`

**Auth**: public (`@Public()`). **Requirements**: FR-019, FR-020, FR-021, FR-023, FR-025.

**Throttle**: `@Throttle({ default: { limit: 10, ttl: 60_000 } })` per IP, matching
`/auth/login`. Plus a per-account counter in Redis: **3 requests per 15 minutes**. The
per-account layer is the one that matters — carrier NAT puts thousands of drivers behind one
address, so IP throttling alone would be both ineffective and unfair.

**Request**

```json
{ "phone": "+9665XXXXXXX" }
```

**Response `202 Accepted` — identical for every outcome**

```json
{ "expiresInMinutes": 5, "attemptsAllowed": 5 }
```

**This response is returned unchanged when the number is not registered, when the code is
sent successfully, and when the SMS provider rejects the send.** That is deliberate and is
the single most important property of this endpoint (FR-021): any variation in status, body,
or timing tells an anonymous caller which phone numbers have accounts. A send failure is
recorded server-side for operators; the driver recovers by tapping resend.

This diverges from `POST /users/me/phone/verification`, which returns `502 SMS_SEND_FAILED`
on a rejected send. That endpoint is authenticated and has no anonymous caller to protect
against. See research R3 for the full reasoning.

**Errors**

| Status | `error` | When |
|---|---|---|
| 429 | `RESET_RATE_LIMITED` | Per-account limit exceeded. Body carries `retryAfterSeconds` so the app can state the wait (FR-025). |

> The 429 is itself a weak existence signal. It is accepted: rate-limit state must be keyed to
> something, refusing anonymously would let an attacker exhaust a real driver's quota, and the
> per-account counter is what makes the limit meaningful at all.

**Side effects**: deletes any prior unconsumed `PasswordReset` for the account before creating
the new one, so only the most recent code is ever accepted (FR-023).

---

## New: `POST /auth/password-reset/verify`

**Auth**: public. **Requirements**: FR-022, FR-024.

Checks the code without changing the password, so the app can show a clear error at the
code-entry step rather than at submission.

**Request**

```json
{ "phone": "+9665XXXXXXX", "code": "123456" }
```

**Response `200 OK`**

```json
{ "resetToken": "<opaque, single-use>", "expiresInMinutes": 5 }
```

The `resetToken` is the proof carried into the next call. It is not a session token: it
authorizes exactly one password change, on one account, and is inert afterwards.

**Errors**

| Status | `error` | When |
|---|---|---|
| 400 | `RESET_CODE_INVALID` | Code wrong, expired, superseded, already used, or attempt limit reached. |

**One code for four conditions, deliberately.** Distinguishing "expired" from "wrong" from
"locked out" tells an attacker which wall they hit and confirms the account exists. The app
shows one message and offers resend.

**`attemptsRemaining` is never returned on this endpoint at all** — an earlier draft of this
contract returned it only when a record existed and the code was simply wrong, which is
itself an enumeration leak: its *absence* would then mean "no such account", the exact signal
FR-021 exists to close, just relocated from the request endpoint to this one. The app tracks
its own attempt count locally (it already knows the limit is 5 from the request endpoint's
`attemptsAllowed`) and never relies on the server to report it back per attempt.

**Side effects**: `attempts` is incremented on a mismatch; `verifiedAt` is set on a match.

---

## New: `POST /auth/password-reset/complete`

**Auth**: public, authorized by `resetToken`. **Requirements**: FR-026, FR-027, FR-043.

**Request**

```json
{ "resetToken": "...", "newPassword": "..." }
```

**Response `204 No Content`.**

The driver is **not** signed in by this call. They return to the login screen and sign in with
the new password — which is also what proves to them that it took.

**Errors**

| Status | `error` | When |
|---|---|---|
| 400 | `RESET_CODE_INVALID` | Token unknown, expired, or already consumed. |
| 400 | `ValidationError` | New password fails the platform's existing password rules. The app states those rules before submission (FR-026), so this is a backstop. |

**Transaction (Principle V)** — all four writes commit together or none do:

1. `passwordHash` updated
2. `sessionGeneration` incremented → every session for the account dies (FR-027)
3. `PasswordReset.consumedAt` set → the token becomes inert
4. `SessionEvent{ type: REVOKED, cause: PASSWORD_RESET }` written

A consumed code without a changed password, or a changed password whose old sessions survive,
are both exactly the partial writes this transaction prevents.

---

## Changed: `POST /auth/login`

**Requirements**: FR-042, FR-043.

Behaviour added, contract unchanged. On success the service now increments
`sessionGeneration` before issuing the pair, which **displaces any existing session for that
driver** — the previous device's tokens stop validating immediately, and it is notified over
the socket (see `realtime-events-delta.md`).

Writes a `SessionEvent{ type: SIGNED_IN }`. When a session was displaced, also writes
`SessionEvent{ type: REVOKED, cause: SIGNED_IN_ELSEWHERE }` for the session that ended.

Request and response shapes are unchanged, so no client change is required to sign in.

---

## Changed: `POST /auth/refresh`

**Requirements**: FR-027, FR-029, FR-035b.

Now validates the refresh token's `sgen` against the user's current `sessionGeneration` and
refuses on mismatch with `401`. Without this a revoked session could renew itself, and every
revocation in this feature would last only until the next silent refresh.

Response shape unchanged.

---

## Changed: `PATCH /users/:id/deactivate`

**Requirements**: FR-035, FR-038, FR-043.

Now also increments the target's `sessionGeneration`, pushes `session:revoked` to their
device, and writes `SessionEvent{ type: REVOKED, cause: ACCOUNT_DEACTIVATED }` — all in one
transaction with the deactivation itself.

**FR-038** — an order the driver was carrying keeps its existing release path. Deactivation
does not invent a new order state: the driver's `activeOrderId` is cleared and the order
returns to the reassignable state the platform already uses when a driver is released from an
order (see `orders.service.ts`), so an administrator can reassign it.

---

## Cross-cutting: the `SESSION_REVOKED` response

Any authenticated request presenting a token whose `sgen` no longer matches receives:

```json
{ "statusCode": 401, "error": "SESSION_REVOKED", "cause": "SIGNED_IN_ELSEWHERE", "message": "..." }
```

The app reads `cause` to choose which localized message to show (FR-036) and must not match
on `message`. This is the HTTP backstop (FR-035b); the socket push and the handshake refusal
are the primary and fallback paths respectively.
