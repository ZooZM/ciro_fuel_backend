import { Global, Module } from '@nestjs/common';
import { RealtimeGatewayService } from './realtime-gateway.service';

@Global()
@Module({
  providers: [RealtimeGatewayService],
  exports: [RealtimeGatewayService],
})
export class RealtimeModule {}
