# Load Sanity Check (SC-008)

**Target**: the platform supports at least 50 concurrent tenant companies and 500 concurrent active users without functional degradation.

This is a manual sanity check, not part of the CI test suite — it needs a
real running server and takes longer than a unit/e2e run, so it's kept
separate deliberately.

## 1. Start dependencies and the app

```bash
docker compose up -d mongo mongo-init redis
npm run start:dev
```

## 2. Seed scale-representative data

```bash
npm run seed:load-test
```

Creates 50 companies, each with 1 admin, 4 clients, and 5 drivers (~500
users total), with fuel prices and dispatch-eligible drivers already set up.
Login password for every seeded user: `LoadTest123!`.

## 3. Drive load with autocannon

```bash
npx autocannon -c 50 -d 30 -m GET \
  -H "Authorization: Bearer <token-from-any-seeded-client-login>" \
  http://localhost:3000/api/v1/orders
```

Repeat against a representative mix of endpoints:

- `GET /api/v1/orders` (read-heavy, tenant-scoped list)
- `POST /api/v1/orders` (write path, with a valid client token + JSON body)
- `PATCH /api/v1/orders/:id/approve` (triggers dispatch's `$geoNear` query + transaction)

A quick way to grab tokens for many different tenants: log in as several of
the seeded admins/clients (`admin{0..49}@loadtest.example` /
`client{0..49}-{0..3}@loadtest.example`) and round-robin their tokens across
`autocannon` runs so requests actually spread across companies (proving
tenant isolation doesn't degrade under concurrent multi-tenant load, not
just single-tenant throughput).

## 4. What "no functional degradation" means here

- No 5xx responses under load.
- p95 latency stays reasonable for the read/write paths above (no hard SLA
  defined by the spec — watch for cliffs, not an absolute number).
- `docker stats` shows Mongo/Redis/app memory and CPU staying stable (no
  runaway growth) across the run.
- Run `npm test` / `npm run test:e2e` again immediately after the load run
  completes — functional correctness (tenant isolation, no double-booking)
  must hold under load, not just throughput.

## Cleanup

The seeded load-test data lives in the same database as everything else;
drop it when done:

```bash
docker compose exec mongo mongosh ciro_fuel --eval 'db.dropDatabase()'
```
