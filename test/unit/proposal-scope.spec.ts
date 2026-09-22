import mongoose, { Schema, Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createProposalScopePlugin } from '../../src/common/plugins/proposal-scope.plugin';
import { markProposal } from '../../src/common/plugins/proposal.marker';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(60_000);

/**
 * spec 016 (broadcast fuel exchange offers) T022/research R3 — `proposal-scope.plugin.ts`
 * tested in isolation against a throwaway schema, mirroring
 * `party-set-scope.plugin.spec.ts`'s own shape. The disjunction under test — author OR
 * the raiser of the parent offer — IS FR-011b (blindness): a responder's read of this
 * collection never fetches a rival's row, rather than merely not rendering it.
 */
describe('proposalScopePlugin', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let tenantContext: TenantContextService;

  const FUEL_CO_A = new mongoose.Types.ObjectId().toString(); // the raiser
  const FUEL_CO_B = new mongoose.Types.ObjectId().toString(); // proposes
  const FUEL_CO_D = new mongoose.Types.ObjectId().toString(); // proposes
  const FUEL_CO_C = new mongoose.Types.ObjectId().toString(); // uninvolved third party

  interface Bid {
    proposingCompanyId?: mongoose.Types.ObjectId;
    offerRaisedByCompanyId?: mongoose.Types.ObjectId;
    name: string;
  }

  let BidModel: mongoose.Model<Bid>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    tenantContext = new TenantContextService();
    connection.plugin(createProposalScopePlugin(tenantContext));

    const bidSchema = new Schema<Bid>({
      proposingCompanyId: { type: Schema.Types.ObjectId },
      offerRaisedByCompanyId: { type: Schema.Types.ObjectId },
      name: { type: String, required: true },
    });
    markProposal(bidSchema);
    bidSchema.index({ proposingCompanyId: 1 });
    bidSchema.index({ offerRaisedByCompanyId: 1 });

    BidModel = connection.model<Bid>('Bid', bidSchema);
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await BidModel.deleteMany({});
  });

  beforeEach(async () => {
    // Seed with no active context, matching how a service would create these documents
    // (the scope plugin has no `pre('save')` — creation is fully application-controlled).
    await BidModel.create([
      { name: 'b-bids', proposingCompanyId: FUEL_CO_B, offerRaisedByCompanyId: FUEL_CO_A },
      { name: 'd-bids', proposingCompanyId: FUEL_CO_D, offerRaisedByCompanyId: FUEL_CO_A },
    ]);
  });

  it('fails at schema registration when a proposal schema is missing either required index', () => {
    const brokenConnection = mongoose.createConnection();
    brokenConnection.plugin(createProposalScopePlugin(tenantContext));
    const brokenSchema = new Schema<Bid>({
      proposingCompanyId: { type: Schema.Types.ObjectId },
      offerRaisedByCompanyId: { type: Schema.Types.ObjectId },
      name: { type: String, required: true },
    });
    markProposal(brokenSchema);
    // Deliberately no indexes at all.
    expect(() => brokenConnection.model<Bid>('BrokenBid', brokenSchema)).toThrow(
      /missing an index/i,
    );
  });

  it("a proposer reads only its OWN proposal, never the rival's", async () => {
    await tenantContext.run(
      { userId: 'admin-b', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_B },
      async () => {
        const results = await BidModel.find({});
        expect(results.map((r) => r.name)).toEqual(['b-bids']);
      },
    );
  });

  it('the raiser of the parent offer reads every proposal against it', async () => {
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      async () => {
        const results = await BidModel.find({});
        expect(results.map((r) => r.name).sort()).toEqual(['b-bids', 'd-bids']);
      },
    );
  });

  it('an uninvolved third company reads neither', async () => {
    await tenantContext.run(
      { userId: 'admin-c', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_C },
      async () => {
        const results = await BidModel.find({});
        expect(results).toHaveLength(0);
      },
    );
  });

  it('SUPER_ADMIN reads all', async () => {
    await tenantContext.run({ userId: 'ciro', role: UserRole.SUPER_ADMIN }, async () => {
      const results = await BidModel.find({});
      expect(results).toHaveLength(2);
    });
  });

  it('anonymous/public-route traffic bypasses without throwing', async () => {
    const results = await BidModel.find({});
    expect(Array.isArray(results)).toBe(true);
  });

  it('an anonymous store carrying only a correlation id (no role) bypasses rather than throwing', async () => {
    await tenantContext.run({ correlationId: 'req-123' } as never, async () => {
      const results = await BidModel.find({});
      expect(Array.isArray(results)).toBe(true);
    });
  });

  it('throws for a role this plugin has no scoping rule for', async () => {
    await expect(
      tenantContext.run({ userId: 'client-x', role: UserRole.CLIENT, companyId: FUEL_CO_A }, () =>
        BidModel.find({}).exec(),
      ),
    ).rejects.toThrow(/no scoping rule/i);
  });
});
