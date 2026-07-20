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
| `MONGODB_URI` | `mongodb://localhost:27017/ciro_fuel?replicaSet=rs0` | replica set REQUIRED (transactions) |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ (payment-timeout delayed jobs) |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | random 64-hex | |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `7d` | |
| `PAYMENT_SADAD_SECRET` / `PAYMENT_MADA_SECRET` | per-gateway HMAC secrets | |
| `PAYMENT_DEADLINE_MINUTES` | `30` | FR-015a |
| `OTP_EXPIRY_MINUTES` | `30` | |
| `STORAGE_DIR` | `sys_storge` | MUST remain exactly this name |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | `60` / `100` | global rate limit |

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

## 4. Smoke test the primary flow (US1)

```bash
# 1. login as super admin → create a company (multipart with commercial register PDF)
# 2. login as company admin → set fuel prices, create a CLIENT and a DRIVER (+truck)
# 3. login as client → POST /api/v1/orders  → see estimatedPrice, status PENDING_APPROVAL
# 4. admin → PATCH /orders/:id/approve {finalPrice} → auto-dispatch assigns driver → PENDING_PAYMENT
# 5. simulate gateway:  POST /api/v1/payments/webhook/sadad  (body + X-Signature HMAC) → IN_TRANSIT
# 6. driver → POST /orders/:id/arrive ; client → GET /orders/:id/otp/current ; driver → verify-arrival → UNLOADING
# 7. driver → request-delivery-otp ; client reads OTP ; driver → verify-delivery → DELIVERED
```

A ready-made `scripts/smoke.http` (REST Client) file covers steps 1–7 (the
payment webhook step needs its `X-Signature` computed out-of-band — see the
comment inside the file — since REST Client can't compute HMACs inline).

## 5. Tests

```bash
npm run test          # unit (state machine, tenant plugin, guards, OTP, dispatch)
npm run test:e2e      # supertest + mongodb-memory-server (replica-set mode — real transactions)
```

Key suites: `tenant-isolation.e2e-spec.ts` (two-company 404 matrix), `dispatch-race.e2e-spec.ts` (parallel assignment, capacity + fuel-type filtering), `payment-idempotency.e2e-spec.ts` (webhook replays, timeout-job vs late-webhook race), `presence.e2e-spec.ts` (6-min offline sweep, re-eligibility), `force-complete.e2e-spec.ts` (admin override audit flag, role denial). E2E uses a real Redis (service container in CI) for BullMQ delayed-job semantics.

## 6. Docker / CI

```bash
docker compose up --build      # app + mongo replica set + redis; sys_storge mounted as a volume
```

GitHub Actions (`.github/workflows/ci.yml`): entry-point guard (grep-fails
the build if a root `index.ts`/`index.js` ever appears) → lint / unit test /
e2e test in parallel → build → docker build (verifies the image builds;
no registry push is configured — add one if/when a deployment target exists).

## Scaling notes (post-v1)

- Payment timeouts are already multi-instance safe (BullMQ atomic job claims); the presence sweep is an idempotent bulk update, safe to run on every instance.
- >1 app instance ⇒ add the Socket.io Redis adapter (Redis is already provisioned for BullMQ).
- `sys_storge` → object storage behind the existing `FilesService` interface.
