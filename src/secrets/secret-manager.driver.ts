import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

/**
 * Fetches each manifest name from the managed secret store — spec 012 FR-043.
 *
 * **No key file.** The client is constructed with no credentials argument, so
 * it authenticates through the VM's attached service identity via the metadata
 * server. There is therefore no credential in any image, snapshot, backup or
 * environment variable: nothing to leak, and nothing to rotate. A key file
 * would reintroduce exactly the exposure this story exists to remove.
 *
 * Reads are recorded by the store's own audit logging (FR-045), which the
 * platform neither writes nor can alter — which is the point, and also why
 * FR-045 is verifiable only against a real project (operations-contract §7
 * item 3) rather than by a test here.
 */
export async function fetchSecretsFromSecretManager(
  projectId: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const client = new SecretManagerServiceClient();

  try {
    const entries = await Promise.all(
      names.map(async (name) => {
        // `latest` rather than a pinned version: rotation adds a version, and
        // the rolling deploy is what adopts it (FR-044). Pinning here would
        // make every rotation a code change.
        const [version] = await client.accessSecretVersion({
          name: `projects/${projectId}/secrets/${name}/versions/latest`,
        });
        const value = version.payload?.data?.toString();
        if (!value) {
          // An EMPTY secret is a failure, not a value. Letting '' through would
          // start the platform with, say, an empty token-signing key — which
          // Joi's `.min(1)` would then reject anyway, but with a message about
          // configuration rather than about the secret store.
          throw new Error(`Secret ${name} resolved to an empty value`);
        }
        return [name, value] as const;
      }),
    );
    return Object.fromEntries(entries);
  } catch (err) {
    // THROWN, and deliberately not caught anywhere upstream (FR-046): this runs
    // before `NestFactory.create`, so the process exits without ever binding a
    // port. A partially-configured instance never serves a request and never
    // reports itself ready — it is absent, which the proxy and the readiness
    // monitor both already handle, rather than present and subtly wrong.
    //
    // The secret NAME is included and no value ever is.
    throw new Error(
      `Failed to load secrets from Secret Manager (project ${projectId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
