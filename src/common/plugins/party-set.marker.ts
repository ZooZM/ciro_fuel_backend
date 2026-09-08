import { Schema } from 'mongoose';

const PARTY_SET_KEY = 'partySet';

// Mirrors tenant-scoped.marker.ts / multi-party.marker.ts's cast-isolation approach —
// Mongoose's SchemaOptions typing only allows known keys via schema.set()/get().
type LooseSchema = { set(key: string, value: unknown): void; get(key: string): unknown };

/**
 * spec 014 T209/research R3, `contracts/isolation-contract.md` — marks a schema as
 * party-set: the record is owned by an ARRAY of companies, not one (`tenant-scope
 * .plugin.ts`) and not one-plus-role-narrowed-others (`multi-party-scope.plugin.ts`).
 * `ExchangeRequest` is the only collection this applies to in this feature — see the
 * contract's own "Scope" section for why this stays narrow rather than generalising.
 */
export function markPartySet(schema: Schema): void {
  (schema as unknown as LooseSchema).set(PARTY_SET_KEY, true);
}

export function isPartySet(schema: Schema): boolean {
  return (schema as unknown as LooseSchema).get(PARTY_SET_KEY) === true;
}
