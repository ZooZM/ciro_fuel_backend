import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from '@nestjs/common';
import { TanksService } from './tanks.service';
import { CreateTankDto } from './dto/create-tank.dto';
import { UpdateTankDto } from './dto/update-tank.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { TankDocument } from './schemas/tank.schema';

/**
 * Every read here maps through {@link toSafeShape}, exactly as
 * `TrucksController` does — a tank and a truck are picked side by side in the
 * same assignment dialog, so the two MUST agree on how they name an id.
 *
 * They did not. This controller returned the raw Mongoose documents, whose
 * identifier is `_id`, while trucks returned a mapped `id`. A caller holding
 * one type for both (the dashboard does, and so does
 * `scripts/seed-dashboard-actors.ts`) read `tank.id` as `undefined` and sent
 * `tankId: undefined` to `POST /dispatch/orders/:id/assign` — refused with
 * "tankId must be a mongodb id", or, where the caller guarded against its own
 * empty value first, refused with no request and no message at all.
 *
 * `activeOrderId` is normalised to `null` rather than left absent for the same
 * reason: the field is optional on the schema (present ⇒ committed, FR-048f),
 * so a free tank simply omitted it, and `'activeOrderId' in tank` answered a
 * different question from `tank.activeOrderId === null`.
 */
@Controller({ path: 'tanks', version: '1' })
@Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
export class TanksController {
  constructor(private readonly tanksService: TanksService) {}

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTankDto) {
    const tank = await this.tanksService.create(this.requireCompanyId(user), dto);
    return this.toSafeShape(tank);
  }

  @Get()
  async findAll(@CurrentUser() user: AuthenticatedUser) {
    const { items, fleetRegistered } = await this.tanksService.findAll(this.requireCompanyId(user));
    return { items: items.map((t) => this.toSafeShape(t)), fleetRegistered };
  }

  @Get(':id')
  async findOne(@Param('id', ObjectIdPipe) id: string) {
    const tank = await this.tanksService.findById(id);
    return this.toSafeShape(tank);
  }

  @Patch(':id')
  async update(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateTankDto) {
    const tank = await this.tanksService.update(id, dto);
    return this.toSafeShape(tank);
  }

  @Patch(':id/withdraw')
  async withdraw(@Param('id', ObjectIdPipe) id: string) {
    const tank = await this.tanksService.withdraw(id);
    return this.toSafeShape(tank);
  }

  @Patch(':id/restore')
  async restore(@Param('id', ObjectIdPipe) id: string) {
    const tank = await this.tanksService.restore(id);
    return this.toSafeShape(tank);
  }

  private toSafeShape(tank: TankDocument) {
    return {
      id: String(tank._id),
      companyId: String(tank.companyId),
      code: tank.code,
      material: tank.material,
      maxCapacityLiters: tank.maxCapacityLiters,
      fuelTypes: tank.fuelTypes,
      isActive: tank.isActive,
      activeOrderId: tank.activeOrderId ? String(tank.activeOrderId) : null,
    };
  }

  private requireCompanyId(user: AuthenticatedUser): string {
    if (!user.companyId) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user.companyId;
  }
}
