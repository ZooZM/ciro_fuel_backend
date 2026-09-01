import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { withCorrelation } from '../../../common/logging/job-correlation';

export const ASSIGNMENT_ESCALATION_QUEUE = 'assignment-escalation';
export const ASSIGNMENT_ESCALATION_JOB_NAME = 'assignment-escalation';

/**
 * spec 010 FR-011/FR-012a (research R3): mirrors
 * `PaymentTimeoutQueueService` exactly — the platform's own existing,
 * Redis-backed answer to "a durable, delayed, cancellable one-shot job,"
 * not a new scheduling mechanism. `jobId = orderId` makes both
 * `schedule` and `cancel` idempotent: rescheduling an order that already
 * has a pending escalation replaces it (used on driver reassignment,
 * FR-014a — cancel the old driver's window, schedule the new one's).
 */
@Injectable()
export class AssignmentEscalationQueueService {
  constructor(
    @InjectQueue(ASSIGNMENT_ESCALATION_QUEUE) private readonly queue: Queue,
    private readonly tenantContext: TenantContextService,
  ) {
    // Without a listener, a Redis error on this queue is an unhandled
    // EventEmitter 'error' — which crashes the process (spec 012).
    attachQueueErrorHandler(this.queue, ASSIGNMENT_ESCALATION_QUEUE);
  }

  async schedule(orderId: string, delayMinutes: number): Promise<void> {
    await this.queue.add(
      ASSIGNMENT_ESCALATION_JOB_NAME,
      // spec 012 FR-030: the assigning request's correlation id travels with
      // the job, so the escalation SMS it eventually sends is retrievable from
      // the same id as the assignment that scheduled it.
      withCorrelation(this.tenantContext, { orderId }),
      { jobId: orderId, delay: delayMinutes * 60_000, removeOnComplete: true, removeOnFail: true },
    );
  }

  /** Called whenever the order or its driver assignment changes before the
   *  window elapses (acknowledgment, cancellation, reassignment to a
   *  different driver) so a stale escalation never fires (FR-014a). */
  async cancel(orderId: string): Promise<void> {
    const job = await this.queue.getJob(orderId);
    if (job) {
      await job.remove();
    }
  }
}
