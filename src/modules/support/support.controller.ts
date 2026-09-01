import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { SupportService } from './support.service';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

@Controller({ path: 'support/requests', version: '1' })
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Roles(UserRole.CLIENT)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSupportRequestDto) {
    return this.supportService.create(user.userId, String(user.companyId), dto);
  }

  /** CLIENT sees their own; FUEL_COMPANY_ADMIN sees their company's whole
   * set (the tenant plugin scopes that automatically) — same route,
   * per-role query, matching the split `GET /users/me/credit`-style
   * routes elsewhere use a dedicated path for instead only because this
   * one needs no `me`-vs-`:id` disambiguation. */
  @Roles(UserRole.CLIENT, UserRole.FUEL_COMPANY_ADMIN)
  @Get()
  async findAll(@CurrentUser() user: AuthenticatedUser) {
    const items =
      user.role === UserRole.CLIENT
        ? await this.supportService.findForClient(user.userId)
        : await this.supportService.findForCompany();
    return { items };
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/acknowledge')
  acknowledge(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    return this.supportService.acknowledge(id, user.userId);
  }
}
