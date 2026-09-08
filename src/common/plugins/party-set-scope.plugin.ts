import { BadRequestException } from '@nestjs/common';
import { Schema, Query } from 'mongoose';
import { TenantContextService } from '../context/tenant-context.service';
import { UserRole } from '../enums/user-role.enum';
import { ErrorCode } from '../enums/error-code.enum';
import { isPartySet } from './party-set.marker';

const SCOPED_QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndRemove',
  'count',
  'countDocuments',
  'updateMany',
  'updateOne',
  'deleteMany',
  'deleteOne',
] as const;

function isQuery(ctx: unknown): ctx is Query<unknown, unknown> {
  return (
    typeof ctx === 'object' &&
    ctx !== null &&
    typeof (ctx as Query<unknown, unknown>).where === 'function' &&
    typeof (ctx as Query<unknown, unknown>).getFilter === 'function'
  );
}

/**
 * spec 014 T210/research R3, `contracts/isolation-contract.md` — the third, deliberately
 * narrow global isolation mechanism. Serves `ExchangeRequest` (legacy, exactly two
 * owners) and, since spec 016 (research R1), `ExchangeOffer`: a record owned by an ARRAY
 * of companies, which neither `tenant-scope.plugin.ts` (one owner, forced on create) nor
 * `multi-party-scope.plugin.ts` (one owner plus role-narrowed OTHER viewers, still forced
 * on create) can express. See the contract's comparison table for why a third mechanism,
 * rather than bending either existing one, is the accepted departure.
 *
 * The failure this prevents, if `ExchangeRequest` were marked `multiParty` instead: Company
 * A raises a request (`pre('save')` forces `fuelCompanyId = A`), Company B lists incoming
 * (`{ fuelCompanyId: B }`) and sees nothing — silently, permanently, with `SUPER_ADMIN`'s
 * bypass making the operator's own screen look correct throughout. Only a two-company test
 * asserting the RECIPIENT can read it catches this (T215's non-negotiable first case).
 *
 * **Amended for spec 016 (research R1)**: a market `ExchangeOffer` is a FOURTH shape —
 * one owner (the raiser) plus an UNBOUNDED audience (every eligible fuel company) — that
 * differs from the third shape by exactly one boolean (`openToMarket`) and lives in the
 * same collection family as the migrated records that still need the third shape. Rather
 * than add a fourth global mechanism (two of them registered against the same collection
 * family, differing by one flag — the isolation contract's own argument for narrowness
 * cuts against this), the injected filter below becomes a disjunction and `pre('save')`
 * splits its validation on the same flag. `ExchangeRequest` keeps working unamended: every
 * one of its documents has `openToMarket` undefined (falsy), so it always takes the
 * two-party branch, byte-compatible with what this plugin validated before this change.
 */
export function createPartySetScopePlugin(tenantContext: TenantContextService) {
  /** `undefined` means bypass (SUPER_ADMIN or no authenticated actor); any other role
   * throws — fail closed, exactly as both existing plugins do for a role they don't
   * recognise. `!ctx?.role`, never `!ctx`: since spec 012 a public route carries a store
   * for its correlation id but establishes no actor (this exact trap was found and fixed
   * in both existing plugins — T211). */
  function resolveActingCompanyId(): string | undefined {
    const ctx = tenantContext.getContext();
    if (!ctx?.role) {
      return undefined;
    }
    if (ctx.role === UserRole.SUPER_ADMIN) {
      return undefined;
    }
    if (ctx.role !== UserRole.FUEL_COMPANY_ADMIN) {
      throw new Error(`Party-set isolation violation: no scoping rule defined for role ${ctx.role}`);
    }
    if (!ctx.companyId) {
      throw new Error('Party-set isolation violation: FUEL_COMPANY_ADMIN context is missing companyId');
    }
    return ctx.companyId;
  }

  return function partySetScopePlugin(schema: Schema): void {
    if (!isPartySet(schema)) {
      return;
    }

    // T213 — fail at registration, not at first query. By the time a schema reaches
    // `connection.plugin()` (app bootstrap, via `MongooseModule.forFeature`), every
    // `.index()` call in that schema's own definition file has already run.
    const hasPartyCompanyIdsIndex = schema
      .indexes()
      .some(([fields]) => Object.prototype.hasOwnProperty.call(fields, 'partyCompanyIds'));
    if (!hasPartyCompanyIdsIndex) {
      throw new Error(
        'Party-set isolation violation: schema is markPartySet but has no index on partyCompanyIds',
      );
    }

    SCOPED_QUERY_OPS.forEach((op) => {
      schema.pre(op as never, function (this: unknown) {
        const actingCompanyId = resolveActingCompanyId();
        if (!actingCompanyId) return;
        if (isQuery(this)) {
          // spec 016 research R1: array membership OR a market offer — a
          // `FUEL_COMPANY_ADMIN` may read any document naming them a party
          // (legacy two-company shape, unchanged) AND every document
          // deliberately published to the whole market, regardless of
          // whether they are named in it at all. `ExchangeRequest` documents
          // never carry `openToMarket: true`, so this disjunction changes
          // nothing for that collection.
          this.where({ $or: [{ partyCompanyIds: actingCompanyId }, { openToMarket: true }] });
        }
      });
    });

    // T212 — VALIDATES membership rather than forcing a value. Forcing is exactly what
    // makes the other two plugins unable to express two legitimate owners; application
    // code (`FuelExchangeService.create`) sets `partyCompanyIds` itself from validated
    // input, and this is the structural backstop that a party-set document can never be
    // saved with the acting company absent from its own parties, or with a party count
    // the domain never defined (exchange is always exactly two).
    // spec 016 research R1: splits on `openToMarket` rather than forcing a value —
    // forcing is exactly what makes tenant-scope/multi-party-scope unable to express
    // two (or an unbounded number of) legitimate owners. A market offer must name
    // EXACTLY the raiser and no one else; a two-party record (every `ExchangeRequest`,
    // and a migrated `ExchangeOffer`) keeps the exact rule this plugin validated before
    // this change — byte-compatible with what `ExchangeRequest` saves today.
    schema.pre(
      'save',
      function (this: { isNew: boolean; partyCompanyIds?: unknown[]; openToMarket?: boolean }) {
        const actingCompanyId = resolveActingCompanyId();
        if (!actingCompanyId || !this.isNew) return;

        const parties = (this.partyCompanyIds ?? []).map((id) => String(id));
        const valid = this.openToMarket
          ? parties.length === 1 && parties[0] === actingCompanyId
          : parties.length === 2 && parties.includes(actingCompanyId);
        if (!valid) {
          throw new BadRequestException({
            error: ErrorCode.EXCHANGE_PARTY_INVALID,
            message: this.openToMarket
              ? 'A market offer must name exactly one party: the company raising it'
              : 'partyCompanyIds must name exactly two companies, including the one creating this record',
          });
        }
      },
    );
  };
}
