import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Redis(config.get<string>('redisUrl')!),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  onModuleDestroy(): void {
    // ioredis instances aren't Nest-lifecycle-aware on their own — without this,
    // app.close() leaves the TCP connection open (visible as a dangling handle
    // in tests, and a real leak on graceful shutdown in production).
    this.client.disconnect();
  }
}
