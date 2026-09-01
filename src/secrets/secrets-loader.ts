import { SecretsDriver } from '../common/enums/secrets-driver.enum';

/**
 * Managed secrets — spec 012 Story 7 (FR-043 – FR-049).
 *
 * **Called before `NestFactory.create`, and that ordering IS the design**
 * (research R8). `ConfigModule.forRoot` validates `process.env` with Joi when
 * the module is constructed, so a Nest custom loader would run *after* Joi and
 * fail validation before it ever had a chance to load anything. Fetching into
 * `process.env` first means:
 *
 *   · not one line of `configuration.ts` or `validation.ts` changes; and
 *   · **Joi remains the thing that fails on an absent secret** (FR-049), so a
 *     missing secret fails in the same place, and the same way, as a missing
 *     ordinary config value — one failure mode to understand instead of two.
 *
 * Read ONCE, here (FR-044a). Nothing later re-reads a secret, so no value
 * changes inside a process's lifetime and a rotation is adopted by the rolling
 * deploy (operations-contract §3) rather than by a background refresh whose
 * timing nobody can observe.
 */
export async function loadSecrets(): Promise<void> {
  const driver = (process.env.SECRETS_DRIVER ?? SecretsDriver.ENV) as SecretsDriver;

  if (driver !== SecretsDriver.GCP) {
    // A COMPLETE no-op (FR-048). Development, the seed scripts and all 53 e2e
    // suites take their secrets straight from the environment and are untouched
    // by this feature — no stub client, no fake project, no network call, and
    // nothing to configure in order to run the tests.
    return;
  }

  // Imported lazily so the cloud SDK is never loaded — nor its transitive
  // dependencies initialised — in the `env` case, which is every test run and
  // every developer machine.
  const { fetchSecretsFromSecretManager } = await import('./secret-manager.driver');

  const manifest = parseManifest(process.env.SECRETS_MANIFEST);
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('SECRETS_DRIVER=gcp requires GCP_PROJECT_ID');
  }

  const values = await fetchSecretsFromSecretManager(projectId, manifest);
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
}

/**
 * The explicit list of names treated as secret (FR-049).
 *
 * Explicit rather than inferred — no "anything ending in _SECRET" rule. A
 * heuristic decides silently, and the failure of a heuristic here is a value
 * the platform thought it had fetched and did not.
 */
export const DEFAULT_SECRET_MANIFEST: readonly string[] = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'PAYMENT_SADAD_SECRET',
  'PAYMENT_MADA_SECRET',
  'SMS_API_KEY',
  'GOOGLE_MAPS_API_KEY',
  'MONGODB_URI',
  'REDIS_URL',
];

export function parseManifest(raw: string | undefined): string[] {
  const names = (raw ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 ? names : [...DEFAULT_SECRET_MANIFEST];
}
