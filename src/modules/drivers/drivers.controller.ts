import { Controller, Get, Query } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { DriverRosterService } from './driver-roster.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { DutyState } from '../../common/enums/duty-state.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { parseEnumQuery } from '../../common/validation/parse-enum-query';
import { parseBooleanQuery } from '../../common/validation/parse-boolean-query';

/**
 * spec 007 US5 (FR-028/FR-034): `me`, not `:id` — there is no identifier to
 * authorise here, so a driver reading another driver's rating/day count is
 * structurally impossible rather than merely guarded against.
 */
@Controller({ path: 'drivers', version: '1' })
export class DriversController {
  constructor(
    private readonly driversService: DriversService,
    private readonly driverRosterService: DriverRosterService,
  ) {}

  @Roles(UserRole.DRIVER)
  @Get('me/summary')
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.driversService.summaryFor(user.userId);
  }

  /**
   * spec 017 (operator dashboard) T086/FR-038–FR-044 — every driver on the
   * platform, their employer, their most recently operated truck and their duty
   * state. **And nothing about where that person has been.**
   *
   * `SUPER_ADMIN` only (FR-074). The route is deliberately NOT a widening of
   * `GET /users?role=DRIVER`: that returns raw `User` documents, which carry
   * `location`, `lastSeenAt`, `lastMovedAt`, `lastMovedLocation` and
   * `activeOrderId`. The roster's own response shape is the privacy boundary
   * (FR-043/FR-044), and it is asserted against the serialized body rather than
   * against what a screen renders (SC-014).
   */
  @Roles(UserRole.SUPER_ADMIN)
  @Get('roster')
  roster(
    @Query('isActive') isActive?: string,
    @Query('dutyState') dutyState?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.driverRosterService.list({
      isActive: parseBooleanQuery(isActive, 'isActive'),
      dutyState: parseEnumQuery(DutyState, dutyState, 'dutyState'),
      cursor,
    });
  }
}
