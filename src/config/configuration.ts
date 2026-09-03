import { hostname } from 'node:os';
import { StorageDriver } from '../common/enums/storage-driver.enum';
import { SecretsDriver } from '../common/enums/secrets-driver.enum';

export interface AppConfig {
  port: number;
  nodeEnv: string;
  mongodbUri: string;
  redisUrl: string;
  jwt: {
    secret: string;
    expiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
  };
  payment: {
    sadadSecret: string;
    madaSecret: string;
    deadlineMinutes: number;
  };
  otp: {
    expiryMinutes: number;
  };
  storage: {
    dir: string;
    maxFileSizeBytes: number;
    // spec 012 Story 6 — `local` keeps development and all 53 e2e suites free
    // of cloud dependencies (FR-042); the download route issues a 302 under
    // BOTH drivers, so tests and production exercise one path (FR-042a).
    driver: StorageDriver;
    gcsBucket: string;
    signedUrlTtlSeconds: number;
    localTokenTtlSeconds: number;
    localTokenSecret: string;
  };
  throttle: {
    ttl: number;
    limit: number;
  };
  presence: {
    offlineThresholdMinutes: number;
    sweepIntervalSeconds: number;
  };
  tracking: {
    displacementThresholdMeters: number;
    heartbeatMinutes: number;
  };
  superAdmin: {
    email?: string;
    password?: string;
    fullName?: string;
  };
  order: {
    averageSpeedKmh: number;
    quoteExpiryMinutes: number;
  };
  geocoding: {
    googleMapsApiKey: string;
  };
  sms: {
    provider: string;
    apiKey: string;
    senderId: string;
    endpointUrl: string;
  };
  // spec 006 (driver auth & session) — see spec.md Assumptions for why
  // these four values are the concrete defaults chosen there.
  passwordReset: {
    expiryMinutes: number;
    maxAttempts: number;
    maxRequestsPerWindow: number;
    windowMinutes: number;
  };
  // spec 007 (driver home & active delivery) — the single day boundary a
  // driver's "deliveries today" count is measured against (FR-033). Must be
  // the platform's own definition, never the caller's device clock, or the
  // same driver's day would differ depending on who is asking.
  platform: {
    dayBoundaryTimezone: string;
  };
  // spec 008 FR-030b — how close to the assigned warehouse a driver must be
  // for their loading-stage verification to count. Generous by design: a
  // depot yard is large, and a GPS fix taken between metal tanks is not.
  verification: {
    warehouseGeofenceRadiusMeters: number;
  };
  // spec 010 (driver availability & assignment escalation) — FR-012/FR-013a.
  // Chosen short by design: for an offline driver (this spec's own Story 1
  // makes assigning one a first-class action) the escalation SMS is not a
  // fallback channel, it is the only one that can ever reach them.
  assignment: {
    ackWindowMinutes: number;
    escalationRateLimitMax: number;
    escalationRateLimitDurationMs: number;
  };
  // spec 011 (in-transit stop detection) — FR-001/FR-003/FR-009/FR-019.
  // `movementMeters` deliberately defaults to the SAME value as
  // `tracking.displacementThresholdMeters`: if the two ever disagreed, the
  // platform could call a driver "moving" for tracking and "stopped" for
  // alerting at the same instant, which is indefensible when an
  // administrator asks why (research R2).
  stopDetection: {
    windowMinutes: number;
    movementMeters: number;
    responseWindowMinutes: number;
    sweepSeconds: number;
  };
  // spec 012 (production hardening). Every value here is operational: none
  // changes what the platform does, only how it is run and observed.
  health: {
    timeoutMs: number;
    instanceId: string;
    readinessPollIntervalSeconds: number;
    readinessFailureThreshold: number;
    readinessRecoveryThreshold: number;
  };
  shutdown: {
    drainMs: number;
  };
  cors: {
    allowedOrigins: string[];
  };
  proxy: {
    // FR-022: deliberately `number | undefined`, with NO default. It is 1 when
    // nginx is the only proxy and 2 when a managed load balancer fronts it, and
    // which holds is a deployment fact (FR-007d), not something to guess.
    // Guessing 1 where there are 2 makes the load balancer the attributed
    // client for EVERY request on the platform — the same undifferentiated-
    // origin failure Story 4 exists to fix, with no error and no symptom.
    trustedHops?: number;
  };
  logging: {
    level: string;
    pretty: boolean;
  };
  secrets: {
    driver: SecretsDriver;
    gcpProjectId: string;
    manifest: string[];
  };
  mongo: {
    maxPoolSize: number;
    minPoolSize: number;
    serverSelectionTimeoutMs: number;
    connectTimeoutMs: number;
    socketTimeoutMs: number;
    waitQueueTimeoutMs: number;
  };
  scheduler: {
    leaseTtlMs: number;
    leaseEnabled: boolean;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/ciro_fuel?replicaSet=rs0',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },
  payment: {
    sadadSecret: process.env.PAYMENT_SADAD_SECRET ?? '',
    madaSecret: process.env.PAYMENT_MADA_SECRET ?? '',
    deadlineMinutes: parseInt(process.env.PAYMENT_DEADLINE_MINUTES ?? '30', 10),
  },
  otp: {
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES ?? '30', 10),
  },
  storage: {
    dir: process.env.STORAGE_DIR ?? 'sys_storge',
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES ?? String(10 * 1024 * 1024), 10),
    driver: (process.env.STORAGE_DRIVER as StorageDriver) ?? StorageDriver.LOCAL,
    gcsBucket: process.env.GCS_BUCKET ?? '',
    signedUrlTtlSeconds: parseInt(process.env.SIGNED_URL_TTL_SECONDS ?? '300', 10),
    // Matches the signed-URL lifetime deliberately, so the two drivers expire
    // alike and a test cannot pass on the local driver for a timing reason that
    // would not hold in production.
    localTokenTtlSeconds: parseInt(process.env.LOCAL_STORAGE_TOKEN_TTL_SECONDS ?? '300', 10),
    // Falls back to JWT_SECRET through a fixed context string (see
    // local-storage-token.ts) rather than reusing it directly — the two must
    // never be the same key material.
    localTokenSecret: process.env.LOCAL_STORAGE_TOKEN_SECRET ?? '',
  },
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  presence: {
    offlineThresholdMinutes: parseInt(process.env.PRESENCE_OFFLINE_MINUTES ?? '6', 10),
    sweepIntervalSeconds: parseInt(process.env.PRESENCE_SWEEP_SECONDS ?? '60', 10),
  },
  tracking: {
    displacementThresholdMeters: parseInt(process.env.TRACKING_DISPLACEMENT_METERS ?? '50', 10),
    heartbeatMinutes: parseFloat(process.env.TRACKING_HEARTBEAT_MINUTES ?? '3'),
  },
  superAdmin: {
    email: process.env.SUPER_ADMIN_EMAIL,
    password: process.env.SUPER_ADMIN_PASSWORD,
    fullName: process.env.SUPER_ADMIN_FULL_NAME ?? 'Platform Owner',
  },
  order: {
    averageSpeedKmh: parseFloat(process.env.ORDER_AVERAGE_SPEED_KMH ?? '60'),
    // How long a quote (POST /orders/quote) stays valid before redemption
    // (POST /orders) requires a fresh one (spec 005 research R10).
    quoteExpiryMinutes: parseInt(process.env.ORDER_QUOTE_EXPIRY_MINUTES ?? '10', 10),
  },
  geocoding: {
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  },
  sms: {
    // 'none' is the development no-op sender (research R4) — logs the code
    // instead of sending it. validation.ts rejects it in production.
    provider: process.env.SMS_PROVIDER ?? 'none',
    apiKey: process.env.SMS_API_KEY ?? '',
    senderId: process.env.SMS_SENDER_ID ?? '',
    endpointUrl: process.env.SMS_ENDPOINT_URL ?? 'https://api.taqnyat.sa/v1/messages',
  },
  passwordReset: {
    expiryMinutes: parseInt(process.env.PASSWORD_RESET_EXPIRY_MINUTES ?? '5', 10),
    maxAttempts: parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS ?? '5', 10),
    maxRequestsPerWindow: parseInt(process.env.PASSWORD_RESET_MAX_REQUESTS ?? '3', 10),
    windowMinutes: parseInt(process.env.PASSWORD_RESET_WINDOW_MINUTES ?? '15', 10),
  },
  platform: {
    dayBoundaryTimezone: process.env.PLATFORM_DAY_BOUNDARY_TIMEZONE ?? 'Asia/Riyadh',
  },
  verification: {
    warehouseGeofenceRadiusMeters: parseInt(
      process.env.WAREHOUSE_GEOFENCE_RADIUS_METERS ?? '500',
      10,
    ),
  },
  assignment: {
    ackWindowMinutes: parseInt(process.env.ASSIGNMENT_ACK_WINDOW_MINUTES ?? '3', 10),
    escalationRateLimitMax: parseInt(
      process.env.ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_MAX ?? '20',
      10,
    ),
    escalationRateLimitDurationMs: parseInt(
      process.env.ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_DURATION_MS ?? '60000',
      10,
    ),
  },
  stopDetection: {
    windowMinutes: parseInt(process.env.STOP_DETECTION_WINDOW_MINUTES ?? '10', 10),
    movementMeters: parseInt(process.env.STOP_DETECTION_MOVEMENT_METERS ?? '50', 10),
    responseWindowMinutes: parseInt(process.env.STOP_RESPONSE_WINDOW_MINUTES ?? '5', 10),
    sweepSeconds: parseInt(process.env.STOP_DETECTION_SWEEP_SECONDS ?? '60', 10),
  },
  health: {
    timeoutMs: parseInt(process.env.HEALTH_TIMEOUT_MS ?? '1000', 10),
    // `||`, NOT `??`. Joi declares INSTANCE_ID as `.allow('').default('')` and
    // @nestjs/config writes the VALIDATED result back into process.env, so an
    // unset variable arrives here as '' rather than undefined — and `??` does
    // not treat '' as absent. The effect was silent and total: every record and
    // every health response carried `instanceId: ''`, so FR-035a's "which
    // instance produced this?" had no answer on any deployment that did not set
    // the variable explicitly. Caught by request-logging.e2e-spec.ts.
    instanceId: process.env.INSTANCE_ID || hostname(),
    readinessPollIntervalSeconds: parseInt(process.env.READINESS_POLL_INTERVAL_SECONDS ?? '10', 10),
    readinessFailureThreshold: parseInt(process.env.READINESS_FAILURE_THRESHOLD ?? '3', 10),
    readinessRecoveryThreshold: parseInt(process.env.READINESS_RECOVERY_THRESHOLD ?? '3', 10),
  },
  shutdown: {
    // Long enough for in-flight requests, short enough for routine deploys.
    drainMs: parseInt(process.env.SHUTDOWN_DRAIN_MS ?? '30000', 10),
  },
  cors: {
    // Exact-match origins: scheme, host and port are all significant, and a
    // trailing slash fails closed. validation.ts requires a non-empty value in
    // production (FR-018) — starting with browser access silently broken is
    // worse than refusing to start.
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },
  proxy: {
    // No `??` fallback, by design — see the interface comment (FR-022).
    trustedHops: process.env.TRUSTED_PROXY_HOPS
      ? parseInt(process.env.TRUSTED_PROXY_HOPS, 10)
      : undefined,
  },
  logging: {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    // Production must stay newline-delimited JSON or the logging agent cannot
    // preserve fields, which is the whole of FR-028.
    pretty: process.env.LOG_PRETTY === 'true' && process.env.NODE_ENV !== 'production',
  },
  secrets: {
    driver: (process.env.SECRETS_DRIVER as SecretsDriver) ?? SecretsDriver.ENV,
    gcpProjectId: process.env.GCP_PROJECT_ID ?? '',
    manifest: (
      process.env.SECRETS_MANIFEST ??
      'JWT_SECRET,JWT_REFRESH_SECRET,PAYMENT_SADAD_SECRET,PAYMENT_MADA_SECRET,SMS_API_KEY,GOOGLE_MAPS_API_KEY,MONGODB_URI,REDIS_URL'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  mongo: {
    maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE ?? '20', 10),
    minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE ?? '2', 10),
    serverSelectionTimeoutMs: parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ?? '5000', 10),
    connectTimeoutMs: parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS ?? '10000', 10),
    // MUST exceed the longest legitimate transaction (dispatch assignment,
    // payment webhook). Set too low, Story 8's resilience work becomes Story
    // 8's data-integrity bug (FR-054).
    socketTimeoutMs: parseInt(process.env.MONGO_SOCKET_TIMEOUT_MS ?? '45000', 10),
    waitQueueTimeoutMs: parseInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS ?? '10000', 10),
  },
  scheduler: {
    // Above the measured p99 sweep duration, below the 60s sweep interval, so a
    // dead holder's lease expires before the next tick (FR-056b/FR-058).
    leaseTtlMs: parseInt(process.env.SCHEDULER_LEASE_TTL_MS ?? '55000', 10),
    leaseEnabled: process.env.SCHEDULER_LEASE_ENABLED !== 'false',
  },
});
