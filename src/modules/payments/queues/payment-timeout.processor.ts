import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Job } from 'bullmq';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { OrderStateService } from '../../orders/services/order-state.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { SYSTEM_ACTOR } from '../../../common/constants/system-actor';
import { PAYMENT_TIMEOUT_QUEUE } from './payment-timeout-queue.service';
import { UserRole } from '../../../common/enums/user-role.enum';

/**
 * Fires exactly once per order (BullMQ delayed job, jobId = orderId) after
 * the 30-minute payment window expires. A webhook confirming payment in the
 * same window races this safely: both paths use OrderStateService's
 * conditional (status-guarded) update, so exactly one of them succeeds and
 * the other's transition() call throws ConflictException, which we treat as
 * an expected, harmless loss of the race (FR-015a, research R6).
 */
@Processor(PAYMENT_TIMEOUT_QUEUE)
export class PaymentTimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentTimeoutProcessor.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly orderStateService: OrderStateService,
    private readonly notificationsService: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ orderId: string }>): Promise<void> {
    const { orderId } = job.data;
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      this.logger.warn(`Payment timeout fired for missing order ${orderId}`);
      return;
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      // Webhook (or an admin cancellation) already moved the order on — expected race loss.
      this.logger.debug(`Payment timeout for ${orderId} skipped — status is now ${order.status}`);
      return;
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (order.driverId) {
          await this.userModel
            .updateOne(
              { _id: order.driverId, activeOrderId: order._id },
              { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
              { session },
            )
            .exec();
        }

        await this.orderStateService.transition(
          order._id as never,
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.APPROVED,
          SYSTEM_ACTOR,
          {
            session,
            extraSet: { paymentTimeoutCount: (order.paymentTimeoutCount ?? 0) + 1 },
            extraUnset: ['driverId', 'paymentDeadline'],
          },
        );
      });

      await this.notifyTimeout(order);
    } catch (err) {
      this.logger.warn(`Payment timeout processing lost a race for order ${orderId}: ${err}`);
    } finally {
      await session.endSession();
    }
  }

  private async notifyTimeout(order: OrderDocument): Promise<void> {
    const admins = await this.userModel
      .find({ companyId: order.companyId, role: UserRole.COMPANY_ADMIN, isActive: true })
      .exec();
    await Promise.all([
      this.notificationsService.notify({
        companyId: order.companyId,
        recipientUserId: order.clientId,
        type: NotificationType.PAYMENT_TIMEOUT,
        orderId: order._id as never,
      }),
      ...admins.map((admin) =>
        this.notificationsService.notify({
          companyId: order.companyId,
          recipientUserId: admin._id as never,
          type: NotificationType.PAYMENT_TIMEOUT,
          orderId: order._id as never,
        }),
      ),
    ]);
  }
}
