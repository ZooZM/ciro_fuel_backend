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
});
