import { Schema } from 'mongoose';

const TENANT_SCOPED_KEY = 'tenantScoped';

// Mongoose's SchemaOptions typing only allows known keys via schema.set()/get();
// this isolates the one necessary cast so call sites elsewhere stay clean.
type LooseSchema = { set(key: string, value: unknown): void; get(key: string): unknown };

export function markTenantScoped(schema: Schema): void {
  (schema as unknown as LooseSchema).set(TENANT_SCOPED_KEY, true);
}

export function isTenantScoped(schema: Schema): boolean {
  return (schema as unknown as LooseSchema).get(TENANT_SCOPED_KEY) === true;
}
