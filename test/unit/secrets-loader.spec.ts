import {
  DEFAULT_SECRET_MANIFEST,
  loadSecrets,
  parseManifest,
} from '../../src/secrets/secrets-loader';

/**
 * Spec 012 Story 7 (FR-043 – FR-049).
 *
 * The GCP driver itself is not exercised here — it needs a real project and a
 * real attached identity, and FR-045's audit-log guarantee is verifiable ONLY
 * against a live store (operations-contract §7 item 3). What is testable, and
 * what this covers, is everything that decides whether the platform starts:
 * the driver dispatch, the manifest, and the failure behaviour.
 */
describe('loadSecrets (spec 012 US7)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe('the env driver is a COMPLETE no-op (FR-048)', () => {
    it('changes nothing and contacts nothing when SECRETS_DRIVER is env', async () => {
      process.env.SECRETS_DRIVER = 'env';
      process.env.JWT_SECRET = 'from-the-environment';
      const before = JSON.stringify(process.env);

      await loadSecrets();

      // Not "loads from env" — does NOTHING. Development, the seed scripts and
      // all 53 e2e suites take their secrets straight from the environment and
      // are untouched by this feature: no stub client, no fake project, no
      // network call, nothing to configure in order to run the tests.
      expect(JSON.stringify(process.env)).toBe(before);
    });

    it('treats an ABSENT SECRETS_DRIVER as env, so an unconfigured process is unaffected', async () => {
      delete process.env.SECRETS_DRIVER;
      const before = JSON.stringify(process.env);

      await loadSecrets();

      expect(JSON.stringify(process.env)).toBe(before);
    });
  });

  describe('a failure prevents startup (FR-046)', () => {
    it('throws rather than continuing when the gcp driver has no project id', async () => {
      process.env.SECRETS_DRIVER = 'gcp';
      delete process.env.GCP_PROJECT_ID;

      // Thrown before `NestFactory.create` and caught by nothing, so the
      // process exits without binding a port. A partially-configured instance
      // never serves a request and never reports itself ready — absent, which
      // the proxy and the readiness monitor already handle, rather than present
      // and subtly wrong.
      await expect(loadSecrets()).rejects.toThrow('GCP_PROJECT_ID');
    });
  });

  describe('the manifest is EXPLICIT, never inferred (FR-049)', () => {
    it('falls back to the documented default list when unset', () => {
      expect(parseManifest(undefined)).toEqual([...DEFAULT_SECRET_MANIFEST]);
      expect(parseManifest('')).toEqual([...DEFAULT_SECRET_MANIFEST]);
    });

    it('parses a csv list, trimming and dropping empties', () => {
      expect(parseManifest(' JWT_SECRET , ,SMS_API_KEY ')).toEqual(['JWT_SECRET', 'SMS_API_KEY']);
    });

    it('names MONGODB_URI and REDIS_URL, which carry credentials and are easy to overlook', () => {
      // Neither ends in _SECRET, which is exactly why the manifest is an
      // explicit list rather than a naming heuristic: a heuristic decides
      // silently, and its failure here is a connection string the platform
      // thought it had fetched and did not.
      expect(DEFAULT_SECRET_MANIFEST).toContain('MONGODB_URI');
      expect(DEFAULT_SECRET_MANIFEST).toContain('REDIS_URL');
    });
  });

  describe('secrets are read once (FR-044a)', () => {
    it('exposes no refresh, so no value can change inside a process lifetime', async () => {
      const loader = await import('../../src/secrets/secrets-loader');
      // A rotation is adopted by the rolling deploy (operations-contract §3),
      // not by a background refresh whose timing nobody can observe. The
      // absence of a re-read path is the guarantee, so it is asserted.
      expect(Object.keys(loader).sort()).toEqual([
        'DEFAULT_SECRET_MANIFEST',
        'loadSecrets',
        'parseManifest',
      ]);
    });
  });
});
