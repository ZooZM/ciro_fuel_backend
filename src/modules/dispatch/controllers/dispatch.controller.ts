import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DispatchService } from '../services/dispatch.service';
import { AssignDriverDto } from '../dto/assign-driver.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '../../../common/enums/user-role.enum';
import { ObjectIdPipe } from '../../../common/pipes/object-id.pipe';

/**
 * spec 004 US4: driver assignment is the Transportation Company's own
 * action, not the Fuel Company's — replacing the pre-004 single
 * `POST /dispatch/orders/:id` auto-select retry (FUEL_COMPANY_ADMIN). A Fuel
 * Company's own manual-resolution action now lives on the order itself
 * (`PATCH /orders/:id/route`, for an AWAITING_ROUTING order), not here.
 */
@Controller({ path: 'dispatch', version: '1' })
export class DispatchController {
  constructor(private readonly dispatchService: DispatchService) {}

  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
  @Get('orders/:id/candidates')
  getCandidates(@Param('id', ObjectIdPipe) id: string) {
    return this.dispatchService.getCandidates(id);
  }

  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
  @Post('orders/:id/assign')
  assign(@Param('id', ObjectIdPipe) id: string, @Body() dto: AssignDriverDto) {
    return this.dispatchService.assignDriver(id, dto.driverId, dto.truckId, dto.tankId, dto.reason);
  }
}
