import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { GlobalThrottlerGuard } from './guards/global-throttler.guard';
import { TenantContextService } from './context/tenant-context.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TenantIsolationInterceptor } from './interceptors/tenant-isolation.interceptor';
import { OtpPrimitivesService } from './otp/otp-primitives.service';
import { ShutdownService } from '../bootstrap/shutdown.service';
import { SchedulerLeaseService } from './scheduler/scheduler-lease.service';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ResilientThrottlerStorage } from './throttler/resilient-throttler.storage';

/**
 * Global module: TenantContextService must be a single shared singleton
 * instance across the whole app — it's injected both by the Mongoose
 * connectionFactory (app.module.ts) and by TenantIsolationInterceptor below,
 * and both must read/write the exact same AsyncLocalStorage.
 *
 * Guard order matters: Throttler -> Jwt (authenticates, populates req.user)
 * -> Roles (reads req.user set by Jwt). Nest runs APP_GUARD providers in
 * registration order.
 */
@Global()
@Module({
  imports: [
    // GlobalThrottlerGuard verifies a bearer token's SIGNATURE to key the rate
    // limit by user (spec 012 FR-023). It cannot read `req.user` — the guard
    // order below puts it before JwtAuthGuard — and it must not trust an
    // unverified claim, or anyone could forge a `sub` and exhaust a named
    // user's budget. Registered here with the same config as AuthModule's and
    // TrackingModule's; not exported, so it stays scoped to this module's own
    // providers.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
      }),
    }),
  ],
  providers: [
    TenantContextService,
    OtpPrimitivesService,
    // Global so the health controller can read the drain gate and the
    // bootstrap signal handler can flip it — one flag, one instance (spec 012
    // FR-005).
    ShutdownService,
    // Scheduler arbitration (spec 012 FR-056b). Lives here, in the global
    // module, because both sweeps that need it are in different feature
    // modules (tracking presence, stop detection) and neither should have to
    // import the other's.
    SchedulerLeaseService,
    // The shared rate-limit counter store (spec 012 FR-061), provided HERE
    // rather than constructed inline in `ThrottlerModule.forRootAsync` so that
    // exactly one instance exists and the health controller can ask it whether
    // it is degraded (FR-063b). Constructed inline it would be unreachable, and
    // the readiness body could only guess.
    {
      provide: ResilientThrottlerStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ResilientThrottlerStorage(
          new ThrottlerStorageRedisService(config.get<string>('redisUrl')!),
        ),
    },
    // Replaces the bare ThrottlerGuard. KEEPS ITS POSITION before JwtAuthGuard
    // — moving it after would let a request with a malformed token bypass
    // rate limiting entirely (see the guard's own comment).
    // Registered as a class provider AND bound to APP_GUARD by `useExisting`,
    // so both resolve to ONE instance. `useClass` alone would register it only
    // under the APP_GUARD token, leaving it unreachable by `app.get(...)` —
    // which is how a test asserts on the tracker key, the whole behaviour here.
    GlobalThrottlerGuard,
    { provide: APP_GUARD, useExisting: GlobalThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantIsolationInterceptor },
  ],
  exports: [
    TenantContextService,
    OtpPrimitivesService,
    ShutdownService,
    SchedulerLeaseService,
    ResilientThrottlerStorage,
    GlobalThrottlerGuard,
  ],
})
export class CommonModule {}
