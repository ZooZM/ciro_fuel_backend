import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';

/**
 * Spec 012 Story 1. The Redis client comes from the @Global() RedisModule and
 * the Mongoose connection from the @Global() MongooseModule, so this module
 * needs only Terminus and config of its own.
 */
@Module({
  imports: [TerminusModule, ConfigModule],
  controllers: [HealthController],
})
export class HealthModule {}
