# Quickstart: Broadcast Fuel Exchange Offers

**Feature**: 016-broadcast-fuel-exchange

A walkthrough that proves the feature end to end. It needs **three fuel companies**, because every interesting guarantee here is invisible with two.

## Part 0 — Environment and the migration (do this first)

The migration is a **pre-deploy** step, not a test step (FR-039b, research R5).

```bash
# 1. Back up the exchange_requests collection.
# 2. Dry run — reports what it would write, changes nothing.
npx ts-node scripts/migrate-exchange-requests-to-offers.ts --dry-run
# 3. Apply.
npx ts-node scripts/migrate-exchange-requests-to-offers.ts
# 4. Idempotency — a second run must report 0 written.
npx ts-node scripts/migrate-exchange-requests-to-offers.ts
```

**Verify before deploying the code**: every migrated offer has `openToMarket: false`. One document with `true` publishes a private historical request to every fuel company on the platform.

```js
db.exchangeoffers.countDocuments({ migratedFromRequestId: { $exists: true }, openToMarket: true })  // MUST be 0
```

Seed three fuel companies for the walkthrough — **A** and **B** both selling `PETROL_95`, **C** selling only `DIESEL`:

```bash
npx ts-node scripts/seed-dashboard-actors.ts
```

## Part 1 — Raise one offer (US1)

As A's administrator, open تبادل الوقود بين الشركات. The panel is expanded with no company selector and no price field.

Enter: `PETROL_95`, `20,000` litres, a delivery time tomorrow, city `JEDDAH`, neighbourhood `الروضة`, a location link, a note. The summary row reads **20,000 لتر — بنزين 95**, not a currency amount. Send.

**Verify**:
- [ ] A sees exactly **one** outgoing offer.
- [ ] B sees it as incoming.
- [ ] **C does not** — C sells only diesel (FR-007).
- [ ] A transport company administrator, a station owner and a driver see nothing anywhere.
- [ ] B was told without opening the screen (FR-029).
- [ ] Raising a `KEROSENE` offer that nobody sells is refused with `EXCHANGE_NO_ELIGIBLE_COMPANY`.

## Part 2 — Answer, blind (US2)

As B, open the offer and propose `2.18` per litre.

**Verify**:
- [ ] A is told a proposal arrived (FR-030).
- [ ] B proposing a second time is refused `EXCHANGE_ALREADY_ANSWERED`.
- [ ] A price of `0` is refused.
- [ ] Onboard a third `PETROL_95` company **D** now — D sees the offer, confirming eligibility is evaluated at view time (FR-006a).
- [ ] As D, read the offer **and inspect the raw response body**: no proposal array, no count, no mention of B. This is the check that matters; a screen not drawing something proves nothing (R12).

Then, as D, propose `2.11`.

## Part 3 — Review and award (US3)

As A, open the offer. Both proposals are listed with company, unit price, currency and resulting total, plus each proposer's contact details.

Award **D**.

**Verify**:
- [ ] The offer is `AWARDED`; `agreedUnitPrice`, `agreedTotal` and currency are stored, not recomputed on read.
- [ ] A and D each see the other's contact details; neither saw them before (FR-019, FR-019a).
- [ ] **B is told the offer closed and can determine neither the winner nor the winning price** — check the notification payload and the offer payload, not just the screen (FR-015).
- [ ] A second award attempt returns `409 EXCHANGE_ALREADY_RESOLVED`.
- [ ] No order, delivery, driver assignment or litre-balance movement exists as a result (FR-017) — check `orders`, `invoices` and the balance collections directly.

**The race** (FR-014a), which no click-through can prove — run the e2e case:

```bash
npx jest --config test/jest-e2e.json test/e2e/exchange-award-race.e2e-spec.ts --runInBand
```

Two simultaneous awards of different proposals: exactly one stands, the other gets `409`.

## Part 4 — Withdraw and counts (US4, US6)

Raise a second offer as A, have B propose, then withdraw it.

**Verify**:
- [ ] It leaves every incoming list and cannot be answered.
- [ ] B is told it was withdrawn (FR-030a).
- [ ] Withdrawing the already-awarded offer from Part 3 is refused.
- [ ] The three cards read from `GET /fuel-exchange/offers/summary` and match a hand count **with more offers than fit one page** (FR-033).
- [ ] An offer awarded last calendar month is excluded from تم الترسية (الشهر).

## Part 5 — Isolation and migration, re-checked against the real server

- [ ] As C, fetch the Part 1 offer **by id** → it returns (market offers are public to fuel companies, R2) and carries no proposal data.
- [ ] As C, fetch a **migrated directed** offer by id → `404`, indistinguishable from a nonexistent id.
- [ ] A migrated unanswered request is still answerable by its original recipient, and by nobody else (SC-010).
- [ ] As `SUPER_ADMIN`, every offer and proposal is readable; raise, propose, award and withdraw are all refused (FR-023).

## Part 6 — Regression gates

```bash
npm run build && npm run test && npm run test:e2e     # backend
cd E:/zeyad/web_dashboard_ciro_fuel && npx tsc -b --force && npx vitest run
```

- [ ] Dashboard baseline no worse: same two suites failing to load, same ~30 unused-import errors.
- [ ] **`flutter test` in the mobile repository** — the four new `NotificationType` values must not break spec 007's enum parity guard. The mobile repo is not on the build machine; this gate is unresolvable here and MUST run before deploy.
- [ ] `npm run lint:check` remains unusable on a Windows checkout (`core.autocrlf` with no `.gitattributes`) — a pre-existing environment condition, not this feature's.

---

## Results

_Record outcomes here when walked against a real server._
