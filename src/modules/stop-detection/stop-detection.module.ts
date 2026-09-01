import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { StopDetectionService } from './stop-detection.service';
import {
  StopEscalationQueueService,
  STOP_ESCALATION_QUEUE,
} from './queues/stop-escalation-queue.service';
import { StopEscalationProcessor } from './queues/stop-escalation.processor';

/**
 * spec 011. Separated from `tracking/` deliberately: that module owns
 * *where the driver is*, this one owns *what it means that they have not
 * moved*. Mixing them would put alerting policy inside the socket hot path.
 *
 * `ScheduleModule.forRoot()` is already registered globally in
 * `app.module.ts` (PresenceService depends on it), so `SchedulerRegistry`
 * is injectable here without re-importing it.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({ name: STOP_ESCALATION_QUEUE }),
    NotificationsModule,
  ],
  providers: [StopDetectionService, StopEscalationQueueService, StopEscalationProcessor],
  // `StopDetectionService` is exported for `OrdersModule`'s driver-facing
  // stop endpoints. The dependency runs one way only — this module reaches
  // for the Order *model*, never `OrdersModule` itself — so there is no
  // cycle to break with `forwardRef`.
  exports: [StopEscalationQueueService, StopDetectionService],
})
export class StopDetectionModule {}
