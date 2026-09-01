import { Controller, Get } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';

/**
 * spec 007 US5 (FR-028/FR-034): `me`, not `:id` — there is no identifier to
 * authorise here, so a driver reading another driver's rating/day count is
 * structurally impossible rather than merely guarded against.
 */
@Controller({ path: 'drivers', version: '1' })
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Roles(UserRole.DRIVER)
  @Get('me/summary')
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.driversService.summaryFor(user.userId);
  }
}
