import { Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { UserRole } from '../../../common/enums/user-role.enum';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { STOP_ESCALATION_QUEUE, StopEscalationJobData } from './stop-escalation-queue.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { runWithJobCorrelation } from '../../../common/logging/job-correlation';

/** Statuses past which a delivery is over and nothing should still escalate
 *  about it (FR-014). */
const FINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
];

/**
 * spec 011 FR-009/FR-014: tells the transportation company when a driver
 * was asked why they stopped and said nothing — the case most likely to
 * mean they cannot answer.
 *
 * Re-reads the order before acting, the same defensive discipline
 * `PaymentTimeoutProcessor` and feature 010's escalation both use: the
 * cancel calls are the primary guarantee, this re-check is the backstop for
 * a job that slipped past one.
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
@Processor(STOP_ESCALATION_QUEUE)
export class StopEscalationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(StopEscalationProcessor.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
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
    attachQueueErrorHandler(this.worker, STOP_ESCALATION_QUEUE);
  }

  /**
   * spec 012 FR-030: restores the correlation id the detection sweep stamped
   * on this job, so the sweep that noticed the stop and the escalation that
   * followed it are one retrievable story rather than two unconnected ones.
   */
  async process(job: Job<StopEscalationJobData>): Promise<void> {
    return runWithJobCorrelation(this.tenantContext, job.data, () => this.escalate(job));
  }

  private async escalate(job: Job<StopEscalationJobData>): Promise<void> {
    const { stopId, orderId } = job.data;
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      this.logger.warn({ orderId, stopId }, 'Stop escalation fired for missing order');
      return;
    }
    if (FINAL_STATUSES.includes(order.status)) {
      this.logger.debug({ orderId, stopId, status: order.status }, 'Stop escalation skipped — delivery is final');
      return;
    }

    const stop = order.stopEvents.find((s) => String((s as never as { _id: unknown })._id) === stopId);
    if (!stop) {
      this.logger.warn({ orderId, stopId }, 'Stop escalation fired for unknown stop');
      return;
    }

    // **The stamp is the guard, and it decides whether to notify.**
    //
    // Three conditions, all evaluated by the database in the write itself
    // rather than read first and acted on after:
    //
    // - `reasonGivenAt`/`resolvedAt` absent — the driver replying cancels
    //   this job, so reaching here means that cancel lost a race. Expected
    //   and harmless, but the transporter must not then be told a driver
    //   went silent when they did not.
    // - `escalatedAt` absent — SC-008 allows one alert per silence, and
    //   BullMQ is at-least-once: a redelivered job WILL arrive eventually.
    //   Checking this in application code first would let two concurrent
    //   deliveries both read "not yet escalated" and both notify, which is
    //   exactly the bug the test for this found.
    //
    // `modifiedCount` is therefore the authority on whether this delivery of
    // the job is the one that gets to alert anybody.
    const claimed = await this.orderModel
      .updateOne(
        {
          _id: order._id,
          stopEvents: {
            $elemMatch: {
              _id: stopId,
              escalatedAt: null,
              reasonGivenAt: null,
              resolvedAt: null,
            },
          },
        },
        { $set: { 'stopEvents.$.escalatedAt': new Date() } },
      )
      .exec();

    if (claimed.modifiedCount === 0) {
      this.logger.debug(
        { orderId, stopId },
        'Stop escalation skipped — already answered, resolved or escalated',
      );
      return;
    }

    // To the transporter that owns the delivery — never the fuel company or
    // the customer. The stop trail is scoped to the company employing the
    // driver (data-model.md's role-scoping note).
    const admins = await this.userModel
      .find({
        companyId: order.transportCompanyId,
        role: UserRole.TRANSPORT_COMPANY_ADMIN,
        isActive: true,
      })
      .select('_id')
      .lean()
      .exec();

    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId: order.fuelCompanyId,
          recipientUserId: String(admin._id),
          type: NotificationType.ORDER_STOP_UNRESOLVED,
          orderId: order._id as never,
          payload: { stopId },
        }),
      ),
    );

    this.logger.debug({ orderId, stopId }, 'Escalated unanswered stop');
  }
}
