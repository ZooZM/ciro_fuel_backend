import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

/**
 * spec 017 (operator dashboard) T109/US6 — platform announcements.
 *
 * Every route is `SUPER_ADMIN`-only (FR-056). That is also the ONLY access
 * control on these collections: neither `Announcement` nor
 * `AnnouncementDelivery` carries a scoping marker, because their author has no
 * tenant and marking them would make an announcement unreadable by its own
 * sender. For a collection with exactly one legitimate reader, the role guard
 * is the correct enforcement point.
 */
@Roles(UserRole.SUPER_ADMIN)
@Controller({ path: 'announcements', version: '1' })
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  /**
   * **202, deliberately not 201** (FR-055). The fan-out is ENQUEUED, not
   * performed: a platform-wide send is N writes, and blocking the composer's
   * request on them would make the screen's responsiveness a function of how
   * many companies the platform has.
   *
   * The response states `intendedRecipientCount` so the operator can tell at a
   * glance whether the send matches the platform they believe they have — and
   * `state: QUEUED`, so the dashboard renders it as queued rather than as
   * delivered. The outcome is read afterwards from `GET /announcements/:id`.
   */
  @HttpCode(202)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAnnouncementDto) {
    return this.announcementsService.create(dto, user.userId);
  }

  /** FR-052 — what was sent, newest first. */
  @Get()
  list(@Query('cursor') cursor?: string) {
    return this.announcementsService.list(cursor || undefined);
  }

  /** FR-052/FR-054 — one announcement, its tallies, and who was missed and why. */
  @Get(':id')
  findOne(@Param('id', ObjectIdPipe) id: string) {
    return this.announcementsService.findOne(id);
  }
}
