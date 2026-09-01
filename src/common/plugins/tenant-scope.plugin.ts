import { Schema, Query, Aggregate, Types } from 'mongoose';
import { TenantContextService } from '../context/tenant-context.service';
import { UserRole } from '../enums/user-role.enum';
import { isTenantScoped } from './tenant-scoped.marker';

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
 * Global, DB-layer tenant isolation (FR-002). Applied to every connection via
 * `connection.plugin(...)` (see app.module.ts), it only activates for schemas
 * that explicitly opt in with `schema.set('tenantScoped', true)`.
 *
 * The enforced companyId always WINS over anything a caller supplied (DTOs
 * forbid the field, but this is the backstop): we unconditionally overwrite
 * the filter/document/pipeline rather than merely filling a gap, so isolation
 * cannot be bypassed by smuggling a foreign companyId through.
 *
 * SUPER_ADMIN requests carry no companyId in context and are the only role
 * exempt from scoping (global platform oversight). A scoped role with a
 * missing companyId indicates a corrupt/forged token — the plugin fails
 * closed (throws) rather than silently running an unscoped query.
 */
export function createTenantScopePlugin(tenantContext: TenantContextService) {
  return function tenantScopePlugin(schema: Schema): void {
    if (!isTenantScoped(schema)) {
      return;
    }

    const resolveCompanyId = (): string | undefined => {
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
        return undefined; // explicit global bypass
      }
      if (!ctx.companyId) {
        throw new Error(
          'Tenant isolation violation: authenticated non-SUPER_ADMIN context is missing companyId',
        );
      }
      return ctx.companyId;
    };

    SCOPED_QUERY_OPS.forEach((op) => {
      schema.pre(op as never, function (this: unknown) {
        const companyId = resolveCompanyId();
        if (!companyId) return;
        if (isQuery(this)) {
          this.where({ companyId });
        }
      });
    });

    schema.pre('save', function (this: { isNew: boolean; companyId?: unknown }) {
      const companyId = resolveCompanyId();
      if (!companyId) return;
      if (this.isNew) {
        this.companyId = companyId;
      }
    });

    schema.pre(
      'insertMany',
      function (next: (err?: Error) => void, docs: Array<Record<string, unknown>>) {
        try {
          const companyId = resolveCompanyId();
          if (companyId && Array.isArray(docs)) {
            const companyObjectId = new Types.ObjectId(companyId);
            docs.forEach((doc) => {
              doc.companyId = companyObjectId;
            });
          }
          next();
        } catch (err) {
          next(err as Error);
        }
      },
    );

    schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
      const companyId = resolveCompanyId();
      if (!companyId) return;

      const pipeline = this.pipeline();
      // Unlike find()/updateOne()/etc, aggregate $match stages get NO automatic
      // schema-based casting — a raw string would silently match nothing against
      // an ObjectId field, which is a fail-*open* (empty result, not an error) bug.
      const matchStage = { $match: { companyId: new Types.ObjectId(companyId) } };
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
