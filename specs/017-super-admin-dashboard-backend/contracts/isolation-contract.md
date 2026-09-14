# Isolation & Non-Regression Contract

**Feature**: `017-super-admin-dashboard-backend` | **Phase**: 1

This feature's hardest requirements are **negative** — things that must not change and data that
must not travel. A negative guarantee has no screen to look at, so each one below names the artifact
it constrains and the test that would catch its violation.

Three requirement families live here: FR-032 (the transport tenant key), FR-074 (operator-only), and
FR-043/FR-044/FR-044a (the driver-surveillance boundary), plus FR-075's blanket non-regression.

---

## 1. The operator's bypass is the mechanism — nothing new is added

Both scoping plugins already exempt `SUPER_ADMIN`, across queries, `save`, `insertMany` **and
`aggregate`** (research R1). This feature relies on that and **adds no second mechanism**.

**Prohibited in this feature's diff:**

- any new `runUnscoped()` call in a request path
- any new Mongoose connection, model registered outside the plugin-bearing connection, or raw
  `collection.*` access
- any change to `resolveCompanyId` in `tenant-scope.plugin.ts`
- any change to `resolveFuelCompanyId` or `resolveFilter` in `multi-party-scope.plugin.ts`

**Why it matters**: each of these would produce a platform-wide result for the operator while
*removing* the guarantee for every other role that shares the code path. The bypass is one branch,
tested, and commented as load-bearing. The correct amount of new isolation code in this feature is
zero.

**Test**: a diff review gate before merge. The four files above appear in no task in this plan.

---

## 2. FR-032 — the transport company's tenant key is untouched

A `TRANSPORT_COMPANY_ADMIN`'s isolation key is `parentFuelCompanyId`, resolved per request. The
plugin fails closed on a missing one:

```ts
if (ctx.role === UserRole.TRANSPORT_COMPANY_ADMIN) {
  if (!ctx.parentFuelCompanyId) {
    throw new Error('Multi-party isolation violation: TRANSPORT_COMPANY_ADMIN context is missing parentFuelCompanyId');
  }
  return ctx.parentFuelCompanyId;
}
```

**Therefore a transport company with no parent is not a "nice to have later" — it is an illegal
state that throws on every scoped read.** This is why Clarification 1 made the parent required on
the operator's onboarding form rather than optional.

**Invariants**

| # | Guarantee | Requirement |
|---|---|---|
| 2.1 | `Company.parentFuelCompanyId` stays required for `type: TRANSPORT` | FR-029 |
| 2.2 | The operator's onboarding refuses an absent, malformed, non-existent or non-`FUEL` parent, creating nothing | FR-030 |
| 2.3 | The transporter-resolution query used by order routing is unchanged | FR-032 |
| 2.4 | Nothing records who onboarded a company | FR-031 |

**2.4 is what makes FR-031 structural.** There is no `onboardedBy` field and none is added, so an
operator-onboarded transporter and a parent-onboarded one are not merely treated alike — they are
not distinguishable at all.

**Tests**

- **SC-006 (the important one)**: onboard transporter A through the operator's route and transporter
  B through the parent fuel company's own route, then drive **both** through the same journey —
  parent lists them, an order routes to each, regions and delivery rates are assigned — and assert
  no behavioural difference. One path, two origins. This is the shape feature 016 used for its
  migrated-versus-new offers.
- **SC-005**: every transport company that existed before this feature stays visible to and
  manageable by its parent. Asserted by the existing transport-surface e2e suites passing unchanged.
- A negative test: the operator's onboarding with `parentFuelCompanyId` omitted returns `400` and
  **`Company.countDocuments()` is unchanged** — FR-028's "creates nothing" applies to the refusal
  path too, not only to the mid-transaction failure.

---

## 3. FR-074 — operator-only, verified per capability

Every route this feature adds refuses `FUEL_COMPANY_ADMIN`, `TRANSPORT_COMPANY_ADMIN`, `CLIENT` and
`DRIVER`.

**SC-012 says "verified per capability"**, so one shared "operator routes are guarded" test is not
enough — each new route carries its own refusal assertion. The authorization matrix in
`rest-api-delta.md` §9 is the checklist.

**The two extended routes need the opposite test.** `GET /companies` and `GET /orders` gain filters
usable by roles other than the operator, and FR-012 requires those filters to **narrow, never
widen**:

- a `FUEL_COMPANY_ADMIN` calling `GET /companies?type=TRANSPORT` receives **their own company or
  nothing** — never a transporter, never another tenant's company;
- a `FUEL_COMPANY_ADMIN` calling `GET /orders?bucket=…` receives only their own orders, bucket
  applied **within** that scope.

This second case is where the `$or` hazard lives. The bucket filter must be `status: { $in: [...] }`
— the plugins inject through `Query.where()`, which **replaces** a same-named top-level key rather
than merging it, so a `$or`-shaped bucket would be silently discarded for scoped roles and work
perfectly for the operator (research R4, and the exact defect feature 016 hit on `ExchangeOffer`).

**Test**: the bucket filter must be exercised **as a `FUEL_COMPANY_ADMIN` in an e2e suite**, not
only as the operator and not only in a unit test. A unit test correctly does not register the
plugins at all, so it cannot see this class of defect — which is precisely how feature 016's leak
survived until a lifecycle e2e suite caught it.

---

## 4. FR-043 / FR-044 / FR-044a — the driver-surveillance boundary

Spec 011 drew this line: safety and delivery visibility, never driver surveillance. FR-044 extends
it to the operator **unchanged**, and FR-044a opens exactly one narrow exception.

### 4.1 What must never reach an operator screen

`location`, `driverLocation`, `lastSeenAt`, `lastMovedAt`, `lastMovedLocation`, any trip count, any
delivery date, any order reference, any stop event, any route.

### 4.2 The single permitted derivation

The identity of the **most recently operated truck**, and nothing else about the deliveries it was
read from (FR-039a, FR-044a).

**Enforced by projection, not by discipline.** The aggregate groups `Order` by `driverId`, sorts by
`createdAt` internally, and projects **`truckId` alone**. The sort key never reaches the output, so
the roster response has no field through which a delivery fact could travel.

**The exception must not be widened.** FR-044a is explicit that a second fact may not be added
"while we are already reading the history". The projection is the enforcement point and any addition
to it is a spec change, not an implementation detail.

### 4.3 Two failure modes worth naming

**Reusing `DispatchService.getSuggestedTruck`** would be wrong in the opposite direction — it
suppresses the truck when it is unavailable, so a driver whose truck is on a job right now would
show "no truck", collapsing FR-039b's required distinction between "never driven" and "not
currently available" (research R8).

**Reusing the transport company's driver table component** would reintroduce the forbidden columns
through a file the operator's own screen never mentions
(`dashboard-integration.md` §5.2).

**Test (SC-014)**: assert on **the response body the platform sends**, not on rendered output. The
roster payload must contain none of §4.1's field names. A rendering test cannot see a field the
screen merely chose not to draw.

---

## 5. FR-075 — nothing else changes

| Surface | Evidence required |
|---|---|
| Mobile (both personas) | `flutter test` passes; the backend diff touches no mobile path |
| Fuel-company dashboard | `vitest run` baseline unchanged |
| Transport-company dashboard | `vitest run` baseline unchanged |
| Backend, all other roles | `npm run test` and `npm run test:e2e` baselines unchanged |

**The mobile gate is a pre-deploy requirement, not an optional check.** This feature adds
`NotificationType.PLATFORM_ANNOUNCEMENT`, and spec 007 installed a parity test in the mobile
repository pinning the Flutter enum to the backend's wire values. That repository is **not present
on this machine**. Feature 013 added a notification type under the same conditions and recorded that
an unrecognised value degrades to the existing `unknown` fallback — but the parity test must still
be run (SC-013), exactly as features 015 and 016 each carried this gate forward.

No administrator has a mobile persona, so no mobile client will ever *receive* a
`PLATFORM_ANNOUNCEMENT`. That makes the runtime risk nil and the **test** risk real; they are
different things.

### 5.1 Endpoints extended rather than added

Three existing routes change. Each must be asserted unchanged for its existing callers:

| Route | Change | Non-regression assertion |
|---|---|---|
| `GET /companies` | new optional `type`, `status` | absent filter returns exactly today's result |
| `GET /orders` | new optional `bucket` | absent filter returns exactly today's result |
| `GET /orders/summary` | new shape for `SUPER_ADMIN` only | `FUEL_COMPANY_ADMIN` and `TRANSPORT_COMPANY_ADMIN` responses byte-for-byte unchanged |
| `GET /platform-account/movements` | response gains derived `direction` | every existing field unchanged; feature 013's dashboard reads it as-is |

### 5.2 Auth internals that must not move

`findByPhoneForAuth` and `findSingleActiveAdminByPhone` are **not** modified (research R10). Their
scoping is deliberate, commented, and load-bearing for sign-in. FR-061 is served by a **new** narrow
lookup beside them.

`sessionGeneration` and `activeSessions` are **read** by this feature and never written (FR-062). A
regression test asserts that confirming a phone-number change leaves both untouched — because the
instinct to re-authenticate after a credential change would silently destroy feature 015's
concurrent administrator sessions.

---

## 6. Announcement fan-out — the tenant stamp

A BullMQ worker runs with **no request context**, so both plugins take their `!ctx?.role` bypass and
`pre('save')` stamps nothing.

`Notification.companyId` is `required: true`, so an unstamped write fails outright. The subtler
hazard: a notification stamped with the **wrong** `companyId` is invisible to the administrator it
was addressed to (`Notification` is `markTenantScoped`), while the operator — who bypasses scoping —
sees it and counts the delivery a success.

**Test**: the delivery assertion authenticates as the **recipient administrator** and reads their
own notification list. Reading it back as the operator proves nothing, and is the shape of test most
likely to be written by accident (research R9).
