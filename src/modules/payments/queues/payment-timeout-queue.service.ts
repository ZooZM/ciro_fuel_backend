import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { withCorrelation } from '../../../common/logging/job-correlation';

export const PAYMENT_TIMEOUT_QUEUE = 'payment-timeout';
export const PAYMENT_TIMEOUT_JOB_NAME = 'payment-timeout';

@Injectable()
export class PaymentTimeoutQueueService {
  constructor(
    @InjectQueue(PAYMENT_TIMEOUT_QUEUE) private readonly queue: Queue,
    private readonly tenantContext: TenantContextService,
  ) {
    // Without a listener, a Redis error on this queue is an unhandled
    // EventEmitter 'error' — which crashes the process (spec 012).
    attachQueueErrorHandler(this.queue, PAYMENT_TIMEOUT_QUEUE);
  }

  /** jobId = orderId makes scheduling idempotent (re-scheduling the same order is a no-op). */
  async schedule(orderId: string, delayMinutes: number): Promise<void> {
    await this.queue.add(
      PAYMENT_TIMEOUT_JOB_NAME,
      // spec 012 FR-030 — carries the ordering request's correlation id, so
      // the timeout's state transition 30 minutes later is joinable to it.
      withCorrelation(this.tenantContext, { orderId }),
      { jobId: orderId, delay: delayMinutes * 60_000, removeOnComplete: true, removeOnFail: true },
    );
  }

  /** Called on payment success or cancellation so a stale timeout never fires. */
  async cancel(orderId: string): Promise<void> {
    const job = await this.queue.getJob(orderId);
    if (job) {
      await job.remove();
    }
  }
}
