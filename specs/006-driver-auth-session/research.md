# Phase 0 Research: Driver Authentication & Session

Eight decisions. Each records what was chosen, why, and what was rejected. No
NEEDS CLARIFICATION markers remain — the five spec clarifications resolved the product
questions; these resolve the technical ones they created.

---

## R1 — How a session is revoked: account-level generation counter

**Decision**: Add `sessionGeneration: number` (default 0) to the `User` schema, mirror it
into the JWT payload as `sgen`, and compare the two inside
`UsersService.validateActiveSessionWithScoping`. A mismatch throws the same
`UnauthorizedException('Invalid credentials')` an inactive user throws. Every revocation —
sign-out, password reset, deactivation, displacement by a new sign-in — is a single
`$inc: { sessionGeneration: 1 }`.

**Rationale**: This one check satisfies four separate requirements (FR-027, FR-029, FR-035b,
FR-042) at a single choke point, and it is genuinely free. `validateActiveSessionWithScoping`
already runs `this.userModel.findById(userId)` on **every** authenticated request and every
socket handshake to check `isActive`; the generation is a field on the document that query
already returns. No extra round trip, no new store, no new failure mode.

It is also the only option that covers both transports without being written twice: the HTTP
path (`JwtStrategy.validate`) and the WebSocket path (`authenticateSocket`) both funnel
through this exact method, which is what makes FR-035a's "refuse the reconnect" fall out for
free rather than needing its own implementation.

FR-042's single-session rule needs nothing beyond this: because there is one counter per
account rather than a set of live sessions, issuing a new token pair *necessarily* invalidates
the previous one. The constraint is structural, not enforced by bookkeeping.

**Alternatives considered**:

- **A `Session` collection keyed by `jti`.** The conventional answer, and wrong here. It adds
  a second query to every authenticated request, and its main benefit — listing and revoking
  individual sessions — is worthless under FR-042, which permits exactly one. We would pay
  per-request latency for a capability the spec forbids.
- **A Redis denylist of revoked tokens.** Adds a network round trip to every request and a
  quiet failure mode that is unacceptable for a security control: if Redis is flushed or
  unreachable, revoked sessions silently become valid again. A field on the user document
  fails closed.
- **Short access-token lifetimes alone.** Doesn't meet SC-008 (5 seconds) at any lifetime a
  driver would tolerate, and does nothing for FR-042.

**Migration**: Existing users have no `sessionGeneration`, and existing tokens have no `sgen`.
Both read as `undefined`; normalize both sides to `0` so tokens in circulation stay valid
across the deploy. Field default `0` on the schema covers new documents; `?? 0` on both sides
of the comparison covers the rest. No backfill script is needed.

**Signature change**: `validateActiveSessionWithScoping(userId)` becomes
`validateActiveSessionWithScoping(payload)`. Three call sites: `JwtStrategy.validate`,
`authenticateSocket`, and the `validateActiveSession(userId)` convenience wrapper used by
login and refresh. Login and refresh have no incoming `sgen` to check — they *establish* it —
so the wrapper keeps its `userId` signature and skips the comparison. This is the whole
reason Phase 0 ships alone: it is a cross-cutting signature change on the hottest path in the
system, affecting the client persona identically.

---

## R2 — How revocation reaches a live device: the existing user room

**Decision**: Emit `session:revoked` with a typed cause via
`RealtimeGatewayService.emitToUser(userId, ...)`. Increment the generation **first**, then
emit. On the client, the handler clears the token store and calls `SessionCubit.signOut`
with the cause, which the router already reacts to.

**Rationale**: No new infrastructure. `TrackingGateway.handleConnection` already joins every
socket to `user:${userId}` — added so `notification:new` and `order:otp` could address a
device directly — and `RealtimeGatewayService.emitToUser` already exists to emit into it from
leaf modules without importing `TrackingModule`. The push is three lines against machinery
that is already load-bearing in production.

Ordering matters and is deliberate: the generation is bumped before the emit, so the session
is genuinely dead at the moment the notice goes out. Socket.io does not re-validate the
handshake per frame, so the already-connected socket still receives the message even though
its credentials are now stale — the notice arrives on a connection that has already lost its
authority, which is exactly right.

**FR-035a (device offline) needs no implementation.** A device that missed the push
reconnects; the handshake calls `authenticateSocket` → `validateActiveSessionWithScoping` →
generation mismatch → `next(new Error('UNAUTHORIZED'))` → `connect_error`. The mobile client
already treats `connect_error` as a session failure. The fallback is a property of R1, not a
feature to build.

**Alternatives considered**: A dedicated `/sessions` namespace (a second handshake to
authenticate, for one event type); push notifications via FCM/APNs (device registration is
explicitly Out of Scope, and delivery is best-effort — unacceptable for a security control);
client polling (SC-008's 5 seconds would mean polling every few seconds from every driver
handset, all day).

---

## R3 — Password recovery: a third consumer of the OTP primitives

**Decision**: New `PasswordResetService` and `PasswordReset` collection, modelled directly on
`PhoneVerificationService` / `PhoneVerification` — same salted-hash storage, same
supersede-on-reissue rule, same `OtpPrimitivesService` for generation/hash/verify, same
`SmsSender` port, same TTL index for self-cleanup.

**Rationale**: `OtpPrimitivesService` was extracted subject-agnostic in spec 005 precisely so
a second security-sensitive mechanism would reuse its hash/salt/cache/lockout behaviour
rather than grow a parallel copy. This is the third subject (after order handover and phone
verification) and it fits the interface without modification. `PhoneVerification`'s schema is
the proven shape: never stores plaintext, TTL-expires, one active record per subject.

**The one real difference — and the tension it creates.** Phone verification is
*authenticated*; recovery is not. That makes FR-021 (enumeration safety) bind here in a way
it never did there, and it collides with FR-020's demand that a code actually be sent:

> `PhoneVerificationService` returns HTTP 502 `SMS_SEND_FAILED` when the provider rejects a
> send, on the principle that a code must never be reported as sent when it was not. Doing
> the same on an unauthenticated endpoint leaks account existence — 202 would mean "no such
> number", 502 would mean "this number exists and we tried".

**Resolution**: the recovery endpoint returns an identical `202 Accepted` in all three cases
— unknown number, successful send, and failed send. The send failure is recorded server-side
and surfaced to operators through logs, never to the caller. FR-021 wins over FR-020's error
precision because enumeration is an attack and a failed send is an incident the driver
recovers from by tapping resend. This is a deliberate divergence from the authenticated
sibling, and the reason is that the sibling had no anonymous caller to protect against.

**Rate limiting (FR-025)**: two layers. `@Throttle` per IP on the request endpoint, matching
the pattern `/auth/login` already uses (`{ limit: 10, ttl: 60_000 }`), plus a per-account
counter in Redis at 3 requests per 15 minutes. The per-account layer is the one that matters
— IP throttling alone is defeated by mobile carrier NAT, where thousands of drivers share an
address. Refusal returns `RESET_RATE_LIMITED` with `retryAfterSeconds` so the app can state
the wait (FR-025 requires the wait be stated, not merely enforced).

**Alternatives considered**: An admin-initiated reset (leaves the driver stranded — the exact
problem US3 exists to solve); email-based reset (Assumptions: drivers lack reliable email on
the road); a magic-link SMS (a second delivery mechanism and a second token type, for no gain
over a 6-digit code the drivers and the platform both already understand).

---

## R4 — Where the mandatory lock lives: a gate widget, not a route redirect

**Decision**: An `AppLockGate` widget installed in `App.builder`, beside the existing
`NotificationBannerPresenter`, driven by an `AppLockCubit` that observes app lifecycle via
`WidgetsBindingObserver`. It renders `LockScreen` over everything whenever the session is a
driver's and the lock is engaged.

**Rationale**: This is a correctness argument, not a stylistic one. The obvious alternative —
a `go_router` redirect to `/locked` — has a hole this codebase actually contains:
`DriverNavigationScreen` and `DriverScanScreen` are pushed with raw `MaterialPageRoute`
(from `delivery_detail_screen.dart:213` and `driver_navigation_bottom_sheet.dart:191`),
bypassing go_router entirely. A redirect-based gate would leave both screens reachable behind
a lock that believes it is holding. A `builder`-level gate sits above the `Navigator` and
covers every route regardless of how it was pushed.

It also composes correctly with FR-036: when the session ends *while* the lock is showing,
the router redirects underneath and the gate — which renders only for an authenticated driver
— dismisses itself. No coordination code between the two.

**Alternatives considered**: A go_router redirect (the hole above); wrapping
`DriverMainScaffold` (same hole, plus it misses `/driver/orders/:id`, which is outside the
shell); a per-screen mixin (repeated in eleven places, and a twelfth screen forgets it).

**Threshold**: 2 minutes of background time, plus every cold launch into an existing session
(FR-012). Held as a named constant beside the existing `AppDurations` values, never inline.

---

## R5 — Satisfying the challenge without hard-locking a driver out

**Decision**: Add an `allowDeviceCredential` parameter to
`BiometricAuthenticator.authenticate`, defaulting to `false`. The lock gate passes `true`,
which sets `local_auth`'s `AuthenticationOptions(biometricOnly: false)` and lets the OS
accept the device passcode when biometrics fail or are absent. Login's existing biometric
sign-in keeps `biometricOnly: true` and is untouched.

**Rationale**: The mandate (FR-010) and the no-lockout guarantee (SC-004a) are in direct
tension, and `biometricOnly: true` resolves it the wrong way. `BiometricAuthenticator`
already returns `false` indistinguishably for a cancel, a sensor lockout, and a missing
enrolment — so a mandatory biometric-only lock strands a driver with wet or gloved hands, a
damaged sensor, or a handset with nothing enrolled, mid-shift, with an assigned delivery they
cannot reach. The OS passcode is still device-level, still requires no backend
administration, and still cannot be disabled by the driver, so it gives up none of what the
mandate was for.

Keeping the default `false` matters: unlocking a *stored session* at login with a device
passcode is a genuinely weaker proposition than unlocking a *running* app, and that call was
already made deliberately in the existing code. This change adds a capability at one call
site rather than loosening the wrapper for everyone.

**FR-013a — a device with neither biometric nor passcode**: `isDeviceSupported()` returns
false. The gate shows a blocking screen explaining that the app requires a device lock, with
sign-out as the only other exit. This is enforceable client-side and needs no server state.

**FR-017 — a changed biometric enrolment**: satisfied structurally, not by detection.
`local_auth` does not surface enrolment-change state (`LAContext.evaluatedPolicyDomainState`
is not exposed by the plugin), so detecting it is not available to us. It does not need to
be: the lock challenges on **every** qualifying foreground and caches no approval, so there
is no stored approval for a new enrolment to inherit. The requirement is met by never having
the thing it warns about.

---

## R6 — Driver identity: `GET /users/:id`, not `/auth/me` (corrected during implementation)

**Decision, superseding an incorrect assumption in the original draft of this document**:
the driver's name, phone, email, photo, truck and company name are added to
`GET /users/:id` — the endpoint `ProfileRemoteDataSource.getProfile` already calls, mapped
through the already-existing `ProfileUser` entity — not to `/auth/me`.

**What was wrong, and how it was found**: this document originally proposed adding a `driver`
block to `/auth/me`, on the reasoning that it is "already the app's single identity source."
That reasoning does not hold for FR-001. `AuthUser` — the entity `/auth/me` populates — has no
`email`, `phone`, or photo field at all; its own doc comment says so explicitly: *"richer than
the thin `AuthUser` carried on `/auth/me`/session state (no phone, email or picture there)."*
`/auth/me` is session identity (who is signed in, for the router); `GET /users/:id` is profile
identity (what to show on a profile screen), and the CLIENT persona's `ProfileScreen` already
draws from the latter via `ProfileCubit`. The error was caught only once implementation
reached the point of actually reading `ProfileUser`'s definition — a research/contracts pass
that had inspected `auth.controller.ts` but not `profile_remote_data_source.dart` had no way
to surface it sooner.

**The corrected shape needs less new work than the original plan, not more.**
`UsersController.findOne` already returns `this.usersService.findById(id)` — the raw
Mongoose document — with no field-level projection, so `truck` (an embedded subdocument)
**already flows through today** for a DRIVER; nothing needs to expose it. The only true
addition is `companyName`, a flat field alongside the existing ones (not a nested `driver`
block — there is no existing nested-block precedent on this endpoint the way `station` is
one on `/auth/me`), populated via one `CompaniesService.findById(user.companyId)` lookup,
mirroring how `/auth/me`'s `resolveStation` already does one extra lookup for CLIENT.
`CompaniesService` is already available to inject: `UsersModule` imports `CompaniesModule`.

**`/auth/me` is untouched by this feature.** The byte-identical-response constraint recorded
in its `resolveStation` comment therefore doesn't apply here at all — a smaller, cleaner
outcome than the additive-but-still-changed endpoint the original draft proposed.

**Alternatives considered**: A separate `GET /drivers/me` (unnecessary — `GET /users/:id`
already exists and the client persona already uses its counterpart); adding the block to
`/auth/me` anyway for symmetry with `station` (rejected: it would duplicate data across two
endpoints for no consumer, since the profile screen never reads `/auth/me`, and would revive
exactly the byte-identical-response constraint that not touching `/auth/me` avoids).

---

## R7 — Session audit: one writer, one collection, no TTL

**Decision**: A `SessionEvent` collection written exclusively by `SessionAuditService`, in a
new `sessions/` module. Tenant-scoped through the existing `markTenantScoped` plugin. Every
write joins the caller's transaction where one exists. **No TTL index** — deliberately unlike
`PhoneVerification`.

**Rationale**: FR-044 requires answering, after the fact, which driver held the session when
a given delivery completed. That question is asked during a dispute, which is precisely when
a TTL would already have deleted the answer. Order and payment history are retained for the
same reason and these records exist to be reconciled against them.

A single writer matters because both `auth/` and `users/` produce these events (sign-out and
deactivation respectively). Putting the writer in either module would make the other depend
on it sideways; a leaf module both can import is the clean shape, and it is the same reasoning
that produced `RealtimeGatewayService`.

Tenant scoping is correct and automatic here — a `SessionEvent` has exactly one owning
`companyId` (the driver's), which is the single-tenant case the original plugin was built for.
This is unlike orders and invoices, which needed the multi-party plugin.

**FR-046 (do not log every request)** is satisfied by construction: the service exposes one
method per lifecycle event and nothing per-request calls it.

---

## R8 — SMS provider: inherit spec 005's deferral

**Decision**: No provider is procured or adapted in this feature. US3 is built against
`NoopSmsSender`, which logs the code, and is verified through that log — the same way spec
005's quickstart verifies phone verification.

**Rationale**: The seam is already correct. `SmsModule` throws at bootstrap for any
`SMS_PROVIDER` other than `none` rather than silently degrading, and `validation.ts` rejects
`none` in production — so a deployment cannot believe it is sending codes when it is not.
Procurement is a commercial decision that is not this feature's to make, and the port exists
so nothing blocks on it.

**Consequence, stated plainly**: US3 is developable, testable and reviewable now, and is
**not launchable** until a provider adapter exists. SC-005 and SC-009 are launch metrics that
cannot be measured before then. This is the same gate spec 005's Story 7 already sits behind,
so procuring one provider unblocks both.
