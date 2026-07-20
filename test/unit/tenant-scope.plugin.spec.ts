import mongoose, { Schema, Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTenantScopePlugin } from '../../src/common/plugins/tenant-scope.plugin';
import { markTenantScoped } from '../../src/common/plugins/tenant-scoped.marker';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(60_000);

describe('tenantScopePlugin', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let tenantContext: TenantContextService;

  const COMPANY_A = new mongoose.Types.ObjectId().toString();
  const COMPANY_B = new mongoose.Types.ObjectId().toString();

  interface Widget {
    companyId?: mongoose.Types.ObjectId;
    name: string;
  }

  let WidgetModel: mongoose.Model<Widget>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  }, 120_000);

  beforeAll(async () => {
    tenantContext = new TenantContextService();
    connection.plugin(createTenantScopePlugin(tenantContext));

    const widgetSchema = new Schema<Widget>({
      companyId: { type: Schema.Types.ObjectId },
      name: { type: String, required: true },
    });
    markTenantScoped(widgetSchema);

    WidgetModel = connection.model<Widget>('Widget', widgetSchema);
  });

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await WidgetModel.deleteMany({});
  });

  it('injects companyId on save for a scoped role', async () => {
    await tenantContext.run(
      { userId: 'u1', role: UserRole.COMPANY_ADMIN, companyId: COMPANY_A },
      async () => {
        const doc = await WidgetModel.create({ name: 'foo' });
        expect(doc.companyId?.toString()).toBe(COMPANY_A);
      },
    );
  });

  it('scopes find() to the current tenant, hiding other tenants documents', async () => {
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_A),
      name: 'a-widget',
    });
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_B),
      name: 'b-widget',
    });

    await tenantContext.run(
      { userId: 'u1', role: UserRole.COMPANY_ADMIN, companyId: COMPANY_A },
      async () => {
        const results = await WidgetModel.find({}).exec();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('a-widget');
      },
    );
  });

  it('overrides a caller-supplied foreign companyId rather than merely filling a gap', async () => {
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_A),
      name: 'a-widget',
    });
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_B),
      name: 'b-widget',
    });

    await tenantContext.run(
      { userId: 'u1', role: UserRole.COMPANY_ADMIN, companyId: COMPANY_A },
      async () => {
        // Attempt to escape scoping by explicitly filtering for company B's id —
        // the plugin must override this back to the actor's own tenant (company A),
        // so the result is still exactly company A's data, never company B's.
        const results = await WidgetModel.find({ companyId: COMPANY_B }).exec();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('a-widget');
      },
    );
  });

  it('bypasses scoping entirely for SUPER_ADMIN', async () => {
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_A),
      name: 'a-widget',
    });
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_B),
      name: 'b-widget',
    });

    await tenantContext.run({ userId: 'root', role: UserRole.SUPER_ADMIN }, async () => {
      const results = await WidgetModel.find({}).exec();
      expect(results).toHaveLength(2);
    });
  });

  it('bypasses scoping when there is no active context (scripts/seeds)', async () => {
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_A),
      name: 'a-widget',
    });
    const results = await WidgetModel.find({}).exec();
    expect(results).toHaveLength(1);
  });

  it('fails closed when a scoped role is missing companyId (corrupt/forged token)', async () => {
    await expect(
      tenantContext.run({ userId: 'u1', role: UserRole.CLIENT }, () => WidgetModel.find({}).exec()),
    ).rejects.toThrow(/missing companyId/);
  });

  it('prepends $match for a plain aggregate pipeline with no $geoNear', async () => {
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_A),
      name: 'a-widget',
    });
    await WidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_B),
      name: 'b-widget',
    });

    await tenantContext.run(
      { userId: 'u1', role: UserRole.COMPANY_ADMIN, companyId: COMPANY_A },
      async () => {
        const results = await WidgetModel.aggregate([{ $sort: { name: 1 } }]).exec();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('a-widget');
      },
    );
  });

  it("inserts $match immediately after $geoNear (which must remain the pipeline's first stage)", async () => {
    interface GeoWidget {
      companyId?: mongoose.Types.ObjectId;
      name: string;
      location: { type: string; coordinates: [number, number] };
    }
    const geoSchema = new Schema<GeoWidget>({
      companyId: { type: Schema.Types.ObjectId },
      name: { type: String, required: true },
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true },
      },
    });
    geoSchema.index({ location: '2dsphere' });
    markTenantScoped(geoSchema);
    const GeoWidgetModel = connection.model<GeoWidget>('GeoWidget', geoSchema);
    await GeoWidgetModel.createIndexes();

    await GeoWidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_A),
      name: 'near-a',
      location: { type: 'Point', coordinates: [0, 0] },
    });
    await GeoWidgetModel.create({
      companyId: new mongoose.Types.ObjectId(COMPANY_B),
      name: 'near-b',
      location: { type: 'Point', coordinates: [0, 0] },
    });

    await tenantContext.run(
      { userId: 'u1', role: UserRole.COMPANY_ADMIN, companyId: COMPANY_A },
      async () => {
        const results = await GeoWidgetModel.aggregate([
          {
            $geoNear: {
              near: { type: 'Point', coordinates: [0, 0] },
              distanceField: 'distance',
              spherical: true,
            },
          },
        ]).exec();
        // Only company A's document should survive — proving the injected
        // $match after $geoNear actually filtered results, and $geoNear
        // itself did not error out from being pushed out of first position.
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('near-a');
      },
    );
  });
});
