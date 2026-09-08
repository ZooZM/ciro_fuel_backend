import { Schema } from 'mongoose';

const PROPOSAL_KEY = 'proposal';

// Mirrors party-set.marker.ts's cast-isolation approach — Mongoose's SchemaOptions
// typing only allows known keys via schema.set()/get().
type LooseSchema = { set(key: string, value: unknown): void; get(key: string): unknown };

/**
 * spec 016 (broadcast fuel exchange) research R3, `contracts/isolation-contract.md` —
 * marks a schema as proposal-scoped: readable by its own author OR by the company that
 * raised the offer it answers, a disjunction neither `tenant-scope` (one owner) nor
 * `party-set-scope` (membership in one fixed array) expresses. `ExchangeProposal` is the
 * only collection this applies to.
 */
export function markProposal(schema: Schema): void {
  (schema as unknown as LooseSchema).set(PROPOSAL_KEY, true);
}

export function isProposal(schema: Schema): boolean {
  return (schema as unknown as LooseSchema).get(PROPOSAL_KEY) === true;
}
