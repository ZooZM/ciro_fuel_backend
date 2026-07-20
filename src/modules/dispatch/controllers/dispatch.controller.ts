import { Controller, Param, Post } from '@nestjs/common';
import { DispatchService } from '../services/dispatch.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '../../../common/enums/user-role.enum';
import { ObjectIdPipe } from '../../../common/pipes/object-id.pipe';

@Controller({ path: 'dispatch', version: '1' })
export class DispatchController {
  constructor(private readonly dispatchService: DispatchService) {}

  /** Manual retry after a NO_ELIGIBLE_DRIVER outcome (FR-013). */
  @Roles(UserRole.COMPANY_ADMIN)
  @Post('orders/:id')
  dispatchOrder(@Param('id', ObjectIdPipe) id: string) {
    return this.dispatchService.assignDriver(id);
  }
}
