# Contract: REST API Delta

**Feature**: 012-production-hardening | **FRs**: FR-038 – FR-038e, FR-065 – FR-067

This feature is defined by how little of this document there is. The platform has ~90 endpoints;
**one** changes its response, **two** are added in every environment (the health signals, documented
separately), **one more exists only under the local storage driver** (§2.1), and every other
endpoint's path, request payload and response payload is byte-identical.

---

## 1. The one changed response: `GET /api/v1/files/:id`

### Before

```http
GET /api/v1/files/652f… HTTP/1.1
Authorization: Bearer <jwt>

HTTP/1.1 200 OK
Content-Type: application/pdf
<file bytes, streamed by res.sendFile from local disk>
```

### After

```http
GET /api/v1/files/652f… HTTP/1.1
Authorization: Bearer <jwt>

HTTP/1.1 302 Found
Location: https://storage.googleapis.com/<bucket>/sys_storge/<companyId>/<uuid>.pdf?X-Goog-Algorithm=…&X-Goog-Expires=300&X-Goog-Signature=…
```

The client follows the redirect and receives the bytes from GCS.

**What is unchanged**: the path, the method, the `Authorization` requirement, the tenant and role
checks, and the error responses. A caller that follows redirects — which both existing clients do —
observes the same "call this, receive the file" contract (FR-038a).

**Error responses are unchanged.** A file that does not exist, or belongs to another tenant, still
produces the platform's standard 404 through `HttpExceptionFilter`. Cross-tenant access is refused by
the tenant-scope plugin on `findById` **before** any URL is signed, so a signed URL is never issued
for a record the caller could not read (FR-039). The 404-not-403 isolation rule is untouched.

### The failure mode this contract exists to prevent

**A client that forwards `Authorization` across the redirect breaks — and only on mobile.**

GCS receives the request with both a V4 signed URL *and* an `Authorization` header, treats that as
two competing credentials, and refuses. Browsers strip the header on a cross-origin redirect, so the
dashboard works. Dart's `HttpClient` copies headers across redirects, so Dio very plausibly does
not — and the app fails while every automated test passes (FR-038c/FR-038d).

Verification must happen on a **real build on a real device**, not against a test double and not
against an assumption that redirect-following is transparent. This is the highest-risk item in the
feature and sits on the pre-launch checklist.

If verification shows the header is forwarded, a change confined to the mobile client's redirect
handling is permitted — the single exception to FR-067's no-client-change rule, and it must not alter
any request the client sends to the platform itself (FR-038e).

### Signed URL properties

| Property | Value | FR |
|---|---|---|
| Scheme | V4 | Q4 |
| Method | `GET` only | FR-040 |
| Scope | One object | FR-040 |
| Expiry | 300 s | FR-038b |
| Issued | Only after the tenant-scoped read succeeds | FR-039 |

For its 5-minute life the URL is a bearer capability GCS honours without re-checking anything.
Revoking a user's access does not invalidate an already-issued URL; the expiry is the only bound.

### Bucket CORS

Named origins only — the dashboard's origins, never `*` (FR-040c). The same list drives the API's
allowlist, so the two cannot drift.

---

### The redirect applies under every driver

`GET /files/:id` answers with a 302 whatever `STORAGE_DRIVER` is set to (FR-042a). Only the
destination differs — a signed object URL under `gcs`, a token-addressed platform route under
`local`. There is deliberately **no driver-conditional branch in the controller**: every e2e suite
runs the local driver, so a branch would leave the redirect executing first in production, which is
the same untested-in-test defect this whole feature exists to remove.

The response carries `Cache-Control: no-store` (FR-042c). A cached redirect pointing at an expired
location fails only sometimes, and presents as an intermittent storage fault rather than a caching
one.

---

## 2.1 Local-driver only: the token-addressed byte route

Exists **only** when `STORAGE_DRIVER=local` — development and the automated suites. It must not be
registered in a production build, and a test asserts its absence under the GCS driver.

```http
GET /api/v1/files/652f…/content?token=<signed, single-file, expiring> HTTP/1.1
                                          ← no Authorization header, by design

HTTP/1.1 200 OK
Content-Type: application/pdf
<file bytes from sys_storge>
```

**Why it carries a token rather than sitting behind the normal auth guard** (FR-042b): an
authenticated byte route would depend on the client forwarding `Authorization` across a redirect —
and clients differ in exactly that, which is the entirety of FR-038c. It would pass for some clients
and fail for others, closing one trap by opening the same one in the test environment. A header-less,
expiring, single-object URL also mirrors the production credential shape, so the local path is
faithful in the security-relevant dimension and not only in its status code.

The token **is** the authorization, so the route is `@Public()`. That makes it an unauthenticated
endpoint that streams tenant documents, which is acceptable only because it is scoped to one file,
expires, and does not exist in production. All three properties are load-bearing.

---

## 2. Unchanged: `POST /api/v1/files` and the company-registration upload

Request: unchanged (`multipart/form-data`, same field names, same 10 MB limit, same MIME allowlist).

Response: unchanged, **including `storagePath`**.

```json
{
  "_id": "652f…",
  "companyId": "6512…",
  "purpose": "COMMERCIAL_REGISTER",
  "storagePath": "sys_storge/6512…/f47ac10b-58cc-4372-a567-0e02b2c3d479.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 284913,
  "originalName": "cr.pdf"
}
```

`storagePath` keeps its name and its type; only its content changes from an absolute filesystem path
to an object key. Renaming it to `objectKey` would read better and would break FR-038, so it keeps
the name it has. Neither client reads it — both address files by `_id` — and it was never a stable
value: it previously embedded `process.cwd()` and therefore already differed between machines.

---

## 3. Behaviour changes visible in *existing* responses

No response body changes. Three behavioural changes are observable without any payload changing:

| Change | Observable as | FR |
|---|---|---|
| CORS in production | Cross-origin requests from allowlisted origins now succeed instead of being blocked | FR-014 – FR-019 |
| Proxy-aware throttling | A client behind a proxy is counted individually rather than sharing one platform-wide budget | FR-021 – FR-024 |
| Shared throttle counters | The platform-wide limit is the configured limit, not a multiple of it across instances | FR-061 |

**The 429 body is unchanged.** `UserThrottlerGuard.throwThrottlingException` already returns
`{ statusCode, message, error, retryAfterSeconds }` and that shape is preserved exactly (FR-027).

**Five routes are fixed, not merely preserved.** `@Throttle({ default: … })` is read by the global,
IP-tracked guard and decorates login and refresh (10/min) and three OTP paths (5/15 min). Behind a
proxy all five collapse into one platform-wide bucket — ten failed logins from any one client would
lock **every** user out of logging in. These become per-client after this feature. Only
`users.controller.ts`'s phone-verification route uses `UserThrottlerGuard`'s separate `perUser`
profile, and that one is genuinely unaffected either way (FR-026).

---

## 4. WebSocket namespace

| | Before | After |
|---|---|---|
| CORS origin | `'*'` — hardcoded, **all environments including production** | The configured allowlist |
| Event names | `order:location`, `order:status`, `order:otp`, `notification:new`, `session:revoked` | Unchanged |
| Payloads | — | Unchanged |
| Rooms | `order:{id}`, `user:{id}` | Unchanged |
| Delivery | Only to clients on the emitting instance | To every addressed client on any instance |

The origin change closes a **pre-existing production wildcard**. The spec describes CORS as
missing in production; on this namespace the opposite was true — it was wide open everywhere. Both
now read one config value so they cannot disagree.

Cross-instance delivery is invisible to clients: a client connected to instance A receives an event
emitted by instance B exactly as it receives one emitted by A (FR-059/FR-060).

---

## 5. Explicitly unchanged

- Every endpoint path and HTTP method
- Every request payload and validation rule
- Every response payload except `GET /files/:id`'s status and `Location`
- `HttpExceptionFilter`'s error shape, including 404-not-403 tenant isolation
- Every role restriction and tenant-scoping rule
- Every transaction boundary
- Every order-lifecycle transition and every `OrderStatus` value
- The auth flow, including the recorded deviation whereby the dashboard sends its refresh token in
  the request body
- `NotificationType` and every enum crossing to the Flutter clients
