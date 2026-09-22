import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NotFoundException } from '@nestjs/common';
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
import { ExchangeOfferState } from '../../src/common/enums/exchange-offer-state.enum';
import { ProposalOutcome } from '../../src/common/enums/proposal-outcome.enum';

jest.setTimeout(60_000);

/**
 * spec 016 (broadcast fuel exchange offers) T070 — `award`'s OWNERSHIP refusals only
 * (T065): these run before `connection.startSession()`, so a plain (non-replica-set)
 * in-memory Mongo suffices. The conditional update's arguments, the frozen figures and
 * loser-stamping all need a REAL transaction and are covered at the e2e level
 * (`exchange-award-race.e2e-spec.ts`) — the same convention
 * `credit-limit-requests.service.spec.ts` already established for `resolve()`.
 */
describe('FuelExchangeService.award (ownership refusals)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let offerModel: mongoose.Model<ExchangeOfferDocument>;
  let proposalModel: mongoose.Model<ExchangeProposalDocument>;
  let userModel: mongoose.Model<UserDocument>;
  let service: FuelExchangeService;

  const companyA = new mongoose.Types.ObjectId().toString();
  const companyB = new mongoose.Types.ObjectId().toString();
  const companyC = new mongoose.Types.ObjectId().toString();
  const userA = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    offerModel = connection.model(ExchangeOffer.name, ExchangeOfferSchema) as never;
    proposalModel = connection.model(ExchangeProposal.name, ExchangeProposalSchema) as never;
    userModel = connection.model(User.name, UserSchema) as never;
    service = new FuelExchangeService(
      offerModel,
      proposalModel,
      userModel,
      {} as Connection,
      {} as CompaniesService,
      {} as NotificationsService,
      new TenantContextService(),
    );
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await offerModel.deleteMany({}).exec();
    await proposalModel.deleteMany({}).exec();
  });

  async function seedOfferWithProposal() {
    const offer = await offerModel.create({
      openToMarket: true,
      partyCompanyIds: [new mongoose.Types.ObjectId(companyA)],
      raisedByCompanyId: new mongoose.Types.ObjectId(companyA),
      raisedByUserId: new mongoose.Types.ObjectId(userA),
      fuelType: FuelType.PETROL_95,
      quantityLitres: 10000,
      deliveryAt: new Date(Date.now() + 86_400_000),
      city: GovernorateCode.JEDDAH,
      state: ExchangeOfferState.OPEN,
    });
    const proposal = await proposalModel.create({
      offerId: offer._id,
      offerRaisedByCompanyId: offer.raisedByCompanyId,
      proposingCompanyId: new mongoose.Types.ObjectId(companyB),
      proposingUserId: new mongoose.Types.ObjectId(),
      outcome: ProposalOutcome.PROPOSED,
      unitPrice: 2.5,
      currency: 'SAR',
      respondedAt: new Date(),
    });
    return { offer, proposal };
  }

  it('404s when the offer does not exist', async () => {
    await expect(
      service.award(
        new mongoose.Types.ObjectId().toString(),
        companyA,
        userA,
        new mongoose.Types.ObjectId().toString(),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s (never reveals the offer exists) when the caller did not raise it (T065)', async () => {
    const { offer, proposal } = await seedOfferWithProposal();
    await expect(
      service.award(String(offer._id), companyC, userA, String(proposal._id)),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the named proposal does not belong to this offer', async () => {
    const { offer } = await seedOfferWithProposal();
    await expect(
      service.award(String(offer._id), companyA, userA, new mongoose.Types.ObjectId().toString()),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s awarding a DECLINED proposal — nothing about a decline can be awarded', async () => {
    const { offer, proposal } = await seedOfferWithProposal();
    await proposalModel
      .updateOne(
        { _id: proposal._id },
        { $set: { outcome: ProposalOutcome.DECLINED, unitPrice: undefined } },
      )
      .exec();
    await expect(
      service.award(String(offer._id), companyA, userA, String(proposal._id)),
    ).rejects.toThrow(NotFoundException);
  });
});
