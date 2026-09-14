import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Announcement, AnnouncementSchema } from './schemas/announcement.schema';
import {
  AnnouncementDelivery,
  AnnouncementDeliverySchema,
} from './schemas/announcement-delivery.schema';
import { Notification, NotificationSchema } from '../notifications/schemas/notification.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Company, CompanySchema } from '../companies/schemas/company.schema';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementsController } from './announcements.controller';
import {
  AnnouncementFanoutQueueService,
  ANNOUNCEMENT_FANOUT_QUEUE,
} from './queues/announcement-fanout.queue';
import { AnnouncementFanoutProcessor } from './queues/announcement-fanout.processor';

/**
 * spec 017 (operator dashboard) T110/US6.
 *
 * Mirrors `AssignmentEscalationModule`'s queue registration exactly — the
 * platform's existing, proven shape for a durable background job, not a new
 * pattern.
 *
 * The models are registered directly rather than imported from their owning
 * modules because the fan-out WORKER reads them with no request context, and
 * what it needs from each is a single write or a single projection. Importing
 * `UsersModule` and `NotificationsModule` for that would pull two service
 * layers (and their own dependency graphs) into a worker that calls neither.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Announcement.name, schema: AnnouncementSchema },
      { name: AnnouncementDelivery.name, schema: AnnouncementDeliverySchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: User.name, schema: UserSchema },
      { name: Company.name, schema: CompanySchema },
    ]),
    BullModule.registerQueue({ name: ANNOUNCEMENT_FANOUT_QUEUE }),
  ],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService, AnnouncementFanoutQueueService, AnnouncementFanoutProcessor],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule {}
