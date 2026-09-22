import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BadRequestException } from '@nestjs/common';
import { FuelExchangeService } from '../../src/modules/fuel-exchange/fuel-exchange.service';
import {
  ExchangeOffer,
  ExchangeOfferSchema,
  ExchangeOfferDocument,
} from '../../src/modules/fuel-exchange/schemas/exchange-offer.schema';
import {
  ExchangeProposal,
  ExchangeProposalSchema,
  ExchangeProposalDocument,
} from '../../src/modules/fuel-exchange/schemas/exchange-proposal.schema';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { GovernorateCode } from '../../src/common/enums/region.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(60_000);

/**
 * spec 016 (broadcast fuel exchange offers) T037 — the non-transactional US1 paths
 * (`create`, `findAll`'s direction derivation), mirroring
 * `credit-limit-requests.service.spec.ts`'s own shape: real in-memory models, the
 * service's OTHER dependencies stubbed by hand. `propose`/`award`/`withdraw`'s
 * conditional-update/transactional behaviour is covered at the e2e level instead (this
 * repository's established convention — see that file's own doc comment).
 *
 * No isolation plugin is registered on this connection at all (matching how scripts and
 * seeds run outside a request) — this file tests business logic, not isolation, which
 * `exchange-offer-isolation.e2e-spec.ts` already owns exclusively.
 */
describe('FuelExchangeService (US1 non-transactional paths)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let offerModel: mongoose.Model<ExchangeOfferDocument>;
  let proposalModel: mongoose.Model<ExchangeProposalDocument>;
  let userModel: mongoose.Model<UserDocument>;
  let companiesService: jest.Mocked<
    Pick<
      CompaniesService,
      | 'findActiveFuelCompaniesSellingGrade'
      | 'findSuspendedFuelCompanyIds'
      | 'findById'
      | 'isActive'
      | 'getBasePrice'
    >
  >;
  let notificationsService: jest.Mocked<Pick<NotificationsService, 'notify'>>;
  let service: FuelExchangeService;

  const companyA = new mongoose.Types.ObjectId().toString();
  const companyB = new mongoose.Types.ObjectId().toString();
  const userA = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    offerModel = connection.model(ExchangeOffer.name, ExchangeOfferSchema) as never;
    proposalModel = connection.model(ExchangeProposal.name, ExchangeProposalSchema) as never;
    userModel = connection.model(User.name, UserSchema) as never;
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  beforeEach(() => {
    companiesService = {
      findActiveFuelCompaniesSellingGrade: jest
        .fn()
        .mockResolvedValue([{ _id: new mongoose.Types.ObjectId(companyB) }]),
      findSuspendedFuelCompanyIds: jest.fn().mockResolvedValue([]),
      findById: jest
        .fn()
        .mockResolvedValue({ fuelPrices: [{ fuelType: FuelType.PETROL_95 }] } as never),
      isActive: jest.fn().mockResolvedValue(true),
      getBasePrice: jest.fn().mockResolvedValue(2.2),
    } as never;
    notificationsService = { notify: jest.fn().mockResolvedValue(undefined) } as never;

    service = new FuelExchangeService(
      offerModel,
      proposalModel,
      userModel,
      {} as Connection,
      companiesService as unknown as CompaniesService,
      notificationsService as unknown as NotificationsService,
      new TenantContextService(),
    );
  });

  afterEach(async () => {
    await offerModel.deleteMany({}).exec();
    await proposalModel.deleteMany({}).exec();
    await userModel.deleteMany({}).exec();
  });

  function offerDto(overrides: Record<string, unknown> = {}) {
    return {
      fuelType: FuelType.PETROL_95,
      quantityLitres: 20000,
      deliveryAt: new Date(Date.now() + 86_400_000).toISOString(),
      city: GovernorateCode.JEDDAH,
      ...overrides,
    } as never;
  }

  it('refuses with EXCHANGE_NO_ELIGIBLE_COMPANY when no other fuel company sells the grade (FR-005)', async () => {
    companiesService.findActiveFuelCompaniesSellingGrade.mockResolvedValueOnce([]);
    await expect(service.create(companyA, userA, offerDto())).rejects.toMatchObject({
      response: { error: ErrorCode.EXCHANGE_NO_ELIGIBLE_COMPANY },
    });
  });

  it('refuses a deliveryAt that is not in the future', async () => {
    await expect(
      service.create(
        companyA,
        userA,
        offerDto({ deliveryAt: new Date(Date.now() - 1000).toISOString() }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('sets openToMarket true, exactly one party (the raiser), and NO price field anywhere (FR-001/FR-003/FR-005a)', async () => {
    const created = await service.create(companyA, userA, offerDto());
    expect(created.openToMarket).toBe(true);
    expect(created.partyCompanyIds.map(String)).toEqual([companyA]);
    expect(created.state).toBe('OPEN');

    const raw = created.toObject();
    expect(raw).not.toHaveProperty('unitPrice');
    expect(raw).not.toHaveProperty('price');
    expect(JSON.stringify(raw)).not.toMatch(/unitPrice/i);
  });

  it("fans out EXCHANGE_OFFER_AVAILABLE to the resolved eligible companies' admins", async () => {
    await userModel.create({
      companyId: new mongoose.Types.ObjectId(companyB),
      role: 'FUEL_COMPANY_ADMIN',
      email: 'admin@b.test',
      passwordHash: 'x',
      fullName: 'B Admin',
      phone: '+966500000001',
      isActive: true,
    });

    await service.create(companyA, userA, offerDto());
    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EXCHANGE_OFFER_AVAILABLE' }),
    );
  });

  it('direction is derived at read time: the raiser sees it outgoing, never incoming, from its own vantage point', async () => {
    const created = await service.create(companyA, userA, offerDto());

    const outgoing = await service.findAll(companyA, 'outgoing', undefined, undefined);
    expect(outgoing.items.map((i) => String((i as never as { _id: unknown })._id))).toContain(
      String(created._id),
    );

    // Company A raised it, so it must never appear in A's own incoming list (FR-009) —
    // buildIncomingFilter would otherwise need to special-case "not raised by me",
    // which it does via `raisedByCompanyId: { $nin: [...suspended, acting] }`.
    const incoming = await service.findAll(companyA, 'incoming', undefined, undefined);
    expect(incoming.items.map((i) => String((i as never as { _id: unknown })._id))).not.toContain(
      String(created._id),
    );
  });
});
