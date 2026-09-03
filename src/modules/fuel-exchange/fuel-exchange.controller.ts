import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { FuelExchangeService, ExchangeDirection } from './fuel-exchange.service';
import { CompaniesService } from '../companies/companies.service';
import { CreateExchangeRequestDto } from './dto/create-exchange-request.dto';
import { RespondExchangeRequestDto } from './dto/respond-exchange-request.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

const VALID_DIRECTIONS: ExchangeDirection[] = ['incoming', 'outgoing', 'all'];

@Controller({ path: 'fuel-exchange/requests', version: '1' })
export class FuelExchangeController {
  constructor(
    private readonly fuelExchangeService: FuelExchangeService,
    private readonly companiesService: CompaniesService,
  ) {}

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateExchangeRequestDto) {
    return this.fuelExchangeService.create(user.companyId!, user.userId, dto);
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('direction') direction: string = 'all',
    @Query('cursor') cursor?: string,
  ) {
    if (!VALID_DIRECTIONS.includes(direction as ExchangeDirection)) {
      throw new BadRequestException('direction must be one of incoming, outgoing, all');
    }
    // SUPER_ADMIN bypasses the party-set plugin entirely (contract's bypass row) — every
    // request, from every company. `direction` is meaningless for an actor with no
    // company of their own, so it is ignored rather than built into a filter that would
    // try to construct an ObjectId from an absent companyId.
    if (user.role === UserRole.SUPER_ADMIN) {
      return this.fuelExchangeService.findForUser('', 'all', cursor || undefined);
    }
    return this.fuelExchangeService.findForUser(
      user.companyId!,
      direction as ExchangeDirection,
      cursor || undefined,
    );
  }

  /** T223/FR-086b — the counterparty's contact details, resolved server-side from
   * whichever party is NOT the caller. Disclosed only because the party-set plugin's own
   * scoping already proved the caller is one of the two parties before this runs. */
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get(':id')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const request = await this.fuelExchangeService.findById(id);
    const counterpartyId =
      String(request.raisedByCompanyId) === user.companyId ? request.recipientCompanyId : request.raisedByCompanyId;
    const counterparty = await this.companiesService.findById(counterpartyId);
    return {
      ...request.toObject(),
      counterparty: {
        _id: counterparty._id,
        name: counterparty.name,
        contactEmail: counterparty.contactEmail,
        contactPhone: counterparty.contactPhone,
      },
    };
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/respond')
  respond(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: RespondExchangeRequestDto,
  ) {
    return this.fuelExchangeService.respond(id, user.companyId!, user.userId, dto.accept);
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/withdraw')
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    return this.fuelExchangeService.withdraw(id, user.companyId!, user.userId);
  }
}
