import mongoose, { Schema, Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createPartySetScopePlugin } from '../../src/common/plugins/party-set-scope.plugin';
import { markPartySet } from '../../src/common/plugins/party-set.marker';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(60_000);

/**
 * spec 016 (broadcast fuel exchange offers) T021/research R1 — the AMENDED
 * `party-set-scope.plugin.ts`'s `pre('save')` split on `openToMarket`, tested against a
 * throwaway schema exactly as `party-set-scope.plugin.spec.ts` already does for the
 * two-party (legacy) shape. That existing file is untouched and must keep passing
 * unamended — its Widget schema never sets `openToMarket`, so every one of its cases
 * takes the two-party branch, byte-compatible with what this plugin validated before
 * this change.
 */
describe('partySetScopePlugin — openToMarket validation (research R1)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let tenantContext: TenantContextService;

  const FUEL_CO_A = new mongoose.Types.ObjectId().toString();
  const FUEL_CO_B = new mongoose.Types.ObjectId().toString();
  const FUEL_CO_C = new mongoose.Types.ObjectId().toString();

  interface Widget {
    partyCompanyIds?: mongoose.Types.ObjectId[];
    openToMarket?: boolean;
    name: string;
  }

  let WidgetModel: mongoose.Model<Widget>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    tenantContext = new TenantContextService();
    connection.plugin(createPartySetScopePlugin(tenantContext));

    const widgetSchema = new Schema<Widget>({
      partyCompanyIds: { type: [Schema.Types.ObjectId] },
      openToMarket: { type: Boolean },
      name: { type: String, required: true },
    });
    markPartySet(widgetSchema);
    widgetSchema.index({ partyCompanyIds: 1 });

    WidgetModel = connection.model<Widget>('MarketWidget', widgetSchema);
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await WidgetModel.deleteMany({});
  });

  function asA<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A }, fn);
  }

  it('accepts a market shape: openToMarket true, exactly one party, the acting company', async () => {
    const doc = await asA(() =>
      WidgetModel.create({
        name: 'market-offer',
        openToMarket: true,
        partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_A)],
      }),
    );
    expect(doc.name).toBe('market-offer');
  });

  it('accepts the legacy two-party shape unchanged: openToMarket false, exactly two parties including the acting company', async () => {
    const doc = await asA(() =>
      WidgetModel.create({
        name: 'directed',
        openToMarket: false,
        partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_A), new mongoose.Types.ObjectId(FUEL_CO_B)],
      }),
    );
    expect(doc.name).toBe('directed');
  });

  it('refuses openToMarket true with two parties', async () => {
    await expect(
      asA(() =>
        WidgetModel.create({
          name: 'invalid',
          openToMarket: true,
          partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_A), new mongoose.Types.ObjectId(FUEL_CO_B)],
        }),
      ),
    ).rejects.toThrow(/EXCHANGE_PARTY_INVALID|exactly one party/i);
  });

  it('refuses openToMarket false with only one party', async () => {
    await expect(
      asA(() =>
        WidgetModel.create({
          name: 'invalid',
          openToMarket: false,
          partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_A)],
        }),
      ),
    ).rejects.toThrow(/EXCHANGE_PARTY_INVALID|partyCompanyIds/i);
  });

  it('refuses openToMarket true when the acting company is absent from the single party', async () => {
    await expect(
      asA(() =>
        WidgetModel.create({
          name: 'imposter',
          openToMarket: true,
          partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_C)],
        }),
      ),
    ).rejects.toThrow(/EXCHANGE_PARTY_INVALID|exactly one party/i);
  });

  it('a FUEL_COMPANY_ADMIN reads a market document even when named in no party', async () => {
    await asA(() =>
      WidgetModel.create({
        name: 'market-offer',
        openToMarket: true,
        partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_A)],
      }),
    );
    await tenantContext.run(
      { userId: 'admin-c', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_C },
      async () => {
        const results = await WidgetModel.find({});
        expect(results.map((r) => r.name)).toEqual(['market-offer']);
      },
    );
  });

  it('a FUEL_COMPANY_ADMIN reads NEITHER a two-party document naming neither of them, market or not', async () => {
    await asA(() =>
      WidgetModel.create({
        name: 'directed',
        openToMarket: false,
        partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_A), new mongoose.Types.ObjectId(FUEL_CO_B)],
      }),
    );
    await tenantContext.run(
      { userId: 'admin-c', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_C },
      async () => {
        const results = await WidgetModel.find({});
        expect(results).toHaveLength(0);
      },
    );
  });
});
