import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { ResilientThrottlerStorage } from './common/throttler/resilient-throttler.storage';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration';
import { validationSchema } from './config/validation';
import { CommonModule } from './common/common.module';
import { RedisModule } from './common/redis/redis.module';
import { RealtimeModule } from './common/realtime/realtime.module';
import { SmsModule } from './common/sms/sms.module';
import { TenantContextService } from './common/context/tenant-context.service';
import { createTenantScopePlugin } from './common/plugins/tenant-scope.plugin';
import { createMultiPartyScopePlugin } from './common/plugins/multi-party-scope.plugin';
import { createPartySetScopePlugin } from './common/plugins/party-set-scope.plugin';
import { createProposalScopePlugin } from './common/plugins/proposal-scope.plugin';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { RegionsModule } from './modules/regions/regions.module';
import { GeocodingModule } from './modules/geocoding/geocoding.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { StopDetectionModule } from './modules/stop-detection/stop-detection.module';
import { StationsModule } from './modules/stations/stations.module';
import { WarehousesModule } from './modules/warehouses/warehouses.module';
import { TrucksModule } from './modules/trucks/trucks.module';
import { TanksModule } from './modules/tanks/tanks.module';
import { SupportModule } from './modules/support/support.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { HealthModule } from './modules/health/health.module';
import { BillingModule } from './modules/billing/billing.module';
import { PlatformAccountModule } from './modules/platform-account/platform-account.module';
import { FuelExchangeModule } from './modules/fuel-exchange/fuel-exchange.module';
import { buildPinoOptions } from './common/logging/pino.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
    }),
    // Structured records (spec 012 Story 5). Replaces
    // `RequestLoggerMiddleware`, which emitted an unparseable single-line
    // string with no correlation id, no actor and no instance — three of the
    // four fields an incident is actually reconstructed from.
    //
    // CommonModule is imported for TenantContextService: `customProps` reads
    // the correlation id and actor out of the SAME AsyncLocalStorage store the
    // scoping plugins use, so an HTTP record and a background-job record are
    // shaped identically (research R6).
    LoggerModule.forRootAsync({
      imports: [ConfigModule, CommonModule],
      inject: [ConfigService, TenantContextService],
      useFactory: buildPinoOptions,
    }),
    CommonModule,
    RedisModule,
    RealtimeModule,
    SmsModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, TenantContextService],
      useFactory: (config: ConfigService, tenantContext: TenantContextService) => ({
        uri: config.get<string>('mongodbUri'),

        // spec 012 Story 8 (FR-050 – FR-054). Explicit bounds, because the
        // driver's defaults are the problem: `serverSelectionTimeoutMS` is 30 s
        // and `waitQueueTimeoutMS` is unbounded, so a brief database
        // interruption does not fail requests — it PARKS them. Connections pile
        // up behind an unavailable server for half a minute each, the event
        // loop fills with pending work, and the instance stops answering
        // anything at all, including its own readiness probe. The outage then
        // looks like an application hang rather than a database blip, which is
        // the wrong thing to page someone about.
        //
        // Bounded, a request fails promptly in the platform's standard error
        // shape, readiness reports not-ready, the proxy stops sending work, and
        // recovery needs no restart (FR-052/FR-053).
        maxPoolSize: config.get<number>('mongo.maxPoolSize'),
        minPoolSize: config.get<number>('mongo.minPoolSize'),
        serverSelectionTimeoutMS: config.get<number>('mongo.serverSelectionTimeoutMs'),
        connectTimeoutMS: config.get<number>('mongo.connectTimeoutMs'),
        // MUST exceed the longest legitimate transaction — dispatch assignment
        // (`dispatch.service.ts`, a multi-document driver/truck/tank booking)
        // and the payment webhook (`payments.service.ts`). Set below one of
        // those, this resilience work becomes a data-integrity bug: the socket
        // is torn down mid-commit and the transaction's outcome is decided by a
        // timeout rather than by the application (FR-054). 45 s is far above
        // both, deliberately — a socket timeout is a backstop against a hung
        // connection, not a request deadline.
        socketTimeoutMS: config.get<number>('mongo.socketTimeoutMs'),
        // The bound that actually prevents the pile-up: with the pool
        // exhausted, a caller waits this long for a connection and then fails,
        // instead of queueing without limit.
        waitQueueTimeoutMS: config.get<number>('mongo.waitQueueTimeoutMs'),

        connectionFactory: (connection) => {
          // Applies to every schema compiled on this connection going forward —
          // the actual scoping only activates for schemas marked tenantScoped (FR-002).
          connection.plugin(createTenantScopePlugin(tenantContext));
          // Second, parallel mechanism for the collections one tenant filter
          // cannot express (orders, invoices) — only activates for schemas
          // marked multiParty; every other schema is untouched by it
          // (plan.md §1, Constitution Check / Complexity Tracking).
          connection.plugin(createMultiPartyScopePlugin(tenantContext));
          // Third, deliberately narrow mechanism for the one collection owned by an
          // ARRAY of companies (spec 013 T214, research R3) — only activates for
          // schemas marked `partySet`; `tenant-scope.plugin.ts` and
          // `multi-party-scope.plugin.ts` above are untouched by its existence.
          connection.plugin(createPartySetScopePlugin(tenantContext));
          // Fourth, deliberately narrow mechanism for the one collection readable by
          // its own author OR the raiser of the offer it answers (spec 016 research
          // R3) — only activates for schemas marked `proposal`; none of the three
          // plugins above are touched by its existence.
          connection.plugin(createProposalScopePlugin(tenantContext));
          return connection;
        },
      }),
    }),
    // spec 012 FR-061: counters live in Redis, so a client's budget is shared
    // across instances. Without this each replica counts separately and the
    // effective limit is silently N× the configured one — the limit appears to
    // work and does not.
    //
    // Wrapped in `ResilientThrottlerStorage`, which is NOT optional: the Redis
    // store fails CLOSED, and this guard is global, so a Redis outage would be
    // a 500 on every request on the platform — making Redis a harder dependency
    // than MongoDB and turning Q7's decision (keep a cache-less instance in
    // rotation) into the cause of the total outage it was taken to prevent.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, CommonModule],
      inject: [ConfigService, ResilientThrottlerStorage],
      useFactory: (config: ConfigService, storage: ResilientThrottlerStorage) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('throttle.ttl')! * 1000,
            limit: config.get<number>('throttle.limit')!,
          },
        ],
        storage,
      }),
    }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>('redisUrl') },
      }),
    }),
    CompaniesModule,
    RegionsModule,
    GeocodingModule,
    StationsModule,
    WarehousesModule,
    TrucksModule,
    TanksModule,
    SessionsModule,
    UsersModule,
    AuthModule,
    NotificationsModule,
    OrdersModule,
    DispatchModule,
    PaymentsModule,
    InvoicesModule,
    BillingModule,
    PlatformAccountModule,
    FuelExchangeModule,
    TrackingModule,
    StopDetectionModule,
    SupportModule,
    DriversModule,
    HealthModule,
  ],
})
export class AppModule {}
