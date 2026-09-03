import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { StationsService } from './stations.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { SetFavouriteDto } from './dto/set-favourite.dto';
import { UpdateStationDto } from './dto/update-station.dto';
import { governorateBelongsToRegion } from '../regions/regions.constants';

/**
 * `GET /stations` lands in the Foundational phase (spec 005 T014) — needed
 * by US2 (station picker at order creation), US7 (profile) and US8
 * (station selection) alike, so it belongs before any one of those stories
 * rather than inside US8's phase. The remaining CLIENT and
 * FUEL_COMPANY_ADMIN routes below are US8 (T107/T108). `GET/POST
 * /users/:id/stations` live on `UsersController` instead — their path is
 * nested under `/users`, not `/stations`.
 */
@Controller({ path: 'stations', version: '1' })
export class StationsController {
  constructor(private readonly stationsService: StationsService) {}

  @Roles(UserRole.CLIENT)
  @Get()
  async findMine(@CurrentUser() user: AuthenticatedUser) {
    const items = await this.stationsService.findForClient(user.userId);
    return { items };
  }

  // spec 013 FR-025, R5, T058: every station of the acting fuel company, across all its
  // owners. No filter to write — `Station` is `markTenantScoped`, so the plugin already
  // confines this query. The spec's Dependencies section called this a platform
  // addition; it is this one route over an existing service call.
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get('all')
  async findAllForCompany(@Query('companyId') companyId?: string) {
    const items = await this.stationsService.findAllForCompany(companyId || undefined);
    return { items };
  }

  /** FR-036a/FR-037 — the only field a CLIENT may ever write on a station;
   * `SetFavouriteDto` whitelists it alone, so a rename/relocate attempt is a
   * 400 (Nest's `forbidNonWhitelisted`), not a silently-ignored no-op. */
  @Roles(UserRole.CLIENT)
  @Patch(':id/favourite')
  setFavourite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SetFavouriteDto,
  ) {
    return this.stationsService.setFavourite(id, user.userId, dto.isFavourite);
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id')
  update(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateStationDto) {
    if ((dto.regionCode == null) !== (dto.governorateCode == null)) {
      throw new BadRequestException('regionCode and governorateCode must be updated together');
    }
    if (
      dto.regionCode != null &&
      dto.governorateCode != null &&
      !governorateBelongsToRegion(dto.governorateCode, dto.regionCode)
    ) {
      throw new BadRequestException('governorateCode does not belong to regionCode');
    }
    return this.stationsService.update(id, {
      ...(dto.name != null ? { name: dto.name } : {}),
      ...(dto.regionCode != null ? { regionCode: dto.regionCode } : {}),
      ...(dto.governorateCode != null ? { governorateCode: dto.governorateCode } : {}),
      ...(dto.addressText != null ? { addressText: dto.addressText } : {}),
      ...(dto.location != null
        ? {
            location: {
              type: 'Point',
              coordinates: [dto.location.longitude, dto.location.latitude],
            } as never,
          }
        : {}),
    });
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ObjectIdPipe) id: string) {
    await this.stationsService.remove(id);
  }
}
