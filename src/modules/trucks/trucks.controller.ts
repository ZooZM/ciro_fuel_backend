import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { TrucksService } from './trucks.service';
import { CreateTruckDto } from './dto/create-truck.dto';
import { UpdateTruckDto } from './dto/update-truck.dto';
import { PairCardDto } from './dto/pair-card.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { TruckDocument } from './schemas/truck.schema';

/**
 * FR-042: a truck's `nfcCardUid`/`qrToken` are credentials, never surfaced by
 * any read here — every response maps through {@link toSafeShape}, which
 * replaces them with `hasCard`/`hasCode` booleans. The mint/rotate endpoints
 * are the sole exception (they are the one legitimate reason the platform
 * ever hands a token back), and even those return it once, at mint time,
 * not as a persisted readable field.
 */
@Controller({ path: 'trucks', version: '1' })
@Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
export class TrucksController {
  constructor(private readonly trucksService: TrucksService) {}

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTruckDto) {
    const truck = await this.trucksService.create(this.requireCompanyId(user), dto);
    return this.toSafeShape(truck);
  }

  @Get()
  async findAll(@CurrentUser() user: AuthenticatedUser, @Query('available') available?: string) {
    const { items, fleetRegistered } = await this.trucksService.findAll(
      this.requireCompanyId(user),
      { availableOnly: available === 'true' },
    );
    return { items: items.map((t) => this.toSafeShape(t)), fleetRegistered };
  }

  @Get(':id')
  async findOne(@Param('id', ObjectIdPipe) id: string) {
    const truck = await this.trucksService.findById(id);
    return this.toSafeShape(truck);
  }

  @Patch(':id')
  async update(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateTruckDto) {
    const truck = await this.trucksService.update(id, dto);
    return this.toSafeShape(truck);
  }

  @Patch(':id/withdraw')
  async withdraw(@Param('id', ObjectIdPipe) id: string) {
    const truck = await this.trucksService.withdraw(id);
    return this.toSafeShape(truck);
  }

  @Patch(':id/restore')
  async restore(@Param('id', ObjectIdPipe) id: string) {
    const truck = await this.trucksService.restore(id);
    return this.toSafeShape(truck);
  }

  @Post(':id/pair-card')
  async pairCard(@Param('id', ObjectIdPipe) id: string, @Body() dto: PairCardDto) {
    const truck = await this.trucksService.pairCard(id, dto.nfcCardUid);
    return this.toSafeShape(truck);
  }

  // The one endpoint permitted to return the raw token (FR-042 exception).
  @Post(':id/qr-token')
  async mintQrToken(@Param('id', ObjectIdPipe) id: string) {
    const { truck, qrToken } = await this.trucksService.mintQrToken(id);
    return { ...this.toSafeShape(truck), qrToken };
  }

  @Post(':id/qr-token/rotate')
  async rotateQrToken(@Param('id', ObjectIdPipe) id: string) {
    const { truck, qrToken } = await this.trucksService.rotateQrToken(id);
    return { ...this.toSafeShape(truck), qrToken };
  }

  @Patch(':id/qr-token/revoke')
  async revokeQrToken(@Param('id', ObjectIdPipe) id: string) {
    const truck = await this.trucksService.revokeQrToken(id);
    return this.toSafeShape(truck);
  }

  private requireCompanyId(user: AuthenticatedUser): string {
    if (!user.companyId) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user.companyId;
  }

  private toSafeShape(truck: TruckDocument) {
    return {
      id: String(truck._id),
      companyId: String(truck.companyId),
      plateNumber: truck.plateNumber,
      model: truck.model ?? null,
      hasCard: Boolean(truck.nfcCardUid),
      hasCode: Boolean(truck.qrToken),
      isActive: truck.isActive,
      activeOrderId: truck.activeOrderId ? String(truck.activeOrderId) : null,
    };
  }
}
