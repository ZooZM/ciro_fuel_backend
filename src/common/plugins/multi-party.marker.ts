import { Schema } from 'mongoose';

const MULTI_PARTY_KEY = 'multiParty';

// Mirrors tenant-scoped.marker.ts's cast-isolation approach — Mongoose's
// SchemaOptions typing only allows known keys via schema.set()/get().
type LooseSchema = { set(key: string, value: unknown): void; get(key: string): unknown };

/**
 * Marks a schema as multi-party (spec 004 plan.md §1): the collection has
 * more than one legitimate viewer role, so it is scoped by
 * `multi-party-scope.plugin.ts` instead of the single-tenant plugin. A
 * schema must be marked with exactly one of `markTenantScoped` or
 * `markMultiParty`, never both — see `assertScopingIsUnambiguous`.
 */
export function markMultiParty(schema: Schema): void {
  (schema as unknown as LooseSchema).set(MULTI_PARTY_KEY, true);
}

export function isMultiParty(schema: Schema): boolean {
  return (schema as unknown as LooseSchema).get(MULTI_PARTY_KEY) === true;
}
