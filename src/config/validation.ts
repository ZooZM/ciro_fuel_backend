import * as Joi from 'joi';
import { E164_PATTERN } from '../common/constants/phone';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  MONGODB_URI: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(16).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
  PAYMENT_SADAD_SECRET: Joi.string().allow('').default(''),
  PAYMENT_MADA_SECRET: Joi.string().allow('').default(''),
  PAYMENT_DEADLINE_MINUTES: Joi.number().default(30),
  OTP_EXPIRY_MINUTES: Joi.number().default(30),
  STORAGE_DIR: Joi.string().default('sys_storge'),
  MAX_FILE_SIZE_BYTES: Joi.number().default(10 * 1024 * 1024),
  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),
  PRESENCE_OFFLINE_MINUTES: Joi.number().default(6),
  PRESENCE_SWEEP_SECONDS: Joi.number().default(60),
  TRACKING_DISPLACEMENT_METERS: Joi.number().default(50),
  TRACKING_HEARTBEAT_MINUTES: Joi.number().default(3),
  SUPER_ADMIN_EMAIL: Joi.string().email().optional(),
  SUPER_ADMIN_PASSWORD: Joi.string().min(8).optional(),
  SUPER_ADMIN_FULL_NAME: Joi.string().optional(),
  // spec 015 R5 — an administrator's phone is now a login identifier, so the
  // seeded SUPER_ADMIN can no longer carry the literal 'N/A'. Optional in the
  // schema (the app boots without seeding); `scripts/seed-super-admin.ts`
  // fails loudly if it is absent or not E.164 when it actually runs.
  SUPER_ADMIN_PHONE: Joi.string().pattern(E164_PATTERN).optional(),
  // Straight-line distance ÷ average speed (spec 004 FR-029, plan.md §5) —
  // an honest approximation, not a routed ETA.
  ORDER_AVERAGE_SPEED_KMH: Joi.number().positive().default(60),
  ORDER_QUOTE_EXPIRY_MINUTES: Joi.number().positive().default(10),
  // Reverse-geocoding at client registration only (spec 004 FR-011); optional
  // because its absence must never block account creation (FR-013).
  GOOGLE_MAPS_API_KEY: Joi.string().allow('').default(''),
  // 'none' is the development no-op SMS sender (spec 005 research R4) — it
  // must be impossible to select in production, or the first production
  // phone-verification code silently never gets sent.
  SMS_PROVIDER: Joi.string()
    .valid('none', 'taqnyat', 'unifonic', 'twilio')
    .default('none')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('none').required(),
    }),
  // The provider's bearer token. Kept under the existing SMS_API_KEY name
  // rather than a provider-specific one: it is already in the secrets
  // manifest, so a new name would mean a new secret, a new IAM binding and a
  // manifest change to express the same thing.
  //
  // spec 015 R6 — conditionally REQUIRED when SMS_PROVIDER=taqnyat, or a
  // production deployment starts "configured for Taqnyat" with a blank token
  // and every SMS then fails against an unauthenticated provider (FR-003).
  // `.invalid('')` in the `then` branch is NOT redundant with `.min(1)`:
  // Joi keeps the base schema's `.allow('')` when it merges the conditional
  // one, and an explicitly-permitted value short-circuits every other rule —
  // so `.min(1).required()` alone is silently satisfied by an empty string.
  // This exact defect shipped twice here (CORS_ALLOWED_ORIGINS, GCS_BUCKET),
  // both commented above. Conditioned on the PROVIDER, not NODE_ENV, so a
  // developer pointing at the real provider is told immediately.
  SMS_API_KEY: Joi.string()
    .allow('')
    .default('')
    .when('SMS_PROVIDER', { is: 'taqnyat', then: Joi.string().min(1).invalid('').required() }),
  SMS_ENDPOINT_URL: Joi.string().uri().default('https://api.taqnyat.sa/v1/messages'),
  SMS_SENDER_ID: Joi.string()
    .allow('')
    .default('')
    .when('SMS_PROVIDER', { is: 'taqnyat', then: Joi.string().min(1).invalid('').required() }),
  // spec 006 (driver auth & session) — defaults per spec.md Assumptions.
  PASSWORD_RESET_EXPIRY_MINUTES: Joi.number().default(5),
  PASSWORD_RESET_MAX_ATTEMPTS: Joi.number().default(5),
  PASSWORD_RESET_MAX_REQUESTS: Joi.number().default(3),
  PASSWORD_RESET_WINDOW_MINUTES: Joi.number().default(15),
  // spec 007 (driver home & active delivery) — the day boundary for a
  // driver's daily delivery count (FR-033). An IANA zone name, not an
  // offset, so it stays correct across DST where applicable.
  PLATFORM_DAY_BOUNDARY_TIMEZONE: Joi.string().default('Asia/Riyadh'),
  // spec 008 FR-030b — the loading-stage geofence radius, in meters. Sized
  // for a depot yard plus civilian GPS error, not for a doorway.
  WAREHOUSE_GEOFENCE_RADIUS_METERS: Joi.number().min(1).default(500),
  // spec 010 FR-012 — how long an assignment can go unacknowledged before the
  // SMS fallback fires. Short by design (see configuration.ts's own comment).
  ASSIGNMENT_ACK_WINDOW_MINUTES: Joi.number().min(1).default(3),
  // spec 010 FR-013a — the BullMQ worker's own `limiter` cap: at most `_MAX`
  // escalation SMS sends per `_DURATION_MS` window; excess jobs queue rather
  // than being dropped or sent in an uncapped burst.
  ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_MAX: Joi.number().min(1).default(20),
  ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_DURATION_MS: Joi.number().min(1000).default(60000),
  // spec 011 FR-001 — how long a truck may sit still during the in-transit
  // leg before the driver is asked why. 10 minutes matches the wording the
  // transport dashboard's own alert has always used.
  STOP_DETECTION_WINDOW_MINUTES: Joi.number().min(1).default(10),
  // spec 011 FR-003 — what counts as having moved. Defaults to the same 50 m
  // the tracking stream already uses to decide a position is worth
  // recording (research R2); a different value here would let the platform
  // call one driver both moving and stopped at the same moment.
  STOP_DETECTION_MOVEMENT_METERS: Joi.number().min(1).default(50),
  // spec 011 FR-009 — how long the driver has to answer before the
  // transporter is told. Deliberately shorter than the stop window: the
  // point is to reach a person quickly once someone has already been silent
  // for ten minutes, not to add another long wait on top.
  STOP_RESPONSE_WINDOW_MINUTES: Joi.number().min(1).default(5),
  // spec 011 — how often the detection sweep runs. Matches PresenceService's
  // own 60s cadence; overridable so tests need not wait a real minute.
  STOP_DETECTION_SWEEP_SECONDS: Joi.number().min(1).default(60),

  // ── spec 012 (production hardening) ──────────────────────────────────────
  // Operational only: none of these changes what the platform does.

  // Story 1 — health. The per-indicator bound must be short enough that a slow
  // dependency resolves as *down* rather than leaving the probe outstanding: a
  // readiness endpoint that hangs is indistinguishable, to a proxy, from an
  // instance that has failed (FR-006).
  HEALTH_TIMEOUT_MS: Joi.number().min(100).default(1000),
  INSTANCE_ID: Joi.string().allow('').default(''),
  READINESS_POLL_INTERVAL_SECONDS: Joi.number().min(1).default(10),
  READINESS_FAILURE_THRESHOLD: Joi.number().min(1).default(3),
  READINESS_RECOVERY_THRESHOLD: Joi.number().min(1).default(3),

  // Story 2 — must exceed the proxy's health-check interval, or new traffic
  // still arrives while the instance is draining (FR-012).
  SHUTDOWN_DRAIN_MS: Joi.number().min(1000).default(30000),

  // Story 3 — REQUIRED in production (FR-018). Without this the service starts
  // happily and every browser request is refused, which presents as an
  // authentication failure and gets diagnosed as one. Refusing to start is the
  // louder, cheaper failure. Same `.when` idiom as SMS_PROVIDER above.
  // `.invalid('')` in the `then` branch is NOT redundant with `.min(1)`.
  // Joi keeps the base schema's `.allow('')` when it merges the conditional
  // one, and an explicitly-permitted value short-circuits every other rule —
  // so `CORS_ALLOWED_ORIGINS=` (set but empty) was ACCEPTED in production,
  // producing exactly the outcome this requirement exists to prevent: an empty
  // allowlist matches nothing, every browser request is refused, and it
  // presents as an authentication failure. `.invalid('')` moves the empty
  // string out of the permitted set so `.required()` is meaningful again.
  // Found by walking quickstart Part 1 against a real server.
  CORS_ALLOWED_ORIGINS: Joi.string()
    .allow('')
    .default('')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().min(1).invalid('').required(),
    }),

  // Story 4 — deliberately NO `.default()`. 1 if nginx is the only proxy, 2 if
  // a managed load balancer fronts it; which holds is a deployment fact
  // (FR-007d), not a guess. Defaulting to 1 where there are 2 attributes every
  // request on the platform to the load balancer, producing no error and no
  // symptom — the same undifferentiated-origin failure Story 4 exists to fix.
  TRUSTED_PROXY_HOPS: Joi.number().min(0).optional(),

  // Story 5 — collected volume is billable, so verbosity is load-bearing
  // (FR-035). `pretty` is dev-only: production must stay newline-delimited
  // JSON or the agent cannot preserve fields.
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .optional(),
  LOG_PRETTY: Joi.boolean().default(false),

  // Story 6 — `local` keeps development and all 53 e2e suites free of cloud
  // dependencies (FR-042). GCS_BUCKET is required only when the gcs driver is
  // selected, so a local run never needs a bucket name.
  STORAGE_DRIVER: Joi.string().valid('local', 'gcs').default('local'),
  // `.invalid('')` for the same reason as CORS_ALLOWED_ORIGINS above: without
  // it, `GCS_BUCKET=` with the gcs driver starts the platform and every upload
  // then fails against an unnamed bucket.
  GCS_BUCKET: Joi.string()
    .allow('')
    .default('')
    .when('STORAGE_DRIVER', { is: 'gcs', then: Joi.string().min(1).invalid('').required() }),
  SIGNED_URL_TTL_SECONDS: Joi.number().min(30).max(3600).default(300),
  LOCAL_STORAGE_TOKEN_TTL_SECONDS: Joi.number().min(30).max(3600).default(300),
  LOCAL_STORAGE_TOKEN_SECRET: Joi.string().allow('').default(''),

  // Story 7 — `env` is a complete no-op, so development and tests are
  // untouched (FR-048). A missing required secret still fails HERE, in Joi,
  // exactly as a missing config value does, because the loader populates
  // process.env before Nest boots (FR-049).
  SECRETS_DRIVER: Joi.string().valid('env', 'gcp').default('env'),
  // Same hole, and the worst of the three: an empty project id with the gcp
  // driver would reach `loadSecrets`, which throws — but only after the
  // process has already been reported as configured.
  GCP_PROJECT_ID: Joi.string()
    .allow('')
    .default('')
    .when('SECRETS_DRIVER', { is: 'gcp', then: Joi.string().min(1).invalid('').required() }),
  SECRETS_MANIFEST: Joi.string().allow('').default(''),

  // Story 8 — explicit pool bounds and timeouts so a brief interruption fails
  // fast and recovers, rather than piling requests up (FR-050/FR-051).
  MONGO_MAX_POOL_SIZE: Joi.number().min(1).default(20),
  MONGO_MIN_POOL_SIZE: Joi.number().min(0).default(2),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: Joi.number().min(500).default(5000),
  MONGO_CONNECT_TIMEOUT_MS: Joi.number().min(500).default(10000),
  // Must exceed the longest legitimate transaction, or a timeout mid-commit
  // turns resilience work into a data-integrity bug (FR-054).
  MONGO_SOCKET_TIMEOUT_MS: Joi.number().min(1000).default(45000),
  MONGO_WAIT_QUEUE_TIMEOUT_MS: Joi.number().min(500).default(10000),

  // Story 9 — above the measured p99 sweep duration, below the sweep interval,
  // so a dead holder's lease expires before the next tick (FR-056b/FR-058).
  SCHEDULER_LEASE_TTL_MS: Joi.number().min(1000).default(55000),
  SCHEDULER_LEASE_ENABLED: Joi.boolean().default(true),

  // spec 013 (fuel company admin dashboard) FR-062b — deliberately
  // `.required()` with NO `.default()`. Unlike CORS_ALLOWED_ORIGINS/
  // GCS_BUCKET (feature 012 findings: a silently-defaulted `''` shipped
  // broken twice), this is a real financial policy value with no safe
  // guess — an absent value must fail at boot, not surface as an
  // unexplained ceiling the first time a company accrues commission.
  PLATFORM_DEFAULT_COMMISSION_CEILING: Joi.number().positive().required(),

  // ── spec 015 (dashboard auth & Taqnyat SMS) ──────────────────────────────

  // FR-032, FR-042 — the concurrent admin-session cap. A `.default()` IS
  // correct here, unlike TRUSTED_PROXY_HOPS above: guessing wrong is a UX
  // inconvenience, not a silently wrong security posture, and `1` remains a
  // valid value that reproduces today's displacement behaviour for admins.
  AUTH_MAX_ADMIN_SESSIONS: Joi.number().integer().min(1).default(3),

  // FR-013/021/023/024/025/026 — the passwordless sign-in code and its abuse
  // controls. The first four DELIBERATELY mirror the PASSWORD_RESET_* values
  // above (5 / 5 / 3 / 15): one security posture across both anonymous code
  // flows, not two sets that drift apart until one becomes the weak one.
  LOGIN_OTP_EXPIRY_MINUTES: Joi.number().positive().default(5),
  LOGIN_OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  LOGIN_OTP_MAX_REQUESTS: Joi.number().integer().min(1).default(3),
  LOGIN_OTP_WINDOW_MINUTES: Joi.number().positive().default(15),
  LOGIN_OTP_CHALLENGE_AFTER: Joi.number().integer().min(1).default(2),
  LOGIN_OTP_FAIL_THRESHOLD: Joi.number().integer().min(1).default(10),
  LOGIN_OTP_BLOCK_MINUTES: Joi.number().positive().default(60),
  // R7 — leading zero bits required of sha256(seed || nonce). `0` disables
  // the search (any nonce satisfies zero bits) and is what the e2e
  // environment sets so no suite spends CPU or turns timing-flaky; `0` must
  // stay reachable in production too, as the escape hatch if the challenge
  // ever proves to be what keeps a legitimate administrator out.
  LOGIN_POW_DIFFICULTY_BITS: Joi.number().integer().min(0).max(32).default(18),
  LOGIN_POW_SEED_TTL_SECONDS: Joi.number().integer().min(30).default(300),
});
