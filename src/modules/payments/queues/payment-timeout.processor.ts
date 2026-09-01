import { Logger, OnModuleInit } from '@nestjs/common';
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
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { CorrelatedJobData, runWithJobCorrelation } from '../../../common/logging/job-correlation';

/**
 * Fires exactly once per order (BullMQ delayed job, jobId = orderId) after
 * the 30-minute payment window expires. A webhook confirming payment in the
 * same window races this safely: both paths use OrderStateService's
 * conditional (status-guarded) update, so exactly one of them succeeds and
 * the other's transition() call throws ConflictException, which we treat as
 * an expected, harmless loss of the race (FR-015a, research R6).
 */
/**
 * ⚠ JOB DISTRIBUTION IS UNCHANGED by spec 012 Story 9 (T097).
 *
 * BullMQ already distributes correctly across instances: every replica runs a
 * worker on the same queue, and exactly one of them claims each job. Nothing
 * here needs a lease, and adding one would serialise this queue behind a single
 * instance — throughput of one from a fleet of two, for no gain.
 *
 * **Delivery is AT-LEAST-ONCE, by design, and this feature does not change
 * that** (FR-062, corrected during planning — the spec originally said "exactly
 * once", which BullMQ does not offer and cannot). A job WILL occasionally be
 * delivered twice: a worker that dies mid-job has it redelivered, and
 * `Worker.close()` deliberately RELEASES an unfinished job for redelivery,
 * which is precisely what graceful shutdown (FR-009) wants.
 *
 * So correctness rests on IDEMPOTENCY, never on the queue. Every processor here
 * re-reads the order before acting, and where a duplicate would be visible to a
 * person it is prevented by a conditional write whose `modifiedCount` decides
 * which delivery gets to act — not by an application-code check, which two
 * concurrent deliveries would both pass.
 */
@Processor(PAYMENT_TIMEOUT_QUEUE)
export class PaymentTimeoutProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(PaymentTimeoutProcessor.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly orderStateService: OrderStateService,
    private readonly notificationsService: NotificationsService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  onModuleInit(): void {
    // `this.worker` only exists once WorkerHost has been initialised, so this
    // cannot go in the constructor. Without the listener, a Redis error on the
    // worker is an unhandled EventEmitter 'error' and the process crashes
    // (spec 012) — turning a degradation Q7 designed for into an outage.
    attachQueueErrorHandler(this.worker, PAYMENT_TIMEOUT_QUEUE);
  }

  /**
   * spec 012 FR-030: the ordering request's correlation id is restored from
   * job data, so the transition this makes 30 minutes later is retrievable
   * alongside the request that created the order.
   */
  async process(job: Job<{ orderId: string } & CorrelatedJobData>): Promise<void> {
    return runWithJobCorrelation(this.tenantContext, job.data, () => this.timeOut(job));
  }

  private async timeOut(job: Job<{ orderId: string }>): Promise<void> {
    const { orderId } = job.data;
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      this.logger.warn({ orderId }, 'Payment timeout fired for missing order');
      return;
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      // Webhook (or an admin cancellation) already moved the order on — expected race loss.
      this.logger.debug(
        { orderId, status: order.status },
        'Payment timeout skipped — status already moved on',
      );
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
      this.logger.warn({ orderId, err }, 'Payment timeout processing lost a race');
    } finally {
      await session.endSession();
    }
  }

  private async notifyTimeout(order: OrderDocument): Promise<void> {
    const admins = await this.userModel
      .find({ companyId: order.fuelCompanyId, role: UserRole.FUEL_COMPANY_ADMIN, isActive: true })
      .exec();
    await Promise.all([
      this.notificationsService.notify({
        companyId: order.fuelCompanyId,
        recipientUserId: order.clientId,
        type: NotificationType.PAYMENT_TIMEOUT,
        orderId: order._id as never,
      }),
      ...admins.map((admin) =>
        this.notificationsService.notify({
          companyId: order.fuelCompanyId,
          recipientUserId: admin._id as never,
          type: NotificationType.PAYMENT_TIMEOUT,
          orderId: order._id as never,
        }),
      ),
    ]);
  }
}
