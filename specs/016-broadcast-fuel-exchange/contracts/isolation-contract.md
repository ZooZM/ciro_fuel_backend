# Isolation Contract: Broadcast Fuel Exchange Offers

**Feature**: 016-broadcast-fuel-exchange | Governs Constitution Principle II compliance for two new collections.

## The four shapes, and which mechanism expresses each

| Shape | Mechanism | Collections |
|---|---|---|
| One owner, forced on create | `tenant-scope.plugin.ts` | users, trucks, files, credit limits |
| One owner + role-narrowed other viewers | `multi-party-scope.plugin.ts` | orders, invoices |
| Exactly two owners, validated not forced | `party-set-scope.plugin.ts` | `ExchangeRequest` (legacy), migrated `ExchangeOffer` |
| **One owner + unbounded market audience** | **`party-set-scope.plugin.ts`, amended** | market `ExchangeOffer` |
| **Author OR the raiser of the parent** | **`proposal-scope.plugin.ts` (new)** | `ExchangeProposal` |

The fourth shape is folded into the third rather than given its own plugin (research R1): the two differ by one boolean, share one collection, and after migration the third has no other consumer.

## `ExchangeOffer` — the injected filter

For `FUEL_COMPANY_ADMIN`:

```
{ $or: [ { partyCompanyIds: <acting> }, { openToMarket: true } ] }
```

For `SUPER_ADMIN`: bypass (read-only at the service layer — FR-023 forbids the operator raising, answering or awarding).
For every other role: **throw**. Fail closed, exactly as both existing plugins do for a role they do not recognise.
For a context with no `role`: bypass, using `!ctx?.role` and never `!ctx` — since spec 012 a public route carries a store for its correlation id but establishes no actor, and this exact trap has already been found and fixed in all three plugins.

### `pre('save')` validation

Validates membership; never forces a value. That is what makes two legitimate owners expressible at all.

- `openToMarket: true` → `partyCompanyIds.length === 1` and it is the acting company.
- `openToMarket: false` → `partyCompanyIds.length === 2` and includes the acting company.
- Otherwise `EXCHANGE_PARTY_INVALID`.

**Registration-time check retained**: a `markPartySet` schema with no index on `partyCompanyIds` throws at bootstrap, not at first query.

## `ExchangeProposal` — the injected filter

For `FUEL_COMPANY_ADMIN`:

```
{ $or: [ { proposingCompanyId: <acting> }, { offerRaisedByCompanyId: <acting> } ] }
```

`offerRaisedByCompanyId` is denormalised onto the proposal precisely so this filter never needs a join. A scope filter that requires a lookup is one that will eventually be worked around.

The disjunction **is** FR-011b. A responder's every read of the proposal collection — list, count, aggregate — is bounded to its own rows before any service code runs, so a rival's price is not withheld by a projection; it is never fetched.

## The failure this contract exists to prevent

If `ExchangeOffer` were marked `multiParty` instead: the plugin forces one `fuelCompanyId` owner on create and narrows other viewers **by role**. A proposing company and a raising company hold the *same* role, so role cannot discriminate them — every fuel company would either see every offer's proposals or none of them, and `SUPER_ADMIN`'s bypass would make the operator's screen look correct throughout. The only test that catches it is a three-company one asserting on a **non-party's** payload.

If migration set `openToMarket: true` on legacy records: every historical directed request — including ones never answered — becomes readable by every fuel company at deploy. No test that exercises only new offers can see this. SC-010 requires the migrated-unanswered case specifically.

## Non-negotiable test cases (Slice 0 gate)

1. Company C, which is party to nothing, reads a **market** offer by id → succeeds (R2: market offers are public to fuel companies) and receives **no** proposal data.
2. Company C reads a **migrated directed** offer by id → `404`, indistinguishable from absence.
3. Company C lists offers → the migrated directed offer is absent; the market offer is present only if C sells the grade.
4. Company B, having proposed, reads the offer and its proposal list → sees only its own proposal; no count, no rival price, no rival name, in the **raw payload**.
5. Company A (raiser) reads the same offer → sees both proposals and both proposers' contacts.
6. A `TRANSPORT_COMPANY_ADMIN`, `CLIENT` or `DRIVER` context reaching either collection → throws, not empty results.
7. `SUPER_ADMIN` reads everything, and is refused on raise, propose, award and withdraw.
8. A migrated unanswered request is still answerable by its original recipient and by nobody else.
