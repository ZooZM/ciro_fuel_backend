import { Schema, Query } from 'mongoose';
import { TenantContextService } from '../context/tenant-context.service';
import { UserRole } from '../enums/user-role.enum';
import { isProposal } from './proposal.marker';

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
 * spec 016 (broadcast fuel exchange offers) research R3, `contracts/isolation-contract.md`
 * — the fourth, deliberately narrow global isolation mechanism. Serves `ExchangeProposal`
 * alone: a document readable by its own author OR by the company that raised the offer it
 * answers. Neither existing mechanism expresses that disjunction — `tenant-scope` has one
 * owner, `multi-party-scope` narrows OTHER viewers by role, and a proposing company and a
 * raising company hold the SAME role, so role cannot discriminate them (plan.md Complexity
 * Tracking).
 *
 * `offerRaisedByCompanyId` is denormalised onto the proposal precisely so this filter
 * never needs a `$lookup` — a scope filter that requires a join is one that will
 * eventually be worked around. The disjunction below IS FR-011b: a responder's every read
 * of this collection — list, count, aggregate — is bounded to its own rows before any
 * service code runs, so a rival's price is never fetched, not merely withheld by a
 * projection.
 */
export function createProposalScopePlugin(tenantContext: TenantContextService) {
  /** `undefined` means bypass (SUPER_ADMIN or no authenticated actor); any other role
   * throws — fail closed, exactly as the other three plugins do for a role they don't
   * recognise. `!ctx?.role`, never `!ctx`: a public route carries a store for its
   * correlation id but establishes no actor (the same trap already found and fixed in
   * every other plugin). */
  function resolveActingCompanyId(): string | undefined {
    const ctx = tenantContext.getContext();
    if (!ctx?.role) {
      return undefined;
    }
    if (ctx.role === UserRole.SUPER_ADMIN) {
      return undefined;
    }
    if (ctx.role !== UserRole.FUEL_COMPANY_ADMIN) {
      throw new Error(`Proposal isolation violation: no scoping rule defined for role ${ctx.role}`);
    }
    if (!ctx.companyId) {
      throw new Error(
        'Proposal isolation violation: FUEL_COMPANY_ADMIN context is missing companyId',
      );
    }
    return ctx.companyId;
  }

  return function proposalScopePlugin(schema: Schema): void {
    if (!isProposal(schema)) {
      return;
    }

    // Fails at registration, not at first query — the same discipline
    // party-set-scope.plugin.ts applies to `partyCompanyIds`. Both fields this filter
    // reads must be indexed, or the disjunction becomes a collection scan on every
    // proposal read on the platform.
    const indexedFields = new Set(
      schema.indexes().flatMap(([fields]) => Object.keys(fields as Record<string, unknown>)),
    );
    if (!indexedFields.has('proposingCompanyId') || !indexedFields.has('offerRaisedByCompanyId')) {
      throw new Error(
        'Proposal isolation violation: schema is markProposal but is missing an index on proposingCompanyId and/or offerRaisedByCompanyId',
      );
    }

    SCOPED_QUERY_OPS.forEach((op) => {
      schema.pre(op as never, function (this: unknown) {
        const actingCompanyId = resolveActingCompanyId();
        if (!actingCompanyId) return;
        if (isQuery(this)) {
          this.where({
            $or: [
              { proposingCompanyId: actingCompanyId },
              { offerRaisedByCompanyId: actingCompanyId },
            ],
          });
        }
      });
    });
  };
}
