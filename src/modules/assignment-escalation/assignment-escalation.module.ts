import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  AssignmentEscalationQueueService,
  ASSIGNMENT_ESCALATION_QUEUE,
} from './queues/assignment-escalation-queue.service';
import { AssignmentEscalationProcessor } from './queues/assignment-escalation.processor';

/**
 * spec 010 (research R3): mirrors `PaymentsModule`'s own queue registration
 * exactly — the platform's existing, proven shape for "a durable,
 * cancellable delayed job," not a new pattern. `SmsSender` (`SMS_SENDER`)
 * is provided by the already-`@Global()` `SmsModule` (spec 005) — no import
 * needed here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({ name: ASSIGNMENT_ESCALATION_QUEUE }),
  ],
  providers: [AssignmentEscalationQueueService, AssignmentEscalationProcessor],
  exports: [AssignmentEscalationQueueService],
})
export class AssignmentEscalationModule {}
