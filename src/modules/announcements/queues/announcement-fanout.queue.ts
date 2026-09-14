import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { withCorrelation } from '../../../common/logging/job-correlation';

export const ANNOUNCEMENT_FANOUT_QUEUE = 'announcement-fanout';
export const ANNOUNCEMENT_FANOUT_JOB_NAME = 'announcement-fanout';

/**
 * spec 017 (operator dashboard) T105/T108/FR-055 — enqueues one announcement's
 * fan-out.
 *
 * Mirrors `AssignmentEscalationQueueService` exactly: the platform's existing,
 * Redis-backed answer to "a durable background job", not a new mechanism.
 * `jobId = announcementId` makes enqueueing idempotent, so a double submit
 * cannot schedule two fan-outs for one announcement — though the guarantee that
 * actually matters is the unique index on `AnnouncementDelivery`, since BullMQ
 * is at-least-once regardless of how carefully a job is added.
 *
 * No `cancel` twin: an announcement, once sent, is sent. There is nothing to
 * call back.
 */
@Injectable()
export class AnnouncementFanoutQueueService {
  constructor(
    @InjectQueue(ANNOUNCEMENT_FANOUT_QUEUE) private readonly queue: Queue,
    private readonly tenantContext: TenantContextService,
  ) {
    // T108: without a listener, a Redis error on this queue is an unhandled
    // EventEmitter 'error' — which crashes the PROCESS (feature 012's finding).
    attachQueueErrorHandler(this.queue, ANNOUNCEMENT_FANOUT_QUEUE);
  }

  async enqueue(announcementId: string): Promise<void> {
    await this.queue.add(
      ANNOUNCEMENT_FANOUT_JOB_NAME,
      // spec 012 FR-030: the composing request's correlation id travels with
      // the job, so every notification it eventually writes is retrievable
      // from the same id as the request that sent the announcement.
      withCorrelation(this.tenantContext, { announcementId }),
      { jobId: announcementId, removeOnComplete: true, removeOnFail: true },
    );
  }
}
