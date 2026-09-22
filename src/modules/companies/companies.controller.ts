import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { CompaniesService } from './companies.service';
import { CompanyDocument } from './schemas/company.schema';
import { UsersService } from '../users/users.service';
import { FilesService } from '../files/files.service';
import { FilePurpose } from '../files/schemas/file.schema';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from '../files/files.constants';
import { CreateFuelCompanyDto } from './dto/create-fuel-company.dto';
import { CreateTransportCompanyDto } from './dto/create-transport-company.dto';
import { OnboardTransportCompanyDto } from './dto/onboard-transport-company.dto';
import { AssignRegionsDto } from './dto/assign-regions.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';
import { SetFuelPricesDto } from './dto/set-fuel-prices.dto';
import { SetPricingConfigDto } from './dto/set-pricing-config.dto';
import { SetDeliveryRatesDto } from './dto/set-delivery-rates.dto';
import { SetCommissionCeilingDto } from './dto/set-commission-ceiling.dto';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { CompanyStatus } from '../../common/enums/company-status.enum';
import { CompanyType } from '../../common/enums/company-type.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { governorateBelongsToRegion } from '../regions/regions.constants';
import { parseEnumQuery } from '../../common/validation/parse-enum-query';

@Controller({ path: 'companies', version: '1' })
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly usersService: UsersService,
    private readonly filesService: FilesService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  @Roles(UserRole.SUPER_ADMIN)
  @Post()
  @UseInterceptors(
    FileInterceptor('commercialRegister', {
      storage: memoryStorage(), // company doesn't exist yet — no companyId to key a disk path on
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(new BadRequestException(`Unsupported file type: ${file.mimetype}`), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async create(
    @UploadedFile() commercialRegister: Express.Multer.File | undefined,
    @Body() dto: CreateFuelCompanyDto,
  ) {
    // This endpoint predates the multi-tier hierarchy (feature 001) and has
    // always created what is now unambiguously a Fuel Company — the sole
    // tenant root that owns pricing, clients and transporters.
    //
    // Company and admin are one unit of work, for the same reason as
    // `createTransporter` below: a duplicate admin email or phone used to leave
    // a committed, admin-less company squatting a platform-unique name.
    //
    // The commercial register is deliberately handled AFTER the commit. Its blob
    // goes to object storage, which no Mongo transaction can roll back — writing
    // it inside would leak an unreferenced object on exactly the failures this
    // transaction exists to undo. Ordered this way, a failed onboard writes no
    // blob at all, and a file failure afterwards leaves a usable company whose
    // register can simply be re-uploaded.
    const session = await this.connection.startSession();
    let company!: CompanyDocument;
    let admin!: Awaited<ReturnType<UsersService['create']>>;
    try {
      await session.withTransaction(async () => {
        company = await this.companiesService.create(
          {
            name: dto.name,
            type: CompanyType.FUEL,
            contactEmail: dto.contactEmail,
            contactPhone: dto.contactPhone,
            status: CompanyStatus.ACTIVE,
            fuelPrices: [],
          },
          session,
        );

        admin = await this.usersService.create(
          {
            companyId: company._id as never,
            role: UserRole.FUEL_COMPANY_ADMIN,
            email: dto.adminEmail,
            password: dto.adminPassword,
            fullName: dto.adminFullName,
            phone: dto.adminPhone,
            isActive: true,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    if (commercialRegister) {
      // spec 012 T063: `writeBufferAndRecord` and `recordUpload` collapsed into
      // one `store` once Multer moved to `memoryStorage` everywhere — both
      // callers now arrive holding a buffer, so the second write path (which
      // wrote straight to local disk) had no reason to exist and would have
      // been the one still writing to a disk production no longer has.
      const fileRecord = await this.filesService.store({
        companyId: company._id as never,
        purpose: FilePurpose.COMMERCIAL_REGISTER,
        buffer: commercialRegister.buffer,
        mimeType: commercialRegister.mimetype,
        originalName: commercialRegister.originalname,
      });
      await this.companiesService.setCommercialRegisterFile(
        String(company._id),
        fileRecord._id as never,
      );
    }

    return {
      company: await this.companiesService.findById(String(company._id)),
      admin: { id: admin._id, email: admin.email },
    };
  }

  // CIRO sees every Fuel Company; a FUEL_COMPANY_ADMIN sees only their own
  // (spec 004 US1) — narrowed in the service, not by an extra route.
  @Roles(UserRole.SUPER_ADMIN, UserRole.FUEL_COMPANY_ADMIN)
  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    // spec 017 (operator dashboard) FR-010/FR-013: until now this handler bound
    // NO query parameters at all. The dashboard has been sending `?type=FUEL`
    // since feature 013 and the platform has never read it, so the operator's
    // fuel-company list and its count card have been counting transporters
    // (research R2). Both filters are validated here and passed through on BOTH
    // branches — a filter that applied only to the operator would leave FR-012
    // unasserted on the branch that actually needs it.
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    const filter = {
      type: parseEnumQuery(CompanyType, type, 'type'),
      status: parseEnumQuery(CompanyStatus, status, 'status'),
    };
    if (user.role === UserRole.SUPER_ADMIN) {
      return this.companiesService.findAll(filter);
    }
    // `Company` has no automatic isolation plugin (it is the tenant root),
    // so this endpoint is the enforcement point. A non-SUPER_ADMIN with no
    // companyId is a data-integrity problem (never a valid state a real
    // login produces) — it must fail closed, not silently fall through to
    // findAll()'s "no filter" meaning and list every tenant's company.
    if (!user.companyId) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // FR-012: the type/status filters INTERSECT this narrowing, never widen it.
    return this.companiesService.findAll({ ...filter, id: user.companyId });
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const company = await this.companiesService.findById(id);
    // Unlike the other :id-scoped routes below, a company lookup must also
    // let a Fuel Company admin read one of their OWN transporters (spec 004
    // US2/T032) — not just their own company — since that transporter's id
    // never equals the acting admin's own companyId.
    await this.assertCompanyReadAccess(user, company);
    return company;
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Patch(':id/status')
  setStatus(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateCompanyStatusDto) {
    return this.companiesService.setStatus(id, dto.status);
  }

  @Get(':id/fuel-prices')
  async getFuelPrices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    this.assertCompanyAccess(user, id);
    const company = await this.companiesService.findById(id);
    return company.fuelPrices;
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Put(':id/fuel-prices')
  async setFuelPrices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SetFuelPricesDto,
  ) {
    this.assertCompanyAccess(user, id);
    return this.companiesService.setFuelPrices(id, dto.prices);
  }

  // spec 005 T053: same access rule as fuel-prices above — a CLIENT reads
  // their own fuel company's configuration (needed for the quote screen),
  // only a FUEL_COMPANY_ADMIN sets it.
  @Get(':id/pricing-config')
  async getPricingConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    this.assertCompanyAccess(user, id);
    const config = await this.companiesService.getPricingConfig(id);
    // FR-011j: an unconfigured company must fail loudly. Returning
    // `undefined` here serialises as a 200 with an empty body, which the
    // client cannot tell apart from a malformed response — it has no
    // figures either way, but no reason to show either. A named 409 is what
    // lets the app say "pricing unavailable" instead of rendering nothing.
    if (!config) {
      throw new ConflictException({
        error: ErrorCode.PRICING_NOT_CONFIGURED,
        message: 'Pricing is not yet configured for this fuel company',
      });
    }
    return config;
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Put(':id/pricing-config')
  async setPricingConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SetPricingConfigDto,
  ) {
    this.assertCompanyAccess(user, id);
    const company = await this.companiesService.setPricingConfig(id, dto);
    return company.pricingConfig;
  }

  // spec 013 FR-033, T086a — genuine platform addition (found during analysis: `create`
  // below existed with no listing counterpart). `:id` is the acting admin's own Fuel
  // Company; `assertCompanyAccess` stops FuelCo A's admin from listing FuelCo B's fleet.
  /**
   * The transport price a TRANSPORT company charges per area — what the client is
   * quoted for delivery, set by the transporter itself.
   *
   * Read uses `assertCompanyReadAccess`, not the strict self-only check: the parent
   * FUEL company must be able to see the rates its own clients are quoted (that helper
   * already admits exactly a fuel admin reading its own transporter, and nobody else's).
   */
  @Get(':id/delivery-rates')
  async getDeliveryRates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const company = await this.companiesService.findById(id);
    await this.assertCompanyReadAccess(user, company);
    return this.companiesService.getDeliveryRates(id);
  }

  /**
   * Write is TRANSPORT_COMPANY_ADMIN and self-only — a fuel company may READ what its
   * transporter charges but may never set it, which is the whole point of moving this
   * price to the party that performs the haul.
   */
  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
  @Put(':id/delivery-rates')
  async setDeliveryRates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SetDeliveryRatesDto,
  ) {
    this.assertCompanyAccess(user, id);

    // Checked here, against `regions.constants.ts`, exactly as CreateUserDto's station
    // pairing is (users.controller.ts) — the mapping is data, not decorators.
    for (const rate of dto.rates) {
      if (
        rate.governorateCode &&
        !governorateBelongsToRegion(rate.governorateCode, rate.regionCode)
      ) {
        throw new BadRequestException('governorateCode does not belong to regionCode');
      }
    }

    // Two entries for one area would make resolution order-dependent — the quote would
    // depend on which happened to be stored first, which is exactly the kind of silent
    // ambiguity a price must never have.
    const keys = dto.rates.map((r) => `${r.regionCode}:${r.governorateCode ?? '*'}`);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException('Duplicate area in delivery rates');
    }

    // The RATES, not the company. `setDeliveryRates` returns the whole updated document,
    // so returning it directly made this endpoint answer with `contactEmail`,
    // `contactPhone`, `parentFuelCompanyId` and `fuelPrices` — none of which a caller
    // asked for — while its own GET twin correctly answers with the array alone. Matches
    // `setPricingConfig` above, which narrows to `company.pricingConfig` for this reason.
    const company = await this.companiesService.setDeliveryRates(id, dto.rates);
    return company.deliveryRates;
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Get(':id/transporters')
  async listTransporters(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    this.assertCompanyAccess(user, id);
    return this.companiesService.findTransporters(id);
  }

  /**
   * spec 017 (operator dashboard) T067/T068/FR-027–FR-031 — the PLATFORM
   * OPERATOR onboards a transport company and its first administrator.
   *
   * Declared **before** `:id/transporters` below: Nest matches routes in
   * declaration order, and `transporters` would otherwise be captured as an
   * `:id` by that route's parameter.
   *
   * The transaction is `createTransporter`'s, verbatim — one unit of work, so a
   * duplicate administrator email leaves neither company nor admin (FR-028).
   *
   * **Its post-insert `companyId` correction is deliberately OMITTED**, and
   * that is the one thing about this handler worth reading twice (research
   * R12). That correction exists because the tenant plugin's `pre('save')` hook
   * overwrites a new document's `companyId` with the ACTING user's tenant — so
   * a `FUEL_COMPANY_ADMIN` creating a transporter's admin would otherwise stamp
   * their OWN company onto it. A `SUPER_ADMIN` has no tenant: the hook takes
   * its role bypass and writes nothing, the insert lands with the companyId it
   * was given, and copying the correction would perform a pointless second
   * write whose only effect is to make a reader believe the hook fired here.
   *
   * FR-031/SC-006: a transporter onboarded here must be indistinguishable from
   * one its parent fuel company created itself. That is why this reuses
   * `createTransportCompany` rather than writing the document directly.
   */
  @Roles(UserRole.SUPER_ADMIN)
  @Post('transporters')
  async onboardTransporter(@Body() dto: OnboardTransportCompanyDto) {
    // Verified BEFORE any write: the named parent must exist AND be of type
    // FUEL. A merely-present id satisfies FR-030's letter and none of its
    // purpose — a transport company parented to another transport company
    // would sign in, appear in every list, and never receive an order, because
    // routing resolves a transporter through its parent FUEL company.
    const parent = await this.companiesService.findById(dto.parentFuelCompanyId).catch(() => null);
    if (!parent || parent.type !== CompanyType.FUEL) {
      throw new BadRequestException({
        error: ErrorCode.INVALID_PARENT_FUEL_COMPANY,
        message: 'parentFuelCompanyId must name an existing FUEL company',
      });
    }

    const session = await this.connection.startSession();
    let transporter!: CompanyDocument;
    let admin!: Awaited<ReturnType<UsersService['create']>>;
    try {
      await session.withTransaction(async () => {
        transporter = await this.companiesService.createTransportCompany(
          dto.parentFuelCompanyId,
          {
            name: dto.name,
            contactEmail: dto.contactEmail,
            contactPhone: dto.contactPhone,
            status: CompanyStatus.ACTIVE,
          },
          session,
        );

        admin = await this.usersService.create(
          {
            companyId: transporter._id as never,
            role: UserRole.TRANSPORT_COMPANY_ADMIN,
            email: dto.adminEmail,
            password: dto.adminPassword,
            fullName: dto.adminFullName,
            phone: dto.adminPhone,
            isActive: true,
          },
          session,
        );
        // No companyId correction here — see this handler's own note above.
      });
    } finally {
      await session.endSession();
    }

    return {
      company: transporter,
      admin: { id: admin._id, email: admin.email },
    };
  }

  // spec 004 US2: a Fuel Company creates its own Transportation Companies.
  // `:id` is the acting admin's own Fuel Company — `assertCompanyAccess`
  // stops FuelCo A's admin from creating a transporter under FuelCo B's id.
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/transporters')
  async createTransporter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: CreateTransportCompanyDto,
  ) {
    this.assertCompanyAccess(user, id);

    // The company and its admin are ONE unit of work (Principle V). Created
    // separately, a duplicate admin email or phone — a 409 the operator hits
    // routinely, since both are unique platform-wide — left the company row
    // already committed, with no admin and no way to ever sign in to it. The
    // name is unique too, so every retry then failed on the ORPHAN rather than
    // on the thing the operator got wrong, reporting a name collision they had
    // no way to explain. Rolling the company back is what makes the retry the
    // operator's obvious next move actually work.
    const session = await this.connection.startSession();
    let transporter!: CompanyDocument;
    let admin!: Awaited<ReturnType<UsersService['create']>>;
    try {
      await session.withTransaction(async () => {
        transporter = await this.companiesService.createTransportCompany(
          id,
          {
            name: dto.name,
            contactEmail: dto.contactEmail,
            contactPhone: dto.contactPhone,
            status: CompanyStatus.ACTIVE,
          },
          session,
        );

        admin = await this.usersService.create(
          {
            companyId: transporter._id as never,
            role: UserRole.TRANSPORT_COMPANY_ADMIN,
            email: dto.adminEmail,
            password: dto.adminPassword,
            fullName: dto.adminFullName,
            phone: dto.adminPhone,
            isActive: true,
          },
          session,
        );
        // `User` is tenant-scoped (Principle II): the plugin's `pre('save')` hook
        // unconditionally overwrites a new document's companyId with the ACTING
        // user's own tenant — correct for every same-tenant create, but this is
        // deliberately cross-tenant (a Fuel Company admin creating an account
        // that belongs to the *new transporter*, not to themselves). The insert
        // above lands with companyId = the fuel company's id despite what was
        // passed; this corrects it. The correcting update is not itself
        // re-clobbered — the hook only forces companyId on `isNew` documents.
        admin = await this.usersService.update(
          String(admin._id),
          { companyId: transporter._id as never },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    return {
      company: transporter,
      admin: { id: admin._id, email: admin.email },
    };
  }

  // `:id` here is the TRANSPORTER being assigned, not the acting admin's own
  // company — unlike the other `:id`-scoped routes above, so this
  // deliberately does not call assertCompanyAccess (that would wrongly
  // require user.companyId === the transporter's id). Ownership is instead
  // verified inside assignRegions: it resolves the transporter's
  // parentFuelCompanyId and 404s unless it matches the caller — Company
  // isn't tenant-scoped, so this check is the only thing enforcing it.
  //
  // Replaces (never merges) the served-region set: an explicit full list
  // keeps "which regions does this transporter serve right now" answerable
  // from one field, no accumulation to reason about (spec 004 FR-014).
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Put(':id/regions')
  assignRegions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: AssignRegionsDto,
  ) {
    if (!user.companyId) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.companiesService.assignRegions(user.companyId, id, dto.regionCodes);
  }

  // spec 013 FR-035/FR-036, T086a/T086b — the FUEL-type counterpart to the pair above:
  // `:id` here IS the acting admin's own company (unlike `:id/regions`, where it is the
  // transporter being assigned), so this uses `assertCompanyAccess` like `fuel-prices`/
  // `pricing-config` do, not the transporter-ownership check `assignRegions` uses.
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get(':id/covered-regions')
  async getCoveredRegions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    this.assertCompanyAccess(user, id);
    const company = await this.companiesService.findById(id);
    return company.coveredRegions;
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Put(':id/covered-regions')
  async setCoveredRegions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: AssignRegionsDto,
  ) {
    this.assertCompanyAccess(user, id);
    const company = await this.companiesService.setCoveredRegions(id, dto.regionCodes);
    return company.coveredRegions;
  }

  // spec 013 T140/FR-062a — SUPER_ADMIN only, deliberately no `assertCompanyAccess` call
  // (that would ALSO admit the company's own FUEL_COMPANY_ADMIN via the `@Roles` decorator
  // if it were on the guard list, which it isn't here) — a company must never set or
  // change its own ceiling, and this route simply doesn't accept that role at all.
  @Roles(UserRole.SUPER_ADMIN)
  @Put(':id/commission-ceiling')
  async setCommissionCeiling(
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SetCommissionCeilingDto,
  ) {
    const company = await this.companiesService.setCommissionCeiling(id, dto.commissionCeiling);
    return { commissionCeiling: company.commissionCeiling };
  }

  /** Company is the tenant root (not plugin-scoped) — ownership is checked explicitly (FR-002 spirit). */
  private assertCompanyAccess(user: AuthenticatedUser, companyId: string): void {
    if (user.role === UserRole.SUPER_ADMIN) return;
    if (user.companyId === companyId) return;
    throw new NotFoundException('Company not found');
  }

  /**
   * As {@link assertCompanyAccess}, plus one further case: a
   * FUEL_COMPANY_ADMIN may also read a company that is genuinely their own
   * Transportation Company (`parentFuelCompanyId` matches). Read-only and
   * scoped to `findOne` — creating a transporter, and setting fuel prices
   * (only meaningful for a FUEL company), stay on the strict, self-only check.
   */
  private async assertCompanyReadAccess(
    user: AuthenticatedUser,
    company: CompanyDocument,
  ): Promise<void> {
    if (user.role === UserRole.SUPER_ADMIN) return;
    const companyId = String(company._id);
    if (user.companyId === companyId) return;
    if (
      user.role === UserRole.FUEL_COMPANY_ADMIN &&
      company.type === CompanyType.TRANSPORT &&
      company.parentFuelCompanyId?.toString() === user.companyId
    ) {
      return;
    }
    throw new NotFoundException('Company not found');
  }
}
