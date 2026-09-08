<!-- SPECKIT START -->
Previously implemented feature: `specs/016-broadcast-fuel-exchange/plan.md`
(a fuel company raises ONE exchange offer that reaches every fuel company on the platform; each
answers blind with a proposed price, and the raiser awards exactly one). **Implemented — 116 of
119 tasks complete.** Supporting artifacts: `spec.md` (6 stories, 53 FRs, 12 SCs, 3 clarifications),
`research.md` (12 decisions — R1, R2, R3, R5 and R8 each overturn something the spec, the approved
design or the existing code assumed), `data-model.md`, `quickstart.md`,
`contracts/rest-api-delta.md`, `contracts/isolation-contract.md`,
`contracts/dashboard-integration.md`, `tasks.md` (119 tasks, full correction log in its Notes
section). **Spans two repositories**: this backend and the dashboard at
`E:\zeyad\web_dashboard_ciro_fuel`.

**This replaces feature 014's Story 12** (the directed request to one named company). Binding
decisions: an offer carries **no price** — each responding company proposes one and the agreed price
is the awarded proposal's (FR-005a, R7) · proposals are **blind**, which is why they are their own
collection rather than an array embedded on the offer — an embedded array travels with every read of
its parent, and this codebase already shipped that exact leak once (spec 008's `findMine`
verification trail) · the award is **one conditional update inside a transaction**, `modifiedCount`
deciding the winner, because a read-then-write award is the same race feature 009 hit on concurrent
assignment · `party-set-scope.plugin.ts` is **amended, not duplicated** — a market offer is one party
plus `openToMarket: true`, a migrated directed offer stays exactly two parties · **grade eligibility
is a relevance filter, not a confidentiality boundary** (R2), because putting it in the injected
filter needs the viewer's price list inside every scoped query and freezing it breaks FR-006a ·
**Slice 0 landed the isolation change, both schemas and the migration alone**, reviewed and gated
(T026) before any endpoint or screen existed.

**Implementation status**: all 6 user stories built and verified. Backend `npm run build` clean,
`npx tsc --noEmit` clean, `npm run test` **316/316** across 40 suites, `npm run test:e2e`
**531-534/540** across 93 suites (a shifting 6-9 suites fail on any given full run — always the
same pre-existing, unrelated set the sequential-`MongoMemoryReplSet` resource pressure feature 011
already documented; every fuel-exchange suite, ~45 tests across 9 files, passed on every run).
Dashboard `tsc -b --force` reports the same pre-existing **33** `TS6133`/`TS6192` unused-import
errors feature 009 left, in files this feature never touched; `vitest run` **116/116** real tests
(103 baseline + 13 new), the same 2 pre-existing suites failing to *load*
(`accessibility.test.tsx`, `orders.mutations.test.tsx`). **Not completed — needs something this
session did not have**: T106 (the manual `quickstart.md` walkthrough, needs a running server),
T107 (running the migration against a real target-environment database — this is a pre-deploy
gate, not a task a development session closes), T108 (`flutter test` in the mobile repository,
not present on this machine).

**The migration is the irreversible step**: `scripts/migrate-exchange-requests-to-offers.ts` must run
against each environment **before** this code deploys there, and every migrated record must carry
`openToMarket: false`. A single `true` publishes a historical private request — including one never
answered — to every fuel company on the platform. No test that exercises only new offers can see it.

Two deliberate departures from the approved Figma, both recorded: the estimated-total row states
quantity and grade rather than a currency amount (no price exists at creation, so it could only ever
read zero), and the design's `المنطقة` field is labelled `الحي`, because the platform already uses
that word for its 13 administrative `RegionCode` regions.

**Corrections found while implementing** — the full log, including two genuine data-disclosure
bugs T081a's own test caught (a raiser's payload was leaking a declining company's identity two
independent ways — full contact details attached to every proposal regardless of outcome, and the
raw `proposingCompanyId` surviving even after that fix), is in `tasks.md`'s *Notes* section. The
one worth surfacing here: **every service-layer `$or` filter built on `ExchangeOffer` was silently
discarded.** `party-set-scope.plugin.ts` injects its own top-level `$or` on every scoped read via
`Query.where({ $or: [...] })`, and Mongoose's `where()` REPLACES an existing top-level key of the
same name rather than combining it — so the grade-relevance filter, the `direction=all` union, and
`summary`'s `awardedThisMonth` count each silently lost their own `$or` the moment the plugin's
pre-hook ran. Found by the lifecycle e2e suite (company C, diesel-only, was seeing a PETROL_95
market offer in its `incoming` list) — invisible to any unit test, since a unit test correctly
does not register the isolation plugin at all. Fixed by nesting every such disjunction under
`$and: [{ $or: [...] }]` instead, a key the plugin cannot collide with.

Previously implemented feature: `specs/015-dashboard-auth-taqnyat-sms/plan.md`
(administrators sign in to the web dashboard with their mobile number and a code sent by SMS).
**Implemented — code complete across both repositories; full-suite / live-environment verification
outstanding (see below).** Supporting artifacts: `spec.md` (7 stories, 74 FRs, 20 SCs, 5
clarifications), `research.md` (12 decisions — R1, R3, R5, R6 and R9 each overturn something the
spec or the existing code assumed), `data-model.md`, `quickstart.md`,
`contracts/rest-api-delta.md`, `contracts/dashboard-integration.md`, `contracts/config-contract.md`,
`tasks.md` (125 tasks). **Spans two repositories**: this backend and the dashboard at
`E:\zeyad\web_dashboard_ciro_fuel` (feature branch `015-dashboard-auth-taqnyat-sms` in both).

**Implementation status**: all 7 user stories built.
· **Backend** — `npm run build` clean; full `tsc --noEmit` clean including all new specs;
`npm run test` (unit) **250/253** — the 3 failures are `assignment-escalation-queue.service.spec.ts`,
which requires a live Redis that the build machine lacks (Docker Desktop unresponsive), not a
regression. New unit suites: `admin-session-primitives`, `challenge.service`, `sms-config-validation`,
`taqnyat-sms-sender`. New e2e suites written (not executed here — no Redis / `MongoMemoryReplSet`):
`admin-multi-session`, `mobile-session-unchanged`, `login-code`, `login-abuse`,
`admin-password-recovery`. `test/utils/fixtures.ts` now gives every fixture admin a `uniquePhone()`
and exposes `.phone` on each actor (the extended partial unique phone index covers admin roles).
· **Dashboard** — `tsc -b --force` reports only the same ~30 pre-existing `TS6133`/`TS6192`
unused-import errors feature 009/011 disclosed; `vitest run` **92 passing / 19 files** (up from 76),
same 2 pre-existing suites that fail to *load* (`accessibility.test.tsx`, `orders.mutations.test.tsx`).
New Vitest: `proof-of-work`, `token-store`, `login-signin`, plus additions to `bootstrap-session`
and `api-client.refresh`.
· **`npm run lint:check` is unusable on this Windows checkout** — `core.autocrlf=true` with no
`.gitattributes` makes eslint-plugin-prettier flag `␍` on every line of every file repo-wide
(~38.9k errors), a pre-existing environment condition; git still normalises the index to LF so
diffs and commits are clean.

**Not verified — needs an environment this session did not have**: the full `npm run test:e2e` run
(no Redis, no `MongoMemoryReplSet`); the Slice 0 **`flutter test` "mobile unchanged" gate** (T032 —
the mobile repo is not present on this machine; the backend diff touches no mobile path, but the gate
MUST run before deploy per research R12); `T108` (mirror `SESSION_LIMIT_EXCEEDED` into the Flutter
session-cause enum — same reason); quickstart Parts 1–4 walkthroughs; and Part 4 steps 1/11, which
need a real Taqnyat account and a handset. `scripts/normalize-admin-phones.ts` (T041) must be run
against **each** target environment **before** the schema change deploys there — `autoIndex` is on,
so the extended phone index builds at boot and fails while any admin phone is still non-E.164.

**Corrections found while implementing** — cases where following the plan verbatim would have
shipped something plausible and wrong:
· **`LoginCodeService.requestCode`'s step order was wrong as first written.** Calling the request-rate
limiter *before* the challenge check makes the challenge branch unreachable — once over the limit the
limiter throws `429` forever and the code never reaches `challengeRequired`. Reordered: block check →
challenge check (a solved PoW **bypasses** the rate limit, which is the point) → rate limit. The
limiter increments a separate `login-otp:rlhits:{phone}` counter on each `429`, and `challengeAfter`
reads *that*, so quickstart 3.5's "`202`×3, then `429`, then `CHALLENGE_REQUIRED`" holds.
· **`SessionAuditService._write` must OMIT `sid` when absent, not write `sid: undefined`.** The
existing `session-audit.service.spec.ts` asserts the exact key set of a written row; a spread guard
(`...(subject.sid ? { sid } : {})`) keeps DRIVER/CLIENT and account-level rows byte-identical.
· **`revokeAndSetPassword` alone did not make admin SMS recovery work** — `PasswordResetService`
resolved the phone through `findByPhoneForAuth`, which is CLIENT/DRIVER-scoped *on purpose* (T053
forbids changing it). Added a fallback to `findSingleActiveAdminByPhone` inside the existing
`runUnscoped` block, after the rate limit has already run keyed on the submitted string.
· **`AuthController.logout` now takes the whole `AuthenticatedUser`**, not `user.userId` — an admin
logout must name its own `sid`, and `sid` is stamped onto `AuthenticatedUser` from the verified token
by `JwtStrategy.validate` (the one handler permitted to read it).
· **The extended partial unique phone index now covers all five roles** (was CLIENT/DRIVER). Every
e2e fixture that hard-coded `+966500000001` for an admin would collide; `fixtures.ts` was the obvious
one and is fixed, but a full e2e run is needed to shake out any per-suite collisions this session
could not execute.
· **Dashboard `ApiError` / `toApiError` gained `retryAfterSeconds` and `challenge`** — the shared
error normaliser dropped every field beyond `error`/`message`/`cause`, so `LOGIN_RATE_LIMITED`'s wait
and `CHALLENGE_REQUIRED`'s `{seed, difficultyBits}` were unreachable by the screens.

**Deferred / scope calls**: the two rewired sign-in screens keep their existing hard-coded Arabic
copy (matching their pre-feature state) — the new strings are added to `ar.json`/`en.json` (key
parity preserved for `i18n-rtl.test.tsx`) but the screens are not fully retrofitted to `t()`.
Playwright journeys (T109/T110) are written under `<dashboard>/tests/e2e/` but not executed here.

Three gaps, of three different kinds. **Sending an SMS is configuration, not a build** —
`TaqnyatSmsSender` already exists and already handles the provider's surprising `201`-with-a-rejected-
recipient; the platform is merely pointed at the development no-op, and `SMS_API_KEY`/`SMS_SENDER_ID`
lack the `.when(SMS_PROVIDER=taqnyat)` conditional, so a production deployment can start "configured
for Taqnyat" with a blank token. That fix **must** include `.invalid('')` — Joi keeps the base
schema's `.allow('')` when merging a conditional, and this exact defect already shipped twice here
(`CORS_ALLOWED_ORIGINS`, `GCS_BUCKET`). **Code sign-in is a new unauthenticated credential endpoint**,
hardened past the existing recovery flow with a per-number block across codes and a self-hosted
proof-of-work challenge. **Concurrent admin sessions break the session model** — `sessionGeneration`
is one integer per account and is the sole mechanism behind driver displacement, sign-out,
password-reset invalidation, deactivation and company suspension; it cannot express "three sessions,
close this one, evict the oldest." That is the real work, and its correctness condition is a
*negative* one (DRIVER/CLIENT bit-for-bit unchanged), so **Slice 0 lands it alone**.

Findings that decided more of the plan than the spec did: **administrator phone numbers are neither
unique nor real** — the partial unique index deliberately excludes admin roles, `seed-super-admin.ts`
writes the literal `'N/A'`, and `findByPhoneForAuth` is scoped away from admin roles *on purpose*
with a comment saying that is what stops the placeholder resolving to a login; the platform has an
explicit, commented design that admin phones are not login identifiers, and this feature reverses it
· **the dashboard persists the wrong token** — access token to `localStorage`, refresh token
memory-only, exactly backwards, so a reload after access expiry throws the administrator back to
sign-in, now at the cost of an SMS · **no `session:revoked` push on admin eviction**, because the
room is `user:{userId}` and both that emit and `disconnectUser` would sign the administrator out of
the very devices this feature exists to keep working · **the abuse counters fail closed**, knowingly
contradicting spec 012's Q7 throttler decision, because the blast radius is two endpoints and failing
open leaves a six-digit code unguarded · **four dashboard files assert that this platform has no OTP
login** (features 013/014 wrote that conclusion into comments and helper copy); all four become false.

Previously implemented feature: `specs/012-production-hardening/plan.md`
(close the operational gaps that decide whether a production incident is a five-minute fix or a
silent failure, **without changing one byte of platform behaviour** — a liveness signal, graceful
shutdown, production CORS, proxy-aware rate limiting, structured logs, durable document storage,
managed secrets, database resilience, and the removal of the constraints that make redundancy
impossible). **Implemented — 124 of 125 tasks complete.** Supporting artifacts: `spec.md` (9 stories, 110 FRs,
20 SCs, 12 clarifications resolved across two sessions), `research.md` (12 decisions — R1/R4/R5 and
R9–R12 each overturn something the spec, the clarification sessions, or the contracts assumed),
`data-model.md`, `quickstart.md`, `tasks.md` (125 tasks), `contracts/health-contract.md`,
`contracts/rest-api-delta.md`, `contracts/config-contract.md`, `contracts/operations-contract.md`.
Two `/speckit-analyze` passes were run; the first found 10 issues (1 critical) and the second 10
more, all resolved — the second pass's value was catching that the first round's fixes had left
`plan.md`, `research.md` and two contracts describing the superseded design.

**Deployment shape (Clarifications Q1/Q3/Q5/Q6)**: Google Compute Engine VMs running the existing
Docker Compose stack behind nginx — unmanaged compute, but the surrounding managed services of the
same project *are* used: a regional GCS bucket for documents, Secret Manager for secrets, Cloud
Logging for records. What the deployment does **not** supply is orchestration, so the rolling deploy,
the scheduler arbitration and the sweep-stall alert are all things this feature builds.

**Implementation status**: all 9 user stories built and verified. Backend `npm run lint:check`
clean, `npm run build` clean, `npm run test` **187/187 across 22 suites**, `npm run test:e2e`
**346/346 across 62 suites** (counts include the card-UID work merged in on 2026-09-01). Both clients confirmed unchanged (FR-067): mobile `flutter test` 418
passing with the same two documented pre-existing non-green tests (`login_screen_golden_test` pixel
diff, `auth_session_test` `skip: true`); dashboard `vitest run` 49 passing with the same two
pre-existing suites that fail to *load*, and `tsc -b --force` reporting the same pre-existing
unused-import errors feature 011 already disclosed. Quickstart Parts 0–2 walked end to end against a
real server (results recorded at the foot of `quickstart.md`). New suites: `health`, `cors`,
`rate-limit-proxy`, `graceful-shutdown`, `request-logging`, `file-storage`, `db-resilience`,
`redis-degradation`, `multi-instance`, plus unit `secrets-loader`. New operational deliverables:
`nginx/nginx.conf`, `nginx/upstream.conf`, `scripts/readiness-monitor.sh`,
`scripts/rolling-deploy.sh`, `docker-compose.prod.yml`.

**Not completed — needs a named person, not a session**: T110 alone, the FR-072 pre-launch
checklist's owners and dates. Also unproven, because the infrastructure does not exist yet (no VMs,
bucket, secret store or log sink — operations-contract §1): quickstart Part 1's two-instance nginx
section and all of Part 3. The two-instance *guarantees* are covered automatically by
`test/e2e/multi-instance.e2e-spec.ts`; what remains unverified is the nginx, monitor and rolling-deploy
machinery itself, which is exactly what §7's checklist tracks.

**Corrections found while implementing** — the full log is in `tasks.md`'s *Corrections* section;
the ones that would have shipped silently:
· **`INSTANCE_ID` resolved to `''` on any deployment that did not set it**, so FR-035a had no answer
in a single record or either health response — Joi's `.default('')` is written back into
`process.env`, and `??` does not treat `''` as absent (`??` → `||`).
· **`CORS_ALLOWED_ORIGINS=` (set but empty) was ACCEPTED in production**, defeating FR-018 by the
likeliest route: Joi keeps a base `.allow('')` when merging the conditional schema, so `.min(1)` and
`.required()` were both short-circuited. **`GCS_BUCKET` and `GCP_PROJECT_ID` had the identical
hole.** Found by walking the quickstart against a real server, not by any suite.
· **The Redis socket adapter never attached** — `afterInit` hands a *namespace*, not the root
`Server`, and `Namespace.adapter` is a property, not a method. The throw was caught and logged, so
every single-instance test passed while cross-instance delivery was silently dead. Only
`multi-instance.e2e-spec.ts` could see it.
· **pino's `customProps` decorates only the request-completion record**, so no background job's
records carried a correlation id — FR-030 half-implemented in exactly the way the plan warned about.
Replaced with a `mixin`; the request record, emitted from `res.on('finish')` *outside* the
AsyncLocalStorage scope, reads its fields off `req` instead.
· **`TrackingGateway.handleConnection` could crash the instance on every driver connect** — socket.io
ignores the promise it returns, and both `client.join` (Redis) and `presenceService.touch` (Mongo)
can reject, so an unawaited rejection would have terminated the process one connect at a time during
exactly the dependency interruptions Q7 says must only degrade.
· **An unhandled `'error'` event on a BullMQ queue crashes the process** — which would have turned
the Redis degradation Q7 designed for into an instance crash.
· **Establishing a correlation id on public routes nearly broke every login**: both scoping plugins
bypassed on `!ctx`, and an anonymous store with no `role` falls into the authenticated branch. The
discriminator is now `!ctx?.role`.
· **A scheduled sweep firing during the drain made a clean shutdown report itself as failed** —
`beginDraining` now stops every cron and interval first.

**The keystone finding, which inverts the obvious implementation order (research R1)**:
`test/utils/test-app.factory.ts` does not boot the app the way `server.ts` does — it re-implements a
subset by hand and omits `helmet` and `enableCors` **entirely**. All 53 e2e suites therefore run
against an application configured differently from production. Every property this feature adds at
bootstrap (CORS, `trust proxy`, shutdown hooks) would be added to `server.ts` and asserted by
nothing. So **Slice 0 extracts `configureApp()` into `src/bootstrap/` and points both entry points at
it, alone, before any behaviour is added** — otherwise the hardening feature reintroduces, four times
over, the exact class of production-only defect it exists to remove. Story 3 is not even testable
before it lands.

**Corrections found while planning** — each is a case where following the spec as written would have
shipped something plausible and wrong:
· **`FR-023` is not implementable as a `req.user` read.** `common.module.ts` registers
`ThrottlerGuard` **before** `JwtAuthGuard`, deliberately and with a comment saying so — at the moment
the global throttler runs, `req.user` does not exist. A tracker reading it would compile, pass tests
and silently always fall through to the IP branch. Reordering the guards is *worse*: a malformed
token would then be rejected before the throttler counts it, so an attacker bypasses rate limiting
entirely by sending garbage. Decoding the JWT without verifying is worse still — `sub` becomes
attacker-controlled and anyone can exhaust a named user's budget. The tracker **verifies the
signature** and falls back to IP on failure.
· **The rate-limit blast radius is five routes wider than the spec says.** `@Throttle({ default: … })`
is read by the *global, IP-tracked* guard and decorates login and refresh (10/min) and three OTP
paths (5/15 min). Behind a proxy all five collapse into one platform-wide bucket — **ten failed
logins from any one client would lock every user out of logging in.** Only
`users.controller.ts:190`'s `UserThrottlerGuard` `perUser` profile is genuinely unaffected.
· **There is a second CORS defect, and it is the opposite of the first.** The REST API grants CORS
only outside production (the defect the spec describes), but `TrackingGateway` is declared
`cors: { origin: '*' }` — a hardcoded wildcard active in **every** environment including production.
Fixing only the REST side would leave the more permissive of the two in place. Both now read one
config value.
· **`enableShutdownHooks()` being absent means `RedisModule.onModuleDestroy` has never run in
production** — a hook written specifically to close the ioredis connection, with a comment saying so.
One line restores every destroy hook already written.
· **The realtime fix is a one-file change.** Every outbound emission in the codebase funnels through
`RealtimeGatewayService` (`emitToOrderRoom`/`emitToUser`); `TrackingGateway` makes no direct emit at
all. Attaching the Redis adapter to the single `Server` covers all five event types and both
addressing modes without touching the six calling services.
· **`FR-062`'s "exactly once" was wrong the same way `FR-056`'s was**, and was corrected in the spec
during the consistency pass: BullMQ is at-least-once, and `Worker.close()` *deliberately* releases an
unfinished job for redelivery — which is what `FR-009` wants. Correctness rests on idempotency, not
on the queue.
· **`storagePath` keeps its name and type**, changing only its content from an absolute filesystem
path to an object key. Renaming it to `objectKey` would read better and would break `FR-038`'s
payload freeze. Neither client reads it, and it already differed between machines.
· **`FileRecord` is `markTenantScoped`, which is why `files.controller.ts:download` has no explicit
tenant check and correctly needs none.** The storage rewrite must not disturb this — the controller
looks unprotected, and removing the marker opens a cross-tenant read.
· **Secrets load into `process.env` *before* `NestFactory.create`**, so not one line of
`configuration.ts` or `validation.ts` changes and Joi remains the thing that fails on an absent
secret. A `ConfigModule` custom loader would run *after* Joi and fail validation before ever loading.
· **The widest-touching and most skippable task is `FR-030`**: the correlation id must be written into
every BullMQ job's data at enqueue and re-established by every processor. Half-done, it yields an
order history that looks complete and is missing every background action.

**Found by the second analysis pass and the clarification round that followed** — three that changed
the design rather than the documentation:
· **Redis becomes load-bearing for five subsystems** (queues, cache, throttler counters, scheduler
leases, socket fan-out) while Q7 deliberately keeps a cache-less instance in rotation. That is only
sound if each of the five degrades gracefully, and the throttler store **fails closed by default** —
so a cache outage would have errored *every request on the platform*, making Redis a harder
dependency than MongoDB and turning the decision meant to prevent a total outage into its cause.
Counters now fall back to per-instance in-memory counting: bounded at N× the budget, not absent —
failing open would strip brute-force protection from login/refresh/OTP exactly when the platform is
already degraded. Realtime fan-out cannot fail open at all (events still reach the emitting
instance's clients, so it is indistinguishable from success from that instance's vantage point) and
is closed by an alert instead.
· **Open-source nginx cannot poll `/health/ready`** — active upstream health checks are nginx Plus.
Worse, `max_fails` counts only what `proxy_next_upstream` names, and the default set is `error
timeout`: **502/503 are not in it**, so a readiness-failing instance returning clean 503s would never
have been marked down and the passive layer would have done nothing. Fixed with an explicit
`proxy_next_upstream error timeout http_502 http_503` (which also retries the request against a
healthy instance) plus an external monitor that *rewrites the upstream and reloads*, not one that
merely alerts. `non_idempotent` is deliberately omitted — nginx already refuses to retry
POST/PATCH/LOCK without it.
· **`TRUSTED_PROXY_HOPS` must not have a default.** It is 1 if nginx is alone and 2 if a managed load
balancer fronts it, and that topology is **unestablished** (FR-007d, now the first implementation
task). Guessing 1 where there are two attributes every request on the platform to the load balancer —
the same undifferentiated-origin failure Story 4 exists to fix, reached differently, with no error
and no symptom.
· **The download path is a 302 under *every* storage driver, including local.** Had local returned
bytes, the redirect would have executed first in production — R1's defect reintroduced inside Story
6. The local byte route is addressed by a scoped expiring token rather than the `Authorization`
header, because clients differ in whether they forward that header across a redirect (which is the
whole of FR-038c) — an authenticated local route would have closed one trap by opening the same one
in the test environment. It is `@Public()`, so *scoped, expiring and absent-from-production* are all
load-bearing and all asserted by test.

**Constitution**: PASS on both gates, Complexity Tracking empty. The `sys_storge` constraint binds
*local* uploads; after Story 6 uploads are not local, so it no longer binds them — and the name is
retained as the GCS key prefix anyway, with `LocalFileStorage` (dev + all 53 e2e suites) still
writing a real `sys_storge` directory. **No amendment required.** The retained prefix is convention,
**not** enforcement: GCS enforces nothing about a key path, and any future code that reads tenancy
from one is a defect.

Previously implemented feature: `specs/011-transit-stop-detection/plan.md`
(detect when a truck carrying fuel stops moving between the warehouse and the customer, ask the
driver why through an alert that reaches them mid-drive, and tell the transporter only when the
driver says nothing). **Implemented — 64 of 65 tasks complete** (see status below). Supporting
artifacts: `spec.md` (4 stories, 26 FRs, 10 SCs, 5 clarifications resolved), `research.md` (7
decisions), `data-model.md`, `quickstart.md`, `contracts/rest-api-delta.md`,
`contracts/realtime-contract.md`, `contracts/dashboard-integration.md`,
`contracts/mobile-integration.md`, `tasks.md` (the full correction log is in its Notes section).

**Implementation status**: all 4 user stories built and verified — **64 of 65 tasks complete**;
only T062 (the on-device quickstart walkthrough) remains. Backend: `npm run test` 152/152 unit
across 19 suites; e2e **267/267 tests passing across 53 suites**, with 3 suites *reported* failed
purely because their `afterAll` `ctx.close()` exceeded a 30 s budget — no test failed, all 3 pass in
isolation, a different set fails each run, and a probe measured `ctx.close()` at 538 ms on a clean
boot. That is accumulated resource pressure from 53 sequential `MongoMemoryReplSet`+Redis apps in
one `--runInBand` process, not a defect; the real fix is a shared teardown budget in
`test-app.factory.ts`, which is test infrastructure outside this feature. Dashboard: `vitest run` 49 passing, with the same 2 pre-existing
suites that fail to *load* (`accessibility.test.tsx`, `orders.mutations.test.tsx` — both import
`@/features/*` paths feature 009 deleted). Mobile: `flutter test` 418 passing, the same 2
documented pre-existing non-green tests (`login_screen_golden_test` pixel diff, `auth_session_test`
`skip: true`). **Not completed — needs a live environment this session did not have**: T062 alone, the
quickstart walkthrough, which requires a real device or simulator with mock location; the whole
point is that the alert reaches a *backgrounded, locked* app, and nothing else can verify that.

**Corrections found while implementing** — each is a case where following the plan as written would
have shipped something plausible and wrong:
· **A declared stop is created already *resolved*, not merely already answered.** The artifacts left
`resolvedAt` to the answering path, which breaks FR-016's own invariant the moment suppression
lapses: the sweep must then raise a *new* `DETECTED` event, and the delivery would carry two
unresolved stops. Suppression is carried by `suppressedUntil` alone, so the sweep's guard has two
clauses, shared with the declare path via one `unblockedStopFilter` — a disagreement between the two
is exactly how two open stops would appear.
· **The escalation processor alerted the transport admin twice for one silence** (SC-008 violation,
found by its own test). It guarded on `reasonGivenAt`/`resolvedAt` only, so a redelivered job —
BullMQ is at-least-once — escalated again. Fixed by folding `escalatedAt: null` into the *same*
conditional write that stamps it, so `modifiedCount` decides which delivery gets to notify.
· **T055's premise was wrong and the real gap was worse.** `MapCard` renders the *destination*, not
a position. The frozen-position bug is in `TrackingMapCard`, whose staleness check was gated on
`position.status === 'live'` — so a socket that never delivered anything at all fell back to the
order's seeded `driverLocation` and drew it **completely unmarked**. A truck whose driver's phone
died and a truck parked at that spot rendered identically. Fixing it required a platform addition
the plan had not identified: **`driverLocationAt`** on `GET /orders/:id`, since FR-017a requires
stating how old a position is and the seeded fix travelled with no timestamp.
· **`StopEvent` keeps its `_id`**, unlike all eight other embedded sub-schemas on `Order` — the
resolve/reason endpoints, the BullMQ `jobId` and the driver's notification all address one specific
stop. Marked in the schema with an explicit "do not tidy this into `_id: false`".
· **The dashboard's four card states are derived from three nullable timestamps, and the check order
IS the behaviour**: `declared` must be tested before `resolved`, or a driver's volunteered stop
renders as "handled" and FR-008c's required distinction is lost.
· **`NotificationType`'s parity test caught a real omission** — spec 007's guard pinning the Flutter
enum to the backend's wire values, working exactly as intended.
· **T049's cancel-on-cancellation is unreachable and kept anyway**: `ADMIN_CANCELLABLE` stops at
`LOADING`, and `IN_TRANSIT` is the only status a stop can exist in. Left as a one-line no-op
backstop with a comment saying so.
· **Fixed a pre-existing flaky test found on the way**: `warehouse-loading.e2e-spec.ts` asserted
`JSON.stringify(order).not.toContain('950')`, which matched any timestamp whose milliseconds
contained `950` — roughly a 14% failure rate. Now asserts on the order's numeric *values*, which is
what FR-028a was ever about.
· **Left disclosed, not fixed**: dashboard `tsc -b --force` reports 30 files with unused-import
errors (`TS6133`/`TS6192`), none touched by this feature — fallout from feature 009's deletions.
CLAUDE.md's earlier claim that feature 009 left it clean no longer holds; fixing 30 unrelated files
inside this feature would have buried the diff.

**The situation it addresses**: a stalled delivery is invisible. The tracking map shows a position
that stops changing, and nothing distinguishes that from a driver who is fine or a phone that lost
signal. Feature 009 built the mock for exactly this (`UrgentNotificationCard.tsx` — "driver stopped
moving for more than 10 minutes") and **deleted** it because no movement-timeout detection existed
behind it; this feature supplies it and the card returns as `StopAlertCard.tsx` — **reinstating the mock's
real elements only**: "remaining distance" and the street-name location are omitted, since neither
has a data source, following feature 009's `MapTrackingCard` legend precedent.

Binding decisions from that plan: detection is a **periodic sweep** (`@Cron`, mirroring
`PresenceService.sweepOfflineDrivers`), **not** a per-order BullMQ job rescheduled on movement — a
truck at 60 km/h crosses the 50 m threshold every ~3 seconds, so the job design would thrash Redis
in proportion to *movement* in order to detect *absence of movement* (research R1) · the sweep reads
a new `User.lastMovedAt`, advanced only by fixes past the movement threshold, deliberately separate
from `lastSeenAt`, which is what makes "reporting the same position" and "reporting nothing"
distinguishable by construction rather than by inference (FR-017) · displacement is measured against
a `lastMovedLocation` baseline, never against `location`, or a parked truck would drift past the
threshold in sub-threshold steps and read as moving · the **response-window escalation** *does* use
BullMQ, feature 010's exact shape, because that timer starts once and cancels once · stop events are
an **embedded array on `Order`** mirroring `Order.verifications`, which structurally prevents a
per-driver stop history from being queried — the anti-surveillance boundary enforced by the data
model, not by discipline · the driver's prompt requires **new mobile capability**: the app has no
local-notification package at all today, so a driving driver would never see it — closed with
`flutter_local_notifications` behind a `NotificationPresenter` seam, and **no push provider**, since
the location foreground service already keeps the app and its socket alive · drivers can **declare**
a stop in advance, suppressed only for a duration they state themselves, so one declaration cannot
silence detection for the rest of a journey.

**Deferred out of this feature**: alerting on a device that has gone *silent* (as opposed to
stationary) — the position is shown as stale with its age (FR-017a, reusing feature 009's
`TrackingMapCard` treatment), but no alert is raised; a real push provider (FCM/APNs), which this
feature deliberately does not need; and **route-deviation detection, geofenced no-stop zones, and
per-driver stop histories**, all explicitly out of scope — the feature is scoped as safety and
delivery visibility, not driver surveillance, and adding any of those would require its own review
of what the platform is entitled to infer about a person from their location.

Previously planned feature, now implemented: `specs/010-driver-availability-escalation/plan.md`
(on the transport dashboard's assignment screen, show every driver — online and offline — instead
of silently filtering out anyone not currently eligible, and add a durable escalation path so an
assignment notification that a driver never acknowledges falls back to an SMS). Supporting
artifacts: `spec.md` (3 stories, 17+5 FRs — FR-011a/012a/013a/014a added during `/speckit-clarify`,
5 clarifications resolved, plus corrections found during implementation — see below), `research.md`
(6 decisions), `data-model.md`, `quickstart.md`, `contracts/rest-api-delta.md`,
`contracts/dashboard-integration.md`, `contracts/mobile-integration.md`, `tasks.md` (49 tasks, 45
complete — see below for what remains).

**Implementation status**: all 3 user stories built and verified. Backend: `npm run test`
136/136 unit, `jest --config test/jest-e2e.json --runInBand` 50 suites/247 tests green. Dashboard:
`tsc -b --force` clean, `vitest run` 42/42 real tests green (the same 2 pre-existing baseline
failures feature 009 already documented, unrelated). Mobile: `flutter test` 404 passing, the same 2
pre-existing non-green tests already documented (`login_screen_golden_test` pixel diff,
`auth_session_test` `skip: true`) — this feature added one field (`assignmentAcknowledgedAt`) to
the shared `Order` entity and one fire-and-forget use case call from `DeliveryCubit.load()`, no UI
change. **Not completed — needs a live environment this session did not have**: the full
`quickstart.md` walkthrough (T046, needs Redis + a running backend + real time passing for the
escalation window).

**Corrections found while implementing** (beyond what `/speckit-clarify` had already caught):
`DriverEligibility` needed a **4th value**, `INACTIVE` — the original two-round design
(`ELIGIBLE`/`BUSY`/`OFFLINE`) internally contradicted its own spec, which says a suspended/
deactivated driver must still be shown (FR-001's "whole roster") but is **never** selectable, not
even with a reason — distinct from `BUSY`, which is shown-but-never-selectable for a completely
different reason (a real driver actively holding another delivery). This surfaced the bigger
finding: **`BUSY` is not force-assignable at all**, contradicting the original FR-007/FR-008
wording — a `BUSY` driver's `activeOrderId` already points to a delivery they hold, and the
platform has no capability to reassign a driver away from their current order without cancelling
it outright, so "selectable with a reason" could only ever have meant `OFFLINE`. FR-007/FR-008 and
the corresponding acceptance scenario were narrowed accordingly; the actual code fix was a
one-line relaxation (`assignDriver`'s booking filter drops `isOnline: true`, keeping
`isActive`/`isAvailable`/`activeOrderId` exactly as before) — `BUSY`/`INACTIVE` were **already**
refused unconditionally by the pre-existing filter, no new guard needed for either. The same
review found FR-014a's "driver reassignment" cancellation case describes a capability that does
not exist on this platform (`reassignVehicle` changes truck/tank only, never `driverId`) — narrowed
to cancellation-only, the one real "no longer applies" case, which already releases the driver via
`OrdersService.releaseDriverIfAssigned`. Separately: the escalation SMS's phone number is read
**live** from the driver's current `User` record at send time, never the `driverSummary.phone`
snapshot taken at assignment (spec's own edge case: a driver's number can change in between); and
`EscalationSkipReason` gained a second value, `SEND_FAILED` (distinct from `NO_PHONE`), so a
genuine SMS-provider failure is recorded as an attempted-but-failed send rather than indistinguishable
from "never attempted."

**The situation it addresses**: `DispatchService.findCandidates`'s `$geoNear` query hard-filters
candidates to `isOnline: true, isAvailable: true, activeOrderId: { $exists: false }` — an
administrator whose entire fleet happens to be briefly offline sees a bare "no drivers available"
empty state indistinguishable from having no drivers at all. Separately, `assignDriver` already
sends an `ORDER_ASSIGNED` notification (a `Notification` document + Socket.io emit — there is no
real push provider anywhere in this codebase), but nothing tracks whether the driver ever saw it,
and nothing happens if they didn't; a silently-dropped notification looks identical to a driver
who simply hasn't started yet.

Binding decisions from that plan: showing "every driver" means splitting the candidate query in
two — `$geoNear` still orders drivers who have a recorded location, but a second plain query
catches drivers who have **never** connected at all, since `$geoNear` silently omits any document
missing the field it sorts by (the same reason a never-located driver is invisible to dispatch
today) · acknowledgment is a **new, purpose-built signal** (`Order.assignmentAcknowledgedAt`, set
by a new driver-only endpoint fired from the existing active-delivery load path, feature 007's
`DeliveryCubit`) — **never** a reuse of the generic `Notification.readAt`, which is set by opening
the notifications list for any notification type and would violate FR-017's "no inferring
acknowledgment from unrelated activity" · the escalation timer reuses the platform's **existing**
BullMQ queue infrastructure (`payments/queues/`'s exact shape — `*QueueService.schedule/cancel`
with `jobId = orderId`, a `@Processor` that re-reads the order before acting), not a new scheduling
mechanism, so durability across a restart (FR-012a) comes for free · the SMS send-rate cap
(FR-013a) is BullMQ's own `Worker` `limiter` option, not a bespoke throttle · the escalation SMS
body is **minimal by design** — an order reference and "open the app," nothing customer- or
delivery-related, since SMS is unencrypted and carrier-visible unlike the in-app push · assigning
a `BUSY`/`OFFLINE` driver requires a **recorded reason** (`Order.assignedWhileIneligible`/
`assignedWhileIneligibleReason`), mirroring the existing `manualOverride`/`overrideReason` pattern
from spec 008's verification override, not a bare confirmation click · a pending escalation is
**cancelled outright**, never fired late, if the order or its driver assignment changes first — a
vehicle-only reassignment (feature 009's `reassignVehicle`) does **not** restart or cancel it,
since it never touches `driverId`.

**Deferred out of this feature**: real push-provider integration (FCM/APNs) — today's "push
notification" is the existing Mongo-document-plus-socket-emit mechanism, unchanged by this plan;
adding a genuine mobile push provider is a larger, separate concern this feature's escalation
merely sits downstream of. Also deferred: any UI for the SMS content itself (it is sent outside the
app, by design) and any change to `Notification`/`readAt` for notification types other than
assignment.

Previously planned feature, now implemented: `specs/009-transport-dashboard-order-lifecycle/plan.md`
(connect the TRANSPORT COMPANY ADMIN's web dashboard to the live platform, and prove one order
travels the whole chain — client, fuel company, transporter, driver, back to client — with each
participant watching the same delivery change state on their own screen). Supporting artifacts:
`spec.md` (6 stories, 78 FRs — 2 added during implementation, `cancel` as a 4th forbidden action
and `reassignVehicle`'s narrower guard, see corrections below — 8 clarifications resolved),
`research.md` (8 decisions), `data-model.md`, `quickstart.md` (the walkthrough itself),
`contracts/rest-api-delta.md`, `contracts/realtime-contract.md`,
`contracts/dashboard-integration.md`, `tasks.md` (132 tasks, all implementable ones complete —
see below for what remains).

**Implementation status**: all 6 slices/user stories built and code-verified — real session +
role vocabulary (Slice 0), stage vocabulary + cursor pagination (Slice 1), order lifecycle
list/detail/assignment/tracking wired to live data, card pairing (both input paths), verification
override/vehicle reassignment, and the dashboard summary. Backend: `npm run test` 127/127 unit,
`jest --config test/jest-e2e.json --runInBand` 39 suites/169 tests green. Dashboard: `tsc -b
--force` clean, `vitest run` 35/35 real tests green (2 pre-existing baseline failures unrelated,
named in tasks.md). Mobile (untouched by this feature): `flutter test` 358 passing, the same 2
pre-existing non-green tests this repo already documented (`login_screen_golden_test` pixel diff,
`auth_session_test` `skip: true`). **Not completed — needs a live environment this session did
not have**: the manual multi-device walkthrough itself (tasks T063-T067, real NFC hardware and a
second tester), the one-hour request-count measurement (T121, SC-015), and quickstart.md Part 4's
full verification table (T122) — Playwright e2e specs for every dashboard flow are written and
reviewed but explicitly **not executed** (no dev server/backend in that session).

**Corrections found while implementing** (beyond what planning had already caught, see below):
concurrent assignment on the SAME order (two admins, or two tabs, per FR-008/SC-008) surfaced as
an unhandled 500, not a clean 409 — both `assignDriver` transactions pass their own document's
`activeOrderId: { $exists: false }` filter under snapshot isolation, and the collision only
appears at commit, as a duplicate-key violation on the shared unique `activeOrderId` index; fixed
in `dispatch.service.ts` with the same `isDuplicateKeyError` idiom `ratings.service.ts` already
used, now `ErrorCode.ORDER_ALREADY_ASSIGNED` · a 4th forbidden action for this role, `cancel`
(`OrdersController.cancel` admits only `FUEL_COMPANY_ADMIN`/`CLIENT`), on top of the three the plan
already named · vehicle reassignment
is only valid at exactly `ASSIGNED_TO_DRIVER`, narrower than first coded — `LOADING` already means
the driver has departed for the warehouse · the dashboard's `FuelType` constant was wrong outright
(`{OCTANE_91:'91',...}` vs the platform's `{DIESEL, PETROL_91, PETROL_95, KEROSENE}`) · a
transport company can **never** have clients (role-creation + tenant isolation both forbid it) —
the entire `transport_company/clients/` feature folder was fabricated against a capability that
does not exist and was deleted, not fixed · `MapTrackingCard.tsx`'s four-way legend (counts
2/1/12/3) was invented — no endpoint gives that breakdown — and was dropped, the same precedent as
`InvoicesSection`/`DoughnutSection` elsewhere in the same composition · `scripts/
seed-dashboard-actors.ts` (pre-existing) had gone stale against spec 008's cutover: it still
POSTed an embedded `truck` object when creating a driver, a field `CreateUserDto` no longer
accepts — fixed, and extended with the warehouse/truck/card-pairing/tank records quickstart.md
Part 2 needs; a new `scripts/approve-and-route-order.ts` covers the fuel-company script step
quickstart.md's walkthrough calls for. **Left disclosed, not fixed**: `FuelIcon.tsx` matches
fuel-type icons against Arabic display strings, but every real caller now passes the platform's
enum values (`'DIESEL'`, `'PETROL_91'`, …) — it silently falls through to its default icon for
every order, a pre-existing defect outside this feature's scope; `DeliveryAreasPage.tsx` and
`NotificationsPage.tsx` remain fully unwired mock screens, a scope decision made and disclosed
during implementation rather than attempted under time constraints.

**The situation it addresses**: the spec was written believing the transport screens were
mock-ups awaiting live data. They are — but the deeper defect is that **no transportation
administrator can sign in to the dashboard at all**. `web_dashboard/src/constants/roles.ts`
predates spec 004's role split: it still names `COMPANY_ADMIN` and has neither
`FUEL_COMPANY_ADMIN` nor `TRANSPORT_COMPANY_ADMIN`, so `bootstrap-session.ts` discards a genuine
transporter's token at boot. Every transport screen has only ever been viewed through
`RoleSelectionPage.tsx`, a demo picker that fabricates a session with the literal token
`'dummy-token'` — which `bootstrapSession` explicitly honours. Route guards are wrong in both
directions: a `DRIVER` reaches both admin surfaces, a `CLIENT` reaches a fuel company's.
Separately, the dashboard's `OrderStatus` has 8 of the platform's 12 values — missing exactly the
transporter's own working range (`AWAITING_ROUTING`, `ROUTED_TO_TRANSPORT`, `ASSIGNED_TO_DRIVER`,
`LOADING`) — its orders API wires three actions this role is **forbidden** (approve/reject/
force-complete) while the transporter's own two (`GET /dispatch/orders/:id/candidates`,
`POST /dispatch/orders/:id/assign`) are absent, its only dispatch path no longer exists on the
platform, and its paged-response type `{ items, total, page }` is a shape the platform has never
produced (it returns `{ items, nextCursor }`).

Binding decisions from that plan: **Slice 0 is a real session** — role vocabulary replaced with
the platform's five, guards re-derived per surface, the `'dummy-token'` bypass and
`RoleSelectionPage` **deleted**, since nothing else in the feature is verifiable until a real
transporter can hold a real session · Slice 1 (the stage vocabulary + cursor pagination) also
lands **alone** — these two are the only slices whose failure mode is silent · updates are a
**hybrid governed by server cost**: background refresh for lists/detail/counts at the longest
interval meeting each bound, a live connection **only** for the truck's position, one connection
per session, nothing refreshing on a hidden tab · a transport admin **cannot** receive
`order:status` for assignment→loading→transit (it goes to the order room, which `order:watch`
refuses outside `IN_TRANSIT`/`UNLOADING`, and to `user:{driverId}`), so refresh covers those
stages and no platform emission is added · `order:watch`'s own `NOT_TRACKABLE` refusal **is**
FR-017 — the screen asks and reports, never judging trackability locally · **one** platform
addition, `GET /orders/summary`, because cursor paging cannot yield a total and the multi-party
plugin already scopes `countDocuments` · card pairing accepts **two** input paths — a reader
presenting as a keyboard (always available; capture **armed only while the pairing dialog is
mounted**, which is what stops a stray read reaching another field) and a device reading the card
itself (feature-detected, never asked about) — discriminated by inter-keystroke timing plus a
terminating newline · new and rebuilt screens are **fully bilingual** from the start; untouched
screens are not retrofitted.

**Verified stale in this repo's own notes, corrected during planning**: spec 008 is described
below as "planned, not yet implemented" — it is **implemented**, on the platform (`trucks/`,
`tanks/`, `warehouses/`, `verify-vehicle`, `confirm-loading`, `LOADING`) **and** in the mobile app
(`nfc_manager`, `lib/core/nfc/`, `VehicleVerificationCubit`, `OrderStatus.loading`). The mobile
`NotificationType` enum is described as sharing no values with the backend's — the two are
**identical**, value for value. The dashboard is the only surface still behind. Treat the
remaining claims below as needing verification before they are relied on.

**Recorded deviation** (plan Complexity Tracking): the dashboard sends the refresh token in the
request body, matching `AuthController.refresh`'s actual `RefreshTokenDto`, rather than the
httpOnly cookie `api.client.ts` currently expects and the platform never issues. The cookie design
is better and remains the natural next feature; changing it here would alter **both** Flutter
clients' refresh path, which this feature cannot test.

Previously planned feature: `specs/008-nfc-truck-loading/plan.md`
(make the VEHICLE a verifiable participant: a real fleet of trucks and tanks, a driver who cannot
start until they physically verify the assigned tractor, and a warehouse leg before the customer).
**Implemented on the platform and in the mobile app** (see the correction above). Supporting
artifacts: `spec.md` (5 stories, 101 FRs, 16 clarifications resolved), `research.md` (14
decisions), `data-model.md`, `quickstart.md`, `contracts/rest-api-delta.md`,
`contracts/mobile-integration.md`.

**The situation it addresses**: a truck is not a thing the platform owns — it is a set of fields
embedded on the DRIVER's own `User` record, permanently bound to that driver, with no `_id` of its
own. Assignment picks a person, never a vehicle, and the moment it does, `assignDriver` advances
`ROUTED_TO_TRANSPORT → ASSIGNED_TO_DRIVER → IN_TRANSIT` in one transaction — there is no step
between "assigned" and "moving", no proof the driver ever reached the vehicle, and no loading stage
at all. Nothing in the platform knows where fuel comes from.

Binding decisions from that plan: a vehicle splits into **`Truck`** (the tractor, carrying the NFC
card) and **`Tank`** (the trailer, carrying code, material, capacity and permitted grades) — so
**capacity and grade guards validate the tank, not the truck** · the operator picks **driver → truck
→ tank**, with the driver's last-operated truck pre-filled (derived from order history, never a
stored `lastTruckId`) · because capability moved to the tank and selection is sequential, the driver
candidate query **drops its capability predicates entirely**, which dissolves the
`$geoNear`-cannot-follow-`$lookup` constraint that forced vehicles onto the driver record rather
than requiring a workaround for it · two credentials resolve to a truck server-side — the card's
identifier and a rotatable random **`qrToken`**, so revoking a leaked code is a token rotation and
the QR never contains an id · **one** new `OrderStatus`, `LOADING`, between assignment and transit,
which removes the `ASSIGNED_TO_DRIVER → IN_TRANSIT` edge and narrows `IN_TRANSIT` to "loaded and
travelling" — the widest blast radius in the feature, since every exhaustive switch in the backend
and **both** Flutter personas must gain a case · **`Warehouse` carries neither scoping marker**,
following `Company`'s precedent for platform-level records with no tenant above them, written only
by `SUPER_ADMIN` · verification is **strictly online and server-decided** — never queued, never
device-judged — with an operator **override** that is recorded via the existing
`manualOverride`/`overrideReason` machinery and deliberately writes **no** verification record, so
"overridden" can never be presented to a customer as "verified" · the driver enters **no quantity
anywhere** (the authoritative volume is an Aramco invoice reconciled asynchronously in a later
feature) · the QR is presentable **only through the app's live camera preview**, never from a stored
image — an absence guarded by a test, since `image_picker` is already a dependency. Slice 0 (the
cutover: the embedded `User.truck` is **deleted, not migrated**, accepted because the platform is
pre-production) and Slice 3 (the `LOADING` status) each land **alone**.

**Amended 2026-08-27 (Phase 6A in `tasks.md`, research R14, FR-030a-d), implemented and green**:
FR-030 as originally written had the loading stage re-read the *same card on the same tractor*
departure had already verified — satisfiable without the driver ever leaving the yard they started
in, so the warehouse leg had no evidence behind it at all. The loading verification is now
additionally **geofenced** against the order's own `warehouseSummary.location` (configurable
`WAREHOUSE_GEOFENCE_RADIUS_METERS`, default 500 m), evaluated against a **fresh fix sent with the
request** — never `User.location`, which the tracking stream throttles to 50 m / 3 min and which is
stalest exactly where a parked driver needs it. `matched` on a LOADING attempt now means truck **and**
place; the credential is still answered first, so a wrong card at the right depot stays
`VEHICLE_MISMATCH` and never hints the location half passed. Two new codes, deliberately not folded
into it: **`NOT_AT_WAREHOUSE`** (403, right truck wrong place — recorded, with `distanceMeters`) and
**`LOCATION_REQUIRED`** (400, no fix — **not** recorded, since nothing about the vehicle was
evaluated; the operator override stays the escape hatch). `VehicleVerification` gained
`distanceMeters`, recorded on refusals too — a boolean `withinGeofence` would mean different things
across a radius change and cannot tell "at the fence" from "in another city". Mobile: a
`PositionReader` seam (`core/location/`, shaped like `NfcReader`, distinct from
`LocationStreamService`) takes a one-shot fix on **every** submit and never short-circuits locally
when there isn't one — the stage remains the platform's call (R7); two new cubit states render as
their own messages; and the `LOADING` destination card gained a real **Navigate to the depot**
action via a new `MapNavigator` seam (T109 had shown the address but never made it a destination).
Verified: backend `npm run test` 127/127, `jest --config test/jest-e2e.json --runInBand` **40
suites / 174 tests** green (new `test/e2e/loading-geofence.e2e-spec.ts`); mobile `flutter test`
**362 passing** with only the two documented pre-existing non-green tests.

**Amended 2026-09-01 (`card-uid.util.ts`, commit `505c709`), implemented and green**: spec 008's
own Assumptions called the NFC identifier "an opaque string ... compared for equality", so "cards of
differing encodings work without change". **That is true only while one reader is the sole capture
path, and the platform has two**: the transporter's desk-mounted reader pairs the card, the driver's
phone presents it, and the two render the same physical UID differently — case, separators, a
decimal rather than hex reading, and frequently the reverse byte order. Compared raw, a driver would
present the correct card at the correct truck and be refused — and because FR-018 deliberately makes
"wrong truck" and "no such card" the same refusal, that failure carries no diagnostic to follow.

Both ends now normalize (`normalizeCardUid`): `TrucksService.pairCard` STORES the canonical form,
and `VehicleVerificationService.resolveCredential` tries `cardUidLookupCandidates` in **precedence
order** — canonical, then the raw value, then the byte-reversal — one lookup at a time rather than a
single `$in`, so an exact match always beats a coincidental byte-reversed one (two distinct cards
whose UIDs are byte-reverses of each other would otherwise be mutually resolvable). The raw value is
retained as a candidate so trucks paired before this change keep working without a re-pair.
Decimal-vs-hex is resolved by **length, not content**: ten digits is the only width a reading cannot
also be hex, since no card carries a 5-byte UID. The **QR token is still compared exactly** — it is
platform-generated, has one rendering, and loosening it would only widen what a guess can hit. This
also strengthens FR-005/SC-008: uniqueness is now enforced on the canonical form, so two renderings
of one card can no longer pair to two different trucks.

**Also 2026-08-27, separately**: spec 008's test backlog — 37 tasks marked complete in
implementation but never written — closed in one pass (`tasks.md`'s Notes section has the full
list and rationale). Writing the missing tests surfaced two real, previously-undetected defects,
both fixed: `DispatchService.assignDriver` committed a partial driver/truck/tank booking on a
mid-transaction refusal (an early `return` inside `session.withTransaction` commits rather than
aborting — fixed by throwing instead) and `OrdersController.findMine` (the client's order list)
leaked the full verification trail — driver GPS, timestamps, truck ids — that `findOne` carefully
stripped, because the strip lived at one endpoint instead of a shared one (fixed by extracting
`toRoleScopedShape`, used by both). Backend now **47 e2e suites / 235 tests** green (7 new files);
mobile **397 passing** (5 new files), same two pre-existing baseline failures. Canonical
`specs/001-fuel-delivery-platform/contracts/rest-api.md` updated to match the platform as it
actually is (fleet/warehouse/verification endpoints, corrected assignment signature). Only T140/
T141 remain — both need a live environment.

**Deferred out of this feature**: Aramco invoice upload/reconciliation and the **client litre
balance** it feeds. Once volume left the delivery flow, nothing here could move a balance — it would
have shipped a screen that could only display zero.

Previously planned feature: `specs/007-driver-home-delivery/plan.md`
(give the DRIVER their real work). **Implemented and verified**: backend 122 unit + 166 e2e green;
mobile 348 passing with exactly two pre-existing non-green tests (`login_screen_golden_test` pixel
diff, `auth_session_test` skipped). 104 of 105 tasks complete — only T102, the manual live-backend
walkthrough, remains.

**The situation it addressed**: every driver-facing operational screen was a static mock-up, and
the delivery machinery behind them — which exists, is registered in DI, and is unit-tested — is
never invoked. `driver_home_screen.dart` (642 lines) has no cubit at all: it hardcodes duty
status, a fabricated `4.8` rating and a `5` orders-today counter, and four sample order rows.
**Four independent defects each keep a delivery uncompletable**: `DeliveryCubit.load()` is never
called from anywhere · `getActiveOrder()` parses `response.data!['data']` against a
`{ items, nextCursor }` response · nothing ever calls `/arrive` or `/request-delivery-otp`, the
two steps that *issue the customer their handover code*, so the customer never receives anything
to show · and **a driver cannot receive `order:status` at all** — `TrackingGateway.watch` refuses
drivers with `FORBIDDEN_ROLE` and the event goes only to the order room, so
`DeliveryCubit._handleStatus` has never once fired. `OtpVerifyCubit` is fully orphaned (never
registered, never used), and nine `onPressed: () {}` handlers sit on driver screens.

Binding decisions from that plan: `order:status` is additionally emitted to **`user:{driverId}`**
— the same user room spec 006 uses for `session:revoked` — because a driver is banned by design
from the order room, and without this FR-007/SC-007 are unimplementable · every socket handler
attaches **after `await trackingSocket.connect()`**, never in a constructor (`DeliveryCubit`
does exactly that today and is a lazy singleton — `mobile_app/CLAUDE.md` debt #6's silent-no-op
failure) · the driver's delivery **list reuses the existing `features/orders/` stack** rather
than growing a second paginated datasource for one endpoint (retiring part of debt #2) · the
customer's contact details are mirrored onto the order as **`clientSummary`**, snapshotted in
`assignDriver`'s existing transaction exactly as `driverSummary` already is · ratings live in a
new **multi-party `DeliveryRating`** collection with a **unique index on `orderId`** as the
actual "rate once" guarantee, and the driver's aggregate is bumped in the **same transaction** ·
`ratingAverage` has **no schema default** — absence *is* "not yet rated", a distinct state from
a score of zero, all the way from document to screen · a new `deliveredAt` field backs the daily
count, since `updatedAt` drifts (invoices and payments touch a delivered order afterwards).
Slice 0 (the realtime routing + attachment fix) must land **first and alone** — it is the one
change that is invisible when wrong. The `NotificationType` correction (debt #5: the app's enum
shares **no values** with the backend's, so every live notification degrades to `unknown`) and
the client's rating control both touch the CLIENT persona and land **alone with both suites
green**.

Previously completed feature: `specs/006-driver-auth-session/plan.md`
(close the DRIVER's session lifecycle: live identity, a mandatory device lock, field password
recovery, real sign-out revocation, prompt revocation). **All 89 tasks (T001–T089) implemented
and verified**: backend 122 unit + 147 e2e green; mobile 294 passing with exactly two pre-existing
non-green tests (`login_screen_golden_test` pixel diff, `auth_session_test` skipped).

Binding decisions from that plan, still in force: revocation rides **one account-level
`sessionGeneration` counter** mirrored into the JWT as `sgen` and compared inside
`validateActiveSessionWithScoping` — one check delivering single-active-session, sign-out
revocation, reset-invalidates-sessions and the deactivation backstop · a driver holds **at most
one session**, so a new sign-in displaces the old · revocation is **pushed** on `session:revoked`
into the `user:{userId}` room, with handshake refusal as the offline fallback · the app lock is
**mandatory and unconfigurable**, enforced client-side via `local_auth`, and **must accept the
device passcode** (`biometricOnly: false`) so a failed sensor cannot strand a driver
mid-delivery · the lock **never changes duty state** — a locked device stays online and
dispatchable · password recovery returns an **identical 202 for known, unknown and failed-send**
numbers · every session lifecycle event is audited, with **no TTL**.

Previously planned feature: `specs/005-client-backend-integration/plan.md`
(connect every client-facing mobile screen to the backend; add the platform capability the client
journey needs). Supporting artifacts: `spec.md` (9 stories, 84 FRs, 5 clarifications resolved),
`research.md` (11 decisions), `data-model.md`, `quickstart.md`,
`contracts/rest-api-delta.md`, `contracts/mobile-integration.md`.

**The situation it addresses**: of every screen a CLIENT can reach, only the home dashboard and
login read live data. Orders list, order detail and track-order are static previews driven by an
in-app `MockOrderState` enum — even though `OrdersCubit`/`OrderDetailCubit`/`PaymentCubit` exist,
are registered in DI and are tested. Roughly half the feature is mounting what is already built.

Binding decisions from that plan: order costs are **itemised** (fuel line, delivery fee, service
fee, tax) from a per-fuel-company `pricingConfig`, with the rates in force retained on the order
so a later config change cannot rewrite history · a client may have **several `Station`
documents**, registered by their fuel company (promoted out of the embedded single `user.station`;
"station" is the canonical term, not "delivery location") · all four client lists are
**cursor-paginated** (never skip/limit — inserts at the head would duplicate rows) · phone
verification reuses the OTP primitives, extracted subject-agnostic from `otp.service.ts` behind an
`SmsSender` port · support requests route to fuel company admins via the existing notification
path, two states only. Two changes touch driver-app ground and must land **alone with the existing
suites green**: the OTP extraction and the station migration.

Previously completed feature:
`specs/004-multi-tier-platform/plan.md` (CIRO → Fuel Company → Transportation Company → Client
hierarchy, order routing/assignment, three payment methods, live-delivery visibility). All 9
phases (T001–T100) are implemented and verified: backend e2e/unit suites green, mobile app wired
end to end. See `specs/004-multi-tier-platform/spec.md`/`tasks.md` for the full requirement and
task breakdown.

**Roles, as they exist today** (spec 004 split the original `COMPANY_ADMIN` in two):
`SUPER_ADMIN` (CIRO, the platform operator, exempt from tenant isolation) · `FUEL_COMPANY_ADMIN`
(pricing, clients, order approval/routing, transporter onboarding, invoice/credit
administration — `COMPANY_ADMIN`'s direct successor) · `TRANSPORT_COMPANY_ADMIN` (owns a driver
fleet, picks up orders routed to it, settles deferred invoices) · `CLIENT` · `DRIVER`. A
`Company` document carries `type: FUEL | TRANSPORT`. Tenant isolation is now two mechanisms:
the original `companyId`-equality plugin for single-tenant collections (users, trucks, files,
credit limits), plus a second, parallel plugin for multi-party collections (orders, invoices,
which can have up to four legitimate viewers in three different companies) that scopes by role
instead of a single field — see `src/common/plugins/multi-party-scope.plugin.ts`.

Also planned: `specs/003-web-admin-dashboard/plan.md` (React web dashboard — CIRO, Fuel
Company and Transportation Company admins). Not yet started — `web_dashboard/` has no code yet;
its role/route contracts have been updated for spec 004's split but the dashboard itself still
needs building. **Spec 005 now depends on it**: registering a client's stations and acknowledging
support requests both need a fuel company administration surface that only the dashboard provides.
Neither blocks 005's development (stations can be seeded directly), but both block its launch.

Supporting design artifacts (003 — web dashboard, planned):
- Spec: `specs/003-web-admin-dashboard/spec.md`
- Research decisions: `specs/003-web-admin-dashboard/research.md`
- Data model: `specs/003-web-admin-dashboard/data-model.md`
- Contracts: `specs/003-web-admin-dashboard/contracts/` (backend-integration, rbac-and-routing, ui-state-contract)
- Quickstart: `specs/003-web-admin-dashboard/quickstart.md`

Web dashboard binding constraints: dedicated `web_dashboard/` root (never mixed with backend or
mobile); React 18 + Vite + TypeScript (`strict`); entry `src/main.tsx`; Feature-Based
Architecture (`src/features/{auth,orders,companies,drivers,clients,settings}`) with fetching/state
decoupled from UI via hooks; functional components only (no class components); TanStack Query for
server state (order views via `refetchInterval` polling — no Socket.io in v1) + Zustand for
session/UI; Tailwind + shadcn/ui; React Router v6 with `<ProtectedRoute allow={Role[]}>` guarding
every route BEFORE any out-of-scope fetch (roles: `SUPER_ADMIN`/`FUEL_COMPANY_ADMIN`/
`TRANSPORT_COMPANY_ADMIN`, spec 004); centralized `api.client.ts` Axios interceptor with
single-flight silent `/auth/refresh` on 401 (403/404 = access boundary, never refresh); access
token in-memory only, refresh token in an httpOnly+Secure+SameSite=Strict cookie (never
JS-readable storage); bilingual Arabic(default)/English with full RTL via react-i18next + Tailwind
logical properties; no magic values (roles/statuses/routes/query-keys as enums/const maps); no
tenant/user free-text rendered as HTML; backend is the sole source of truth for every transition.
NOTE: depends on a feature-001 backend change to issue the refresh token as an httpOnly cookie.

Mobile app (feature 002, extended by spec 004): `specs/002-flutter-mobile-app/plan.md` —
dedicated `mobile_app/` root; Clean Architecture + MVVM/Cubit; Dio single-flight `/auth/refresh`
interceptor; `socket_io_client` on `/tracking`; native Sadad/Mada gateway for DIRECT orders only
(backend webhook = sole payment confirmation) — DEFERRED/CREDIT skip payment entirely
(`paymentMethod` on order creation, spec 004 FR-021); OTP never rendered on driver build; driver
name/plate/ETA/delivery address are now real API fields (`driverSummary`, `etaMinutes`,
`deliveryAddressText`), no longer placeholders; backend is source of truth for every transition.

Backend platform (feature 001, extended by spec 004, consumed by both clients):
`specs/001-fuel-delivery-platform/plan.md`, contract in
`specs/001-fuel-delivery-platform/contracts/rest-api.md`. Entry file `src/server.ts`; uploads
under `sys_storge`; REST `/api/v1`; `/tracking` Socket.io namespace; tenant isolation via two
global Mongoose plugins (see above) + AsyncLocalStorage; MongoDB transactions for dispatch,
order approval/invoice issuance, payment settlement, and the payment webhook.
<!-- SPECKIT END -->
