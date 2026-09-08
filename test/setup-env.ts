/**
 * Runs (via jest's `setupFiles`) BEFORE any test file is evaluated — critically,
 * before anything imports AppModule. @nestjs/config's ConfigModule.forRoot()
 * validates process.env synchronously the moment app.module.ts's @Module()
 * decorator runs (i.e. at import time), so placeholder-but-valid values must
 * already exist here. createTestApp() later overwrites MONGODB_URI with the
 * real MongoMemoryReplSet URI before compiling the testing module; since the
 * `configuration()` loader factory is only invoked when Nest's DI container
 * instantiates ConfigModule (during .compile()/app.init(), not at import
 * time), it picks up the corrected value — only this eager presence/format
 * check needs a placeholder.
 */
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/placeholder';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET ??= 'test-jwt-refresh-secret-0123456789abcdef';
process.env.PAYMENT_SADAD_SECRET ??= 'sadad-test-secret';
process.env.PAYMENT_MADA_SECRET ??= 'mada-test-secret';

// spec 012: these must be present BEFORE app.module.ts is imported, for the
// same reason as everything above — Joi validates process.env at import time
// and ConfigModule writes the validated result back. Anything left unset here
// is replaced by its Joi `.default()`, after which `??=` in the test factory
// can no longer fill it (the value is '' rather than undefined). Setting them
// here is what makes the CORS suite able to have an allowlist at all.
process.env.CORS_ALLOWED_ORIGINS ||= 'http://localhost:5173,https://dash.example.com';
process.env.STORAGE_DRIVER ||= 'local';
process.env.SECRETS_DRIVER ||= 'env';

// FR-015's enumeration safety is the DEFAULT, and it is what the login suites assert:
// an identical 202 for a registered and an unregistered number. `LOGIN_CODE_REVEAL_UNKNOWN_PHONE`
// turns that off deliberately, and `ConfigModule.forRoot()` reads the developer's own
// `.env` — so a flag flipped on one machine to debug a missing SMS silently changed what
// the platform was PROVEN to do everywhere else. Forced off here, with `=` rather than
// `||=`: a value inherited from `.env` is exactly what must not survive. A suite that
// wants the opt-in behaviour sets it for itself.
process.env.LOGIN_CODE_REVEAL_UNKNOWN_PHONE = 'false';

// spec 012 Story 5: pino replaces the old request-logger middleware, and its
// non-production default is `debug` — which across 53 suites would bury the
// jest reporter in per-request JSON. Silent by default, and overridable, so
// `request-logging.e2e-spec.ts` (the one suite whose subject IS the records)
// can raise it for itself.
process.env.LOG_LEVEL ||= 'silent';

// spec 012 Story 9: leases OFF for the ordinary suites.
//
// Two sweeps are now lease-guarded, and Redis is SHARED across every suite in a
// `--runInBand` run and across runs. A suite that drives a sweep directly (the
// stop-detection and presence suites both do) would otherwise be at the mercy
// of whether some earlier app still holds the lease — a 55 s TTL means one
// crashed suite could skip another's sweep entirely, failing a test for a
// reason unrelated to its subject.
//
// `multi-instance.e2e-spec.ts` turns it back ON for itself, because contention
// IS its subject.
process.env.SCHEDULER_LEASE_ENABLED ||= 'false';

// spec 015 T082: proof-of-work OFF for every suite — `0` means any nonce
// satisfies zero leading zero bits, so no suite spends CPU solving a
// challenge or becomes timing-flaky. `login-abuse.e2e-spec.ts` still
// exercises that a challenge is DEMANDED; it just never has to be solved.
process.env.LOGIN_POW_DIFFICULTY_BITS ||= '0';

// spec 013: PLATFORM_DEFAULT_COMMISSION_CEILING is `.required()` with no
// Joi default (config/validation.ts) — a real financial policy value must
// not be guessed. Every e2e suite needs a placeholder present before
// app.module.ts is imported, for the same eager-validation reason as
// everything above; the actual figure is arbitrary for tests, since
// individual commission/ceiling suites set their own per-company ceiling
// explicitly and only fall back to this when they deliberately don't.
process.env.PLATFORM_DEFAULT_COMMISSION_CEILING ||= '100000';
