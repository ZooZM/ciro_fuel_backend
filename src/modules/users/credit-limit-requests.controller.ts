import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { CreditLimitRequestsService } from './services/credit-limit-requests.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { ResolveCreditLimitRequestDto } from './dto/resolve-credit-limit-request.dto';
import { CreditLimitRequestState } from '../../common/enums/credit-limit-request-state.enum';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

/**
 * spec 013 (fuel company admin dashboard) FR-030/FR-031, contracts/rest-api-delta.md —
 * a top-level path (`/credit-limit-requests`, not nested under `/users`), so this is a
 * separate controller from `UsersController` rather than an absolute-path escape from
 * it (Nest always appends a controller method's path to its own controller prefix).
 */
@Controller({ path: 'credit-limit-requests', version: '1' })
export class CreditLimitRequestsController {
  constructor(
    private readonly creditLimitRequestsService: CreditLimitRequestsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // FR-030: the administrator's queue, optionally filtered by state (`?state=PENDING`).
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Get()
  async findForCompany(@Query('state') state?: CreditLimitRequestState) {
    const items = await this.creditLimitRequestsService.findForCompany(state || undefined);
    return { items };
  }

  // FR-030/FR-031/SC-008: conditional on PENDING — a second resolution is refused as
  // already resolved (409), never a silent overwrite.
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/resolve')
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ResolveCreditLimitRequestDto,
  ) {
    const resolved = await this.creditLimitRequestsService.resolve(
      id,
      user.userId,
      dto.accept,
      dto.grantedAmount,
    );

    // FR-030: the owner is told the outcome — what was granted where accepted, that it
    // was declined otherwise. Called after resolve() commits, matching the platform's
    // existing convention (notify from the controller, never inside the transaction).
    await this.notificationsService.notify({
      companyId: resolved.companyId,
      recipientUserId: resolved.clientId,
      type: NotificationType.CREDIT_LIMIT_REQUEST_RESOLVED,
      payload: {
        accepted: dto.accept,
        grantedAmount: resolved.grantedAmount ?? null,
      },
    });

    return resolved;
  }
}
