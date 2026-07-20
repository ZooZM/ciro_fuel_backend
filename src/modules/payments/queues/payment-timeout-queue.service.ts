import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const PAYMENT_TIMEOUT_QUEUE = 'payment-timeout';
export const PAYMENT_TIMEOUT_JOB_NAME = 'payment-timeout';

@Injectable()
export class PaymentTimeoutQueueService {
  constructor(@InjectQueue(PAYMENT_TIMEOUT_QUEUE) private readonly queue: Queue) {}

  /** jobId = orderId makes scheduling idempotent (re-scheduling the same order is a no-op). */
  async schedule(orderId: string, delayMinutes: number): Promise<void> {
    await this.queue.add(
      PAYMENT_TIMEOUT_JOB_NAME,
      { orderId },
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
