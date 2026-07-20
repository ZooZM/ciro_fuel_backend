import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { PaymentEvent, PaymentEventSchema } from './schemas/payment-event.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import {
  PaymentTimeoutQueueService,
  PAYMENT_TIMEOUT_QUEUE,
} from './queues/payment-timeout-queue.service';
import { PaymentTimeoutProcessor } from './queues/payment-timeout.processor';
import { OrderCoreModule } from '../orders/order-core.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentEvent.name, schema: PaymentEventSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({ name: PAYMENT_TIMEOUT_QUEUE }),
    OrderCoreModule,
    NotificationsModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentTimeoutQueueService, PaymentTimeoutProcessor],
  exports: [PaymentTimeoutQueueService],
})
export class PaymentsModule {}
