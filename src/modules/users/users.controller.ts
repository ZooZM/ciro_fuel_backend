import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { UsersService } from './users.service';
import { FilesService } from '../files/files.service';
import { FilePurpose } from '../files/schemas/file.schema';
import { CreateUserDto, StationDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetCreditLimitDto } from './dto/set-credit-limit.dto';
import { RequestPhoneVerificationDto } from './dto/request-phone-verification.dto';
import { ConfirmPhoneVerificationDto } from './dto/confirm-phone-verification.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { roundCurrency } from '../../common/constants/money.constants';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { governorateBelongsToRegion } from '../regions/regions.constants';
import { StationsService } from '../stations/stations.service';
import { InvoicesService } from '../invoices/invoices.service';
import { PhoneVerificationService } from './services/phone-verification.service';
import { CreditLimitRequestsService } from './services/credit-limit-requests.service';
import { LitreBalancesService } from '../litre-balances/litre-balances.service';
import { CreateCreditLimitRequestDto } from './dto/create-credit-limit-request.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { CompaniesService } from '../companies/companies.service';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import { SessionAuditService } from '../sessions/session-audit.service';
import { SessionRevocationCause } from '../../common/enums/session-revocation-cause.enum';
import { RealtimeGatewayService } from '../../common/realtime/realtime-gateway.service';

const SESSION_REVOKED_EVENT = 'session:revoked';

@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly filesService: FilesService,
    private readonly stationsService: StationsService,
    private readonly invoicesService: InvoicesService,
    private readonly phoneVerificationService: PhoneVerificationService,
    private readonly creditLimitRequestsService: CreditLimitRequestsService,
    private readonly litreBalancesService: LitreBalancesService,
    private readonly notificationsService: NotificationsService,
    private readonly companiesService: CompaniesService,
    private readonly sessionAudit: SessionAuditService,
    private readonly realtimeGateway: RealtimeGatewayService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // Split by tier (spec 004 FR-004a and its symmetric driver-fleet
  // counterpart): a FUEL_COMPANY_ADMIN provisions CLIENT accounts only —
  // clients are the Fuel Company's own relationship, never the
  // transporter's. A TRANSPORT_COMPANY_ADMIN provisions DRIVER accounts
  // only — the fleet is exclusively theirs. Neither may create the other's
  // role, even though both reach this one endpoint.
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.TRANSPORT_COMPANY_ADMIN)
  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    if (!user.companyId) {
      throw new BadRequestException('Acting user must belong to a company');
    }
    if (user.role === UserRole.FUEL_COMPANY_ADMIN && dto.role !== UserRole.CLIENT) {
      throw new ForbiddenException('A Fuel Company may only create CLIENT accounts');
    }
    if (user.role === UserRole.TRANSPORT_COMPANY_ADMIN && dto.role !== UserRole.DRIVER) {
      throw new ForbiddenException('A Transportation Company may only create DRIVER accounts');
    }
    if (dto.role === UserRole.CLIENT && !dto.station) {
      throw new BadRequestException('station is required for CLIENT accounts');
    }
    if (
      dto.role === UserRole.CLIENT &&
      !governorateBelongsToRegion(dto.station!.governorateCode, dto.station!.regionCode)
    ) {
      throw new BadRequestException('governorateCode does not belong to regionCode');
    }
    const created = await this.usersService.create({
      companyId: user.companyId as never,
      role: dto.role,
      email: dto.email,
      password: dto.password,
      fullName: dto.fullName,
      phone: dto.phone,
      isActive: true,
      ...(dto.role === UserRole.CLIENT
        ? {
            // Kept for backward compatibility only (spec 005 data-model.md)
            // — no new code path reads this field; StationsService.create
            // below is what actually seeds the client's station going
            // forward. Left in place because client-station.e2e-spec.ts
            // and every other pre-005 consumer still exercise it directly.
            station: {
              regionCode: dto.station!.regionCode,
              governorateCode: dto.station!.governorateCode,
              location: {
                type: 'Point',
                coordinates: [dto.station!.location.longitude, dto.station!.location.latitude],
              },
              // Never re-derived from the pin on a later read (FR-012) —
              // whatever the client edits it to (or leaves empty, FR-013) is
              // exactly what's stored.
              addressText: dto.station!.addressText ?? '',
              name: dto.station!.name,
            } as never,
          }
        : {}),
      ...(dto.role === UserRole.DRIVER
        ? {
            isAvailable: true,
            isOnline: false,
          }
        : {}),
    });

    // spec 005 D2: a client's real station now lives in its own collection,
    // not just the legacy embedded field above — created here so a client
    // has a genuine Station document (and passes GET /stations, FR-036a)
    // from the moment they're onboarded, not only after the migration or an
    // admin's first visit to the (not-yet-built) station management screen.
    if (dto.role === UserRole.CLIENT) {
      await this.stationsService.create(String(created._id), String(user.companyId), {
        name: dto.station!.name,
        regionCode: dto.station!.regionCode,
        governorateCode: dto.station!.governorateCode,
        location: {
          type: 'Point',
          coordinates: [dto.station!.location.longitude, dto.station!.location.latitude],
        } as never,
        addressText: dto.station!.addressText,
      });
    }

    return created;
  }

  // Tenant-scoped automatically (the existing single-tenant plugin, unchanged):
  // a FUEL_COMPANY_ADMIN sees their own clients/admins, a
  // TRANSPORT_COMPANY_ADMIN sees their own drivers — never each other's.
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.TRANSPORT_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  findAll(
    @Query('role') role?: UserRole,
    @Query('isActive') isActive?: string,
    @Query('companyId') companyId?: string,
  ) {
    // An empty value (`?role=&isActive=`, which is what an unset filter in a UI
    // sends) means "no filter" — not "match empty" or "match inactive". `companyId`
    // is safe to accept from any role: the tenant-scope plugin's own `.where()`
    // OVERWRITES this key for FUEL_COMPANY_ADMIN/TRANSPORT_COMPANY_ADMIN regardless
    // of what's passed (same override precedent the plugin's own tests assert), so
    // it is only ever load-bearing for SUPER_ADMIN, who bypasses the plugin (T238/US13).
    return this.usersService.findAll({
      role: role || undefined,
      isActive: isActive ? isActive === 'true' : undefined,
      companyId: companyId || undefined,
    });
  }

  /**
   * spec 005 T081/FR-026: the CLIENT's own credit standing, computed live
   * from the same derivation `InvoicesService.getAvailableCredit` already
   * uses to refuse an over-limit order — nothing here is a second,
   * independently stored figure that could drift from it. Registered
   * ahead of `GET /users/:id` below; Nest matches routes in declaration
   * order, so `:id` would otherwise swallow `me` as an id.
   */
  @Roles(UserRole.CLIENT)
  @Get('me/credit')
  async myCredit(@CurrentUser() user: AuthenticatedUser) {
    const client = await this.usersService.findById(user.userId);
    if (client.creditLimit == null) {
      return { creditLimit: null, consumed: null, available: null };
    }
    const available = await this.invoicesService.getAvailableCredit(user.userId);
    return {
      creditLimit: client.creditLimit,
      // Rounded because the subtraction is floating point: a limit of
      // 1000000 less an available 987094.12 evaluates to
      // 12905.880000000005, and this figure is rendered to the client as
      // money on both the dashboard and the credit screen (FR-026/FR-029).
      consumed: roundCurrency(client.creditLimit - available),
      available,
    };
  }

  /**
   * spec 013 FR-029 — the owner raises a request for a higher limit. `me` resolves to
   * the caller (`JwtStrategy`), never a param. Registered here, ahead of `GET
   * /users/:id` below, for the exact reason `me/credit` above states.
   */
  @Roles(UserRole.CLIENT)
  @Post('me/credit-limit-requests')
  async createCreditLimitRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCreditLimitRequestDto,
  ) {
    if (!user.companyId) {
      throw new BadRequestException('Invalid session');
    }
    return this.creditLimitRequestsService.create(user.userId, user.companyId, dto.requestedAmount);
  }

  // spec 013 FR-029 — the owner's own history and outcomes.
  @Roles(UserRole.CLIENT)
  @Get('me/credit-limit-requests')
  async findMyCreditLimitRequests(@CurrentUser() user: AuthenticatedUser) {
    const items = await this.creditLimitRequestsService.findForClient(user.userId);
    return { items };
  }

  // spec 013 T198/FR-075a/FR-076 — the station owner's own balances, movements
  // included, never anyone else's. Registered here (not on LitreBalancesController)
  // for the same `/users/me/...` convention the two routes above already follow.
  @Roles(UserRole.CLIENT)
  @Get('me/litre-balances')
  async findMyLitreBalances(@CurrentUser() user: AuthenticatedUser) {
    const items = await this.litreBalancesService.listForClient(user.userId);
    return { items };
  }

  /** spec 005 T097/FR-035 — any authenticated role may change their own
   * phone; per-user throttled (T098), never the global per-IP guard. */
  @UseGuards(UserThrottlerGuard)
  @Throttle({ perUser: { limit: 3, ttl: 15 * 60_000 } })
  @HttpCode(202)
  @Post('me/phone/verification')
  requestPhoneVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestPhoneVerificationDto,
  ) {
    return this.phoneVerificationService.requestVerification(user.userId, dto.newPhone);
  }

  // The 5-attempts-per-code limit is enforced by PhoneVerificationService
  // itself (OtpPrimitivesService's lockout, keyed to the specific code's
  // own record) — not a `@nestjs/throttler` time window, which has no
  // concept of "per code". A locked-out attempt still surfaces as 429.
  @Post('me/phone/verification/confirm')
  confirmPhoneVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmPhoneVerificationDto,
  ) {
    return this.phoneVerificationService.confirm(user.userId, dto.code);
  }

  /** spec 005 T108 — a station is provisioned for a specific client, hence
   * nested under `/users` rather than `/stations`. `findById` is itself
   * tenant-scoped (the plugin merges the admin's own `companyId` into the
   * query), so a foreign or nonexistent id 404s here before any station
   * work happens — the same fail-closed check `setCreditLimit` above uses. */
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Get(':id/stations')
  async findClientStations(@Param('id', ObjectIdPipe) id: string) {
    const target = await this.usersService.findById(id);
    if (target.role !== UserRole.CLIENT) {
      throw new BadRequestException('Stations may only be listed for CLIENT accounts');
    }
    const items = await this.stationsService.findForClientAsAdmin(id);
    return { items };
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/stations')
  async createClientStation(@Param('id', ObjectIdPipe) id: string, @Body() dto: StationDto) {
    const target = await this.usersService.findById(id);
    if (target.role !== UserRole.CLIENT) {
      throw new BadRequestException('Stations may only be created for CLIENT accounts');
    }
    if (!governorateBelongsToRegion(dto.governorateCode, dto.regionCode)) {
      throw new BadRequestException('governorateCode does not belong to regionCode');
    }
    return this.stationsService.create(id, String(target.companyId), {
      name: dto.name,
      regionCode: dto.regionCode,
      governorateCode: dto.governorateCode,
      location: {
        type: 'Point',
        coordinates: [dto.location.longitude, dto.location.latitude],
      } as never,
      addressText: dto.addressText,
    });
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    if (
      user.role !== UserRole.FUEL_COMPANY_ADMIN &&
      user.role !== UserRole.TRANSPORT_COMPANY_ADMIN &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.userId !== id
    ) {
      throw new ForbiddenException('May only view your own profile');
    }
    const target = await this.usersService.findById(id);
    // spec 006 FR-002: `companyName` is the only field this endpoint adds.
    // `companyName` is undefined for every non-DRIVER role, matching how
    // `/auth/me`'s `station`/`creditLimit` are CLIENT-only.
    if (target.role !== UserRole.DRIVER || !target.companyId) {
      return target;
    }
    return {
      ...target.toObject(),
      companyName: await this.companiesService.findNameById(target.companyId),
    };
  }

  /** role/companyId are immutable and never accepted here — UpdateUserDto whitelists only fullName/phone. */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    if (
      user.role !== UserRole.FUEL_COMPANY_ADMIN &&
      user.role !== UserRole.TRANSPORT_COMPANY_ADMIN &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.userId !== id
    ) {
      throw new ForbiddenException('May only update your own profile');
    }
    return this.usersService.update(id, dto);
  }

  // The underlying update is tenant-scoped automatically (the target's
  // companyId must match the acting admin's own) — a FUEL_COMPANY_ADMIN
  // activating a driver that now belongs to some Transportation Company
  // simply finds no match (404), same as any other cross-tenant id.
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.TRANSPORT_COMPANY_ADMIN)
  @Patch(':id/activate')
  activate(@Param('id', ObjectIdPipe) id: string) {
    return this.usersService.setActive(id, true);
  }

  /**
   * spec 006 FR-035/036/038/042: deactivation also ends the target's live
   * session — bump + push + audit row, all in the same transaction as the
   * deactivation itself (Principle V), same as sign-out and login's
   * displacement of a prior session. FR-038: the driver's own busy markers
   * are cleared (`releaseActiveOrderOnDeactivation`) so dispatch stops
   * treating them as unavailable; the order they were carrying is left
   * exactly as `orders.service.ts` leaves it whenever a driver is released
   * — no new order state is invented here.
   */
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.TRANSPORT_COMPANY_ADMIN)
  @Patch(':id/deactivate')
  async deactivate(@Param('id', ObjectIdPipe) id: string) {
    const session = await this.connection.startSession();
    let revoked!: Awaited<ReturnType<UsersService['revokeAllSessions']>>;
    try {
      await session.withTransaction(async () => {
        await this.usersService.setActive(id, false, session);
        // spec 015 FR-037: `revokeAllSessions` bumps `sessionGeneration` AND
        // clears `activeSessions`, so an administrator's every device ends
        // too — not only a driver's one session.
        revoked = await this.usersService.revokeAllSessions(
          id,
          SessionRevocationCause.ACCOUNT_DEACTIVATED,
          session,
        );
        await this.usersService.releaseActiveOrderOnDeactivation(id, session);
        await this.sessionAudit.revoked(
          {
            userId: id,
            companyId: revoked.companyId?.toString(),
            role: revoked.role,
            generation: revoked.sessionGeneration ?? 0,
          },
          SessionRevocationCause.ACCOUNT_DEACTIVATED,
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    this.realtimeGateway.emitToUser(id, SESSION_REVOKED_EVENT, {
      cause: SessionRevocationCause.ACCOUNT_DEACTIVATED,
      occurredAt: new Date().toISOString(),
    });

    return revoked;
  }

  /**
   * spec 013 (fuel company admin dashboard) T077 — the admin-facing read counterpart to
   * `GET /users/me/credit` (CLIENT-only, above): the dashboard's owner-detail screen
   * needs to SHOW a client's standing without mutating it, and no such route existed
   * before this feature. Tenant-scoped automatically via `findById`, same as
   * `setCreditLimit` below — a foreign or nonexistent client 404s here before the
   * credit derivation runs.
   */
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Get(':id/credit-limit')
  async getCreditLimit(@Param('id', ObjectIdPipe) id: string) {
    const target = await this.usersService.findById(id);
    if (target.role !== UserRole.CLIENT) {
      throw new BadRequestException('creditLimit may only be read for CLIENT accounts');
    }
    if (target.creditLimit == null) {
      return { creditLimit: null, consumed: null, available: null };
    }
    const available = await this.invoicesService.getAvailableCredit(id);
    return {
      creditLimit: target.creditLimit,
      consumed: roundCurrency(target.creditLimit - available),
      available,
    };
  }

  // Tenant-scoped automatically (the target must be the acting admin's own
  // client) — spec 004 FR-023: only a Fuel Company sets its clients' credit
  // limits, never a Transportation Company or the client themselves.
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Put(':id/credit-limit')
  async setCreditLimit(@Param('id', ObjectIdPipe) id: string, @Body() dto: SetCreditLimitDto) {
    const target = await this.usersService.findById(id);
    if (target.role !== UserRole.CLIENT) {
      throw new BadRequestException('creditLimit may only be set on CLIENT accounts');
    }
    const updated = await this.usersService.setCreditLimit(id, dto.creditLimit);
    // spec 013 FR-032: a limit lowered below what the owner has already drawn is
    // PERMITTED, but the consequence must be stated explicitly, never left as a silent
    // negative remainder — `available` here reflects the NEW limit against the same
    // outstanding balance `getAvailableCredit` already computes for the CLIENT-facing
    // `GET /users/me/credit`, so it can genuinely go negative.
    const available = await this.invoicesService.getAvailableCredit(id);
    return {
      creditLimit: updated.creditLimit,
      available,
      consumed: roundCurrency((updated.creditLimit ?? 0) - available),
    };
  }

  /** Self-service or admin-managed avatar upload — feeds a user's profilePictureFileId. */
  @Patch(':id/profile-picture')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProfilePicture(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (
      user.role !== UserRole.FUEL_COMPANY_ADMIN &&
      user.role !== UserRole.TRANSPORT_COMPANY_ADMIN &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.userId !== id
    ) {
      throw new ForbiddenException('May only update your own profile picture');
    }
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!user.companyId) {
      throw new BadRequestException('Only company-scoped users may upload files here');
    }
    // spec 012 T063: Multer now uses `memoryStorage` under every driver, so
    // this arrives holding a buffer rather than a path to bytes already on
    // disk. `store` writes them through the configured FileStorage and records
    // the metadata only after they land (FR-041).
    const fileRecord = await this.filesService.store({
      companyId: user.companyId,
      ownerUserId: id,
      purpose: FilePurpose.PROFILE_PICTURE,
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });
    return this.usersService.update(id, { profilePictureFileId: fileRecord._id as never });
  }
}
