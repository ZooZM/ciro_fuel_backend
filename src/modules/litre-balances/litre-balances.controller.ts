import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { LitreBalancesService } from './litre-balances.service';
import { RecordCorrectionDto } from './dto/record-correction.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

// spec 013 Phase 14 (US11) — the fuel company's own view of its clients' litre balances.
// The station owner's own view lives on `UsersController` (`GET /users/me/litre-balances`),
// matching the `/users/me/credit-limit-requests` precedent.
@Controller({ path: 'litre-balances', version: '1' })
export class LitreBalancesController {
  constructor(private readonly litreBalancesService: LitreBalancesService) {}

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Get()
  async findForCompany(@Query('clientId') clientId?: string) {
    const items = await this.litreBalancesService.listForCompany(clientId || undefined);
    return { items };
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/corrections')
  correct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: RecordCorrectionDto,
  ) {
    return this.litreBalancesService.recordCorrection(id, dto.litres, dto.reason, user.userId);
  }
}
