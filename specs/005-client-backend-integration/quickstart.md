# Quickstart: Client Mobile App — Backend Integration

**Feature**: `005-client-backend-integration` | **Date**: 2026-08-15

How to get a working environment, verify the feature end to end, and know when it is done.

---

## Prerequisites

Two repositories, in different roots:

| Component | Path | Stack |
|---|---|---|
| Backend | `ciro_fuel/` (this repo) | NestJS 10, MongoDB (replica set), Redis |
| Mobile | `../mobile_app/` | Flutter, Dart SDK ^3.11.5 |

MongoDB **must** run as a replica set — the platform uses multi-document transactions for
dispatch, approval, settlement and the payment webhook (Principle V), and they fail on a
standalone `mongod`. `docker-compose.yml` in this repo provides both Mongo and Redis.

---

## Backend

```bash
docker compose up -d              # Mongo (replica set) + Redis
npm install
cp .env.example .env              # then fill in the values below
npm run seed:super-admin
npm run seed:dashboard            # fuel company, transport company, client, driver
npm run start:dev                 # http://localhost:3000/api/v1
```

New environment variables introduced by this feature:

```bash
SMS_PROVIDER=none                 # 'none' = dev no-op sender, logs codes instead of sending
SMS_API_KEY=
SMS_SENDER_ID=
```

`SMS_PROVIDER=none` is the development default and is what makes Story 7 testable before a
provider is procured (research R4): the no-op sender logs the code rather than sending it. It must
be impossible to select in production — validate it in `src/config/validation.ts` alongside the
existing Joi schema, or the first production phone change will silently no-op.

### Migration

Run once, after the schema changes land and before the client app is pointed at the API:

```bash
npm run migrate:005-stations      # stations + order.stationId + paymentEvent.clientId
```

Idempotent. Verify against a copy of production-shaped data first — step 1 changes what
`GET /auth/me` returns to **every** role, drivers included.

### Seeding for this feature

`npm run seed:dashboard` needs extending to cover the new surface, otherwise none of it is
reachable locally:

- a `pricingConfig` on the seeded fuel company (without it, every quote returns
  `PRICING_NOT_CONFIGURED` — correct behaviour, confusing first run)
- two or three `Station` documents for the seeded client, so multi-station selection is exercisable
- enough orders to page past 20, or FR-048 is untestable by hand

---

## Mobile

```bash
cd ../mobile_app
flutter pub get
dart run build_runner build --delete-conflicting-outputs   # Freezed state changes
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
```

`10.0.2.2` is the Android emulator's host alias. Use `localhost` for iOS simulator, or the
machine's LAN IP for a physical device.

Re-run `build_runner` after any change to a Freezed state class — the pagination work in
`contracts/mobile-integration.md` touches several.

---

## Verifying the feature

Grouped by user story so each can be checked independently, in priority order.

### Story 1 — Real orders

1. Sign in as the seeded client.
2. Orders list shows the seeded orders, not five samples. **The old build showed
   `ORD-2024-256` to every client — if you see it, the screen is still static.**
3. Scroll past 20 → next page loads, nothing repeats, nothing is skipped.
4. Apply a status filter → results come from the server across the whole set, not the loaded pages.
5. Open an order → status, actions and progress match the platform.
6. Open another client's order id directly → 404, no data.
7. Kill the backend, pull to refresh → error with retry, **never** sample data.

### Story 2 — Real price

1. Start a new request. Grades offered are only those the seeded fuel company sells.
2. Select quantity → breakdown itemises fuel line, delivery fee, service fee, tax.
3. **Check they sum to the total.** This is FR-011b and the rounding rule in research R2 is what
   makes it hold; a one-halala discrepancy means the components are being rounded after summing.
4. Change the company's `pricingConfig` while the quote is open, then confirm →
   `QUOTE_STALE`, the new breakdown is shown, re-confirmation is required.
5. Confirm on DEFERRED → no payment step.
6. Confirm on DIRECT → payment, and the order advances only on the webhook.
7. Clear the company's `pricingConfig` → `PRICING_NOT_CONFIGURED`, not a total of zero.

### Story 3 — Tracking

1. With an order in transit and the driver build emitting position, open tracking as the client.
2. Driver name, plate, ETA are the platform's.
3. Stop the driver's updates → position reported stale within one staleness window.
4. Open tracking on a not-yet-dispatched order → explanatory state, not an error.

### Story 4 — Money

1. Invoices list matches the platform; page past 20.
2. Payments list shows real payments. **Confirm `rawPayload` is absent from the response** — check
   the network response, not the UI.
3. Settle an invoice → stays outstanding until the platform confirms.
4. Settle the same invoice from two places → the second is refused as already settled.

### Story 5 — Credit

1. Credit screen shows limit, consumed, available.
2. They agree with the home dashboard (FR-026).
3. Clear the client's `creditLimit` → "no facility assigned", not a zero.
4. Attempt an order over the limit → warned before submission, with the shortfall.

### Story 6 — Notifications

1. Raise one on the platform → badge count increases.
2. Mark read → count decreases, and stays decreased after restart.
3. Tap an order notification → that order opens.

### Story 7 — Profile

1. Profile shows real name, phone, stations, picture.
2. Change name → persists across restart.
3. Change phone → with `SMS_PROVIDER=none`, the code is in the backend log. Submit it → number
   changes.
4. Request a code and abandon → original number still in force.
5. Request four codes in 15 minutes → 429 with `retryAfterSeconds`.
6. Try a number already on another account → `PHONE_IN_USE`, and **no code is sent**.

### Story 8 — Stations

1. Stations screen lists the seeded stations.
2. **No create, rename or delete control is present** (FR-036b) — the absence is the requirement.
3. Select a non-default station for an order → the platform records that station.
4. Mark a favourite → survives restart and a sign-in on another device.

### Story 9 — Support

1. Raise a problem from an order → order attached without typing its number.
2. The seeded fuel company admin receives a `SUPPORT_REQUEST_RAISED` notification.
3. Another company's admin cannot see it.
4. The screen shows submitted / acknowledged, and does not imply a written reply is coming.

---

## Tests

```bash
# Backend
npm test                    # unit
npm run test:e2e            # e2e — requires the replica set
npm run lint:check
npm run lint:no-index       # constitution: no root index.ts

# Mobile
cd ../mobile_app
flutter analyze
flutter test
```

**The existing suites are a regression gate, not just a target** (spec Assumptions). Two changes
touch shared ground and must be green before anything builds on them:

- the OTP extraction (research R4) — delivery handover codes run through it
- the station migration (research R1) — `GET /auth/me` serves every role

Run the full backend e2e suite after each of those two lands, on its own, before continuing.

---

## Definition of done

- [ ] All 9 stories verified above
- [ ] `grep -ri "mock" mobile_app/lib/features` returns nothing reachable from a client route
- [ ] Backend unit + e2e green, including the pre-existing suites
- [ ] `flutter analyze` clean, `flutter test` green
- [ ] Every new endpoint has a tenant-isolation test proving a client cannot reach another's data
      (FR-046a)
- [ ] Every newly connected screen reviewed in Arabic (RTL) and English
- [ ] No credential, OTP or payment detail in any log across a full client journey
- [ ] Cursor pagination verified against a client with 500+ orders (SC-004a)

---

## Known gaps at feature completion

Neither blocks development; both block launch.

1. **No SMS provider.** `SMS_PROVIDER=none` logs codes. Story 7 is functionally complete but
   cannot deliver a real message until a provider is selected and provisioned.
2. **No fuel company administration surface.** Registering stations and acknowledging support
   requests both need the web dashboard (feature 003), which has no code yet. Until then, stations
   are seeded directly and support requests accumulate unread — which is why the support screen
   keeps the phone and messaging channels prominent (FR-039b).
