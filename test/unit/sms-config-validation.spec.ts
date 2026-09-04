import { validationSchema } from '../../src/config/validation';

/**
 * spec 015 US1 T034 — the Taqnyat start-up failure matrix
 * (`contracts/config-contract.md` §7). Asserts on the Joi schema directly:
 * the behaviour under test IS the refusal to boot.
 *
 * The assertion that matters most: `SMS_PROVIDER=taqnyat` with
 * `SMS_API_KEY=''` (SET BUT EMPTY) is REJECTED. That is the case a bare
 * `.min(1).required()` silently accepts — Joi keeps the base `.allow('')`
 * when merging a conditional — and it has shipped twice in this repository
 * already (`CORS_ALLOWED_ORIGINS`, `GCS_BUCKET`).
 */
describe('SMS configuration validation (spec 015 US1)', () => {
  const base = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_SECRET: '0123456789abcdef0123',
    JWT_REFRESH_SECRET: '0123456789abcdef0123',
    PLATFORM_DEFAULT_COMMISSION_CEILING: '100000',
  };
  // Everything a production boot needs BESIDES the SMS settings, so a failure
  // is unambiguously about SMS.
  const prod = {
    ...base,
    NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://dash.example.com',
    TRUSTED_PROXY_HOPS: 1,
  };

  const validate = (env: Record<string, unknown>) => validationSchema.validate(env);

  it('production + SMS_PROVIDER=none still refuses to boot (existing rule, must remain)', () => {
    const { error } = validate({ ...prod, SMS_PROVIDER: 'none' });
    expect(error).toBeDefined();
    expect(error?.message).toContain('SMS_PROVIDER');
  });

  it('production + taqnyat + SMS_API_KEY unset → fails, naming SMS_API_KEY', () => {
    const { error } = validate({ ...prod, SMS_PROVIDER: 'taqnyat', SMS_SENDER_ID: 'ciro' });
    expect(error).toBeDefined();
    expect(error?.message).toContain('SMS_API_KEY');
  });

  it('production + taqnyat + SMS_API_KEY="" (set but empty) → REJECTED (the .invalid("") case)', () => {
    const { error } = validate({
      ...prod,
      SMS_PROVIDER: 'taqnyat',
      SMS_API_KEY: '',
      SMS_SENDER_ID: 'ciro',
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('SMS_API_KEY');
  });

  it('production + taqnyat + SMS_SENDER_ID unset → fails, naming SMS_SENDER_ID', () => {
    const { error } = validate({ ...prod, SMS_PROVIDER: 'taqnyat', SMS_API_KEY: 'real-token' });
    expect(error).toBeDefined();
    expect(error?.message).toContain('SMS_SENDER_ID');
  });

  it('production + taqnyat + SMS_SENDER_ID="" → REJECTED', () => {
    const { error } = validate({
      ...prod,
      SMS_PROVIDER: 'taqnyat',
      SMS_API_KEY: 'real-token',
      SMS_SENDER_ID: '',
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('SMS_SENDER_ID');
  });

  it('production + taqnyat + both set → starts', () => {
    const { error } = validate({
      ...prod,
      SMS_PROVIDER: 'taqnyat',
      SMS_API_KEY: 'real-token',
      SMS_SENDER_ID: 'ciro',
    });
    expect(error).toBeUndefined();
  });

  it('development / test + SMS_PROVIDER=none + nothing set → starts (unchanged)', () => {
    const { error } = validate({ ...base, NODE_ENV: 'test' });
    expect(error).toBeUndefined();
    const dev = validate({ ...base, NODE_ENV: 'development' });
    expect(dev.error).toBeUndefined();
  });

  it('development + taqnyat + both blank → fails (the conditional keys on SMS_PROVIDER, not NODE_ENV)', () => {
    const { error } = validate({
      ...base,
      NODE_ENV: 'development',
      SMS_PROVIDER: 'taqnyat',
      SMS_API_KEY: '',
      SMS_SENDER_ID: '',
    });
    expect(error).toBeDefined();
  });

  it('the two conditionals do NOT apply for any non-taqnyat provider', () => {
    // e.g. the default 'none' in every e2e suite: SMS_API_KEY / SMS_SENDER_ID
    // stay optional and empty-permitting, so nothing about the test
    // environment changes (T039).
    const { error, value } = validate({ ...base, SMS_PROVIDER: 'none' });
    expect(error).toBeUndefined();
    expect(value.SMS_API_KEY).toBe('');
    expect(value.SMS_SENDER_ID).toBe('');
  });
});
