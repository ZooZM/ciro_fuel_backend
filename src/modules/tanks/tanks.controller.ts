import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from '@nestjs/common';
import { TanksService } from './tanks.service';
import { CreateTankDto } from './dto/create-tank.dto';
import { UpdateTankDto } from './dto/update-tank.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

@Controller({ path: 'tanks', version: '1' })
@Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
export class TanksController {
  constructor(private readonly tanksService: TanksService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTankDto) {
    return this.tanksService.create(this.requireCompanyId(user), dto);
  }

  @Get()
  async findAll(@CurrentUser() user: AuthenticatedUser) {
    const { items, fleetRegistered } = await this.tanksService.findAll(this.requireCompanyId(user));
    return { items, fleetRegistered };
  }

  @Get(':id')
  findOne(@Param('id', ObjectIdPipe) id: string) {
    return this.tanksService.findById(id);
  }

  @Patch(':id')
  update(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateTankDto) {
    return this.tanksService.update(id, dto);
  }

  @Patch(':id/withdraw')
  withdraw(@Param('id', ObjectIdPipe) id: string) {
    return this.tanksService.withdraw(id);
  }

  @Patch(':id/restore')
  restore(@Param('id', ObjectIdPipe) id: string) {
    return this.tanksService.restore(id);
  }

  private requireCompanyId(user: AuthenticatedUser): string {
    if (!user.companyId) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user.companyId;
  }
}
