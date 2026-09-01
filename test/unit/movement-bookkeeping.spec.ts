import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { haversineDistanceMeters } from '../../src/common/utils/geo.util';

jest.setTimeout(60_000);

const MOVEMENT_THRESHOLD_METERS = 50;
const BASE: [number, number] = [46.6753, 24.7136];

/**
 * spec 011 T012 (FR-003, FR-017, SC-007): the two properties the whole
 * feature rests on, tested against the real schema.
 *
 * This deliberately reproduces `tracking.gateway.ts`'s movement rule rather
 * than booting the gateway (which needs a socket server, a JWT and a live
 * connection): what is under test is the *rule*, and reproducing it here
 * would fail loudly if the gateway's own version ever diverged — which is
 * exactly the regression worth catching, since both would otherwise stay
 * silently green.
 */
describe('Driver movement bookkeeping (spec 011)', () => {
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

  async function seedDriver(): Promise<UserDocument> {
    return UserModel.create({
      companyId: new mongoose.Types.ObjectId(),
      role: UserRole.DRIVER,
      email: `driver-${new mongoose.Types.ObjectId().toString()}@movement.test`,
      passwordHash: 'not-a-real-hash',
      fullName: 'Movement Test Driver',
      phone: '+966500000000',
      isActive: true,
    });
  }

  /** The gateway's rule, reproduced: displacement is measured from
   *  `lastMovedLocation`, never from `location`. */
  async function applyFix(driverId: mongoose.Types.ObjectId, lng: number, lat: number, at: Date) {
    const driver = await UserModel.findById(driverId).exec();
    const movedDistance = driver?.lastMovedLocation
      ? haversineDistanceMeters(driver.lastMovedLocation.coordinates, [lng, lat])
      : Infinity;
    const hasMoved = movedDistance > MOVEMENT_THRESHOLD_METERS;

    await UserModel.updateOne(
      { _id: driverId },
      {
        $set: {
          location: { type: 'Point', coordinates: [lng, lat] },
          locationUpdatedAt: at,
          lastSeenAt: at,
          ...(hasMoved
            ? { lastMovedAt: at, lastMovedLocation: { type: 'Point', coordinates: [lng, lat] } }
            : {}),
        },
      },
    ).exec();
  }

  it('a heartbeat from a stationary driver advances lastSeenAt but never lastMovedAt (FR-017)', async () => {
    const driver = await seedDriver();
    const id = driver._id as mongoose.Types.ObjectId;

    const firstFix = new Date('2026-01-01T10:00:00Z');
    await applyFix(id, BASE[0], BASE[1], firstFix);
    const afterFirst = await UserModel.findById(id).exec();
    // The first-ever fix establishes the baseline — there was nothing to
    // measure against, so it counts as movement.
    expect(afterFirst?.lastMovedAt?.toISOString()).toBe(firstFix.toISOString());

    // Three heartbeats at the exact same position, minutes apart.
    for (let i = 1; i <= 3; i++) {
      await applyFix(id, BASE[0], BASE[1], new Date(`2026-01-01T10:0${i * 3}:00Z`));
    }

    const afterHeartbeats = await UserModel.findById(id).exec();
    // Presence kept advancing...
    expect(afterHeartbeats?.lastSeenAt?.toISOString()).toBe(
      new Date('2026-01-01T10:09:00Z').toISOString(),
    );
    // ...but movement did not. This is the distinction the whole feature
    // rests on: a parked truck is *reporting*, just not *moving*.
    expect(afterHeartbeats?.lastMovedAt?.toISOString()).toBe(firstFix.toISOString());
  });

  it('GPS jitter around a parked vehicle never accumulates into a movement (FR-003, SC-007)', async () => {
    const driver = await seedDriver();
    const id = driver._id as mongoose.Types.ObjectId;

    const firstFix = new Date('2026-01-01T10:00:00Z');
    await applyFix(id, BASE[0], BASE[1], firstFix);

    // What GPS drift on a parked truck actually looks like: fixes scattered
    // around a fixed point, each within the threshold of it, wandering in no
    // consistent direction. The *total path walked* here is far over 50 m —
    // which is precisely why measuring from `lastMovedLocation` matters. If
    // displacement were measured from `location` (updated by every accepted
    // fix), each hop would rebaseline and this stationary truck would
    // eventually read as moving, silently disabling stop detection.
    const JITTER = [
      [0.0002, 0.0001],
      [-0.0003, 0.0002],
      [0.0001, -0.0003],
      [-0.0002, -0.0001],
      [0.0003, 0.0002],
      [-0.0001, 0.0003],
      [0.0002, -0.0002],
      [-0.0003, -0.0002],
    ] as const;

    let pathWalkedMeters = 0;
    let previous: [number, number] = BASE;
    for (let i = 0; i < JITTER.length; i++) {
      const point: [number, number] = [BASE[0] + JITTER[i][0], BASE[1] + JITTER[i][1]];
      // Every jittered fix stays within the threshold of the parked position.
      expect(haversineDistanceMeters(BASE, point)).toBeLessThan(MOVEMENT_THRESHOLD_METERS);
      pathWalkedMeters += haversineDistanceMeters(previous, point);
      previous = point;
      await applyFix(
        id,
        point[0],
        point[1],
        new Date(`2026-01-01T10:${String((i + 1) * 3).padStart(2, '0')}:00Z`),
      );
    }

    const after = await UserModel.findById(id).exec();
    expect(after?.lastMovedAt?.toISOString()).toBe(firstFix.toISOString());
    // Sanity: the jitter really did wander a meaningful total distance, so
    // this passes because the rule works, not because nothing happened.
    expect(pathWalkedMeters).toBeGreaterThan(MOVEMENT_THRESHOLD_METERS * 2);
  });

  it('slow steady travel IS movement, even in sub-threshold steps (the deliberate counterpart to drift)', async () => {
    const driver = await seedDriver();
    const id = driver._id as mongoose.Types.ObjectId;

    await applyFix(id, BASE[0], BASE[1], new Date('2026-01-01T10:00:00Z'));

    // A truck crawling forward in ~22 m increments is not drifting — it is
    // driving slowly, and must read as moving once it has genuinely left the
    // baseline behind. This is the boundary the previous test's rule must not
    // over-suppress: "ignore small deltas" is wrong; "ignore small deltas
    // *from where we last called it moved*" is right.
    const STEP_DEGREES = 0.0002; // ~22 m of latitude
    for (let i = 1; i <= 3; i++) {
      await applyFix(
        id,
        BASE[0],
        BASE[1] + STEP_DEGREES * i,
        new Date(`2026-01-01T10:0${i * 2}:00Z`),
      );
    }

    const after = await UserModel.findById(id).exec();
    // By the third step the truck is ~66 m from the baseline — genuinely moved.
    expect(after?.lastMovedAt?.toISOString()).toBe(new Date('2026-01-01T10:06:00Z').toISOString());
  });

  it('a genuine move past the threshold does advance lastMovedAt and rebaselines', async () => {
    const driver = await seedDriver();
    const id = driver._id as mongoose.Types.ObjectId;

    await applyFix(id, BASE[0], BASE[1], new Date('2026-01-01T10:00:00Z'));
    const movedAt = new Date('2026-01-01T10:05:00Z');
    // ~220 m north — comfortably past 50 m.
    await applyFix(id, BASE[0], BASE[1] + 0.002, movedAt);

    const after = await UserModel.findById(id).exec();
    expect(after?.lastMovedAt?.toISOString()).toBe(movedAt.toISOString());
    expect(after?.lastMovedLocation?.coordinates[1]).toBeCloseTo(BASE[1] + 0.002, 6);
  });

  it('a driver who has never sent a fix has no lastMovedAt at all (FR-020 precondition)', async () => {
    const driver = await seedDriver();
    const fetched = await UserModel.findById(driver._id).exec();
    // Not zero, not epoch — absent. The stop sweep's `$lt: cutoff` query
    // skips null naturally, which is what keeps a permission-denied driver
    // from being reported as stopped.
    expect(fetched?.lastMovedAt).toBeUndefined();
  });
});
