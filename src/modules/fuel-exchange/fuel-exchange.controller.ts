import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { FuelExchangeService, ExchangeDirection } from './fuel-exchange.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { AwardOfferDto } from './dto/award-offer.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { ExchangeOfferState } from '../../common/enums/exchange-offer-state.enum';

const VALID_DIRECTIONS: ExchangeDirection[] = ['incoming', 'outgoing', 'all'];

/**
 * spec 016 (broadcast fuel exchange offers) — replaces spec 014's directed
 * `/fuel-exchange/requests` surface entirely (FR-040): no recipient is ever named, no
 * price is ever set by the raiser, and every write route admits `FUEL_COMPANY_ADMIN`
 * alone — `SUPER_ADMIN` reads everything and acts on nothing (FR-023), enforced here by
 * simply never naming it on a write route's `@Roles`, the same discipline the removed
 * controller already used for create/respond/withdraw.
 */
@Controller({ path: 'fuel-exchange/offers', version: '1' })
export class FuelExchangeController {
  constructor(private readonly fuelExchangeService: FuelExchangeService) {}

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOfferDto) {
    return this.fuelExchangeService.create(user.companyId!, user.userId, dto);
  }

  // Registered BEFORE `:id` — a literal path segment is otherwise swallowed by the
  // param route and fails `ObjectIdPipe` (the trap `GET /companies/exchange-partners`
  // already documented, T093).
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.fuelExchangeService.summary(user.companyId!);
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('direction') direction: string = 'all',
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (!VALID_DIRECTIONS.includes(direction as ExchangeDirection)) {
      throw new BadRequestException('direction must be one of incoming, outgoing, all');
    }
    if (state && !Object.values(ExchangeOfferState).includes(state as ExchangeOfferState)) {
      throw new BadRequestException('state is not a recognised exchange offer state');
    }
    if (user.role === UserRole.SUPER_ADMIN) {
      return this.fuelExchangeService.findAllForOperator(cursor || undefined);
    }
    return this.fuelExchangeService.findAll(
      user.companyId!,
      direction as ExchangeDirection,
      state as ExchangeOfferState | undefined,
      cursor || undefined,
    );
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    return this.fuelExchangeService.findOne(id, user.companyId, user.role);
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/proposals')
  propose(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: CreateProposalDto,
  ) {
    return this.fuelExchangeService.propose(id, user.companyId!, user.userId, dto);
  }

  // 200, not the `@Post` default 201 — this resolves an EXISTING offer rather than
  // creating a new resource (contracts/rest-api-delta.md).
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/award')
  @HttpCode(200)
  award(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: AwardOfferDto,
  ) {
    return this.fuelExchangeService.award(id, user.companyId!, user.userId, dto.proposalId);
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/withdraw')
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    return this.fuelExchangeService.withdraw(id, user.companyId!, user.userId);
  }
}
