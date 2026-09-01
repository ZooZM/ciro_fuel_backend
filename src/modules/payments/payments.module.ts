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
import { InvoicesModule } from '../invoices/invoices.module';
import { DispatchModule } from '../dispatch/dispatch.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentEvent.name, schema: PaymentEventSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({ name: PAYMENT_TIMEOUT_QUEUE }),
    OrderCoreModule,
    NotificationsModule,
    InvoicesModule,
    // For RoutingService — settlement resumes routing (FR-020a). Safe: since
    // DispatchModule no longer imports PaymentsModule (dispatch.module.ts,
    // spec 004 US5), this is a one-directional edge, not a cycle.
    DispatchModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentTimeoutQueueService, PaymentTimeoutProcessor],
  exports: [PaymentTimeoutQueueService],
})
export class PaymentsModule {}
