import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { FuelExchangeService } from '../../src/modules/fuel-exchange/fuel-exchange.service';
import { ExchangeOffer, ExchangeOfferSchema, ExchangeOfferDocument } from '../../src/modules/fuel-exchange/schemas/exchange-offer.schema';
import { ExchangeProposal, ExchangeProposalSchema, ExchangeProposalDocument } from '../../src/modules/fuel-exchange/schemas/exchange-proposal.schema';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { GovernorateCode } from '../../src/common/enums/region.enum';
import { ExchangeOfferState } from '../../src/common/enums/exchange-offer-state.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(60_000);

/**
 * spec 016 (broadcast fuel exchange offers) T054 — `propose`'s non-transactional
 * guards: the grade guard (research R2, moved here from raising), price validation's
 * XOR with decline, the decline shape, and the duplicate-key translation (T050).
 */
describe('FuelExchangeService.propose', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let offerModel: mongoose.Model<ExchangeOfferDocument>;
  let proposalModel: mongoose.Model<ExchangeProposalDocument>;
  let userModel: mongoose.Model<UserDocument>;
  let companiesService: jest.Mocked<Pick<CompaniesService, 'findActiveFuelCompaniesSellingGrade' | 'findSuspendedFuelCompanyIds' | 'findById' | 'isActive' | 'getBasePrice'>>;
  let notificationsService: jest.Mocked<Pick<NotificationsService, 'notify'>>;
  let service: FuelExchangeService;

  const companyA = new mongoose.Types.ObjectId().toString();
  const companyB = new mongoose.Types.ObjectId().toString();
  const userB = new mongoose.Types.ObjectId().toString();

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
      findActiveFuelCompaniesSellingGrade: jest.fn().mockResolvedValue([]),
      findSuspendedFuelCompanyIds: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue({ name: 'Co', fuelPrices: [], contactEmail: 'x@x.com', contactPhone: '+9665' } as never),
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
  });

  async function seedOpenOffer() {
    return offerModel.create({
      openToMarket: true,
      partyCompanyIds: [new mongoose.Types.ObjectId(companyA)],
      raisedByCompanyId: new mongoose.Types.ObjectId(companyA),
      raisedByUserId: new mongoose.Types.ObjectId(),
      fuelType: FuelType.PETROL_95,
      quantityLitres: 10000,
      deliveryAt: new Date(Date.now() + 86_400_000),
      city: GovernorateCode.JEDDAH,
      state: ExchangeOfferState.OPEN,
    });
  }

  it('refuses EXCHANGE_GRADE_NOT_SOLD when the proposing company does not sell the grade (research R2)', async () => {
    const offer = await seedOpenOffer();
    companiesService.getBasePrice.mockResolvedValueOnce(undefined);
    await expect(service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5 })).rejects.toMatchObject({
      response: { error: ErrorCode.EXCHANGE_GRADE_NOT_SOLD },
    });
  });

  it('refuses when both unitPrice and decline are given', async () => {
    const offer = await seedOpenOffer();
    await expect(
      service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5, decline: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses when neither unitPrice nor decline is given', async () => {
    const offer = await seedOpenOffer();
    await expect(service.propose(String(offer._id), companyB, userB, {})).rejects.toThrow(BadRequestException);
  });

  it('records a decline with no price and no currency (FR-013)', async () => {
    const offer = await seedOpenOffer();
    const proposal = await service.propose(String(offer._id), companyB, userB, { decline: true });
    expect(proposal.outcome).toBe('DECLINED');
    expect(proposal.toObject()).not.toHaveProperty('unitPrice');
  });

  it('records a priced proposal with the default currency', async () => {
    const offer = await seedOpenOffer();
    const proposal = await service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5 });
    expect(proposal.outcome).toBe('PROPOSED');
    expect(proposal.unitPrice).toBe(2.5);
    expect(proposal.currency).toBe('SAR');
  });

  it('403s the raiser attempting to answer its own offer (FR-009)', async () => {
    const offer = await seedOpenOffer();
    await expect(service.propose(String(offer._id), companyA, userB, { unitPrice: 2.5 })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('409s EXCHANGE_OFFER_NOT_OPEN when the offer is not OPEN', async () => {
    const offer = await seedOpenOffer();
    await offerModel.updateOne({ _id: offer._id }, { $set: { state: ExchangeOfferState.WITHDRAWN } }).exec();
    await expect(service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5 })).rejects.toMatchObject({
      response: { error: ErrorCode.EXCHANGE_OFFER_NOT_OPEN },
    });
  });

  it('409s EXCHANGE_OFFER_NOT_OPEN when the raising company is suspended (research R13)', async () => {
    const offer = await seedOpenOffer();
    companiesService.isActive.mockResolvedValueOnce(false);
    await expect(service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5 })).rejects.toMatchObject({
      response: { error: ErrorCode.EXCHANGE_OFFER_NOT_OPEN },
    });
  });

  it('translates a duplicate submission into EXCHANGE_ALREADY_ANSWERED, never a 500 (T050/FR-011c/FR-018)', async () => {
    const offer = await seedOpenOffer();
    await service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5 });
    await expect(service.propose(String(offer._id), companyB, userB, { unitPrice: 2.6 })).rejects.toMatchObject({
      response: { error: ErrorCode.EXCHANGE_ALREADY_ANSWERED },
    });
    await expect(service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('notifies the RAISING company\'s admins, a different tenant from the proposer (T053/T056a)', async () => {
    const offer = await seedOpenOffer();
    await userModel.create({
      companyId: new mongoose.Types.ObjectId(companyA),
      role: 'FUEL_COMPANY_ADMIN',
      email: 'admin@a.test',
      passwordHash: 'x',
      fullName: 'A Admin',
      phone: '+966500000002',
      isActive: true,
    });
    await service.propose(String(offer._id), companyB, userB, { unitPrice: 2.5 });
    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EXCHANGE_PROPOSAL_RECEIVED' }),
    );
  });
});
