import { Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';
import { Announcement, AnnouncementDocument } from '../schemas/announcement.schema';
import {
  AnnouncementDelivery,
  AnnouncementDeliveryDocument,
} from '../schemas/announcement-delivery.schema';
import {
  Notification,
  NotificationDocument,
} from '../../notifications/schemas/notification.schema';
import { AnnouncementCandidate, AnnouncementsService } from '../announcements.service';
import { ANNOUNCEMENT_FANOUT_QUEUE } from './announcement-fanout.queue';
import { AnnouncementState } from '../../../common/enums/announcement-state.enum';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { attachQueueErrorHandler } from '../../../common/queues/queue-error-handling';
import { isDuplicateKeyError } from '../../../common/utils/mongo-error.util';
import { CorrelatedJobData, runWithJobCorrelation } from '../../../common/logging/job-correlation';

/**
 * spec 017 (operator dashboard) T106/T107/FR-053/FR-054 — writes one
 * notification per recipient of one announcement.
 *
 * **Two things about this worker decide whether Story 6 works at all.**
 *
 * 1. **`companyId` must be stamped BY HAND** (research R9). A BullMQ worker has
 *    no request context, so both scoping plugins take their `!ctx?.role`
 *    bypass and `pre('save')` writes nothing. `Notification.companyId` is
 *    `required: true`, so an unstamped write fails loudly — but the subtler
 *    hazard is the recipient's own READ: `Notification` is `markTenantScoped`,
 *    so a notification carrying the WRONG `companyId` is invisible to the
 *    administrator it was addressed to, while the operator (who bypasses
 *    scoping) sees it and counts the delivery a success. This is the single
 *    most likely silent defect in this story, and it is invisible to any test
 *    that reads the notification back as the operator — which is why T094
 *    authenticates as the recipient.
 *
 * 2. **Idempotency is the unique index, not this code.** BullMQ is
 *    at-least-once and `Worker.close()` deliberately releases an unfinished job
 *    for redelivery, so this job WILL sometimes run twice. The duplicate insert
 *    is refused by `AnnouncementDelivery`'s `(announcementId, recipientUserId)`
 *    index and skipped here. A prior "have I delivered this?" read would be a
 *    read-then-write race under exactly the redelivery it exists to survive.
 */
@Processor(ANNOUNCEMENT_FANOUT_QUEUE)
export class AnnouncementFanoutProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(AnnouncementFanoutProcessor.name);

  constructor(
    @InjectModel(Announcement.name)
    private readonly announcementModel: Model<AnnouncementDocument>,
    @InjectModel(AnnouncementDelivery.name)
    private readonly deliveryModel: Model<AnnouncementDeliveryDocument>,
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    private readonly announcementsService: AnnouncementsService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  onModuleInit(): void {
    // `this.worker` exists only after WorkerHost initialises, so this cannot
    // live in the constructor. Without it a Redis error on the worker is an
    // unhandled EventEmitter 'error' and the process crashes (feature 012).
    attachQueueErrorHandler(this.worker, ANNOUNCEMENT_FANOUT_QUEUE);
  }

  async process(job: Job<{ announcementId: string } & CorrelatedJobData>): Promise<void> {
    return runWithJobCorrelation(this.tenantContext, job.data, () => this.fanOut(job));
  }

  private async fanOut(job: Job<{ announcementId: string }>): Promise<void> {
    const { announcementId } = job.data;
    const announcement = await this.announcementModel.findById(announcementId).exec();
    if (!announcement) {
      this.logger.warn({ announcementId }, 'Fan-out fired for a missing announcement');
      return;
    }

    // Candidates are re-resolved HERE, not carried in the job. A company
    // suspended or an administrator deactivated between enqueue and fan-out
    // must be treated as unreachable NOW — a frozen list taken at enqueue would
    // deliver to an account the platform has since closed.
    const candidates = await this.announcementsService.resolveCandidates(
      announcement.targetCompanyIds ?? [],
    );

    let delivered = 0;
    let failed = 0;

    for (const candidate of candidates) {
      const outcome = await this.deliverTo(announcement, candidate);
      if (outcome === 'delivered') delivered += 1;
      else if (outcome === 'failed') failed += 1;
      // 'skipped' is a redelivery hitting the unique index: already counted by
      // the run that wrote it, so counting it again would inflate the tally.
    }

    // FR-054's tallies. `$inc`, never `$set`, so a redelivered job that
    // legitimately delivers to a recipient the first run did not reach (one
    // reinstated in between) adds to the count rather than overwriting it.
    await this.announcementModel
      .updateOne(
        { _id: announcement._id },
        {
          $inc: { deliveredCount: delivered, failedCount: failed },
          $set: { state: AnnouncementState.COMPLETED },
        },
      )
      .exec();
  }

  /**
   * One recipient. Returns what happened so the caller can tally it.
   *
   * The unreachable cases are recorded as rows carrying a NAMED reason and NO
   * `notificationId` — recorded as missed, never counted as delivered
   * (FR-054).
   */
  private async deliverTo(
    announcement: AnnouncementDocument,
    candidate: AnnouncementCandidate,
  ): Promise<'delivered' | 'failed' | 'skipped'> {
    const { recipient, failureReason } = candidate;

    // Written BEFORE the notification, deliberately. This insert is the thing
    // the unique index guards, so it has to be the first write a redelivered
    // job attempts — writing the notification first would create a duplicate
    // notification and only then discover the delivery row already existed.
    try {
      const delivery = await this.deliveryModel.create({
        announcementId: announcement._id,
        ...(recipient
          ? { recipientUserId: recipient._id }
          : // No person to name. `companyAddressed` is what the second unique
            // index is partial on — the flag exists solely so that index can be
            // expressed in a form MongoDB will actually build (see the schema).
            { companyAddressed: true }),
        // Stamped BY HAND — see this class's own note. No plugin runs here.
        companyId: candidate.companyId,
        failureReason,
      });

      // Unreachable: a row with a NAMED reason and no `notificationId`.
      // Recorded as missed, never counted as delivered (FR-054).
      if (failureReason || !recipient) return 'failed';

      let notification;
      try {
        [notification] = await this.notificationModel.create([
          {
            // The RECIPIENT's company, not the sender's: the operator has none,
            // and a notification stamped with anything else is invisible to the
            // very person it was addressed to.
            companyId: candidate.companyId,
            recipientUserId: recipient._id,
            type: NotificationType.PLATFORM_ANNOUNCEMENT,
            payload: {
              announcementId: String(announcement._id),
              title: announcement.title,
              body: announcement.body,
            },
          },
        ]);
      } catch (notificationError) {
        // The delivery row is already written, and it MEANS "this recipient has
        // been processed" — so leaving it behind after a failed notification
        // write would make the next (at-least-once) redelivery skip this person
        // permanently, and they would never receive the announcement. Nothing
        // would say so: the row carries no failure reason either, so it reads
        // as neither delivered nor missed.
        //
        // Removing it restores the pre-attempt state so the retry can redo it
        // cleanly. Best-effort: if the remove also fails there is nothing
        // further this worker can do, and the original error is the one worth
        // propagating.
        await this.deliveryModel
          .deleteOne({ _id: delivery._id })
          .exec()
          .catch(() => undefined);
        throw notificationError;
      }

      await this.deliveryModel
        .updateOne({ _id: delivery._id }, { $set: { notificationId: notification._id } })
        .exec();
      return 'delivered';
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // A redelivered job. FR-053: zero duplicate notifications, and the
        // guarantee is the index rather than any check above it.
        return 'skipped';
      }
      throw error;
    }
  }
}
