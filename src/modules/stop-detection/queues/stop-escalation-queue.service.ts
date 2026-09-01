import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { withCorrelation, CorrelatedJobData } from '../../../common/logging/job-correlation';

export const STOP_ESCALATION_QUEUE = 'stop-escalation';
export const STOP_ESCALATION_JOB_NAME = 'stop-escalation';

export interface StopEscalationJobData extends CorrelatedJobData {
  stopId: string;
  orderId: string;
}

/**
 * spec 011 FR-009 (research R3): the response-window timer.
 *
 * Unlike detection — which is a sweep precisely because a per-order timer
 * would thrash on every movement — this timer genuinely starts once per
 * stop and is cancelled once, so BullMQ is the right fit and brings
 * restart-durability for free. Mirrors feature 010's
 * `AssignmentEscalationQueueService` exactly, including `jobId` as the
 * idempotency key.
 */
/**
 * ⚠ DELIBERATELY UNCHANGED by spec 012 Story 9 (T092, FR-057a).
 *
 * This is NOT leased and must not be. It is per-delivery work on the shared
 * BullMQ queue with a deterministic per-order job id, so it already distributes
 * correctly across instances — exactly one worker in the fleet claims each job,
 * whichever instance that worker belongs to. It was never a single-instance
 * constraint, so there is nothing here for arbitration to fix.
 *
 * Adding a lease would be a regression: it would serialise per-delivery
 * escalations behind one instance, so a fleet of two would process them at the
 * throughput of one, and a lost lease would delay an alert about a driver who
 * has gone silent.
 *
 * Only the two FLEET-WIDE sweeps take leases (`SWEEP_NAMES`).
 */
@Injectable()
export class StopEscalationQueueService {
  constructor(
    @InjectQueue(STOP_ESCALATION_QUEUE) private readonly queue: Queue,
    private readonly tenantContext: TenantContextService,
  ) {
    // Without a listener, a Redis error on this queue is an unhandled
    // EventEmitter 'error' — which crashes the process (spec 012).
    attachQueueErrorHandler(this.queue, STOP_ESCALATION_QUEUE);
  }

  /** `jobId = stopId` — the reason `StopEvent` keeps its `_id` while every
   *  other embedded sub-schema on `Order` disables it. */
  async schedule(stopId: string, orderId: string, delayMinutes: number): Promise<void> {
    await this.queue.add(
      STOP_ESCALATION_JOB_NAME,
      // spec 012 FR-030. Scheduled from the detection SWEEP, which has no
      // request behind it — `withCorrelation` mints an id in that case rather
      // than leaving the field empty, so the escalation's records still group.
      withCorrelation(this.tenantContext, { stopId, orderId }),
      { jobId: stopId, delay: delayMinutes * 60_000, removeOnComplete: true, removeOnFail: true },
    );
  }

  /** Called the moment a stop stops being unanswered — the driver replying,
   *  an administrator resolving it, or the delivery finishing (FR-014). */
  async cancel(stopId: string): Promise<void> {
    const job = await this.queue.getJob(stopId);
    if (job) {
      await job.remove();
    }
  }
}
