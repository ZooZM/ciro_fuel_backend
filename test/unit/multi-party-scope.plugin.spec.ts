import mongoose, { Schema, Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMultiPartyScopePlugin } from '../../src/common/plugins/multi-party-scope.plugin';
import { markMultiParty } from '../../src/common/plugins/multi-party.marker';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(60_000);

describe('multiPartyScopePlugin', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let tenantContext: TenantContextService;

  const FUEL_CO_A = new mongoose.Types.ObjectId().toString();
  const FUEL_CO_B = new mongoose.Types.ObjectId().toString();
  const TRANSPORT_CO_A1 = new mongoose.Types.ObjectId().toString();
  const CLIENT_A = new mongoose.Types.ObjectId().toString();
  const CLIENT_A2 = new mongoose.Types.ObjectId().toString();
  const DRIVER_A = new mongoose.Types.ObjectId().toString();

  interface Widget {
    fuelCompanyId?: mongoose.Types.ObjectId;
    transportCompanyId?: mongoose.Types.ObjectId;
    clientId?: mongoose.Types.ObjectId;
    driverId?: mongoose.Types.ObjectId;
    name: string;
  }

  let WidgetModel: mongoose.Model<Widget>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  }, 120_000);

  beforeAll(async () => {
    tenantContext = new TenantContextService();
    connection.plugin(createMultiPartyScopePlugin(tenantContext));

    const widgetSchema = new Schema<Widget>({
      fuelCompanyId: { type: Schema.Types.ObjectId },
      transportCompanyId: { type: Schema.Types.ObjectId },
      clientId: { type: Schema.Types.ObjectId },
      driverId: { type: Schema.Types.ObjectId },
      name: { type: String, required: true },
    });
    markMultiParty(widgetSchema);

    WidgetModel = connection.model<Widget>('Widget', widgetSchema);
  });

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await WidgetModel.deleteMany({});
  });

  // --- fuelCompanyId forced on write, one per role -----------------------

  it('forces fuelCompanyId on save for FUEL_COMPANY_ADMIN', async () => {
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      async () => {
        const doc = await WidgetModel.create({ name: 'w1' });
        expect(doc.fuelCompanyId?.toString()).toBe(FUEL_CO_A);
      },
    );
  });

  it('forces fuelCompanyId from parentFuelCompanyId for TRANSPORT_COMPANY_ADMIN, never their own companyId', async () => {
    await tenantContext.run(
      {
        userId: 'transport-admin',
        role: UserRole.TRANSPORT_COMPANY_ADMIN,
        companyId: TRANSPORT_CO_A1,
        parentFuelCompanyId: FUEL_CO_A,
      },
      async () => {
        const doc = await WidgetModel.create({ name: 'w2' });
        expect(doc.fuelCompanyId?.toString()).toBe(FUEL_CO_A);
        expect(doc.fuelCompanyId?.toString()).not.toBe(TRANSPORT_CO_A1);
      },
    );
  });

  it('forces fuelCompanyId on save for CLIENT', async () => {
    await tenantContext.run(
      { userId: CLIENT_A, role: UserRole.CLIENT, companyId: FUEL_CO_A },
      async () => {
        const doc = await WidgetModel.create({ name: 'w3' });
        expect(doc.fuelCompanyId?.toString()).toBe(FUEL_CO_A);
      },
    );
  });

  it('forces fuelCompanyId on save for DRIVER', async () => {
    await tenantContext.run(
      { userId: DRIVER_A, role: UserRole.DRIVER, companyId: FUEL_CO_A },
      async () => {
        const doc = await WidgetModel.create({ name: 'w4' });
        expect(doc.fuelCompanyId?.toString()).toBe(FUEL_CO_A);
      },
    );
  });

  it('CIRO (SUPER_ADMIN) writes are never scoped', async () => {
    await tenantContext.run({ userId: 'ciro', role: UserRole.SUPER_ADMIN }, async () => {
      const doc = await WidgetModel.create({ name: 'w5' });
      expect(doc.fuelCompanyId).toBeUndefined();
    });
  });

  // --- read filters: every non-CIRO role carries fuelCompanyId -----------

  async function seedAcrossTenants() {
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      () => WidgetModel.create({ name: 'a1', clientId: new mongoose.Types.ObjectId(CLIENT_A) }),
    );
    await tenantContext.run(
      { userId: 'admin-b', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_B },
      () => WidgetModel.create({ name: 'b1' }),
    );
  }

  it("FUEL_COMPANY_ADMIN sees only its own fuel company's records", async () => {
    await seedAcrossTenants();
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      async () => {
        const results = await WidgetModel.find({});
        expect(results.map((r) => r.name)).toEqual(['a1']);
      },
    );
  });

  it("TRANSPORT_COMPANY_ADMIN's filter carries fuelCompanyId, not just transportCompanyId", async () => {
    await seedAcrossTenants();
    await tenantContext.run(
      {
        userId: 'admin-a',
        role: UserRole.FUEL_COMPANY_ADMIN,
        companyId: FUEL_CO_A,
      },
      () =>
        WidgetModel.create({
          name: 'routed-to-a1',
          transportCompanyId: new mongoose.Types.ObjectId(TRANSPORT_CO_A1),
        }),
    );
    // A transporter genuinely serving Fuel Company A sees the routed record.
    await tenantContext.run(
      {
        userId: 'transport-admin-a1',
        role: UserRole.TRANSPORT_COMPANY_ADMIN,
        companyId: TRANSPORT_CO_A1,
        parentFuelCompanyId: FUEL_CO_A,
      },
      async () => {
        const results = await WidgetModel.find({});
        expect(results.map((r) => r.name)).toEqual(['routed-to-a1']);
      },
    );
    // The *same transportCompanyId*, but forged under Fuel Company B's
    // parentage, must see nothing — proving fuelCompanyId is a real
    // predicate here, not decorative alongside transportCompanyId alone.
    await tenantContext.run(
      {
        userId: 'imposter',
        role: UserRole.TRANSPORT_COMPANY_ADMIN,
        companyId: TRANSPORT_CO_A1,
        parentFuelCompanyId: FUEL_CO_B,
      },
      async () => {
        const results = await WidgetModel.find({});
        expect(results).toHaveLength(0);
      },
    );
  });

  it('CLIENT sees only their own records within their fuel company', async () => {
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      async () => {
        await WidgetModel.create({
          name: 'mine',
          clientId: new mongoose.Types.ObjectId(CLIENT_A),
        });
        await WidgetModel.create({
          name: 'not-mine',
          clientId: new mongoose.Types.ObjectId(CLIENT_A2),
        });
      },
    );
    await tenantContext.run(
      { userId: CLIENT_A, role: UserRole.CLIENT, companyId: FUEL_CO_A },
      async () => {
        const results = await WidgetModel.find({});
        expect(results.map((r) => r.name)).toEqual(['mine']);
      },
    );
  });

  it('DRIVER sees only records assigned to them', async () => {
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      async () => {
        await WidgetModel.create({
          name: 'assigned-to-me',
          driverId: new mongoose.Types.ObjectId(DRIVER_A),
        });
        await WidgetModel.create({ name: 'unassigned' });
      },
    );
    await tenantContext.run(
      { userId: DRIVER_A, role: UserRole.DRIVER, companyId: FUEL_CO_A },
      async () => {
        const results = await WidgetModel.find({});
        expect(results.map((r) => r.name)).toEqual(['assigned-to-me']);
      },
    );
  });

  it('CIRO (SUPER_ADMIN) reads are never scoped', async () => {
    await seedAcrossTenants();
    await tenantContext.run({ userId: 'ciro', role: UserRole.SUPER_ADMIN }, async () => {
      const results = await WidgetModel.find({});
      expect(results.map((r) => r.name).sort()).toEqual(['a1', 'b1']);
    });
  });

  // --- injected filter overrides caller-supplied values -------------------

  it('overrides a caller-supplied foreign fuelCompanyId rather than merely filling a gap', async () => {
    await seedAcrossTenants();
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      async () => {
        // Attempts to escape scoping by explicitly filtering for Fuel Company
        // B's id — the plugin must override this back to the actor's own
        // tenant, so the result is still exactly Fuel Company A's data.
        const results = await WidgetModel.find({ fuelCompanyId: FUEL_CO_B });
        expect(results.map((r) => r.name)).toEqual(['a1']);
      },
    );
  });

  it("a caller-supplied clientId cannot make a CLIENT read another client's record", async () => {
    await tenantContext.run(
      { userId: 'admin-a', role: UserRole.FUEL_COMPANY_ADMIN, companyId: FUEL_CO_A },
      () =>
        WidgetModel.create({
          name: 'not-mine',
          clientId: new mongoose.Types.ObjectId(CLIENT_A2),
        }),
    );
    await tenantContext.run(
      { userId: CLIENT_A, role: UserRole.CLIENT, companyId: FUEL_CO_A },
      async () => {
        const results = await WidgetModel.find({ clientId: CLIENT_A2 });
        expect(results).toHaveLength(0);
      },
    );
  });

  // --- fail-closed on a missing scoping identity ---------------------------

  it('throws rather than querying unscoped when a non-CIRO context has no companyId at all', async () => {
    await expect(
      tenantContext.run(
        { userId: 'broken', role: UserRole.FUEL_COMPANY_ADMIN, companyId: undefined },
        () => WidgetModel.find({}).exec(),
      ),
    ).rejects.toThrow(/isolation violation/i);
  });

  it('throws for a TRANSPORT_COMPANY_ADMIN with no parentFuelCompanyId resolved', async () => {
    await expect(
      tenantContext.run(
        {
          userId: 'broken-transport-admin',
          role: UserRole.TRANSPORT_COMPANY_ADMIN,
          companyId: TRANSPORT_CO_A1,
          parentFuelCompanyId: undefined,
        },
        () => WidgetModel.find({}).exec(),
      ),
    ).rejects.toThrow(/isolation violation/i);
  });

  it('with no context at all (scripts/seeds), queries run unscoped', async () => {
    const results = await WidgetModel.find({});
    expect(Array.isArray(results)).toBe(true);
  });
});
