import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { validationSchema } from './config/validation';
import { CommonModule } from './common/common.module';
import { RedisModule } from './common/redis/redis.module';
import { RealtimeModule } from './common/realtime/realtime.module';
import { TenantContextService } from './common/context/tenant-context.service';
import { createTenantScopePlugin } from './common/plugins/tenant-scope.plugin';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
    }),
    CommonModule,
    RedisModule,
    RealtimeModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, TenantContextService],
      useFactory: (config: ConfigService, tenantContext: TenantContextService) => ({
        uri: config.get<string>('mongodbUri'),
        connectionFactory: (connection) => {
          // Applies to every schema compiled on this connection going forward —
          // the actual scoping only activates for schemas marked tenantScoped (FR-002).
          connection.plugin(createTenantScopePlugin(tenantContext));
          return connection;
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('throttle.ttl')! * 1000,
            limit: config.get<number>('throttle.limit')!,
          },
        ],
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
    UsersModule,
    AuthModule,
    NotificationsModule,
    OrdersModule,
    DispatchModule,
    PaymentsModule,
    TrackingModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
