import { Schema, Query, Aggregate, Types } from 'mongoose';
import { TenantContextService } from '../context/tenant-context.service';
import { UserRole } from '../enums/user-role.enum';
import { isMultiParty } from './multi-party.marker';

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
 * Global, DB-layer isolation for collections with more than one legitimate
 * viewer role (spec 004 plan.md §1) — orders and invoices, where a single
 * record is visible to a Fuel Company, a Transportation Company, a client
 * and a driver, each in a different tenant. `tenant-scope.plugin.ts`'s
 * single fixed-equality `companyId` filter cannot express that, so this is
 * a second, parallel global mechanism for that second category of
 * collection — see plan.md's Complexity Tracking for why a second plugin
 * is the accepted departure rather than a schema-shape workaround.
 *
 * Every non-CIRO role's injected filter carries `fuelCompanyId`, with no
 * exception — this is what keeps the mechanism a strict generalization of
 * the existing plugin rather than a weaker replacement for it. CLIENT and
 * DRIVER filters narrow *within* that tenant boundary; they never rely on a
 * bare user id alone to stand in for it.
 */
export function createMultiPartyScopePlugin(tenantContext: TenantContextService) {
  /**
   * The Fuel Company that owns whatever the acting user belongs to.
   *
   * FUEL_COMPANY_ADMIN and CLIENT always belong to a Fuel Company directly,
   * so their own `companyId` IS the fuelCompanyId.
   *
   * TRANSPORT_COMPANY_ADMIN's own `companyId` names the Transportation
   * Company they belong to — by construction, never a Fuel Company — so it
   * must NEVER be used as a fuelCompanyId. `parentFuelCompanyId` (resolved
   * once per request, `UsersService.validateActiveSessionWithScoping`) is
   * mandatory for this role; a missing one fails closed rather than
   * silently scoping by the transport company's own id.
   *
   * DRIVER is the one role that can genuinely be either today: pre-migration
   * a driver still belongs directly to a Fuel Company (`parentFuelCompanyId`
   * correctly resolves to undefined, so `companyId` is used); once assigned
   * to a Transportation Company, `parentFuelCompanyId` takes over. Both are
   * correct outcomes for this role, so — and only for this role — falling
   * back to `companyId` is intentional, not a gap-filler.
   */
  function resolveFuelCompanyId(): string | undefined {
    const ctx = tenantContext.getContext();
    if (!ctx?.role) {
      // No AUTHENTICATED actor — bypass. Two distinct situations reach here
      // and both must:
      //   · a script, seed or test running entirely outside a request (no
      //     store at all), which is what this check has always covered; and
      //   · since spec 012, a PUBLIC route (login, refresh, the payment
      //     webhook), which now DOES have a store because it carries a
      //     correlation id (FR-029) but establishes no actor.
      //
      // Testing `!ctx` alone would have been correct until spec 012 and
      // silently wrong afterwards: the anonymous store would fall through to
      // the non-SUPER_ADMIN branch below and throw "missing companyId" on
      // every login attempt. `role` is the discriminator because a genuine
      // authenticated context always carries one.
      return undefined;
    }
    if (ctx.role === UserRole.SUPER_ADMIN) {
      return undefined; // CIRO — explicit global bypass, same as the tenant plugin.
    }

    if (ctx.role === UserRole.TRANSPORT_COMPANY_ADMIN) {
      if (!ctx.parentFuelCompanyId) {
        throw new Error(
          'Multi-party isolation violation: TRANSPORT_COMPANY_ADMIN context is missing parentFuelCompanyId',
        );
      }
      return ctx.parentFuelCompanyId;
    }

    const fuelCompanyId = ctx.parentFuelCompanyId ?? ctx.companyId;
    if (!fuelCompanyId) {
      throw new Error(
        'Multi-party isolation violation: authenticated non-SUPER_ADMIN context is missing a resolvable fuelCompanyId',
      );
    }
    return fuelCompanyId;
  }

  /** The full role-derived filter (plan.md §1's table), or `undefined` for a
   * bypass (CIRO / no context). Never partially built — either every
   * predicate the role requires is present, or this throws. */
  function resolveFilter(): Record<string, string> | undefined {
    const ctx = tenantContext.getContext();
    const fuelCompanyId = resolveFuelCompanyId();
    if (!ctx || fuelCompanyId === undefined) {
      return undefined;
    }

    // A context that reaches here has a role (`resolveFuelCompanyId` returns
    // undefined otherwise, which is the bypass above), so it must also have a
    // userId — the two are established together, from one token. Since spec 012
    // the stored shape allows either to be absent independently, so this states
    // the invariant instead of assuming it: the CLIENT and DRIVER filters below
    // are BUILT from `userId`, and an undefined one would scope those roles to
    // `{ clientId: undefined }` — a filter Mongo reads as "clientId does not
    // exist", which matches other tenants' orders rather than none. Fail closed.
    if (!ctx.userId) {
      throw new Error(
        'Multi-party isolation violation: context has a role but no userId',
      );
    }

    switch (ctx.role) {
      case UserRole.FUEL_COMPANY_ADMIN:
        return { fuelCompanyId };
      case UserRole.TRANSPORT_COMPANY_ADMIN:
        if (!ctx.companyId) {
          throw new Error(
            'Multi-party isolation violation: TRANSPORT_COMPANY_ADMIN context is missing companyId',
          );
        }
        return { fuelCompanyId, transportCompanyId: ctx.companyId };
      case UserRole.CLIENT:
        return { fuelCompanyId, clientId: ctx.userId };
      case UserRole.DRIVER:
        return { fuelCompanyId, driverId: ctx.userId };
      default:
        // A role with no defined filter (e.g. a future role added without
        // updating this switch) fails closed rather than querying unscoped.
        throw new Error(
          `Multi-party isolation violation: no scoping rule defined for role ${ctx.role}`,
        );
    }
  }

  return function multiPartyScopePlugin(schema: Schema): void {
    if (!isMultiParty(schema)) {
      return;
    }

    SCOPED_QUERY_OPS.forEach((op) => {
      schema.pre(op as never, function (this: unknown) {
        const filter = resolveFilter();
        if (!filter) return;
        if (isQuery(this)) {
          this.where(filter);
        }
      });
    });

    // Only the owning tenant (fuelCompanyId) is forced on create — mirroring
    // tenant-scope.plugin.ts exactly. clientId/transportCompanyId/driverId
    // are set by application logic at their own lifecycle points (order
    // creation, routing, assignment) by whichever actor legitimately sets
    // them; forcing them here would be wrong for e.g. a FUEL_COMPANY_ADMIN
    // approving an order they did not create.
    schema.pre('save', function (this: { isNew: boolean; fuelCompanyId?: unknown }) {
      const fuelCompanyId = resolveFuelCompanyId();
      if (!fuelCompanyId) return;
      if (this.isNew) {
        this.fuelCompanyId = fuelCompanyId;
      }
    });

    schema.pre(
      'insertMany',
      function (next: (err?: Error) => void, docs: Array<Record<string, unknown>>) {
        try {
          const fuelCompanyId = resolveFuelCompanyId();
          if (fuelCompanyId && Array.isArray(docs)) {
            const fuelCompanyObjectId = new Types.ObjectId(fuelCompanyId);
            docs.forEach((doc) => {
              doc.fuelCompanyId = fuelCompanyObjectId;
            });
          }
          next();
        } catch (err) {
          next(err as Error);
        }
      },
    );

    schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
      const filter = resolveFilter();
      if (!filter) return;

      // Unlike find()/updateOne()/etc, aggregate $match stages get NO
      // automatic schema-based casting — a raw string would silently match
      // nothing against an ObjectId field (fail-open, not fail-closed).
      const castFilter = Object.fromEntries(
        Object.entries(filter).map(([key, value]) => [key, new Types.ObjectId(value)]),
      );
      const matchStage = { $match: castFilter };

      const pipeline = this.pipeline();
      const geoNearIndex = pipeline.findIndex(
        (stage) => typeof stage === 'object' && stage !== null && '$geoNear' in stage,
      );

      if (geoNearIndex !== -1) {
        // $geoNear must remain the pipeline's first stage — Mongo requirement.
        pipeline.splice(geoNearIndex + 1, 0, matchStage);
      } else {
        pipeline.unshift(matchStage);
      }
    });
  };
}
