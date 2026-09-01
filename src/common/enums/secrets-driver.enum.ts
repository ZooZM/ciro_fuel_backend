/**
 * Where secrets come from at startup (spec 012 Story 7).
 *
 * `ENV` is a complete no-op: `process.env` is already populated, so development
 * and every test suite are untouched (FR-048). `GCP` fetches each name in the
 * manifest from Secret Manager via the VM's attached service identity and
 * writes it into `process.env` BEFORE `NestFactory.create` runs — which is why
 * `configuration.ts` and `validation.ts` need no change at all, and Joi remains
 * the thing that fails on an absent secret (FR-046/FR-049, research R8).
 */
export enum SecretsDriver {
  ENV = 'env',
  GCP = 'gcp',
}
