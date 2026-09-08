import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { migrateExchangeRequestsToOffers } from '../../scripts/migrate-exchange-requests-to-offers';
import { ExchangeRequestState } from '../../src/common/enums/exchange-request-state.enum';
import { ExchangeOfferState } from '../../src/common/enums/exchange-offer-state.enum';
import { ProposalOutcome } from '../../src/common/enums/proposal-outcome.enum';

jest.setTimeout(60_000);

/**
 * spec 016 (broadcast fuel exchange offers) T023/T023a/research R5 — every row of the
 * state mapping table, on raw collections (matching every other migration in this
 * repository), plus the idempotency guarantee (FR-039b) and the ACCEPTED
 * attributability fix (T019a/FR-039/FR-013). The one case this suite exists to catch
 * above all others: `openToMarket` must be `false` on EVERY migrated record — a `true`
 * here would publish a historical private request to the whole market (FR-039a).
 */
describe('migrateExchangeRequestsToOffers', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;

  const COMPANY_A = new mongoose.Types.ObjectId();
  const COMPANY_B = new mongoose.Types.ObjectId();
  const USER_A = new mongoose.Types.ObjectId();
  const USER_B = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await connection.collection('exchangerequests').deleteMany({});
    await connection.collection('exchangeoffers').deleteMany({});
    await connection.collection('exchangeproposals').deleteMany({});
  });

  function baseRequest(overrides: Record<string, unknown>) {
    return {
      partyCompanyIds: [COMPANY_A, COMPANY_B],
      raisedByCompanyId: COMPANY_A,
      recipientCompanyId: COMPANY_B,
      raisedByUserId: USER_A,
      fuelType: 'DIESEL',
      quantityLitres: 1000,
      unitPrice: 2.5,
      currency: 'SAR',
      deliveryAt: new Date('2026-06-01'),
      deliveryPlaceText: 'Riyadh warehouse',
      createdAt: new Date('2026-05-01'),
      ...overrides,
    };
  }

  it('AWAITING_RESPONSE -> OPEN, audience-restricted, no proposal', async () => {
    await connection
      .collection('exchangerequests')
      .insertOne(baseRequest({ state: ExchangeRequestState.AWAITING_RESPONSE }));

    const summary = await migrateExchangeRequestsToOffers(connection);
    expect(summary.offersCreated).toBe(1);
    expect(summary.proposalsCreated).toBe(0);

    const offer = await connection.collection('exchangeoffers').findOne({});
    expect(offer?.openToMarket).toBe(false);
    expect(offer?.state).toBe(ExchangeOfferState.OPEN);
    expect(offer?.partyCompanyIds).toEqual([COMPANY_A, COMPANY_B]);

    const proposals = await connection.collection('exchangeproposals').find({}).toArray();
    expect(proposals).toHaveLength(0);
  });

  it('ACCEPTED -> AWARDED, with an attributable, awarded proposal (T019a)', async () => {
    await connection.collection('exchangerequests').insertOne(
      baseRequest({
        state: ExchangeRequestState.ACCEPTED,
        resolvedBy: USER_B,
        resolvedAt: new Date('2026-05-05'),
      }),
    );

    const summary = await migrateExchangeRequestsToOffers(connection);
    expect(summary.offersCreated).toBe(1);
    expect(summary.proposalsCreated).toBe(1);

    const offer = await connection.collection('exchangeoffers').findOne({});
    expect(offer?.openToMarket).toBe(false);
    expect(offer?.state).toBe(ExchangeOfferState.AWARDED);
    // Attributable: the raiser supplies, the accepting recipient receives.
    expect(offer?.raisedByCompanyId).toEqual(COMPANY_A);
    expect(offer?.awardedCompanyId).toEqual(COMPANY_B);
    expect(offer?.agreedUnitPrice).toBe(2.5);
    expect(offer?.agreedQuantityLitres).toBe(1000);
    expect(offer?.agreedTotal).toBe(2500);
    expect(offer?.currency).toBe('SAR');

    const proposal = await connection.collection('exchangeproposals').findOne({});
    expect(proposal?.outcome).toBe(ProposalOutcome.AWARDED);
    expect(proposal?.proposingCompanyId).toEqual(COMPANY_B);
    expect(proposal?.offerRaisedByCompanyId).toEqual(COMPANY_A);
    expect(proposal?.unitPrice).toBe(2.5);
    expect(proposal?.offerId).toEqual(offer?._id);
  });

  it('DECLINED -> CLOSED_NO_AWARD, with a declined proposal', async () => {
    await connection.collection('exchangerequests').insertOne(
      baseRequest({
        state: ExchangeRequestState.DECLINED,
        resolvedBy: USER_B,
        resolvedAt: new Date('2026-05-05'),
      }),
    );

    await migrateExchangeRequestsToOffers(connection);

    const offer = await connection.collection('exchangeoffers').findOne({});
    expect(offer?.openToMarket).toBe(false);
    expect(offer?.state).toBe(ExchangeOfferState.CLOSED_NO_AWARD);
    // A decline carries no price — never fabricated from the request's terms.
    expect(offer?.agreedUnitPrice).toBeUndefined();

    const proposal = await connection.collection('exchangeproposals').findOne({});
    expect(proposal?.outcome).toBe(ProposalOutcome.DECLINED);
    expect(proposal?.unitPrice).toBeUndefined();
  });

  it('WITHDRAWN -> WITHDRAWN, no proposal', async () => {
    await connection.collection('exchangerequests').insertOne(
      baseRequest({
        state: ExchangeRequestState.WITHDRAWN,
        resolvedBy: USER_A,
        resolvedAt: new Date('2026-05-05'),
      }),
    );

    const summary = await migrateExchangeRequestsToOffers(connection);
    expect(summary.proposalsCreated).toBe(0);

    const offer = await connection.collection('exchangeoffers').findOne({});
    expect(offer?.openToMarket).toBe(false);
    expect(offer?.state).toBe(ExchangeOfferState.WITHDRAWN);
  });

  it('is idempotent: a second run writes zero new documents', async () => {
    await connection
      .collection('exchangerequests')
      .insertOne(baseRequest({ state: ExchangeRequestState.AWAITING_RESPONSE }));

    const first = await migrateExchangeRequestsToOffers(connection);
    expect(first.offersCreated).toBe(1);

    const second = await migrateExchangeRequestsToOffers(connection);
    expect(second.offersCreated).toBe(0);
    expect(second.alreadyMigrated).toBe(1);

    const offers = await connection.collection('exchangeoffers').find({}).toArray();
    expect(offers).toHaveLength(1);
  });

  it('exits non-zero (reports unmapped) on a record with an unmappable state', async () => {
    await connection
      .collection('exchangerequests')
      .insertOne(baseRequest({ state: 'SOME_FUTURE_STATE' }));

    const summary = await migrateExchangeRequestsToOffers(connection);
    expect(summary.unmapped).toHaveLength(1);
    expect(summary.offersCreated).toBe(0);
  });

  it('dry-run makes no writes', async () => {
    await connection
      .collection('exchangerequests')
      .insertOne(baseRequest({ state: ExchangeRequestState.AWAITING_RESPONSE }));

    const summary = await migrateExchangeRequestsToOffers(connection, { dryRun: true });
    expect(summary.offersCreated).toBe(1);

    const offers = await connection.collection('exchangeoffers').find({}).toArray();
    expect(offers).toHaveLength(0);
  });
});
