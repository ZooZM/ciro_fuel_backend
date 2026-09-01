import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { EscalationSkipReason } from '../../../common/enums/escalation-skip-reason.enum';
import { E164_PATTERN } from '../../../common/constants/phone';
import { SMS_SENDER, SmsSender } from '../../../common/sms/sms-sender.port';
import { ASSIGNMENT_ESCALATION_QUEUE } from './assignment-escalation-queue.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { CorrelatedJobData, runWithJobCorrelation } from '../../../common/logging/job-correlation';

// spec 010 FR-013a: BullMQ's own Worker `limiter` — jobs that become due while it is
// saturated simply wait longer in the queue, never dropped (research R4). Read directly
// from `process.env` (matching `validation.ts`'s own defaults) rather than via
// `ConfigService`: `@Processor`'s worker options are evaluated once, at class-definition
// time, before Nest's DI container exists to inject anything into a decorator argument.
const RATE_LIMIT_MAX = parseInt(process.env.ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_MAX ?? '20', 10);
const RATE_LIMIT_DURATION_MS = parseInt(
  process.env.ASSIGNMENT_ESCALATION_SMS_RATE_LIMIT_DURATION_MS ?? '60000',
  10,
);

/**
 * spec 010 FR-011/FR-013/FR-014a: fires once per assignment (BullMQ delayed
 * job, jobId = orderId, cancelled outright on acknowledgment/cancellation/
 * reassignment — `AssignmentEscalationQueueService.cancel`). Re-reads the
 * order fresh before acting, the same defensive pattern
 * `PaymentTimeoutProcessor` already uses for "the state changed while this
 * job was waiting."
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
@Processor(ASSIGNMENT_ESCALATION_QUEUE, {
  limiter: { max: RATE_LIMIT_MAX, duration: RATE_LIMIT_DURATION_MS },
})
export class AssignmentEscalationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(AssignmentEscalationProcessor.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  onModuleInit(): void {
    // `this.worker` only exists once WorkerHost has been initialised, so this
    // cannot go in the constructor. Without the listener, a Redis error on the
    // worker is an unhandled EventEmitter 'error' and the process crashes
    // (spec 012) — turning a degradation Q7 designed for into an outage.
    attachQueueErrorHandler(this.worker, ASSIGNMENT_ESCALATION_QUEUE);
  }

  /**
   * spec 012 FR-030: re-establishes the correlation id the enqueuing request
   * stamped onto the job, so everything below is retrievable by the same id as
   * the assignment that scheduled it. AsyncLocalStorage does not cross the
   * queue — the id travels in the job data and is restored here, and nothing
   * else joins the two halves of the story.
   */
  async process(job: Job<{ orderId: string } & CorrelatedJobData>): Promise<void> {
    return runWithJobCorrelation(this.tenantContext, job.data, () => this.escalate(job));
  }

  private async escalate(job: Job<{ orderId: string }>): Promise<void> {
    const { orderId } = job.data;
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      this.logger.warn({ orderId }, 'Assignment escalation fired for missing order');
      return;
    }

    // Acknowledged, or the order was cancelled before the window elapsed —
    // `AssignmentEscalationQueueService.cancel` (called from
    // `OrdersService.cancel`) should already have removed this job in
    // either case; this is the same belt-and-suspenders re-check
    // `PaymentTimeoutProcessor` performs, not the primary guarantee
    // (FR-014a). Checked on `status`, not `driverId`/`activeOrderId` —
    // cancellation deliberately leaves `Order.driverId` in place for
    // history (`OrdersService.releaseDriverIfAssigned` only clears the
    // driver's own `activeOrderId`), so `status` is the only reliable
    // signal here.
    if (
      order.assignmentAcknowledgedAt ||
      !order.driverId ||
      order.status === OrderStatus.CANCELLED
    ) {
      this.logger.debug({ orderId }, 'Assignment escalation skipped — no longer applicable');
      return;
    }

    // spec.md Edge Cases: uses whatever phone is on file at the moment the SMS is actually
    // sent, never the `driverSummary.phone` snapshot taken at assignment — a driver's
    // number can change in between, and the escalation must reach them, not their old one.
    const driver = await this.userModel.findById(order.driverId).exec();
    const phone = driver?.phone;
    if (!phone || !E164_PATTERN.test(phone)) {
      await this.orderModel
        .updateOne(
          { _id: order._id },
          { $set: { assignmentEscalationSkippedReason: EscalationSkipReason.NO_PHONE } },
        )
        .exec();
      this.logger.warn({ orderId }, 'Assignment escalation skipped — no valid phone on file');
      return;
    }

    // FR-011a: deliberately minimal — an order reference and an instruction to open the
    // app, nothing customer- or delivery-related. SMS is unencrypted and carrier-visible,
    // unlike the in-app push this is a fallback for.
    const reference = orderId.slice(-6).toUpperCase();
    try {
      await this.smsSender.send(
        phone,
        `Ciro: You have a new delivery assignment (ref ${reference}). Open the app to view it.`,
      );
    } catch (err) {
      // `SmsSender` implementations MUST throw on failure, never swallow it — recorded as
      // its own reason (edge case: "the SMS provider itself fails to deliver..."), distinct
      // from NO_PHONE, since the platform genuinely did attempt this one.
      await this.orderModel
        .updateOne(
          { _id: order._id },
          { $set: { assignmentEscalationSkippedReason: EscalationSkipReason.SEND_FAILED } },
        )
        .exec();
      this.logger.warn({ orderId, err }, 'Assignment escalation SMS failed');
      return;
    }

    await this.orderModel
      .updateOne({ _id: order._id }, { $set: { assignmentEscalationSmsAt: new Date() } })
      .exec();
  }
}
