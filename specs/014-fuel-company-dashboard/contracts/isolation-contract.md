# Contract: Party-Set Isolation

**Feature**: `013-fuel-company-dashboard` | **Source**: research R3, plan Complexity Tracking

This is the feature's one accepted architectural addition. It exists because a fuel exchange request
is owned by **two** fuel companies and neither existing isolation plugin can express that.

## Why a third mechanism

| Mechanism | Read filter | Create behaviour | Can express two owners? |
|---|---|---|---|
| `tenant-scope.plugin.ts` | `{ companyId }` — equality | Forces `companyId` = acting company | **No** |
| `multi-party-scope.plugin.ts` | `{ fuelCompanyId }` + role narrowing | Forces `fuelCompanyId` = acting company | **No** |
| `party-set-scope.plugin.ts` *(new)* | `{ partyCompanyIds: acting }` — array membership | Requires acting company ∈ parties | **Yes** |

"Multi-party" names a record with several legitimate **roles** inside one fuel company's tenant — a
client, a driver, a transporter and a fuel company all seeing one order. Every one of those filters
still carries a single `fuelCompanyId`. A record straddling **two fuel companies** is a category the
plugin was never built for, and its name makes that easy to miss.

## The failure it prevents

Marking `ExchangeRequest` as multi-party compiles, passes review, and passes every single-company
test:

1. Company A raises a request → `pre('save')` stamps `fuelCompanyId = A`.
2. Company B lists incoming → plugin injects `{ fuelCompanyId: B }`.
3. **B's list is empty. Always.** No error. An empty state indistinguishable from "nobody sent you
   anything".

Two properties make this worse than an ordinary bug:

- **It is silent on the side that matters.** A raises, sees their outgoing request, and concludes it
  works. Only B can observe the defect, and only as an absence.
- **`SUPER_ADMIN` bypasses both plugins**, so the operator's exchange screen (Story 13) shows every
  request correctly while both fuel companies see nothing. The screen most likely to be demoed is
  the one that cannot reveal the fault.

Only a test with **two fuel companies**, asserting that the recipient *can* read the request, detects
it. That test is mandatory before Story 12 is considered done.

## Contract

**Marker**: `markPartySet(schema)`, mirroring `markTenantScoped` / `markMultiParty`.

**Required field**: `partyCompanyIds: ObjectId[]`, indexed (multikey). A party-set schema without it
MUST fail at registration, not at first query.

**Read** — for every operation in `SCOPED_QUERY_OPS`:

| Acting role | Injected filter |
|---|---|
| `SUPER_ADMIN` | *(bypass — same as both existing plugins)* |
| No authenticated actor (script, seed, public route) | *(bypass — discriminate on `!ctx?.role`, never `!ctx`)* |
| `FUEL_COMPANY_ADMIN` | `{ partyCompanyIds: ctx.companyId }` |
| Any other role | **Throw.** Fail closed, exactly as both existing plugins do for an unhandled role. |

**Write**: on create, the acting company MUST appear in `partyCompanyIds`, and the array MUST hold
exactly the parties the domain defines (two, for exchange). Unlike the existing plugins, this one
**validates membership rather than forcing a value** — forcing is what makes the other two unable to
express this shape.

**Bypass discriminator**: `!ctx?.role`, never `!ctx`. Since feature 012 a public route carries a
store for its correlation id but establishes no actor; testing `!ctx` alone would fall through to the
authenticated branch and throw on anonymous traffic. This exact trap was found and fixed in both
existing plugins — do not reintroduce it in the third.

## Required tests

| Test | Asserts |
|---|---|
| Recipient reads a request raised by the counterparty | The defect above. **Non-negotiable.** |
| Raiser reads their own | Direction derived, not stored |
| A third fuel company reads neither | FR-079 |
| Create with the acting company absent from parties | Refused |
| Create with one party, or three | Refused |
| `SUPER_ADMIN` reads all | Bypass intact |
| Anonymous/public-route traffic | Bypasses without throwing |
| Concurrent accept and withdraw | One outcome, both parties see the same one (FR-082) |

## Scope

This mechanism serves `ExchangeRequest` alone. The other three new collections are single-owner and
use `markTenantScoped` (data-model R6). Do not generalise it further in this feature — the reason a
third plugin is acceptable at all is that it leaves the two plugins guarding orders and invoices
untouched.
