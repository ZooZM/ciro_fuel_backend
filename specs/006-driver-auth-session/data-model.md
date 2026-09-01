# Phase 1 Data Model: Driver Authentication & Session

One new field on an existing collection, two new collections, three new enums. Everything
else this feature needs already exists.

---

## Changed: `User` (`src/modules/users/schemas/user.schema.ts`)

| Field | Type | Rules |
|---|---|---|
| `sessionGeneration` | `number` | `default: 0`, `min: 0`. Incremented on every revocation event. Compared against the JWT's `sgen` on every authenticated request and socket handshake. |

**Migration**: none required. Documents without the field read as `undefined`; tokens issued
before this feature carry no `sgen`. Both sides normalize to `0`, so every session in
circulation survives the deploy (research R1).

**No index.** The field is only ever read from a document already fetched by `_id`, and only
ever written by `_id`. An index would serve no query.

---

## Changed: `JwtPayload` (`src/common/interfaces/jwt-payload.interface.ts`)

| Field | Type | Rules |
|---|---|---|
| `sgen` | `number \| undefined` | The `sessionGeneration` in force when the pair was issued. Optional so pre-existing tokens stay valid; absent is treated as `0`. |

Carried on both the access and the refresh token — refresh must be revocable, or a revoked
session would renew itself.

---

## New: `PasswordReset` (`src/modules/auth/schemas/password-reset.schema.ts`)

A short-lived proof that an anonymous requester controls the phone number on an account.
Modelled on `PhoneVerification`, which solves the same problem for an authenticated caller.

| Field | Type | Rules |
|---|---|---|
| `userId` | `ObjectId` → `User` | required, immutable |
| `phone` | `string` | required. The E.164 number the code was sent to, captured at issue so a later phone change cannot redirect an outstanding reset. |
| `hash` | `string` | required. Salted SHA-256 of the code. |
| `salt` | `string` | required |
| `expiresAt` | `Date` | required. Issue time + 5 minutes. |
| `attempts` | `number` | `default: 0`. Max 5, then the record is refused. |
| `verifiedAt` | `Date?` | Set when the code is accepted. Opens the window in which a new password may be set. |
| `resetTokenHash` | `string?` | Set alongside `verifiedAt` — SHA-256 of the opaque `resetToken` `POST /auth/password-reset/verify` returns to the caller. Added during implementation: the contract needed *some* single-use bearer credential to carry into `complete`, and the record's own `_id` is unsuitable for that — a Mongo ObjectId is not cryptographically random (it embeds a timestamp and counter), so using it as a bearer secret would be guessable in a way a real token must not be. A fresh random token is generated at verify time and only its hash is ever stored, the same hash-at-rest discipline `hash`/`salt` already apply to the code itself. |
| `consumedAt` | `Date?` | Set when the password is actually changed. A record with `consumedAt` is inert. |
| `createdAt` | `Date` | from `timestamps` |

**Never stores the plaintext code, or the plaintext reset token.** The code exists in the
Redis cache (via `OtpPrimitivesService`) and in the SMS; the reset token exists only in the
`200` response body that returns it once, nowhere else.

**Indexes**
- `{ userId: 1, consumedAt: 1 }` — finding the active record for an account.
- `{ resetTokenHash: 1 }` — the lookup `complete` performs.
- `{ expiresAt: 1 }, { expireAfterSeconds: 0 }` — TTL; expired records self-delete.

**Tenant scoping: EXEMPT — deliberately not `markTenantScoped`.** Recovery runs before
authentication, so no `companyId` exists in `AsyncLocalStorage` for the plugin to inject; a
scoped query would match nothing and every recovery would fail. Reached only via
`TenantContextService.runUnscoped`, the same mechanism `PhoneVerificationService` already uses
to look up a phone across tenants. Recorded in the plan's Complexity Tracking.

**Invariants**
1. At most one record per user without `consumedAt` — issuing supersedes by deleting prior
   unconsumed records first (FR-023, matching `PhoneVerificationService.requestVerification`).
2. `verifiedAt` must precede `consumedAt`; a password cannot be set on an unverified record.
3. A record is inert once `consumedAt` is set, `expiresAt` has passed, or `attempts` reaches 5.

**Lifecycle**

```
issued ──verify ok──▶ verified ──set password──▶ consumed (inert)
   │                     │
   ├──5 wrong attempts──▶ locked out (inert, resend required)
   ├──expiry reached ───▶ expired (TTL-deleted)
   └──new code issued ──▶ superseded (deleted)
```

---

## New: `SessionEvent` (`src/modules/sessions/schemas/session-event.schema.ts`)

The audit trail for FR-043–046. Append-only; nothing updates or deletes a row.

| Field | Type | Rules |
|---|---|---|
| `userId` | `ObjectId` → `User` | required, immutable |
| `companyId` | `ObjectId?` → `Company` | **Optional.** Drives tenant scoping. Absent only for `SUPER_ADMIN`, who has no `companyId` on `User` at all and is exempt from tenant isolation — see the post-design note in `plan.md`. Present for every driver, which is what FR-043/044 concern. |
| `role` | `UserRole` | required. Denormalized so a historical row stays readable if the account changes. |
| `type` | `SessionEventType` | required, enum |
| `cause` | `SessionRevocationCause?` | Present on revocation events; absent on `SIGNED_IN`, `RECOVERY_REQUESTED` and `RECOVERY_VERIFY_FAILED`. |
| `generation` | `number` | required. The `sessionGeneration` after the event, so a row ties to the exact session it concerns. |
| `occurredAt` | `Date` | required, `default: Date.now` |
| `createdAt` | `Date` | from `timestamps` |

**Never stores** credentials, tokens, codes, passwords, IP addresses, or anything from which
a session could be reconstructed (FR-045).

**Indexes**
- `{ userId: 1, occurredAt: -1 }` — the reconstruction query FR-044 exists for: which session
  did this driver hold at time T.
- `{ companyId: 1, occurredAt: -1 }` — an administrator reviewing their own fleet.

**No TTL index**, unlike `PasswordReset`. These records must outlive the deliveries they
explain (research R7).

**Tenant scoping: YES — `markTenantScoped`.** Single owning company per row; the original
`companyId`-equality plugin is exactly right. Not a multi-party document. A `SUPER_ADMIN` row
carries no `companyId`, which is consistent — that role is already exempt from tenant isolation
platform-wide.

---

## New enums

### `SessionEventType` (`src/common/enums/session-event-type.enum.ts`)

| Value | Written when |
|---|---|
| `SIGNED_IN` | A token pair is issued by `/auth/login` |
| `SIGNED_OUT` | The driver signs out deliberately via `/auth/logout` |
| `REVOKED` | The session is ended by anything other than the driver's own sign-out |
| `RECOVERY_REQUESTED` | A password-reset code is issued **for a phone number that resolves to an account** (FR-028). Written only in that case — the required `userId`/`companyId` on this collection mean a probe against a nonexistent number has no account to attach the row to, and FR-021's enumeration guarantee already lives entirely in `POST /auth/password-reset/request`'s identical response, not in whether an audit row exists. An anonymous probe is governed by FR-025's rate limiter, not by this trail. |
| `RECOVERY_VERIFY_FAILED` | A submitted recovery code does not match, is expired, or is locked out (FR-028) |

### `SessionRevocationCause` (`src/common/enums/session-revocation-cause.enum.ts`)

| Value | Meaning | Message shown (FR-036) |
|---|---|---|
| `SIGNED_IN_ELSEWHERE` | Displaced by a sign-in on another device (FR-042) | "You signed in on another device" |
| `PASSWORD_RESET` | A recovery flow completed (FR-027) | "Your password was changed" |
| `ACCOUNT_DEACTIVATED` | The account was deactivated (FR-035) | "Your account is no longer active" |

The app maps the cause to a localized message; it never renders the enum value or matches on
message text (Principle I, Principle III).

### `ErrorCode` additions (`src/common/enums/error-code.enum.ts`)

| Value | HTTP | Meaning |
|---|---|---|
| `RESET_CODE_INVALID` | 400 | Code wrong, expired, superseded, or attempt-limited. Deliberately one code for all four — distinguishing them tells an attacker which wall they hit. |
| `RESET_RATE_LIMITED` | 429 | Recovery request refused; carries `retryAfterSeconds` (FR-025). |
| `SESSION_REVOKED` | 401 | Carries a `cause` so the app can state which of the three applies. |

---

## Entity relationships

```
Company ──1:N──▶ User (DRIVER)
                  │  sessionGeneration : the live session's identity
                  │  truck (embedded)  : shown on the profile (FR-003)
                  │
                  ├──1:N──▶ SessionEvent    (append-only history, retained)
                  └──0:1──▶ PasswordReset   (at most one active, TTL-expired)
```

`PasswordReset` and `SessionEvent` are both per-user and never shared across companies —
neither is a multi-party document, so neither touches `multi-party-scope.plugin.ts`.

---

## What is deliberately NOT modelled

- **A device or unlock preference record.** The lock is mandatory and unconfigurable
  (FR-010/FR-011), so there is no setting to store — on the device or on the server. This is
  the concrete data-model consequence of clarification Q4, which replaced the spec's original
  "Device unlock preference" entity with a challenge that has no state.
- **A `Session` document.** FR-042 permits one session per driver, so a counter expresses the
  rule and a collection would only add per-request cost (research R1).
- **Per-request access logs.** Explicitly excluded by FR-046.
