# Feature Specification: Production Hardening & Horizontal Readiness

**Feature Branch**: `012-production-hardening`

**Created**: 2026-08-30

**Status**: Draft

**Input**: User description: "The platform goes to production this week, carrying real orders, drivers and payments for a Saudi customer. Reading the backend as it stands, several properties a production system needs are missing — not features anyone asked for, but the things that decide whether an incident is a five-minute fix or a silent failure nobody notices. [...] The work is to close these gaps without changing any behaviour the platform already has."

## Overview

This feature changes **how the platform is operated and observed**, not what it does. Every existing
endpoint, request/response payload, tenant-scoping rule, transaction boundary and order-lifecycle
transition stays exactly as it is. The deliverable is a set of operational properties the platform
does not have today, ordered so that the four that block launch land first, the four that decide
whether an incident is diagnosable land second, and the two that decide whether the platform can
ever run redundantly land last — because that last pair is what makes the deployment final rather
than provisional.

Every gap below was **verified against the code**, not assumed. Where the original framing was
imprecise, the corrected finding is recorded in *Verified Current State* and reflected in the
requirements. Three findings there are materially different from the framing that prompted this
spec, and one of them is an additional single-instance constraint that was not named at all.

## Clarifications

### Session 2026-08-30

- Q: What is the production deployment target? → A: VMs running the existing Docker Compose behind nginx, with a process manager (Option C)
- Q: Does the Saudi customer impose a data-residency requirement on personal data? → A: Unknown — not yet stated by the customer. Treat in-Kingdom residency as the defensive assumption, design every external store to be region-portable, and record the legal confirmation as an open pre-launch risk (Option D, extended)
- Q: What makes uploaded documents durable? → A: Google Cloud Storage, a regional bucket in the same project and region as the VM. Documents are served to clients by time-limited signed URL directly from the bucket, never proxied through the platform. The existing `sys_storge/{companyId}/{uuid}{ext}` shape is retained as the object key prefix
- Q: How does the download route hand over the signed location? → A: A 302 redirect to a V4 signed URL with a 5-minute expiry, issued only after the existing token and tenant-scope checks pass. Bucket CORS scoped to the dashboard origin specifically, never a wildcard. Acceptance MUST include verifying the redirect on a real mobile build, because a client that forwards its `Authorization` header through the cross-origin redirect will be rejected by the object store — a failure that appears on mobile only
- Q: Where do secrets come from, and how are their reads recorded? → A: A managed secret store in the same project, read at startup through the VM's own service identity; rotation is a new secret version, and reads are recorded by the provider's audit logging (Option A)
- Q: How is Story 9 verified, given none of its guarantees is observable in a single process? → A: Both — an automated multi-instance suite (two app instances, shared database and coordination backend) runs in continuous integration and covers the contested lease, duplicate sweep, cross-instance delivery, shared counters and drain-one-keep-serving cases; **and** a live pre-launch pass on the real deployment confirms the handful of properties only a real environment can establish, tracked as an owned checklist rather than as prose (Option D)
- Q: Which dependencies make an instance report itself not ready? → A: The database alone disqualifies an instance. Redis is checked and reported in the response for monitoring, but never removes an instance from rotation — a Redis blip would otherwise make every instance unready at the same moment and leave the proxy with nowhere to route, converting a partial degradation into a total outage (Option B)
- Q: What does "exactly once" mean for the scheduled sweeps? → A: A distributed lease, **plus** mandatory idempotency — a lease is at-most-once under normal operation, not exactly-once, since a pause or stall past the TTL can still produce a concurrent run. FR-056 is amended to state the achievable guarantee, and every sweep must additionally be safe to run twice using the conditional-write pattern feature 011 established. Lease mechanics: acquire with a unique token and expiry in one atomic operation, release by compare-and-delete so no holder can release another's lease, TTL above the measured p99 sweep duration with renewal for long runs. A sweep that stops completing MUST raise an alert (Option A, corrected and extended)
- Q: Where do structured records go, and is the collector in scope? → A: Managed logging in the same project and region, collected from the container's standard output by the VM's logging agent. Retrieval by order identifier is a field filter on the collected records, which makes SC-007 demonstrable inside this feature. No new service to operate; log volume becomes a running cost, so per-environment verbosity control (FR-035) is load-bearing (Option A)

### Session 2026-08-31

Raised by the post-`/speckit-tasks` cross-artifact analysis, which found that this feature makes
Redis load-bearing for **five** subsystems — queues, cache, rate-limit counters, scheduler leases and
cross-instance realtime delivery — while Session 2026-08-30's Q7 decided Redis must never affect the
readiness verdict. That combination is only sound if each of the five has a defined degradation.
Three did not.

- Q: What does the local storage driver return on download, and does the redirect path get CI coverage? → A: The local driver also returns a URL and the controller **always** issues a 302, so there is one controller path exercised identically by every suite and by production. **Two amendments.** (1) The local byte route MUST take a short-lived signed token in the URL rather than sitting behind the normal `Authorization` header — clients vary in whether they forward that header across a redirect, so an authenticated local route would break for some and pass for others, reintroducing the very trap this closes; a signed, expiring, header-less URL also mirrors the production shape in the security-relevant dimension, not merely in the status code. (2) The spec must state plainly what this does **not** cover, so green CI is not read as full coverage. Also: `Cache-Control: no-store` on the redirect, since a cached 302 pointing at an expired URL fails intermittently and reads as a storage fault
- Q: What consumes the readiness signal in steady state, given open-source nginx cannot actively poll it? → A: An external monitor polls readiness while nginx keeps passive detection — **with three amendments**. (1) First establish whether a managed load balancer or instance group already sits in front of nginx: if so its own health check supplies active readiness-based routing at no cost, and this reduces to an alerting concern. This also settles the trusted-hop count, which is otherwise still open. (2) The monitor MUST be able to *act*, not only alert — on sustained readiness failure it rewrites the upstream and reloads, because passive detection cannot be relied on to shed a broken instance. (3) Configure the proxy to retry a failed request against a healthy instance, which both protects users during the detection gap and makes those responses count as upstream failures so passive detection fires at all. HAProxy documented as the fallback if (1) is negative and the upstream rewrite proves too hand-rolled (Option A, extended)
- Q: What does the platform do when Redis is unavailable, given Q7 keeps instances in rotation? → A: Rate-limit counters **fall back to per-instance in-memory counting** on a storage error. Limiting continues at N× the intended budget across N instances — approximate but **bounded**, which is categorically different from unlimited, and it is exactly the platform's behaviour today, so the fallback path is not novel code. Availability and brute-force protection are both preserved; counters reset on failover. Loss of the cross-instance transport must additionally be **detectable and alerted**, closing FR-063 (Option D, extended)

## User Scenarios & Testing *(mandatory)*

Stories are grouped in three priority bands, matching the three tiers in the request. Within a band
the listed order is the intended implementation order. Every story is independently testable and
independently deployable.

---

### User Story 1 - The platform can be asked whether it is alive (Priority: P1)

An automated monitor, a load balancer, or a container orchestrator needs to determine, without
credentials and without side effects, whether a given instance of the service is running and whether
it is ready to receive traffic. Today nothing can ask: there is no such endpoint, so no monitor can
watch the platform, no proxy can route away from a broken instance, and the first person who learns
the platform is down is a driver on the phone.

**Why this priority**: This is the precondition for every other operational property. Without it,
graceful shutdown cannot be observed to work, a failed instance cannot be routed away from, and no
deployment platform can make a rollout decision. It is also the cheapest of the four blockers.

**Independent Test**: Start the service; call the liveness signal with no credentials and confirm a
healthy response. Stop the database; confirm the liveness signal still reports the process alive
while the readiness signal reports the instance not ready. Confirm neither signal consumes the
caller's rate-limit budget, and that a monitor polling every few seconds indefinitely is never
throttled.

**Acceptance Scenarios**:

1. **Given** a running service with its database and queue backend reachable, **When** an
   unauthenticated caller asks whether the instance is alive, **Then** it receives an affirmative
   response identifying the instance, without needing a token and without a tenant context.
2. **Given** a running service whose database has become unreachable, **When** an unauthenticated
   caller asks whether the instance is ready to serve traffic, **Then** it receives a negative
   response naming which dependency is unavailable, while the liveness signal still reports the
   process itself as alive.
2a. **Given** a running service whose cache and queue backend has become unreachable but whose
   database is healthy, **When** readiness is asked, **Then** the answer is **affirmative** and the
   response body reports the cache and queue backend as unavailable — so monitoring sees the
   degradation while the instance stays in rotation.
2b. **Given** every instance loses the cache and queue backend at the same moment, **When** the proxy
   evaluates readiness across the fleet, **Then** every instance remains in rotation and the platform
   continues serving requests that do not depend on it — including requests subject to rate limiting,
   which falls back to per-instance counting rather than failing (FR-061a).
2c. **Given** the same outage, **When** it begins, **Then** an alert is raised for stalled scheduled
   work and for the impaired cross-instance transport, because the platform will otherwise report
   itself entirely healthy throughout (FR-058a, FR-063a).
3. **Given** a monitor polling the liveness signal every five seconds for an hour, **When** the
   polling continues, **Then** no request is ever refused for exceeding a rate limit, and no other
   client's rate-limit budget is affected.
4. **Given** an instance that has started but has not yet finished connecting to its dependencies,
   **When** readiness is asked, **Then** the answer is negative until every dependency the instance
   needs to serve a request is confirmed reachable.
5. **Given** an instance that has begun shutting down, **When** readiness is asked, **Then** the
   answer is negative *before* the instance stops accepting connections, so a proxy stops sending it
   new work while it drains.

---

### User Story 2 - A deploy does not sever work in progress (Priority: P1)

The service is replaced on every deploy, not only when it crashes. Today it stops instantly: HTTP
requests are cut mid-response, realtime connections vanish without a close frame, and background
jobs are killed part-way through. A payment-timeout or escalation job severed halfway leaves an
order in a state no code path expects — and because this only ever happens during a restart, it will
be diagnosed as an intermittent logic bug rather than as a shutdown problem.

**Why this priority**: This one produces *corrupt data*, not just downtime, and it produces it on a
schedule — every single deploy. It is also the failure most likely to be misattributed, which makes
it the most expensive to discover after launch.

**Independent Test**: Issue a long-running request and a background job, then signal the process to
terminate. Confirm the in-flight request completes with a correct response, the job either completes
or is returned to its queue for redelivery rather than being abandoned mid-write, connected realtime
clients receive an orderly disconnect, and the process exits only after all of that or after a
bounded deadline.

**Acceptance Scenarios**:

1. **Given** an in-flight request that has not yet produced a response, **When** the service is
   asked to terminate, **Then** the request runs to completion and its response is delivered before
   the process exits.
2. **Given** a background job that is mid-execution, **When** the service is asked to terminate,
   **Then** the job is allowed to finish, or is released back to its queue so another instance or a
   later start redelivers it — it is never abandoned between two writes that were meant to be
   consistent.
3. **Given** connected realtime clients, **When** the service is asked to terminate, **Then** each
   client is disconnected in an orderly way that its own reconnect logic recognises, rather than
   having the connection disappear.
4. **Given** a shutdown in progress, **When** a new request arrives, **Then** the instance is already
   reporting itself not ready, so a correctly configured proxy has stopped routing new work to it.
5. **Given** work that does not finish within the drain deadline, **When** the deadline expires,
   **Then** the process exits anyway rather than hanging indefinitely, and the forced exit is
   recorded distinguishably from a clean one.
6. **Given** any shutdown, clean or forced, **When** the process exits, **Then** every open
   connection to the database, the queue backend and the cache has been closed deliberately rather
   than dropped.

---

### User Story 3 - The web dashboard can reach the API in production (Priority: P1)

Cross-origin access is granted only when the service is *not* running in production. In production
every browser request from the dashboard is refused before it reaches any handler, while the mobile
apps — which are not subject to cross-origin rules — work perfectly. The result is that the
dashboard appears to be broken in a way that looks exactly like an authentication failure, and will
be investigated as one.

**Why this priority**: The transport and fuel company administrators have no other client. This is a
total outage of an entire surface, presenting under a misleading symptom.

**Independent Test**: Run the service configured as production and issue a browser-style cross-origin
request from a configured dashboard origin; confirm it succeeds. Issue the same request from an
origin that is not configured; confirm it is refused. Confirm a mobile-style request with no origin
header is unaffected in both cases.

**Acceptance Scenarios**:

1. **Given** the service running in production configuration with the dashboard's origin permitted,
   **When** a browser at that origin issues a cross-origin request, **Then** the request is permitted
   and the response carries the headers a browser requires to hand it to the page.
2. **Given** the same service, **When** a browser at an origin that has not been permitted issues a
   cross-origin request, **Then** the request is refused, and the refusal does not reveal which
   origins are permitted.
3. **Given** a browser issuing a preflight check before a request that carries authorization,
   **When** the preflight is handled, **Then** it succeeds without consuming the caller's rate-limit
   budget and without requiring credentials.
4. **Given** a mobile client, which sends no origin, **When** it issues any request in any
   environment, **Then** its behaviour is exactly what it is today — unchanged and unaffected.
5. **Given** any environment, **When** the permitted-origin configuration is absent or empty in
   production, **Then** the service refuses to start rather than starting with browser access
   silently broken.

---

### User Story 4 - Rate limiting tells one client from another behind a proxy (Priority: P1)

In production the service will sit behind a proxy or load balancer. Every request then arrives
carrying the proxy's address rather than the client's, so the platform-wide rate limit — which counts
per originating address — collapses into a single shared budget for every user on the platform. One
busy client exhausts it and locks out everyone else. Separately, nothing anywhere records which
client a request came from, so when that happens there is no way to find out who.

**Why this priority**: A single client can deny service to the entire platform, and the platform
cannot see it happening. Both halves are launch-blocking, and both are fixed at the same place.

**Independent Test**: Place the service behind a proxy that forwards client addresses. Drive one
client past the limit and confirm it alone is refused while a second client from a different address
continues to be served. Confirm the recorded request line for each attributes it to a distinct
originating client. Confirm an address forged by a client, rather than added by the trusted proxy, is
not honoured.

**Acceptance Scenarios**:

1. **Given** the service behind a trusted proxy, **When** two clients at different addresses issue
   requests, **Then** each is counted against its own budget and exhausting one does not affect the
   other.
2. **Given** an authenticated request, **When** its budget is counted, **Then** it is attributed to
   the authenticated user, so a user cannot obtain a fresh budget by changing networks and users
   sharing one office network do not share one budget.
3. **Given** an untrusted client that supplies its own forwarded-address header, **When** the request
   is evaluated, **Then** the client-supplied value is not honoured and the request is attributed to
   the address the trusted proxy actually observed.
4. **Given** any request, **When** it completes, **Then** the record kept for it identifies the
   originating client — the authenticated user where there is one, the client address otherwise — so
   the origin of a burst is recoverable after the fact.
5. **Given** an existing route that already applies a per-user limit today, **When** this change
   lands, **Then** that route's observable limit and its refusal response are exactly what they are
   now.

---

### User Story 5 - Everything that happened to one order can be retrieved (Priority: P2)

When something goes wrong with a specific order, there is no practical way to retrieve everything
that happened to it. Records are unstructured lines of text with no field anyone can filter on, and
the request record carries no identity at all — not the user, not the tenant, not the order, and no
identifier that would let a request be followed across the services and background jobs it triggers.

**Why this priority**: This does not prevent launch, but it is the difference between a five-minute
incident and an unbounded one. It is first in the second band because every later investigation
depends on it.

**Independent Test**: Drive one order through its lifecycle across several requests and at least one
background job, then retrieve every record relating to that order by its identifier alone, and
confirm the set is complete and ordered.

**Acceptance Scenarios**:

1. **Given** an order that has moved through several lifecycle stages, **When** an operator retrieves
   records filtered by that order's identifier, **Then** they receive every record produced by every
   request and background job that touched it, in chronological order.
2. **Given** any single request, **When** its records are examined, **Then** each carries a
   correlation identifier, the acting user and tenant where one exists, the route, the outcome and
   the duration, as separately addressable fields rather than as prose.
3. **Given** a request that enqueues background work, **When** that work later runs, **Then** its
   records carry the same correlation identifier as the request that caused it.
4. **Given** any record, **When** it is produced, **Then** it never contains a credential, a token, a
   proof-of-delivery code, a payment secret, or any value the platform is forbidden from returning in
   a response.
5. **Given** an unhandled failure, **When** it is recorded, **Then** the record carries the
   correlation identifier and enough structure to locate the failing operation, while the response
   sent to the caller is exactly the response shape the platform sends today.

---

### User Story 6 - Uploaded documents outlive the machine that received them (Priority: P2)

Uploaded documents are written to a directory on the local filesystem of whichever machine handled
the upload. The containerised deployment does bind-mount that directory from the host, so a document
survives its container — but not the host. Their durability is that one disk's durability and nothing
more: no replication, no off-box copy, and no recovery if the VM is lost. A second instance on a
second machine cannot serve a document uploaded to the first.

**Why this priority**: Documents are compliance and dispute evidence. Losing them is unrecoverable,
unlike almost every other failure here. It is also a hard prerequisite for running more than one
instance, so it sits ahead of that work.

**Independent Test**: Upload a document, then serve it from a process that has no access to the
filesystem the upload was received on, and confirm the bytes are identical. Destroy and recreate the
serving environment and confirm the document is still retrievable.

**Acceptance Scenarios**:

1. **Given** a document uploaded through the existing upload route, **When** the machine or container
   that received it is destroyed and replaced, **Then** the document is still retrievable, byte for
   byte, through the existing download route.
2. **Given** two instances of the service, **When** a document is uploaded to one and requested from
   the other, **Then** the second serves it successfully.
3. **Given** any upload, **When** it is performed, **Then** its request and response payloads are
   exactly what they are today. **Given** any download, **When** it is performed, **Then** it remains
   a single call to the same route, and neither client has to learn a new route, parse a new body, or
   manage a location's lifetime.
4. **Given** a document belonging to one tenant, **When** a user of another tenant requests it,
   **Then** it is refused exactly as it is refused today, and no signed location is issued.
5. **Given** the object store is temporarily unreachable, **When** an upload is attempted, **Then**
   it fails promptly with the platform's standard error shape rather than appearing to succeed, and
   no metadata record is left behind for bytes that never landed.
6. **Given** a signed location that has been issued, **When** its lifetime expires, **Then** it no
   longer serves the object, and a caller must return to the platform — and pass the tenant and role
   checks again — to obtain another.
7. **Given** an object's storage key, **When** it is requested without a valid signed location,
   **Then** the object store refuses it, whether the requester is anonymous or authenticated to the
   hosting provider for some other purpose.
8. **Given** a real build of the mobile app on a device, **When** a driver or client opens a document,
   **Then** the redirect is followed and the file is displayed — verified on the build itself, since
   a client that forwards its `Authorization` header across the redirect fails here and nowhere else.
9. **Given** a page on an origin the bucket's cross-origin policy does not name, **When** it obtains a
   signed location and requests the object from a browser, **Then** the browser refuses to hand it
   the response.

---

### User Story 7 - Secrets can be rotated, and their use is accountable (Priority: P2)

Secrets — signing keys, payment gateway secrets, database and messaging credentials — are read from
a file that sits beside the application. That file travels into every backup, image and snapshot
taken of the machine; the secrets in it cannot be rotated without redeploying; and nothing records
who has read them.

**Why this priority**: A signing key that cannot be rotated means a suspected compromise has no
remedy short of invalidating every session on the platform. This is a real risk for a platform
carrying payments, but it is not a launch blocker in the way an outage is.

**Independent Test**: Change a secret at its source without rebuilding or redeploying the
application, and confirm the running platform picks up the change within its stated window. Take a
backup or image of a deployment and confirm no secret value is recoverable from it. Read a secret and
confirm the read is recorded with an identity and a timestamp.

**Acceptance Scenarios**:

1. **Given** a deployed service, **When** an image, snapshot or backup of it is inspected, **Then**
   no secret value is recoverable from it.
2. **Given** a secret that must be rotated, **When** it is changed at its source, **Then** the
   platform adopts the new value within a stated, bounded window without an application rebuild.
3. **Given** a signing key rotation, **When** it takes effect, **Then** already-issued credentials
   behave exactly as the platform's existing session and revocation rules say they should — this
   feature introduces no new session semantics.
4. **Given** any secret read, **When** it occurs, **Then** it is recorded with the identity that read
   it and when, and that record is retrievable independently of the platform's own records.
5. **Given** a required secret that cannot be retrieved at start, **When** the service starts,
   **Then** it refuses to start rather than starting in a degraded state — matching how the platform
   already refuses to start on invalid configuration.
6. **Given** local development, **When** a developer runs the platform, **Then** they are not
   required to stand up production secret infrastructure to do so.

---

### User Story 8 - A brief database interruption fails fast and recovers (Priority: P2)

The database connection carries no explicit limits on how many connections it may hold, how long it
will wait to acquire one, or how long an operation may run. A brief interruption therefore does not
surface as a burst of quick failures that the platform recovers from; it surfaces as requests piling
up, holding resources, and degrading the whole service long after the interruption itself has ended.

**Why this priority**: It turns a transient dependency blip into a compounding outage. It is last in
the second band because it changes failure *shape* rather than adding a missing capability.

**Independent Test**: Interrupt the database briefly under load. Confirm requests fail promptly with
the platform's standard error shape rather than accumulating, that concurrent connections never
exceed the configured ceiling, and that the platform serves normally again within a bounded time
after the database returns, with no restart.

**Acceptance Scenarios**:

1. **Given** the database is briefly unreachable under load, **When** requests arrive, **Then** each
   fails within a bounded time with the platform's standard error shape, rather than waiting
   indefinitely.
2. **Given** the database becomes reachable again, **When** it does, **Then** the platform serves
   requests normally within a bounded recovery window without being restarted.
3. **Given** sustained load, **When** connection demand exceeds the configured ceiling, **Then**
   requests queue for a bounded time and are refused promptly after it, and the ceiling is never
   exceeded.
4. **Given** an operation that exceeds its permitted duration, **When** the limit is reached,
   **Then** it is terminated, and the termination does not leave a transaction partially applied —
   every existing transaction boundary keeps exactly its current all-or-nothing behaviour.
5. **Given** the database is unreachable, **When** readiness is asked, **Then** the instance reports
   itself not ready, so traffic is routed elsewhere while it recovers.

---

### User Story 9 - The platform can run as more than one instance (Priority: P3)

Today the platform can only ever run as a single instance, and two independent constraints enforce
that — plus a third found while verifying this spec. Scheduled sweeps are scheduled inside each
running process, so a second instance would run every sweep again, concurrently, over the same
drivers and the same deliveries. Realtime messages are held in the memory of whichever process owns
the connection, so a broadcast from one instance would never reach clients attached to another — live
tracking would work for some users and silently fail for others, determined by nothing but which
instance they happened to land on. And rate-limit counters are held in process memory, so N instances
grant N times the intended budget and every deploy resets every counter.

**Why this priority**: Until all three are addressed, redundancy is not a budget decision — it is
impossible. This is the outcome that makes the deployment final rather than provisional, and it is
last because it depends on durable document storage (Story 6) and is verified using the readiness
signal (Story 1).

**Independent Test**: Run two instances against one shared database and coordination backend, in an
automated suite (FR-069). Confirm each scheduled sweep is run by at most one instance per interval,
not once per instance, and that a sweep forced to run twice concurrently has the effect of one.
Confirm a client connected to one instance receives an event emitted by the other. Confirm a client's
rate-limit budget is one shared budget regardless of which instance serves each request. Then drain
one instance and confirm the other keeps serving and no work is lost.

**Acceptance Scenarios**:

1. **Given** two or more instances running, **When** a scheduled sweep interval elapses, **Then** at
   most one instance runs the sweep, and every driver and delivery it examines is acted on once.
1a. **Given** a sweep that runs concurrently on two instances because a lease lapsed during a process
   pause, **When** both runs complete, **Then** the observable effect is identical to a single run —
   no duplicate notification is sent, no lifecycle is advanced twice, and no second stop event is
   opened for one stop.
2. **Given** the instance that most recently ran a sweep stops, **When** the next interval elapses,
   **Then** a surviving instance runs the sweep, within one interval, without operator action.
3. **Given** a realtime client connected to one instance, **When** another instance emits an event
   addressed to that client's user or to a delivery that client is watching, **Then** the client
   receives it, indistinguishably from the single-instance case.
4. **Given** two or more instances, **When** one client issues requests that are distributed across
   them, **Then** those requests count against one shared budget, and the platform-wide limit is the
   configured limit rather than a multiple of it.
5. **Given** two or more instances, **When** background jobs are processed, **Then** each job is
   handled once, and adding instances increases throughput rather than duplicating work.
6. **Given** an instance is removed from service, **When** it drains and exits, **Then** its realtime
   clients reconnect to a surviving instance and resume receiving events, and no scheduled or
   background work is lost.
7. **Given** any number of instances, **When** the platform is exercised end to end, **Then** every
   existing behaviour — endpoints, payloads, tenant scoping, transaction boundaries, order lifecycle
   semantics — is identical to the single-instance case.

---

### Edge Cases

- **A dependency is degraded but not down.** Readiness must distinguish "cannot serve" from "slow".
  A readiness check that itself hangs when the database is slow turns a partial degradation into a
  full outage by removing every instance from rotation at once — bounded by FR-006, and kept off the
  request pool by FR-006a.
- **The cache and queue backend goes down platform-wide.** Resolved by Clarifications Q7 and Q10:
  instances stay in rotation and report the degradation without acting on it (FR-002a); rate limiting
  falls back to per-instance counting rather than failing requests (FR-061a); queued work stalls and
  cross-instance realtime delivery is impaired, both alerted (FR-058a, FR-063a). Requests that need
  none of that continue to be served, and the proxy never faces an empty rotation. **Every one of the
  five things the cache now carries has a defined degradation** — that is what makes Q7's decision
  safe rather than merely optimistic.
- **An event is emitted while the cross-instance transport is down.** It still reaches clients on the
  emitting instance, so from that instance's own vantage point delivery is indistinguishable from
  success. Only FR-063a's alert surfaces it; without that, tracking works for some users and silently
  fails for others with no symptom anywhere.
- **Rate limiting is running in per-instance fallback when the shared store returns.** Counters reset;
  a client mid-burst gets a fresh budget. Accepted — the alternative is refusing requests to protect
  a counter's continuity, which inverts the priority (FR-061a).
- **The database is unreachable at exactly the moment readiness is asked, but recovers immediately.**
  A single failed probe must not permanently condemn an instance; the verdict must reflect the
  database's state at the time of asking, so an instance returns to rotation on its own once the
  database is back.
- **Shutdown arrives while a transaction is open.** The drain must let the transaction reach its own
  commit-or-abort decision; it must never force an exit at a point that leaves a transaction's effects
  half-applied. Where the deadline expires anyway, the queue redelivery guarantee — not the drain — is
  what protects consistency.
- **A background job is redelivered after a severed shutdown.** Redelivery is at-least-once, so a job
  interrupted mid-write may run again. Each job must reach the same end state whether it runs once or
  twice — the same conditional-write discipline the platform already uses for escalation.
- **Two instances start at the same moment.** Neither may assume it is the only scheduler, and the
  arbitration must not deadlock or leave an interval with no runner.
- **The instance holding the scheduler is killed without draining.** The next interval must still find
  a runner, without operator action and without waiting for a lease that never expires.
- **A sweep outlives its own lease.** A long garbage-collection pause, a network stall, or a sweep
  slower than its expiry lets a second instance acquire the lease while the first is still running.
  This is the case the lease cannot prevent and idempotency must absorb (FR-056/FR-056a); the first
  run must also be unable to release the second's lease on its way out (FR-056b).
- **The cache and queue backend is unreachable, so no lease can be acquired at all.** Every sweep
  stalls while the platform keeps serving and reporting itself ready (Clarification Q7). Nothing
  else surfaces this, which is why FR-058a requires an alert on sweeps that stop completing.
- **A realtime event is emitted while the cross-instance transport is briefly unavailable.** The
  platform must not present partial delivery as success; degraded realtime must be detectable rather
  than silent, since silent partial delivery is precisely the failure this story exists to remove.
- **A client forges a forwarded-address header.** Only addresses added by the trusted proxy may be
  honoured; the number of trusted hops must be explicit, or a client can spoof its way into a fresh
  rate-limit budget.
- **A permitted origin is configured with a trailing slash, a different port, or a different scheme.**
  Origin matching is exact; a near-miss must fail closed and be diagnosable, not silently permit.
- **A document is requested while the object store is unreachable.** This must fail with the
  platform's standard error shape, never with a partial or empty file that a client would treat as
  the document.
- **A client forwards its platform credential across the document redirect.** The object store sees
  two competing credentials and refuses. Browsers strip the header on a cross-origin redirect and
  mobile HTTP clients may not, so this presents as "documents work on the dashboard, fail in the app"
  — and only on a real build (FR-038c–e).
- **A signed location is still in flight when the user's access is revoked.** Access was checked at
  issue time, so the location keeps working until it expires. The 5-minute lifetime is what bounds
  this; nothing revokes an already-issued location.
- **A secret is rotated while requests are in flight.** Resolved by construction: secrets are read
  once at startup and never re-read (FR-044a), so no value changes inside a process's lifetime.
- **A token-signing secret is rotated across a rolling restart.** Instances holding the old and new
  secret serve concurrently, so tokens issued by one are refused by the other for the duration of the
  rollout, and every previously-issued token is invalid afterwards. This is a sign-everyone-out event,
  not a transparent one (FR-047a).
- **The secret store is unreachable when an instance starts.** The instance must fail to start and
  must never report itself ready — a half-configured instance that begins serving is worse than one
  that does not start, because the proxy would route real traffic to it.
- **Records are produced during shutdown.** They must still be structured and still reach their
  destination; losing exactly the records that describe a shutdown would defeat Story 2's diagnosis.
- **The health signal is reachable from the public internet.** It must reveal nothing about tenants,
  configuration, secrets or internal topology beyond whether this instance can serve.

## Requirements *(mandatory)*

### Functional Requirements

**Liveness and readiness (Story 1)**

- **FR-001**: The platform MUST expose an unauthenticated signal reporting whether the process is
  alive, answerable without a tenant context and without side effects.
- **FR-002**: The platform MUST expose an unauthenticated signal reporting whether the instance is
  ready to serve traffic. Per Clarification Q7, **the database is the only disqualifying
  dependency**: readiness is negative when the database is unreachable and at no other time.
- **FR-002a**: The cache and queue backend MUST be checked and their status reported in the readiness
  response, but MUST NOT affect the ready/not-ready verdict. Their loss degrades specific
  capabilities rather than the ability to answer a request, and disqualifying on them would make
  every instance unready at the same instant, leaving the proxy with nowhere to route.
- **FR-002b**: The readiness verdict MUST be reported by the response's status so that a proxy can
  act on it without parsing a body, while the per-dependency detail MUST be present in the body for
  monitoring.
- **FR-003**: Liveness and readiness MUST be separately addressable, so a temporarily unready
  instance is not restarted as though it were dead.
- **FR-004**: Both signals MUST be exempt from rate limiting and MUST NOT consume or affect any
  client's budget.
- **FR-005**: Readiness MUST turn negative at the start of shutdown, before the instance stops
  accepting new connections.
- **FR-006**: Each dependency check MUST complete within a bounded time and MUST report which
  dependency is unavailable when it is. A check MUST NOT be able to hang: a slow dependency MUST
  resolve as unavailable within that bound rather than leaving the readiness request outstanding,
  since a readiness endpoint that stalls is indistinguishable to a proxy from an instance that has
  failed.
- **FR-006a**: A readiness check MUST NOT hold a connection from the pool that request traffic needs,
  or a degraded database would exhaust the pool through health checking alone and turn slowness into
  a self-inflicted outage.
- **FR-007**: Neither signal may disclose tenant data, configuration values, secrets, or internal
  topology beyond whether this instance can serve.
- **FR-007a**: The readiness signal MUST have a steady-state consumer that can **act on it**, not
  merely alert (Clarification Q11). A signal nothing reads between deploys does not satisfy this
  story's purpose — "no proxy can route away from a broken instance" is the situation being fixed, so
  an instance that has been failing readiness for a sustained period MUST be removed from rotation
  without a human intervening.
- **FR-007b**: Passive proxy failure detection MUST NOT be relied on as that consumer. It counts only
  failed *proxied requests*, and only the failure conditions the proxy is configured to recognise —
  so an instance failing readiness for a reason that does not produce those errors on every route
  stays in rotation indefinitely, serving whatever subset of traffic still works.
- **FR-007c**: The proxy MUST retry a failed request against a healthy instance, bounded to one
  retry, treating gateway and unavailable responses as retryable. This is what actually protects
  users during the detection gap, and it is also what makes those responses register as upstream
  failures so passive detection fires at all. Retries MUST NOT be extended to non-idempotent methods:
  the platform's write endpoints are not established as safe to replay, and the proxy's default
  already excludes them — that default must be left in place rather than overridden.
- **FR-007d**: Before any of FR-007a–c is built, it MUST be established whether a managed load
  balancer or instance group already fronts the proxy. If one does, its own health check supplies
  active readiness-based routing at no cost, FR-007a reduces to an alerting concern, and the
  deployment topology is materially different. This finding also determines the trusted-hop count
  (FR-022), which cannot be fixed at one until it is known.

**Graceful shutdown (Story 2)**

- **FR-008**: On a termination signal the platform MUST stop accepting new work and allow in-flight
  requests to complete before exiting.
- **FR-009**: Background jobs in progress MUST be allowed to complete, or be released for
  redelivery, and MUST never be abandoned between two writes intended to be consistent.
- **FR-010**: Connected realtime clients MUST be disconnected in an orderly way that their existing
  reconnect logic recognises.
- **FR-011**: Connections to the database, queue backend and cache MUST be closed deliberately
  during shutdown.
- **FR-012**: Shutdown MUST be bounded by a configurable deadline, after which the process exits
  regardless; a forced exit MUST be recorded distinguishably from a clean one.
- **FR-013**: Shutdown MUST NOT alter the outcome of any transaction: each either commits fully or
  aborts fully, exactly as today.
- **FR-012a**: Because the chosen deployment (Clarification Q1) replaces containers by stopping
  them and provides no rolling-deploy orchestration of its own, the feature MUST deliver an explicit
  documented deploy procedure that starts the replacement instance, waits for it to report ready,
  moves traffic to it, and only then signals the outgoing instance to drain. Without this, graceful
  shutdown is implemented but never exercised, and SC-003 is unreachable.

**Browser access (Story 3)**

- **FR-014**: The platform MUST permit cross-origin browser access in every environment, including
  production, from an explicitly configured set of origins.
- **FR-015**: Permitted origins MUST be configurable per environment; production MUST NOT reflect
  arbitrary origins.
- **FR-016**: A request from a non-permitted origin MUST be refused without disclosing which origins
  are permitted.
- **FR-017**: Preflight checks MUST succeed without credentials and without consuming a rate-limit
  budget.
- **FR-018**: The platform MUST refuse to start in production if no permitted origin is configured,
  rather than starting with browser access silently broken.
- **FR-019**: Clients that send no origin MUST be entirely unaffected in every environment.
- **FR-020**: The cross-origin policy MUST permit the credential-carrying request shape the dashboard
  uses today, and MUST accommodate the platform's existing session and refresh mechanism without
  requiring a change to it.

**Client-differentiated rate limiting and request attribution (Story 4)**

- **FR-021**: When behind a proxy, the platform MUST attribute each request to the originating client
  rather than to the proxy.
- **FR-022**: The number of trusted proxy hops MUST be explicit configuration; addresses beyond the
  trusted boundary, including client-supplied ones, MUST NOT be honoured. The proxy immediately in
  front of the service MUST be configured to overwrite, not append to, any forwarded-address header a
  client supplies. **The hop count is determined by FR-007d's finding and MUST NOT be assumed**: one
  if nginx is the only proxy, two if a managed load balancer fronts it. Configuring one where there
  are two makes the load balancer's address the attributed client for every request on the platform,
  which is the same undifferentiated-origin failure this story exists to fix — arrived at by a
  different route and equally invisible.
- **FR-023**: An authenticated request MUST be counted against a budget keyed to the authenticated
  user; an unauthenticated one against a budget keyed to its originating address.
- **FR-024**: Exhausting one client's budget MUST NOT affect any other client.
- **FR-025**: Every request record MUST identify its originating client — the authenticated user
  where there is one, the originating address otherwise.
- **FR-026**: Routes that already apply a per-user limit MUST retain exactly their present limits and
  their present refusal response, including its body fields.
- **FR-027**: The refusal response for exceeding a limit MUST keep its current shape; no client
  requires a change.

**Diagnosability (Story 5)**

- **FR-028**: Records MUST be emitted to standard output in a machine-parseable structured form with
  individually addressable fields, shaped so the deployment's logging agent collects them into the
  managed logging service with those fields preserved as fields — not flattened back into a single
  text blob, which would reinstate the very problem this story exists to remove (Clarification Q6).
- **FR-028a**: The severity of each record MUST be expressed in the form the logging service
  recognises, so that an error is retrievable as an error rather than by matching on its text.
- **FR-029**: Every record MUST carry a correlation identifier that is unique to the request or job
  that produced it.
- **FR-030**: Work enqueued by a request MUST carry that request's correlation identifier, so a chain
  spanning requests and background jobs is retrievable as one.
- **FR-031**: Records produced while handling a request MUST carry the acting user and tenant where
  one exists, the route, the outcome and the duration.
- **FR-032**: Records relating to a specific order MUST be retrievable by that order's identifier
  alone, as a field filter in the managed logging service, and the retrieved set MUST be complete and
  chronologically ordered. Any record produced while an order is in scope MUST therefore carry that
  order's identifier as a field, including records produced by background jobs that act on it.
- **FR-033**: No record may contain a credential, token, proof-of-delivery code, payment secret, or
  any value the platform is forbidden from returning in a response.
- **FR-034**: Unhandled failures MUST be recorded with their correlation identifier and enough
  structure to locate the failing operation, while the response sent to the caller stays exactly the
  shape the platform sends today.
- **FR-035**: Record verbosity MUST be configurable per environment without a rebuild. Because
  collected volume is a running cost (Clarification Q6), the production default MUST NOT emit a
  record per successful database operation or per realtime position update — the tracking stream
  alone would dominate the volume, and nothing in Story 5 needs it.
- **FR-035a**: Records MUST identify the instance that produced them, so that once the platform runs
  redundantly (Story 9) an investigation can tell whether a symptom is platform-wide or confined to
  one instance.

**Durable document storage (Story 6)**

- **FR-036**: Uploaded documents MUST be stored in the managed regional object store (Clarification
  Q3), which replicates within its region, so a document survives the destruction of the machine or
  container that received it.
- **FR-037**: Any instance MUST be able to serve a document uploaded through any other instance; no
  instance may hold document bytes that another cannot reach.
- **FR-038**: The upload request and response payloads MUST be unchanged. Document *retrieval* moves
  off the platform (Clarification Q3): the existing download route no longer returns bytes but
  directs the caller to a time-limited signed location. This is the one deliberate departure from
  the payload freeze in FR-065, and its exact form is fixed by FR-038a.
- **FR-038a**: Retrieval MUST remain a single call to the existing download route, and MUST NOT
  require either client to learn a new route, parse a new response body, or manage a URL lifetime
  itself. The route MUST answer with a redirect to the signed location, so that a client which
  follows redirects — as both existing clients do — observes the same "call this, receive the file"
  contract it observes today.
- **FR-038b**: The signed location MUST expire 5 minutes after issue (Clarification Q4) — long
  enough to complete a download over a poor mobile connection, short enough that a leaked location
  is worth little.
- **FR-038c**: The platform's own credential MUST NOT travel to the object store. Because the signed
  location carries its own authorization, a request arriving at the object store with an additional
  `Authorization` header presents two competing credentials and is refused. Any client that forwards
  that header across the cross-origin redirect MUST be made to stop.
- **FR-038d**: FR-038c MUST be verified against a real build of each client, not against a test
  double or a redirect-following assumption. A browser strips the header across a cross-origin
  redirect and a mobile HTTP client may not — so this defect is invisible on the dashboard and
  reproduces only on a device. This is the single highest-risk item in Story 6.
- **FR-038e**: If FR-038d's verification shows a client does forward the header, a change confined to
  that client's redirect handling is permitted, notwithstanding FR-067. It is the only client change
  this feature may make, and it MUST NOT alter any request the client sends to the platform itself.
- **FR-039**: The tenant and role checks governing document access MUST be exactly those in force
  today, and MUST be evaluated in full *before* any signed location is issued.
- **FR-040**: A signed location MUST be unguessable, MUST be scoped to one object and to read only,
  and MUST expire per FR-038b. Once issued it is a bearer capability that the object store honours
  without re-checking tenancy — so its lifetime, not the request, is the exposure window.
- **FR-040a**: The object key prefix `sys_storge/{companyId}/{uuid}{ext}` is retained for
  organisation and for continuity with the platform's existing convention. It MUST NOT be relied on
  for access control: the object store enforces nothing about the prefix, and the tenant boundary is
  held entirely by FR-039's check at issue time. Any future code that reads tenancy from a key path
  is a defect.
- **FR-040b**: The bucket MUST NOT permit anonymous or public object access under any configuration,
  so that a signed location is the only way an object is ever readable.
- **FR-040c**: The bucket's cross-origin policy MUST name the dashboard's origin explicitly and MUST
  NOT use a wildcard — the platform's own origin allowlist (FR-014–FR-016) governs the API, and a
  wildcard on the bucket would let any page that obtains a signed location read the object from a
  browser, undoing that allowlist for documents.
- **FR-041**: A failure to write to or read from the object store MUST surface promptly in the
  platform's standard error shape, and a failed upload MUST NOT appear to succeed — in particular a
  metadata record MUST NOT be persisted for an object whose bytes did not land.
- **FR-042**: Local development and the automated test suites MUST remain possible without
  provisioning cloud storage, through a local equivalent selected by configuration.
- **FR-042a**: The download route MUST issue a redirect under **every** storage driver, including the
  local one, so there is a single controller path exercised identically by the automated suites and
  by production (Clarification Q12). A driver-conditional branch would leave the redirect path
  running first in production, which is the same untested-in-test defect this feature exists to
  remove.
- **FR-042b**: The local driver's byte route MUST be addressed by a short-lived signed token carried
  in the URL, scoped to one file, and MUST NOT depend on the request carrying the platform's
  `Authorization` header. Clients differ in whether they forward that header across a redirect, so an
  authenticated local route would pass for some clients and fail for others — reintroducing FR-038c's
  trap in the test environment. A header-less, expiring, single-object URL also mirrors the
  production credential shape, so the local path is faithful in the security-relevant dimension and
  not merely in its status code.
- **FR-042c**: The redirect response MUST carry `Cache-Control: no-store`. A cached redirect pointing
  at an expired signed location fails only sometimes, and presents as an intermittent storage fault
  rather than as a caching one.
- **FR-042d**: **What FR-042a does not establish MUST be stated wherever its coverage is claimed.**
  It proves the controller emits a redirect with a location. It does **not** exercise a mobile HTTP
  client following a *cross-origin* redirect to the object store — which is where bucket CORS, clock
  skew against the signed expiry, and per-client redirect and header behaviour all live, and none of
  those is touched by a same-origin redirect. Green automated coverage here MUST NOT be read as
  covering FR-038d.
- **FR-042e**: The live pre-launch pass (FR-071) MUST therefore include downloading a file on a real
  mobile client against the real bucket and asserting the bytes arrive. That is the only place the
  cross-origin path is verified at all.

**Secrets (Story 7)**

- **FR-043**: Secrets MUST be read at startup from the managed secret store (Clarification Q5), using
  the compute's own attached service identity, so that no image, snapshot, backup or environment file
  of a deployment contains a secret value and no static credential exists to reach the store.
- **FR-044**: A secret MUST be rotatable by adding a new version at its source, without rebuilding
  the application; the platform adopts it at next start, so rotation is completed by the rolling
  deploy procedure of FR-012a rather than by a bespoke mechanism.
- **FR-044a**: Secrets MUST be read only at startup and held for the life of the process. The
  platform MUST NOT re-read or hot-reload a secret while running — a value that changes mid-process
  is what would make an in-flight request fail on a rotation, and reading once removes that failure
  mode by construction.
- **FR-045**: Reads of a secret MUST be recorded by the secret store's own audit logging, with the
  reading identity and a timestamp, retrievable independently of the platform's records. The
  platform MUST NOT be the thing that records its own secret access. **This requirement is verified
  only in the live pre-launch pass** (FR-071) and cannot be covered automatically — continuous
  integration has no attached service identity, and a test that asserted against a stubbed store
  would be asserting the stub's behaviour rather than the store's. Recorded here as a deliberate
  limit, not an oversight.
- **FR-046**: A missing or unretrievable required secret MUST prevent startup, matching how the
  platform already refuses to start on invalid configuration. Because startup now depends on a
  network call, this behaviour is load-bearing rather than theoretical: a partially-configured
  instance MUST never begin serving, and MUST never report itself ready.
- **FR-047**: Rotation MUST NOT change the platform's existing session, revocation or refresh
  semantics.
- **FR-047a**: Rotating a token-signing secret MUST be treated as a session-ending event and
  documented as one. During a rolling restart, instances holding the old and the new secret run
  concurrently, so a token issued by one is refused by the other; and once rotation completes, every
  token signed with the previous secret is invalid. Both effects are acceptable as a response to a
  suspected compromise and unacceptable as a routine maintenance action — the operations
  documentation MUST say so, so that a signing-key rotation is never scheduled in the belief that it
  is transparent.
- **FR-048**: Local development and the automated test suites MUST NOT require access to the managed
  secret store; a local source selected by configuration MUST remain available, while production
  reads through the store.
- **FR-049**: The set of values treated as secret MUST be explicit, and non-secret configuration MUST
  remain ordinary configuration — the platform's existing boot-time configuration validation MUST
  continue to cover both, so an absent secret fails in the same place and the same way an absent
  configuration value does today.

**Database resilience (Story 8)**

- **FR-050**: The database connection MUST carry an explicit maximum and minimum concurrent
  connection count.
- **FR-051**: Acquiring a connection, establishing one, and executing an operation MUST each be
  bounded by an explicit timeout.
- **FR-052**: When the database is unreachable, requests MUST fail within a bounded time in the
  platform's standard error shape rather than accumulating.
- **FR-053**: After the database returns, the platform MUST serve normally within a bounded recovery
  window without a restart.
- **FR-054**: Timeouts MUST NOT leave a transaction partially applied; every existing transaction
  boundary keeps its current all-or-nothing behaviour.
- **FR-055**: All limits and timeouts MUST be configurable per environment, with defaults suitable for
  production.

**Horizontal readiness (Story 9)**

- **FR-056**: **At most one instance** runs a given scheduled sweep in a given interval under normal
  operation, regardless of instance count; and **every sweep MUST be safe to execute more than
  once**. Both halves are required, and the second is not a fallback for a broken first: the
  coordination mechanism is at-most-once, not exactly-once, because a process pause or network stall
  outlasting the lease can produce a concurrent run no lease can prevent (Clarification Q8).
  Acceptance MUST be written against this guarantee and never against exactly-once.
- **FR-056a**: Each sweep MUST make its effects conditional on the state it expects to change, so a
  duplicate run is a no-op rather than a repeat — the pattern feature 011 established for stop
  escalation, where the conditional write's own modified-count decides which run acts. A sweep that
  would send a duplicate notification, or advance a lifecycle twice, on a second concurrent run does
  not satisfy this requirement.
- **FR-056b**: The lease MUST be acquired with a token unique to the acquiring run and an expiry set
  in the same atomic operation, and released only by a compare-and-delete that verifies that token —
  so a slow run whose lease has already expired cannot release the lease a different instance now
  holds. The expiry MUST exceed the measured p99 sweep duration, and a run that legitimately outlives
  it MUST renew rather than let it lapse.
- **FR-057**: The arbitration MUST cover both scheduling shapes the platform uses: the statically
  declared schedule and the one registered at runtime. The runtime-registered schedule is registered
  that way solely so its interval remains configurable at run time; it is a **fleet-wide** sweep, not
  per-entity work, so it takes the same lease as the static one. A repeatable queue job keyed by
  sweep name is an acceptable alternative mechanism for either, provided FR-056 still holds.
- **FR-057a**: The per-delivery escalation timer is **out of scope for this arbitration** and MUST NOT
  be changed. It already runs on the shared queue with a deterministic per-order job identifier,
  already distributes correctly across instances, and was never a single-instance constraint —
  applying a lease to it would be a regression.
- **FR-058**: If the instance that ran the last sweep stops, a surviving instance MUST run the next
  one within one interval, without operator action — which requires the lease to expire on its own
  rather than depend on the holder releasing it.
- **FR-058a**: A sweep that stops completing MUST raise an alert. This failure is now silent by
  construction: Clarification Q7 keeps instances in rotation when the cache and queue backend is
  unreachable, so an outage there stalls every leased sweep while the platform continues serving and
  reporting itself healthy. Stalled stop-detection means stalled deliveries go unnoticed, which is
  the precise harm feature 011 exists to prevent. This alert is the one exception to alerting being
  out of scope, because it is the only signal for a failure mode this feature introduces.
- **FR-059**: A realtime event emitted by any instance MUST reach every addressed client, regardless
  of which instance holds that client's connection.
- **FR-060**: Cross-instance delivery MUST cover every realtime addressing mode the platform uses
  today — per-user and per-delivery — and every emission path, whether it originates in the realtime
  layer itself or in another service.
- **FR-061**: Rate-limit counters MUST be shared across instances, so the platform-wide limit is the
  configured limit rather than a multiple of it, and counters MUST survive an instance restart.
- **FR-061a**: If the shared counter store is unavailable, rate limiting MUST fall back to
  per-instance in-memory counting rather than failing the request (Clarification Q10). A store that
  fails closed would make every request error during a cache outage — which would make the cache a
  *harder* dependency than the database, contradict FR-002a's decision to keep such an instance in
  rotation, and turn a partial degradation into the total outage that decision exists to prevent.
- **FR-061b**: Rate limiting MUST NOT be absent during that fallback. The degraded budget is N× the
  configured limit across N instances — approximate, but **bounded**. Failing open would leave the
  login, refresh and one-time-code routes with no brute-force protection at all for the duration,
  which anyone able to induce a cache outage could then exploit.
- **FR-061c**: Entering and leaving the fallback MUST each be recorded, so a period of degraded
  limiting is identifiable afterwards rather than inferred.
- **FR-062**: Background jobs MUST be **taken up by one consumer at a time** across the fleet, so
  adding instances increases throughput rather than duplicating work. Delivery remains
  at-least-once — the platform's queue redelivers a job whose consumer died mid-execution, which is
  the behaviour Story 2 relies on (FR-009) — so a redelivered job MUST reach the same end state as a
  single delivery, by the same conditional-write discipline FR-056a requires of sweeps. This is a
  property to preserve, not a change to make: the queues already distribute correctly, and feature
  011's escalation already guards its own redelivery.
- **FR-063**: If the cross-instance transport is unavailable, the condition MUST be detectable rather
  than presenting as silent partial delivery.
- **FR-063a**: Loss of the cross-instance transport MUST raise an alert, on the same basis as
  FR-058a. Nothing else can surface it: an event emitted while the transport is down still reaches
  the clients connected to the emitting instance, so delivery *appears* to work — from the emitting
  instance's point of view it is indistinguishable from success. Combined with FR-002a keeping every
  instance in rotation and reporting itself healthy, the platform would show no symptom at all while
  live tracking silently worked for some users and not others, which is the exact failure Story 9
  exists to remove.
- **FR-063b**: The readiness response's degraded reporting (FR-002a) MUST cover the cross-instance
  transport, not only raw reachability of the cache, so that monitoring sees the specific capability
  that is impaired.
- **FR-064**: Running multiple instances MUST NOT change any endpoint, payload, tenant-scoping rule,
  transaction boundary or order-lifecycle transition.

**Region portability and personal-data residency (Clarification Q2)**

- **FR-064a**: Every external store this feature introduces — durable documents, structured records,
  secrets — MUST be reachable through a seam that makes its location and provider a configuration
  choice, so relocating it to satisfy a residency requirement is a deployment change and never a
  code change.
- **FR-064b**: No component may depend on an interface available from only one hosting provider,
  where a portable or self-hostable equivalent exists. **This is satisfied by the seams of FR-064a
  rather than by avoiding provider clients**: the object-store and secret-store clients are
  necessarily provider-specific, but each sits behind a port with a second working implementation
  (the local storage driver, the environment secrets driver), so relocating means writing a third
  adapter rather than changing a call site. A component that reaches a provider API **without** such
  a port is a violation; one that reaches it through a port is not. This distinction MUST be checked
  at review rather than assumed, since it is the difference between portability and the appearance
  of it.
- **FR-064c**: The hosting provider chosen in Clarification Q3 is accepted as a processor of personal
  data. Residency therefore rests entirely on region selection: every store holding personal data —
  the object bucket, the record destination, the secret store — MUST be provisioned in the same
  region as the compute, and that region MUST be the one a residency review would accept. No store
  may be provisioned in a different region for convenience.
- **FR-064d**: The categories of personal data this feature causes to be written outside the primary
  database — uploaded documents, and the identifiers and locations appearing in structured records —
  MUST be enumerated in the delivered operations documentation, so a residency review can be
  performed against a list rather than a code search.

**Whole-feature invariants**

- **FR-065**: No existing endpoint path, request payload or response payload may change, except where
  a response gains a field that no existing client reads.
- **FR-066**: No existing tenant-scoping rule, role restriction, transaction boundary or
  order-lifecycle transition may change.
- **FR-067**: Both existing clients — the mobile app and the web dashboard — MUST require no change to
  work against the hardened platform.
- **FR-068**: The platform's existing automated test suites MUST continue to pass unchanged, except
  where a test asserts on an operational behaviour this feature deliberately alters.

**Verification (Clarification Q9)**

- **FR-069**: Story 9's guarantees MUST be verified by an automated suite that runs **two application
  instances against one shared database and one shared coordination backend**, executable in
  continuous integration without a live environment or a second person. None of these guarantees is
  observable in a single process, so single-process tests cannot substitute.
- **FR-070**: That suite MUST cover, as assertions rather than as documentation: a lease contested by
  two instances; a sweep run twice concurrently producing no duplicate effect (FR-056a); an event
  emitted by one instance reaching a client connected to the other (FR-059/FR-060); one client's
  requests spread across both instances counting against one budget (FR-061); and one instance
  draining while the other continues to serve (FR-015/SC-015).
- **FR-071**: A live pre-launch pass on the real deployment MUST additionally confirm what only the
  real environment can: the rolling deploy procedure (FR-012a), the mobile document redirect on a
  real build and a real device (FR-038d), secret retrieval through the attached service identity
  (FR-043), and record retrieval by order identifier in the collected records (FR-032). Each is a
  case where a passing automated test would not establish the property.
- **FR-072**: The items in FR-071 MUST be enumerated as an explicit pre-launch checklist with a named
  owner, not left as prose. Five consecutive features in this repository have ended with a live
  verification step outstanding; the checklist exists so that this one's remaining work is visible as
  a list rather than discovered in an incident.

### Key Entities

- **Health Signal**: An instance's own answer to "am I alive" and "can I serve", including which
  dependency is unavailable when the answer is negative. Not persisted.
- **Correlation Identifier**: A value unique to one request or job, carried through every record it
  produces and inherited by any work it enqueues. Not persisted as its own record.
- **Structured Record**: One machine-parseable event with addressable fields — timestamp, severity,
  correlation identifier, acting user and tenant where present, route or job, outcome, duration, and
  the domain identifiers (notably order) the event concerns.
- **Stored Document**: An uploaded file, addressed by an identifier the platform already issues,
  whose bytes now live somewhere that outlives any one machine. Its existing metadata record is
  unchanged in shape.
- **Secret**: A configuration value that must not appear in any artifact, is rotatable at its source,
  and whose reads are recorded.
- **Scheduler Lease**: Whatever grants exactly one instance the right to run a given sweep for a
  given interval, and expires so that the death of its holder does not stop the schedule.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An external monitor can determine the platform's availability without credentials, and
  detects an unavailable instance within 30 seconds of it becoming unable to serve.
- **SC-002**: Over 50 consecutive deploys under continuous traffic, zero in-flight requests are
  severed, zero orders are left in a state no lifecycle path produces, and zero background jobs are
  abandoned part-way through.
- **SC-003**: A deploy completes with no user-visible interruption: no request fails and no realtime
  client experiences a gap longer than its normal reconnect.
- **SC-004**: A user of the web dashboard can sign in and complete every action their role permits
  against a production-configured service, with zero requests refused for cross-origin reasons.
- **SC-005**: One client issuing requests at 100 times the permitted rate causes zero refusals for
  any other client.
- **SC-006**: For any request refused for exceeding a limit, the responsible client is identifiable
  from the retained records in under 5 minutes.
- **SC-007**: Everything that happened to a given order across every request and background job can
  be retrieved by that order's identifier alone, in under 1 minute, with no manual correlation.
- **SC-008**: 100% of retained records are machine-parseable, and zero contain a credential, token,
  proof-of-delivery code or payment secret.
- **SC-009**: Every uploaded document remains retrievable after the machine that received it is
  destroyed and replaced, with zero loss and byte-identical content; and zero objects are readable
  without a valid, unexpired signed location.
- **SC-010**: Zero secret values are recoverable from any deployment artifact, image, snapshot,
  environment file or backup; every secret can be rotated without an application rebuild and takes
  effect within one rolling deploy; and 100% of secret reads are attributable to an identity in a
  record the platform itself does not write.
- **SC-011**: A 60-second database interruption under load produces prompt failures rather than
  accumulation, and the platform serves normally again within 60 seconds of the database returning,
  without a restart.
- **SC-012**: With two or more instances running, each scheduled sweep is run by at most one instance
  per interval over at least 20 consecutive intervals, with zero missed intervals; and a sweep
  deliberately executed twice concurrently produces zero duplicate notifications and zero duplicate
  state changes.
- **SC-013**: With two or more instances running, 100% of realtime events reach their addressed
  clients regardless of which instance holds the connection.
- **SC-014**: With two or more instances running, one client's requests distributed across instances
  count against a single shared budget: the observed platform-wide limit equals the configured limit.
- **SC-015**: Removing one of two running instances from service causes zero lost requests, zero lost
  scheduled work and zero lost background jobs; affected realtime clients resume within their normal
  reconnect window.
- **SC-016**: The platform's full end-to-end behaviour is identical before and after this feature and
  identical at one instance and at several — demonstrated by the existing test suites passing
  unchanged, and by the existing multi-role order walkthrough producing the same outcome in both
  configurations.
- **SC-017**: Every guarantee in Story 9 is asserted by an automated suite that runs two instances in
  continuous integration, with zero of them resting on a manual step.
- **SC-018**: The pre-launch checklist of live-environment items is closed in full before launch, with
  every item either confirmed or explicitly accepted as an open risk by a named owner — zero items
  left in an unexamined state.
- **SC-019**: With the shared cache unavailable, the platform continues to serve every request that
  does not itself require the cache, with zero requests failing because rate limiting could not reach
  its counter store, and rate limiting still refuses a client exceeding N× the configured budget.
- **SC-020**: Every subsystem that depends on the shared cache — queued work, scheduled sweeps,
  cross-instance realtime delivery, rate limiting — surfaces its degradation within one alerting
  interval of the cache becoming unavailable, with zero of them degrading silently.

## Verified Current State

Every item below was read in the code on this branch rather than assumed. Three findings materially
correct or extend the framing that prompted this feature; they are marked **⚠**.

**Confirmed as described**

- There is no health, liveness or readiness endpoint anywhere in the codebase, and no dependency-check
  facility of any kind.
- Shutdown hooks are never enabled at bootstrap, so the process exits immediately on a termination
  signal. Consequently the one destroy hook that does exist (the cache module's) never runs — so even
  the cache connection is dropped rather than closed.
- Cross-origin access is enabled inside a non-production-only branch, alongside the API documentation
  and the static test console — so in production it is not enabled at all. Where it is enabled, the
  policy reflects any origin, which is not a policy production can adopt as-is.
- Uploaded documents are written to a directory on the local filesystem, and the download route reads
  the file directly from that path. The compose file **does** bind-mount that directory from the
  host, so a document survives its container — the exposure is the host disk, not the container. It
  is unreplicated, has no off-box copy, and is unreachable from a second machine.
- Secrets are supplied entirely as environment values validated at boot, sourced from a file; nothing
  rotates them and nothing records their use.
- The database connection is created with a connection string and a plugin factory only — no pool
  bounds and no timeouts of any kind.
- Realtime broadcasts are addressed through a single in-process holder of the socket server, so a
  broadcast reaches only clients connected to that process.

**⚠ Corrections and additions**

- **⚠ Rate limiting is not uniformly address-based.** A per-user limiter already exists and tracks by
  authenticated user, but it is applied only to specific routes. The *global* limiter is
  address-based, and that is the one that collapses behind a proxy. The per-route per-user limits are
  unaffected by the proxy problem and must be preserved exactly as they are (FR-026).
- **⚠ There is a third single-instance constraint that was not named: rate-limit counters live in
  process memory.** No shared counter store is configured, so N instances would grant N times the
  intended budget, and every deploy resets every counter. It belongs with the two named constraints
  and is captured as FR-061.
- **⚠ Nothing records a request's origin at all.** The framing describes an audit trail recording one
  indistinguishable origin; in fact the request record contains only method, path, status and
  duration — no address, no user, no tenant, no correlation identifier. The session audit collection,
  which is the platform's real audit trail, records no address either. The gap is larger than
  described, which is why attribution is stated as its own requirement (FR-025) rather than as a
  side effect of the proxy fix.
- **Two distinct scheduling shapes exist, not one — but both are fleet-wide sweeps.** One is declared
  statically; the other is registered at runtime through the scheduler registry, and its own comment
  records why: a decorator's compile-time constant could not honour a configurable interval, which
  the e2e suite and the quickstart both lower so neither waits a real minute. It is **not** per-entity
  scheduling, so it takes the same lease as the static one rather than a per-entity job identifier
  (FR-057). The per-order escalation timer *is* per-entity, but it already runs on the shared queue
  with a deterministic job identifier and was never a single-instance constraint (FR-057a).
- **Background job processing is *not* a duplication risk.** Jobs are distributed through a shared
  queue backend, so multiple instances share the work rather than repeating it. The single-instance
  problem is confined to the in-process schedulers, the in-memory realtime server and the in-memory
  rate-limit counters — the fix must not be over-applied to the queues (FR-062 states the property to
  preserve, not a change to make).
- **The realtime fix has a narrow seam.** Every emission from outside the realtime layer already flows
  through one shared service, and there is exactly one gateway. Cross-instance delivery therefore has
  two touch points, not many — but FR-060 requires both to be covered, since missing the non-gateway
  path would leave exactly the silent partial delivery this story exists to remove.
- **Document storage has a narrow seam too, with one payload caveat.** File handling is confined to
  two operations — write-and-record, and find-for-download. However, the stored metadata record
  carries a filesystem path field which is returned by the upload responses. Preserving payloads
  (FR-038) while removing the filesystem constrains what that field may become; the plan must resolve
  it deliberately rather than by accident.

## Assumptions

- **Behaviour is frozen.** Endpoints, payloads, tenant scoping, role restrictions, transaction
  boundaries and order-lifecycle semantics do not change. Where a change is unavoidable it is additive
  and invisible to existing clients.
- **Redundancy becomes possible, not mandatory.** This feature must make running several instances
  correct and verifiable. Whether the launch itself runs one instance or several remains an
  operational decision.
- **No migration of existing uploaded documents.** The platform is pre-production — the same premise
  the earlier vehicle cutover was accepted on — so documents currently on disk are development and
  test data. If any production document exists before this ships, a migration becomes in scope.
- **Documents are served directly from the object store by time-limited signed location, not proxied
  through the platform** (Clarification Q3). The platform's authorization check moves from *serving
  the bytes* to *deciding whether to issue the location*; the check itself is unchanged, but the
  window during which the decision remains in force is no longer the request — it is the lifetime of
  the signed location (FR-040).
- **Structured records are emitted to standard output and collected into managed logging** by the
  deployment's logging agent (Clarification Q6). Collection is therefore in scope and SC-007 is
  demonstrable within this feature. Retention duration, cost alerting and any saved queries or
  dashboards built on top remain operational choices outside it.
- **The proxy in front of the platform forwards the client address** in the conventional way, and the
  number of trusted hops is known at deploy time.
- **Local development must stay simple.** No developer should need production secret, storage or proxy
  infrastructure to run the platform; local equivalents are acceptable provided the production path is
  the one exercised in production.
- **Default drain deadline of 30 seconds**, configurable — long enough for in-flight requests and
  short enough for routine deploys.
- **Existing session, revocation and refresh semantics are untouched**, including the recorded
  deviation whereby the dashboard sends its refresh token in the request body.
- **The dashboard's origins are known** and can be configured per environment before launch — the
  same list governs both the platform's origin allowlist (FR-014) and the bucket's cross-origin
  policy (FR-040c), so the two cannot drift apart.
- **Redis remains a single shared instance**, not a cluster. Story 9's coordination — leases, shared
  rate-limit counters, cross-instance realtime delivery — assumes one logical Redis all instances
  reach. Clustering would change the lease's atomicity guarantees and is out of scope.
- **Verification is both automated and live** (Clarification Q9): the multi-instance suite runs in
  continuous integration, and a named owner closes the live pre-launch checklist (FR-071/FR-072).

## Dependencies

- **Deployment target (resolved, Clarification Q1): virtual machines running the existing Docker
  Compose stack behind nginx, with a process manager.** Compute is unmanaged, but the surrounding
  managed services of the same cloud project *are* used — object storage (Q3), the secret store (Q5)
  and log collection (Q6) — so those three are configuration this feature consumes rather than
  infrastructure it builds. What the deployment does **not** supply is orchestration: there is no
  rolling deploy, no scheduler arbitration and no service discovery. Two consequences follow and are
  reflected in the requirements: nginx is the single trusted proxy hop (FR-022), and a deploy that
  does not interrupt users must be *built* as an explicit procedure (FR-012a), because Compose
  replaces containers by stopping them.
- **A managed secret store** in the same project (Clarification Q5), holding every value the platform
  treats as secret, readable by the compute's attached service identity and no static credential.
- **Managed log collection** reachable by the VM's logging agent (Clarification Q6), configured to
  collect the container's standard output with structured fields preserved as fields.
- **An attached service identity** on the VM, granted exactly three capabilities: write objects to
  the bucket, sign read locations for that bucket, and read the platform's secrets. No broader grant,
  and no key file — the identity is attached to the instance, so there is nothing to leak or rotate.
- **A shared coordination backend is required** for single-runner scheduling, cross-instance realtime
  delivery and shared rate-limit counters (Story 9). The platform already depends on one for its job
  queues and cache, so this is an existing dependency being relied on more heavily, not a new one.
- **A managed regional object bucket** in the same project and region as the compute (Clarification
  Q3), provisioned with anonymous access disabled, plus a service identity permitted to write objects
  and sign read locations for that bucket alone.
- **⚠ Open pre-launch risk — residency is legally unconfirmed (Clarification Q2).** The customer has
  not stated whether personal data must remain in the Kingdom. The platform holds continuous driver
  location traces, which is among the more sensitive categories it could hold, and this feature is
  what causes that data to be written to new places. The design proceeds on the defensive assumption
  that in-Kingdom residency is required and that every store must be region-portable (FR-064a–d);
  legal confirmation MUST be obtained before launch, and is tracked as a risk rather than a blocker
  because the defensive assumption is valid under either answer.
- **The proxy or load balancer** must be configured to consume the readiness signal (Story 1) for
  Story 2's drain to be user-invisible.
- **Constitutional position (resolved, Clarification Q3).** The constitution binds *local* file
  uploads to a directory named exactly `sys_storge`. After Story 6 uploads are no longer local, so
  the constraint no longer binds them; the name is nonetheless retained as the object key prefix
  (FR-040a), preserving the convention. The plan MUST record this reading explicitly in its
  Constitution Check rather than leaving it inferred — and MUST note that the retained prefix is
  convention, not enforcement.

## Out of Scope

- Any change to what the platform does: no new endpoint that serves a business purpose, no new field a
  client reads, no lifecycle change.
- Autoscaling policy, capacity planning and cost optimisation.
- Dashboards, saved queries, alerting rules and retention/cost policy built on top of the collected
  records. This feature produces the records and ensures they are collected and filterable
  (Clarification Q6); what an operator then builds on them is an operational choice.
- A real mobile push provider, which remains deferred as earlier features recorded.
- Multi-region deployment, database replication topology and disaster-recovery procedure.
- Retrofitting the two unwired dashboard screens, and the pre-existing unused-import errors, both
  recorded as disclosed-not-fixed by earlier features.
- Penetration testing and formal compliance certification.
