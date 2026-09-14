import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PlatformOverviewService } from './platform-overview.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { PlatformOverviewDto } from './dto/platform-overview.dto';
import { TransportCompanyVolumeDto } from './dto/transport-company-volume.dto';

/**
 * spec 017 (operator dashboard) T029/T068a — the platform's own cross-company
 * figures.
 *
 * Every route here is `SUPER_ADMIN`-only (FR-007, FR-074) and has no
 * tenant-scoped equivalent: these questions have no answer for a company
 * administrator, which is why they live on their own controller rather than as
 * a role branch inside an existing one.
 */
@Roles(UserRole.SUPER_ADMIN)
@Controller({ path: 'platform', version: '1' })
export class PlatformController {
  constructor(private readonly platformOverviewService: PlatformOverviewService) {}

  @Get('overview')
  getOverview(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<PlatformOverviewDto> {
    const period = resolvePeriod(from, to);
    return this.platformOverviewService.getOverview(
      period.from,
      period.to,
      period.isDefault,
    );
  }

  @Get('transport-company-volumes')
  async getTransportCompanyVolumes(
    @Query('companyIds') companyIds: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{
    from: string;
    to: string;
    isDefault: boolean;
    items: TransportCompanyVolumeDto[];
  }> {
    if (!companyIds) {
      throw new BadRequestException('companyIds is required');
    }
    const period = resolvePeriod(from, to);
    const items = await this.platformOverviewService.getTransportCompanyVolumes(
      companyIds
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      period.from,
      period.to,
    );
    return {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      isDefault: period.isDefault,
      items,
    };
  }
}

/**
 * FR-005/FR-026a — the SAME resolution `OrdersController.summary` has always
 * used: absent boundaries mean the current calendar month.
 *
 * Shared by both routes above deliberately. The transporter volume column and
 * the home overview are read minutes apart under what the operator believes is
 * one date range; two independent defaults would make "this month" mean two
 * things on two screens, with nothing on either saying so.
 *
 * `isDefault` is returned rather than left to be inferred from the dates
 * (FR-005): a caller comparing the echoed range against its own month boundary
 * would be re-deriving a fact the platform already knows.
 */
function resolvePeriod(
  from?: string,
  to?: string,
): { from: Date; to: Date; isDefault: boolean } {
  const now = new Date();
  const isDefault = !from && !to;
  return {
    from: from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1),
    to: to ? new Date(to) : now,
    isDefault,
  };
}
