import { validationSchema } from '../../src/config/validation';

/**
 * Spec 012 — boot-time configuration guards.
 *
 * These assert on the Joi schema directly rather than by booting an app: the
 * behaviour under test IS the refusal to boot, so there is nothing to boot.
 */
describe('Configuration validation (spec 012)', () => {
  const base = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_SECRET: '0123456789abcdef0123',
    JWT_REFRESH_SECRET: '0123456789abcdef0123',
  };

  const validate = (env: Record<string, unknown>) => validationSchema.validate(env);

  describe('CORS_ALLOWED_ORIGINS (FR-018)', () => {
    it('REFUSES TO START in production when no origin is configured', () => {
      // This is the whole point: starting with browser access silently broken
      // presents as an authentication failure and gets diagnosed as one. A
      // loud refusal at boot is far cheaper than that investigation.
      const { error } = validate({ ...base, NODE_ENV: 'production', SMS_PROVIDER: 'unifonic' });

      expect(error).toBeDefined();
      expect(error?.message).toContain('CORS_ALLOWED_ORIGINS');
    });

    it('starts in production when an origin IS configured', () => {
      const { error } = validate({
        ...base,
        NODE_ENV: 'production',
        SMS_PROVIDER: 'unifonic',
        CORS_ALLOWED_ORIGINS: 'https://dash.example.com',
        TRUSTED_PROXY_HOPS: 1,
      });

      expect(error).toBeUndefined();
    });

    it('permits an empty allowlist outside production, so local development is unblocked', () => {
      const { error } = validate({ ...base, NODE_ENV: 'development' });

      expect(error).toBeUndefined();
    });
  });

  describe('TRUSTED_PROXY_HOPS (FR-022)', () => {
    it('has NO default — an unset value must not silently become 1', () => {
      // 1 is right when nginx is the only proxy and wrong when a load balancer
      // fronts it, in which case every request on the platform is attributed to
      // the load balancer, with no error and no symptom. The topology is a
      // deployment fact (FR-007d), so the schema refuses to guess.
      const { value } = validate({ ...base, NODE_ENV: 'development' });

      expect(value.TRUSTED_PROXY_HOPS).toBeUndefined();
    });

    it('accepts an explicit hop count', () => {
      const { error, value } = validate({ ...base, TRUSTED_PROXY_HOPS: 2 });

      expect(error).toBeUndefined();
      expect(value.TRUSTED_PROXY_HOPS).toBe(2);
    });
  });

  describe('storage driver (FR-042)', () => {
    it('defaults to the local driver, so tests and development need no bucket', () => {
      const { value } = validate({ ...base });

      expect(value.STORAGE_DRIVER).toBe('local');
    });

    it('requires a bucket name once the gcs driver is selected', () => {
      const { error } = validate({ ...base, STORAGE_DRIVER: 'gcs' });

      expect(error).toBeDefined();
      expect(error?.message).toContain('GCS_BUCKET');
    });

    it('rejects a driver name that is neither', () => {
      const { error } = validate({ ...base, STORAGE_DRIVER: 's3' });

      expect(error).toBeDefined();
    });
  });

  describe('secrets driver (FR-046, FR-048)', () => {
    it('defaults to env, a complete no-op that leaves development untouched', () => {
      const { value } = validate({ ...base });

      expect(value.SECRETS_DRIVER).toBe('env');
    });

    it('requires a project id once the managed store is selected', () => {
      const { error } = validate({ ...base, SECRETS_DRIVER: 'gcp' });

      expect(error).toBeDefined();
      expect(error?.message).toContain('GCP_PROJECT_ID');
    });
  });

  describe('database resilience defaults (FR-050, FR-051, FR-054)', () => {
    it('applies explicit pool bounds and timeouts', () => {
      const { value } = validate({ ...base });

      expect(value.MONGO_MAX_POOL_SIZE).toBe(20);
      expect(value.MONGO_SERVER_SELECTION_TIMEOUT_MS).toBe(5000);
      expect(value.MONGO_WAIT_QUEUE_TIMEOUT_MS).toBe(10000);
    });

    it('keeps the socket timeout above the longest legitimate transaction', () => {
      // Set below a real dispatch or payment-webhook transaction, this
      // resilience work would become a data-integrity bug: a commit cut off
      // mid-flight (FR-054).
      const { value } = validate({ ...base });

      expect(value.MONGO_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    });
  });

  describe('scheduler lease (FR-056b, FR-058)', () => {
    it('expires below the sweep interval so a dead holder does not stall the schedule', () => {
      const { value } = validate({ ...base });

      expect(value.SCHEDULER_LEASE_TTL_MS).toBeLessThan(
        value.STOP_DETECTION_SWEEP_SECONDS * 1000 + 1,
      );
      expect(value.SCHEDULER_LEASE_TTL_MS).toBeGreaterThan(0);
    });
  });
});
