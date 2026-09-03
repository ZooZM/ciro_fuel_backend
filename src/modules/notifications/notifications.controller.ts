import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unread') unread?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.notificationsService.findForUser(user.userId, unread === 'true', cursor);
  }

  /**
   * feature 013 FR-025 (contracts/rest-api-delta.md §2): mark every
   * notification read for the caller. The recipient is taken from the token,
   * never the request. Returns `{ updated }` — the count actually
   * transitioned, so a second call is `{ updated: 0 }`, not an error.
   *
   * Declared BEFORE `:id/read` so the literal path segment is not captured
   * by the `:id` param.
   */
  @Patch('read-all')
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllRead(user.userId);
  }

  @Patch(':id/read')
  markRead(@Param('id', ObjectIdPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markRead(id, user.userId);
  }
}
