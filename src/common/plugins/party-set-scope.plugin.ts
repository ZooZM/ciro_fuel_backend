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
 * spec 013 T210/research R3, `contracts/isolation-contract.md` — the third, deliberately
 * narrow global isolation mechanism. Serves `ExchangeRequest` alone: a record owned by an
 * ARRAY of companies, which neither `tenant-scope.plugin.ts` (one owner, forced on
 * create) nor `multi-party-scope.plugin.ts` (one owner plus role-narrowed OTHER viewers,
 * still forced on create) can express. See the contract's comparison table for why a
 * third mechanism, rather than bending either existing one, is the accepted departure.
 *
 * The failure this prevents, if `ExchangeRequest` were marked `multiParty` instead: Company
 * A raises a request (`pre('save')` forces `fuelCompanyId = A`), Company B lists incoming
 * (`{ fuelCompanyId: B }`) and sees nothing — silently, permanently, with `SUPER_ADMIN`'s
 * bypass making the operator's own screen look correct throughout. Only a two-company test
 * asserting the RECIPIENT can read it catches this (T215's non-negotiable first case).
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
          // Array membership, not equality — this is the whole point of the mechanism
          // (contract's comparison table).
          this.where({ partyCompanyIds: actingCompanyId });
        }
      });
    });

    // T212 — VALIDATES membership rather than forcing a value. Forcing is exactly what
    // makes the other two plugins unable to express two legitimate owners; application
    // code (`FuelExchangeService.create`) sets `partyCompanyIds` itself from validated
    // input, and this is the structural backstop that a party-set document can never be
    // saved with the acting company absent from its own parties, or with a party count
    // the domain never defined (exchange is always exactly two).
    schema.pre('save', function (this: { isNew: boolean; partyCompanyIds?: unknown[] }) {
      const actingCompanyId = resolveActingCompanyId();
      if (!actingCompanyId || !this.isNew) return;

      const parties = (this.partyCompanyIds ?? []).map((id) => String(id));
      if (parties.length !== 2 || !parties.includes(actingCompanyId)) {
        throw new BadRequestException({
          error: ErrorCode.EXCHANGE_PARTY_INVALID,
          message: 'partyCompanyIds must name exactly two companies, including the one creating this record',
        });
      }
    });
  };
}
