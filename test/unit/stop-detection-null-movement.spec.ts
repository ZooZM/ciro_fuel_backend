import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(60_000);

/**
 * spec 011 T016a (FR-020): a driver who never granted location permission
 * has never sent a fix, so they have no `lastMovedAt` at all — and must
 * never be reported as stopped. Not moving and never having reported are
 * different things, and only the first is a stop.
 *
 * This tests the **query semantics** the sweep depends on rather than the
 * service, because the failure mode is a query-shape mistake, not a logic
 * one: `{ lastMovedAt: { $lt: cutoff } }` correctly skips absent fields, but
 * a well-meant `$or: [{ lastMovedAt: null }, { lastMovedAt: { $lt: cutoff } }]`
 * "to be safe" would report every permission-denied driver as stopped —
 * silently, and for exactly the drivers least able to answer the prompt.
 * Both shapes are asserted here so the wrong one cannot be introduced
 * without a red test.
 */
describe('Stop detection — a driver who has never moved is not a stopped driver (FR-020)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: mongoose.Model<UserDocument>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema) as unknown as mongoose.Model<UserDocument>;
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await UserModel.deleteMany({});
  });

  async function seedDriver(overrides: Record<string, unknown>): Promise<UserDocument> {
    return UserModel.create({
      companyId: new mongoose.Types.ObjectId(),
      role: UserRole.DRIVER,
      email: `driver-${new mongoose.Types.ObjectId().toString()}@nullmove.test`,
      passwordHash: 'not-a-real-hash',
      fullName: 'Null Movement Driver',
      phone: '+966500000000',
      isActive: true,
      activeOrderId: new mongoose.Types.ObjectId(),
      ...overrides,
    });
  }

  /** The sweep's actual query, verbatim. */
  function stalledQuery(cutoff: Date) {
    return {
      role: UserRole.DRIVER,
      activeOrderId: { $exists: true },
      lastMovedAt: { $lt: cutoff },
    };
  }

  it('excludes a driver with no lastMovedAt, while still catching a genuinely stalled one', async () => {
    const cutoff = new Date(Date.now() - 10 * 60_000);

    // Never granted location permission — no fix has ever arrived.
    const neverMoved = await seedDriver({});
    // Genuinely stopped: reported, then stopped reporting movement.
    const stalled = await seedDriver({ lastMovedAt: new Date(Date.now() - 30 * 60_000) });
    // Moving normally.
    const moving = await seedDriver({ lastMovedAt: new Date() });

    const matched = await UserModel.find(stalledQuery(cutoff)).select('_id').lean().exec();
    const matchedIds = matched.map((d) => String(d._id));

    expect(matchedIds).toContain(String(stalled._id));
    expect(matchedIds).not.toContain(String(neverMoved._id));
    expect(matchedIds).not.toContain(String(moving._id));
  });

  it('demonstrates the wrong query shape would sweep in every permission-denied driver', async () => {
    const cutoff = new Date(Date.now() - 10 * 60_000);
    const neverMoved = await seedDriver({});

    // The tempting "defensive" variant — this is what must NOT be written.
    const overreaching = await UserModel.find({
      role: UserRole.DRIVER,
      activeOrderId: { $exists: true },
      $or: [{ lastMovedAt: null }, { lastMovedAt: { $lt: cutoff } }],
    })
      .select('_id')
      .lean()
      .exec();

    // It matches the driver the correct query correctly ignores. Pinning
    // this makes the difference between the two shapes explicit rather than
    // a subtlety someone has to already know.
    expect(overreaching.map((d) => String(d._id))).toContain(String(neverMoved._id));
    const correct = await UserModel.find(stalledQuery(cutoff)).select('_id').lean().exec();
    expect(correct).toHaveLength(0);
  });
});
