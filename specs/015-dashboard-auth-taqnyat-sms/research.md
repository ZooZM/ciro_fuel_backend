# Research: Web Dashboard Authentication & Taqnyat SMS Provider

**Feature**: `015-dashboard-auth-taqnyat-sms` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

Twelve decisions. **R1, R3, R5, R6 and R9 each overturn something the spec, the clarification
session, or the existing code assumed.** R1 and R12 together decide the implementation order.

---

## R1 — Where per-session identity lives

**Decision**: A bounded `activeSessions` array on the `User` document, plus a new `sid` claim on the
JWT. `sessionGeneration` is **retained with its exact current meaning** and becomes the "revoke
everything" epoch; `sid` membership is the "is *this* session still open" check. The two run
together in the one place that already loads the user.

**Rationale**: `UsersService._loadActiveUser` already performs `userModel.findById(userId)` on
**every authenticated REST request** (`JwtStrategy.validate`) **and every `/tracking` handshake**
(`authenticateSocket`). Checking array membership on a document already in hand costs nothing. The
cap is 3, so the array is permanently tiny and needs no pagination, no projection and no separate
index.

Eviction is **by creation order, not by last use**. FR-038 says "the oldest session"; ordering by
`createdAt` needs no write on the request path, whereas an LRU policy would require touching the
user document on every single request — a write amplification the platform would feel immediately.

**The role split is the whole point.** Admin roles get a `sid` and an array entry. DRIVER and CLIENT
get **neither**: their login keeps bumping `sessionGeneration` exactly as it does today, their
tokens carry no `sid`, and `validateActiveSessionWithScoping` only consults the array when the
payload has one. That is what makes FR-033/SC-013/SC-020 true by construction rather than by
regression testing.

**Backward compatibility is deliberately not offered for admins.** An existing admin access token
has no `sid`; it will be refused and the administrator signs in again once. Accepting an absent
`sid` for an admin would leave a permanent bypass of the entire session cap, and the platform is
pre-production (the same reasoning spec 008's Slice 0 cutover used).

**Alternatives considered**:
- *A separate `AuthSession` collection.* Cleaner conceptually and better for a future "your devices"
  screen, but it adds a second query to the platform's hottest path — every request and every
  handshake. Rejected on cost; revisit if per-session metadata ever grows beyond an id and a
  timestamp.
- *Redis-held session set.* Rejected outright. Spec 012's Q7 already made Redis load-bearing for
  five subsystems and deliberately kept a cache-less instance in rotation; making **authentication**
  the sixth would mean a cache blip logs every administrator out, or — worse — fails open.
- *Short-lived access tokens with no server-side check.* Cannot satisfy FR-035 (sign out this device
  only) or FR-038 (evict the oldest) at all.

---

## R2 — What revokes what, and the primitive that is doing three different jobs

**Decision**: Replace the single overloaded `revokeSession` with three explicit primitives, and make
each caller name the one it means.

`UsersService.revokeSession` is currently called by three callers with three different intentions,
which is invisible today only because all three want the same effect:

| Caller | Intent today | Intent after this feature |
|---|---|---|
| `AuthService.login` | displace the prior session | **driver/client only** — admins open a session instead |
| `AuthService.logout` | end the session | **end only this `sid`** for admins; unchanged for mobile |
| `UsersController` deactivate | end everything | end everything, for every role |
| `revokeAndSetPassword` (password reset) | end everything | end everything, for every role |

New primitives:
- `revokeAllSessions(userId, cause?, session?)` — bumps `sessionGeneration` **and** empties
  `activeSessions`. Used by password reset, deactivation, and mobile login/logout. This is
  today's `revokeSession` plus one `$set`.
- `openSession(userId, sid, cap, session)` — admin only. Pushes `{ sid, createdAt }`, evicts the
  oldest beyond `cap`, returns the evicted `sid` (if any) so the caller can write its audit row.
- `closeSession(userId, sid, session)` — admin only. `$pull`s one entry. Does **not** touch
  `sessionGeneration`, which is precisely what leaves the administrator's other devices working.

**Rationale**: the overload is exactly the kind of thing that ships a plausible defect — a reviewer
reading `revokeSession(userId)` at the logout call site has no way to see that it now means "end
every device" for one role and "end this device" for another. Naming the intent makes the role split
reviewable.

**Atomicity**: `openSession` and its audit row commit in the caller's existing
`session.withTransaction` (Principle V), the same shape `AuthService.login` already uses. An evicted
session recorded without being evicted, or evicted without a record, are both partial writes.

---

## R3 — Do **not** push `session:revoked` when a session is evicted

**Decision**: The evicted administrator's device learns on its **next platform contact**, via
`validateActiveSessionWithScoping`. No socket push is emitted for eviction, and
`RealtimeGatewayService.disconnectUser` is **no longer called on an admin login**.

**Rationale, and the defect this avoids**: the realtime room is `user:{userId}` — **per user, not
per session**. `AuthService.login` today calls `emitToUser(userId, 'session:revoked', …)` and
`disconnectUser(userId)` on *every* login. Left as-is under a multi-session model, an administrator
signing in on a laptop would push "your session ended" to **all three** of their own devices and
forcibly disconnect every socket they hold — turning the feature that was supposed to let them work
from two machines into one that logs them out of both.

Adding a `sid` to the event payload and filtering client-side was considered and rejected: both
Flutter clients also consume `session:revoked`, and FR-033/SC-020 forbid changes reaching them. The
push stays exactly as it is for DRIVER/CLIENT displacement — which is the only case it was ever
designed for (spec 006 research R2) — and admins fall back to the next-contact check, which is all
FR-038 asks for.

**Consequence to accept**: an evicted admin tab sitting idle on a screen with no polling could stay
visually signed in until it next talks to the platform. Every dashboard screen polls (feature 013
FR-049), so in practice this is bounded by the shortest refresh interval on screen.

---

## R4 — `TrackingGateway`'s per-frame check stays `sgen`-only

**Decision**: Leave `tracking.gateway.ts`'s per-frame comparison
(`client.data.user.sgen !== driver.sessionGeneration`) exactly as it is. Do not add a `sid`
comparison to it.

**Rationale**: that check guards `location:update`, whose only caller is a DRIVER — a role that has
no `sid` and keeps single-session semantics. Adding a `sid` check there would be dead code guarding
a role that cannot reach it, and would need `activeSessions` loaded on the per-frame path for no
benefit. The handshake path (`authenticateSocket` → `validateActiveSessionWithScoping`) already
gains the `sid` check for free, which is what covers an admin holding an `order:watch` subscription.

**Recorded so it is not "fixed" later**: this asymmetry is deliberate. A future reviewer who adds a
`sid` check to the per-frame handler will be adding cost to the driver hot path to guard a case that
does not exist.

---

## R5 — Administrator phone numbers are neither unique nor real

**Decision**: enforce "exactly one active administrator" **at query time** as the load-bearing
guarantee; extend the partial unique index to the three admin roles as a second line; require a
valid E.164 phone when creating an administrator; and fix `scripts/seed-super-admin.ts`.

**This is the finding that would have shipped a broken feature.** The spec assumes a mobile number
identifies an administrator. The data does not support that today:

- `UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { role: { $in: [CLIENT,
  DRIVER] } } })` — the uniqueness constraint **excludes every admin role**, with a comment saying
  so ("Partial so admin placeholder phones ('N/A') stay exempt").
- `scripts/seed-super-admin.ts` writes `phone: 'N/A'` literally.
- `UsersService.findByPhoneForAuth` is *scoped to CLIENT/DRIVER on purpose*, with a comment
  explaining that this is what stops the SUPER_ADMIN's `'N/A'` placeholder resolving to a login.

So the platform has an explicit, commented, deliberate design that admin phone numbers are **not**
login identifiers — which is exactly what this feature reverses.

**Ordering matters**: the unique index cannot be created while two admins share `'N/A'`. Index
creation would fail at boot, which on this platform means the service does not start. The
data-normalisation task is therefore sequenced **before** the index task, and both before the OTP
endpoints.

**The query-time check is the real guarantee**, not the index: FR-014 requires "exactly one active
account holding an administrator role", which is a `countDocuments`-style condition the index alone
cannot express (it says nothing about `isActive`). A number matching zero or two or more accounts
falls into the same neutral response as an unknown number — failing safe and silently, which is what
enumeration-safety requires anyway.

**Alternative rejected**: a separate `loginPhone` field on `User`, distinct from the contact `phone`.
It would sidestep the placeholder problem entirely, but it introduces two numbers per administrator
that can disagree, and the first support question would be "which one gets the code?".

---

## R6 — Taqnyat is already built; the gaps are two configuration holes

**Decision**: Ship no new Taqnyat client. Set `SMS_PROVIDER=taqnyat` and close the validation holes.

`src/common/sms/taqnyat-sms-sender.ts` already implements FR-002, FR-004 (the `rejected` payload
check), FR-005 (a 10 s `AbortSignal.timeout`), FR-006, FR-007 (message body never logged) and FR-008
(the narrow `05…` expansion, hardened in commit `a29bb38`). `SmsModule` already wires
`case 'taqnyat'`. `validation.ts` already lists `taqnyat` as a valid provider and already forbids
`none` in production. Nothing in Story A is new code.

**The two holes**, both the same class of defect this repository has already shipped twice:

```
SMS_API_KEY:   Joi.string().allow('').default(''),
SMS_SENDER_ID: Joi.string().allow('').default(''),
```

Neither is conditioned on `SMS_PROVIDER`, so `SMS_PROVIDER=taqnyat` with a blank token starts
cleanly and every SMS then fails against an unauthenticated provider — FR-003's exact scenario.

The fix must use the idiom `validation.ts` already documents at `CORS_ALLOWED_ORIGINS`, **including
`.invalid('')`**:

```
Joi.string().allow('').default('')
  .when('SMS_PROVIDER', { is: 'taqnyat', then: Joi.string().min(1).invalid('').required() })
```

`.invalid('')` is not redundant with `.min(1)`. Joi **keeps the base schema's `.allow('')` when it
merges the conditional one**, and an explicitly-permitted value short-circuits every other rule — so
`.min(1).required()` alone is silently satisfied by an empty string. This exact bug shipped for
`CORS_ALLOWED_ORIGINS` and again for `GCS_BUCKET`, and both are commented in `validation.ts` as
warnings. Writing the naive version here would be the third.

**Value mapping** (the deployment's names → the platform's, per FR-009): `SMS_SENDER` → `SMS_SENDER_ID`
(`ciro`); `SMS_BEARER_TOKEN` → `SMS_API_KEY`; `SMS_ENDPOINT_URL` → unchanged; plus
`SMS_PROVIDER=taqnyat`. The message-text field is already `body` in the sender's payload.

---

## R7 — The challenge is a self-hosted proof-of-work, not a third-party CAPTCHA

**Decision**: Server-issued proof-of-work. The platform mints a random single-use seed with a
difficulty, holds it in Redis with a short TTL, and the client must find a nonce such that
`sha256(seed || nonce)` has *N* leading zero bits. Verified once, then the seed is consumed.

**Rationale**: the challenge gates only *repeat* code requests **after** the per-number rate limit
has already fired (FR-023), so the threat it addresses is scripted volume, which proof-of-work taxes
directly. Against that narrow target it buys:
- no third-party account, no new secret, no new IAM binding, no new manifest entry — which matters
  because FR-009 and spec 012's secret story deliberately avoid adding secrets;
- no user PII leaving the platform to a scoring service, for a Saudi-operated platform;
- **deterministic in tests** — difficulty 0 in the test environment makes every e2e suite pass
  without a network call or a vendor sandbox key;
- no Content-Security-Policy change and no third-party script on the dashboard.

**Alternatives considered**:
- *Cloudflare Turnstile* — the best third-party option and materially stronger against a
  human-driven attack. Rejected for the vendor, secret, CSP and test-flakiness cost relative to how
  narrow the gate is. It is the natural upgrade if abuse is ever observed in production; the
  challenge is deliberately kept behind an interface so swapping it is one adapter.
- *Google reCAPTCHA* — same objections plus a PII/Google dependency.
- *No challenge* — excluded by the clarification session's own answer (Q3).

---

## R8 — The abuse counters fail **closed**, and that contradicts spec 012 on purpose

**Decision**: Redis holds the per-number request counter, the cross-code failure accumulator, the
temporary block, and the proof-of-work seeds. If Redis is unavailable, both OTP endpoints refuse.

**Rationale, and the tension worth naming**: spec 012's Q7 deliberately made the throttler store
*fail open into per-instance in-memory counting* because a Redis outage that errors **every request
on the platform** turns a cache failure into a total outage. That reasoning does not transfer here.
The blast radius is **two endpoints**, and those counters are the only thing bounding six-digit code
guessing. Failing open would strip brute-force protection from an unauthenticated credential
endpoint at exactly the moment the platform is already degraded — the same argument spec 012 used to
*keep* the login/refresh/OTP throttle rather than remove it.

FR-030 states this explicitly so the asymmetry is a decision, not an oversight.

**Note on placement**: the cross-code failure accumulator (FR-025) **cannot** live on the
`LoginCode` record, because that record is TTL-deleted at expiry — the accumulation must outlive the
codes it counts across. Redis is not an optimisation here; it is the only correct home.

---

## R9 — The dashboard stores the wrong token, in the wrong place, in both directions

**Decision**: Invert the current storage. Access token → memory only. Refresh token → `localStorage`
when "Remember me" is checked, `sessionStorage` otherwise.

**What is there today** (`src/lib/auth/token-store.ts`), and its own comment admits half of it:

```
// Access token: the header comment here has long claimed "in-memory only — never written
// to localStorage" (FR-011a) while the code below actually persists it …
let accessToken = localStorage.getItem('accessToken') || null;   // persisted
let refreshToken: string | null = null;                          // memory only
```

The long-lived, more powerful credential is the one that is *not* kept, and the short-lived one is
the one written to disk. The consequence is a live defect against FR-060: after a browser reload, if
the access token has expired, `bootstrapSession` calls `me()`, the interceptor tries to refresh,
`runRefresh()` finds no refresh token, and the administrator is thrown back to sign-in. The file's
own comment records this as "the consequence is accepted" — which was reasonable when the whole
refresh path had never worked, and is not reasonable now that sign-in costs an SMS.

**Rationale for the flip**: in a SPA that holds tokens in JavaScript at all, both are reachable by
XSS; the httpOnly-cookie design that would actually change that is explicitly out of scope (spec
Assumptions, because it would alter both Flutter clients' refresh path). Given that, the honest
tradeoff is to persist the credential that makes reload work and keep the one used on every request
out of storage. "Remember me" chooses the persistence *scope*, which is the only meaningful control
left, and is what the checkbox on the sign-in screen has always implied.

---

## R10 — Sign-in codes need their own collection, not a reuse of `PasswordReset`

**Decision**: A new `LoginCode` collection, modelled on `PasswordReset` (salted hash at rest,
`expiresAt` TTL index, `attempts`, `consumedAt`) and **not** tenant-scoped, for the same reason
`PasswordReset` is not: the caller is anonymous, so there is no `companyId` in `AsyncLocalStorage`
and a scoped query would match nothing and fail every sign-in as "code not found".

**Rationale**: both flows apply a "supersede any unconsumed record for this subject" rule
(FR-018 here, FR-023 in spec 006). Sharing one collection would make that rule cross-contaminate:
requesting a sign-in code would silently invalidate a password-reset code already in flight, and a
reviewer would have to notice the discriminator to see it. Two collections, one shared
`OtpPrimitivesService`, is the same shape spec 005 R4 chose when it extracted those primitives for
exactly this reason.

`LoginCode` records `userId` **and** the `phone` the code was sent to — the latter so a phone change
mid-flight cannot redirect an outstanding code, mirroring `PasswordReset.phone`'s comment.

---

## R11 — Three dashboard screens carry copy that this feature makes false

**Decision**: correct the copy on `AddPetrolCompanyPage.tsx`, `AddTransporterPage.tsx`,
`AddStationOwnerPage.tsx` and the comment block in `petrol_company/stations/api/owners.api.ts`.

Features 013/014 repeatedly encountered the Figma mock's passwordless-OTP sign-in, concluded
correctly that the platform had no such capability, and wrote that conclusion into the code:

- `AddPetrolCompanyPage.tsx:12` — "a FUEL_COMPANY_ADMIN signs in with email+password, not phone+OTP"
- `AddTransporterPage.tsx:14` — "The 'no password, OTP-only login' copy is corrected …"
- `AddStationOwnerPage.tsx:8` — "'password needed, OTP-only login' copy described a login flow this
  platform does not [support]"
- `owners.api.ts:44` — "`/auth/login` is the sole login route — Figma's mock described a passwordless
  OTP flow"

**The original design was right and the platform was behind it.** After this feature all four
statements are false. They are comments and helper copy, not logic, so nothing breaks — which is
precisely why they would survive indefinitely and mislead the next reader. `CreateUserDto` still
requires a password (min 8) and that does **not** change (Q2: coexist), so the corrected copy says
an administrator signs in *either* with their mobile number and a code *or* with email and password.

---

## R12 — Slice 0 is the session model, alone

**Decision**: the per-session identity change lands first and by itself, with both Flutter suites and
all existing e2e suites green, before any OTP endpoint or dashboard screen is touched.

**Rationale**: it modifies the return of `validateActiveSessionWithScoping`, which every
authenticated REST request and every socket handshake passes through; the token payload; refresh;
logout; deactivation; password reset; and the login-time realtime push. Its correctness condition is
a **negative** one — that DRIVER and CLIENT behaviour is bit-for-bit unchanged (FR-033, SC-013,
SC-020) — and a negative condition is only credible when nothing else moved in the same change.

Landing it together with the OTP endpoints would mean a mobile session regression and an OTP bug are
indistinguishable in the same diff, which is the shape of failure feature 012's R1 was written to
prevent.

**Everything after Slice 0 is independently shippable.** Taqnyat activation (Slice 1) touches only
configuration and delivers the escalation-SMS and password-reset paths on its own. The phone-integrity
work (Slice 2) is a prerequisite for the OTP endpoints and nothing else. The dashboard slices depend
on the endpoints but not on each other.
