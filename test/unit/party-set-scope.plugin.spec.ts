import mongoose, { Schema, Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createPartySetScopePlugin } from '../../src/common/plugins/party-set-scope.plugin';
import { markPartySet } from '../../src/common/plugins/party-set.marker';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(60_000);

/**
 * spec 014 T216/Part A (built and reviewed ALONE, before any exchange domain code —
 * T217's gate). Mirrors `multi-party-scope.plugin.spec.ts`'s own testing shape.
 */
describe('partySetScopePlugin', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let tenantContext: TenantContextService;

  const FUEL_CO_A = new mongoose.Types.ObjectId().toString();
  const FUEL_CO_B = new mongoose.Types.ObjectId().toString();
  const FUEL_CO_C = new mongoose.Types.ObjectId().toString();

  interface Widget {
    partyCompanyIds?: mongoose.Types.ObjectId[];
    name: string;
  }

  let WidgetModel: mongoose.Model<Widget>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  }, 120_000);

  beforeAll(() => {
    tenantContext = new TenantContextService();
    connection.plugin(createPartySetScopePlugin(tenantContext));

    const widgetSchema = new Schema<Widget>({
      partyCompanyIds: { type: [Schema.Types.ObjectId] },
      name: { type: String, required: true },
    });
    markPartySet(widgetSchema);
    widgetSchema.index({ partyCompanyIds: 1 });

    WidgetModel = connection.model<Widget>('Widget', widgetSchema);
  });

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await WidgetModel.deleteMany({});
  });

  async function createAsA(name: string, parties: [string, string] = [FUEL_CO_A, FUEL_CO_B]) {
    return tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      () =>
        WidgetModel.create({
          name,
          partyCompanyIds: parties.map((p) => new mongoose.Types.ObjectId(p)),
        }),
    );
  }

  // --- T213: registration-time failure, not first-query -----------------

  it('fails at schema registration when a partySet schema has no index on partyCompanyIds', () => {
    const brokenConnection = mongoose.createConnection();
    brokenConnection.plugin(createPartySetScopePlugin(tenantContext));
    const brokenSchema = new Schema<Widget>({
      partyCompanyIds: { type: [Schema.Types.ObjectId] },
      name: { type: String, required: true },
    });
    markPartySet(brokenSchema);
    // Deliberately no `.index({ partyCompanyIds: 1 })`.
    expect(() => brokenConnection.model<Widget>('BrokenWidget', brokenSchema)).toThrow(
      /no index on partyCompanyIds/i,
    );
  });

  // --- Required tests table (contracts/isolation-contract.md) ------------

  it('THE recipient reads a request raised by the counterparty (non-negotiable)', async () => {
    await createAsA('a-raises-to-b', [FUEL_CO_A, FUEL_CO_B]);
    await tenantContext.run(
      { userId: 'admin-b', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_B },
      async () => {
        const results = await WidgetModel.find({});
        expect(results.map((r) => r.name)).toEqual(['a-raises-to-b']);
      },
    );
  });

  it('the raiser reads their own', async () => {
    await createAsA('a-raises-to-b', [FUEL_CO_A, FUEL_CO_B]);
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      async () => {
        const results = await WidgetModel.find({});
        expect(results.map((r) => r.name)).toEqual(['a-raises-to-b']);
      },
    );
  });

  it('a third fuel company reads neither', async () => {
    await createAsA('a-raises-to-b', [FUEL_CO_A, FUEL_CO_B]);
    await tenantContext.run(
      { userId: 'admin-c', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_C },
      async () => {
        const results = await WidgetModel.find({});
        expect(results).toHaveLength(0);
      },
    );
  });

  it('create with the acting company absent from parties is refused', async () => {
    await expect(
      tenantContext.run(
        { userId: 'admin-c', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_C },
        () =>
          WidgetModel.create({
            name: 'imposter',
            partyCompanyIds: [
              new mongoose.Types.ObjectId(FUEL_CO_A),
              new mongoose.Types.ObjectId(FUEL_CO_B),
            ],
          }),
      ),
    ).rejects.toThrow(/EXCHANGE_PARTY_INVALID|partyCompanyIds/i);
  });

  it('create with one party is refused', async () => {
    await expect(
      tenantContext.run(
        { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
        () =>
          WidgetModel.create({
            name: 'one-party',
            partyCompanyIds: [new mongoose.Types.ObjectId(FUEL_CO_A)],
          }),
      ),
    ).rejects.toThrow(/EXCHANGE_PARTY_INVALID|partyCompanyIds/i);
  });

  it('create with three parties is refused', async () => {
    await expect(
      tenantContext.run(
        { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
        () =>
          WidgetModel.create({
            name: 'three-parties',
            partyCompanyIds: [FUEL_CO_A, FUEL_CO_B, FUEL_CO_C].map(
              (p) => new mongoose.Types.ObjectId(p),
            ),
          }),
      ),
    ).rejects.toThrow(/EXCHANGE_PARTY_INVALID|partyCompanyIds/i);
  });

  it('SUPER_ADMIN reads all', async () => {
    await createAsA('a-to-b', [FUEL_CO_A, FUEL_CO_B]);
    await tenantContext.run(
      { userId: 'admin-b', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_B },
      () =>
        WidgetModel.create({
          name: 'b-to-c',
          partyCompanyIds: [
            new mongoose.Types.ObjectId(FUEL_CO_B),
            new mongoose.Types.ObjectId(FUEL_CO_C),
          ],
        }),
    );
    await tenantContext.run({ userId: 'ciro', role: UserRole.SUPER_ADMIN }, async () => {
      const results = await WidgetModel.find({});
      expect(results.map((r) => r.name).sort()).toEqual(['a-to-b', 'b-to-c']);
    });
  });

  it('anonymous/public-route traffic bypasses without throwing', async () => {
    await createAsA('a-to-b', [FUEL_CO_A, FUEL_CO_B]);
    const results = await WidgetModel.find({});
    expect(Array.isArray(results)).toBe(true);
  });

  // --- the `!ctx?.role` discriminator (T211) ------------------------------

  it('an anonymous store carrying only a correlation id (no role) bypasses rather than throwing', async () => {
    await createAsA('a-to-b', [FUEL_CO_A, FUEL_CO_B]);
    await tenantContext.run({ correlationId: 'req-123' } as never, async () => {
      const results = await WidgetModel.find({});
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // --- fail-closed on an unrecognised role --------------------------------

  it('throws for a role this plugin has no scoping rule for', async () => {
    await expect(
      tenantContext.run({ userId: 'client-x', role: UserRole.CLIENT, companyId: FUEL_CO_A }, () =>
        WidgetModel.find({}).exec(),
      ),
    ).rejects.toThrow(/no scoping rule/i);
  });
});
