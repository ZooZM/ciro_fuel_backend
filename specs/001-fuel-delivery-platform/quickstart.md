# Quickstart — Fuel Delivery Platform Backend

## Prerequisites

- Node.js 20 LTS, npm 10
- Docker + Docker Compose (for MongoDB replica set)

## 1. Environment

```bash
cp .env.example .env
```

| Variable | Example | Notes |
|----------|---------|-------|
| `PORT` | `3000` | |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/ciro_fuel?directConnection=true` | replica set REQUIRED (transactions). From the host, `replicaSet=rs0` fails with `ENOTFOUND mongo` because the compose replica set advertises `mongo:27017`; `directConnection` avoids that and still supports transactions. In-container: `mongodb://mongo:27017/ciro_fuel?replicaSet=rs0` |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ (payment-timeout delayed jobs) |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | random 64-hex | |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `7d` | |
| `PAYMENT_SADAD_SECRET` / `PAYMENT_MADA_SECRET` | per-gateway HMAC secrets | |
| `PAYMENT_DEADLINE_MINUTES` | `30` | FR-015a |
| `OTP_EXPIRY_MINUTES` | `30` | |
| `STORAGE_DIR` | `sys_storge` | MUST remain exactly this name |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | `60` / `100` | global rate limit |
| `GOOGLE_MAPS_API_KEY` | (optional) | reverse-geocode suggestions at client registration (spec 004 FR-011); missing key ⇒ empty suggestion, never a failure (FR-013) |
| `ORDER_AVERAGE_SPEED_KMH` | `60` | drives the live ETA shown on an order (spec 004 FR-029) |

## 2. Start MongoDB (single-node replica set) + Redis

```bash
docker compose up -d mongo redis
# compose runs mongo:7 with --replSet rs0 (+ init job executing rs.initiate()) and redis:7-alpine
```

## 3. Install & run

```bash
npm ci
npm run start:dev        # Nest CLI watch mode on src/server.ts  ← entry file is server.ts, NEVER index.ts
```

Seed the platform owner (idempotent):

```bash
npm run seed:super-admin   # reads SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD from .env
```

## 4. Smoke test the primary flow (spec 004's multi-tier hierarchy)

The pre-004 `COMPANY_ADMIN` role split in two — `FUEL_COMPANY_ADMIN` (pricing, clients, order
approval/routing) and `TRANSPORT_COMPANY_ADMIN` (a driver fleet, picked up by orders routed to
it). The full journey now runs CIRO → Fuel Company → Transportation Company → Client → Driver:

```bash
# 1. login as super admin (CIRO) → create a Fuel Company (multipart with commercial register PDF)
# 2. login as the Fuel Company's admin → set fuel prices
# 3. fuel admin → POST /companies/:id/transporters → creates a Transportation Company + its admin
# 4. fuel admin → PUT /companies/:transportCompanyId/regions {regionCodes} → e.g. ["RIYADH"]
# 5. fuel admin → POST /users → create a CLIENT with station{regionCode, governorateCode, location}
# 6. login as the Transportation Company's admin → POST /users → create a DRIVER (+truck)
# 7. login as client → POST /api/v1/orders {fuelType, quantityLiters, paymentMethod?}
#    → estimatedPrice, status PENDING_APPROVAL (paymentMethod defaults to DIRECT)
# 8. fuel admin → PATCH /orders/:id/approve {finalPrice?} → issues the invoice (FR-020);
#    DIRECT → PENDING_PAYMENT (routing waits for settlement, FR-020a);
#    DEFERRED/CREDIT → routes immediately: one serving transporter ⇒ ROUTED_TO_TRANSPORT,
#    none ⇒ AWAITING_ROUTING (+ notified), several ⇒ AWAITING_ROUTING with routingCandidates
#    (resolve via PATCH /orders/:id/route {transportCompanyId})
# 9. [DIRECT only] simulate gateway: POST /api/v1/payments/webhook/sadad (body + X-Signature HMAC)
#    → settles the invoice, order returns to APPROVED, then auto-routes (FR-020a)
# 10. transport admin → GET /dispatch/orders/:id/candidates → POST /dispatch/orders/:id/assign
#     {driverId} → ASSIGNED_TO_DRIVER → IN_TRANSIT (payment, if any, already happened before this)
# 11. driver → POST /orders/:id/arrive ; client → GET /orders/:id/otp/current ; driver → verify-arrival → UNLOADING
# 12. driver → request-delivery-otp ; client reads OTP ; driver → verify-delivery → DELIVERED
```

The Postman collection (`postman/ciro-fuel-api.postman_collection.json`) covers this full
flow end to end, including Regions, Geocoding and Invoices — run **Auth → Login – Fuel Admin**
/ **Login – Transport Admin** after their respective accounts exist (each request's own
description notes its prerequisite). `scripts/smoke.http` still covers the original
single-tier happy path (steps 7/11/12 above, with a Fuel Company acting as its own effective
tenant) for a quicker manual check; the payment webhook step needs its `X-Signature` computed
out-of-band — see the comment inside the file — since REST Client can't compute HMACs inline.

## 5. Tests

```bash
npm run test          # unit (state machine, tenant plugin, guards, OTP, dispatch)
npm run test:e2e      # supertest + mongodb-memory-server (replica-set mode — real transactions)
```

Key suites: `tenant-isolation.e2e-spec.ts` (two-company + multi-party 404 matrix, including
sibling-transporter and driver-to-driver isolation), `dispatch-race.e2e-spec.ts` (parallel
assignment, capacity + fuel-type filtering), `payment-idempotency.e2e-spec.ts` (webhook
replays, timeout-job vs late-webhook race), `presence.e2e-spec.ts` (6-min offline sweep,
re-eligibility), `force-complete.e2e-spec.ts` (admin override audit flag, role denial). Spec
004 additions: `order-routing.e2e-spec.ts` (none/one/several serving transporters, FR-014–016),
`billing-methods.e2e-spec.ts` / `billing-credit.e2e-spec.ts` / `billing-edge-cases.e2e-spec.ts`
/ `billing-transaction-integrity.e2e-spec.ts` (all three payment methods, credit-limit races,
cancellation voiding, settlement/order-transition atomicity), `order-visibility.e2e-spec.ts`
(driver summary/ETA exposure, SC-007's zero-geocoding-calls-on-read proof), and
`migration.e2e-spec.ts` (the re-runnable pre-004 → multi-tier migration, `scripts/migrate-multi-tier.ts`).
E2E uses a real Redis (service container in CI) for BullMQ delayed-job semantics.

## 6. Docker / CI

```bash
docker compose up --build      # app + mongo replica set + redis; sys_storge mounted as a volume
```

Either the container **or** a host `npm run start:dev` can own port 3000 — never
both. Stop the other side first (`docker compose stop app`, or kill the host
process).

Beware the log when they clash: Nest prints `Nest application successfully
started` **and then** `Error: listen EADDRINUSE: address already in use :::3000`.
The success line is emitted before the bind fails, so a quick glance at the log —
or a `curl` that the *other* process happily answers — both suggest all is well
while your build is not actually serving anything. Always grep the log for
`EADDRINUSE` before trusting that the instance you just started is the one
responding.

The two modes reach Mongo differently, and each needs its own URI:

| Running | `MONGODB_URI` | Driver topology |
|---------|---------------|-----------------|
| Host (`npm run start:dev`) | `mongodb://127.0.0.1:27017/ciro_fuel?directConnection=true` (from `.env`) | `Single` |
| Container (compose `app`) | `mongodb://mongo:27017/ciro_fuel?replicaSet=rs0` (from `environment:` in `docker-compose.yml`) | `ReplicaSetWithPrimary` |

Transactions work in both — the server reports `setName: rs0` either way, which
is what enables them. The compose `environment:` block overrides `env_file: .env`,
so the host-oriented value in `.env` is correctly ignored inside the container.
Clients on the host (mobile app, Postman) hit `http://localhost:3000/api/v1`
identically in both modes.

GitHub Actions (`.github/workflows/ci.yml`): entry-point guard (grep-fails
the build if a root `index.ts`/`index.js` ever appears) → lint / unit test /
e2e test in parallel → build → docker build (verifies the image builds;
no registry push is configured — add one if/when a deployment target exists).

## Scaling notes (post-v1)

- Payment timeouts are already multi-instance safe (BullMQ atomic job claims); the presence sweep is an idempotent bulk update, safe to run on every instance.
- >1 app instance ⇒ add the Socket.io Redis adapter (Redis is already provisioned for BullMQ).
- `sys_storge` → object storage behind the existing `FilesService` interface.
