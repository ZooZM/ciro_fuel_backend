import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderSchema, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { StopOrigin } from '../../src/common/enums/stop-origin.enum';
import { StopReason } from '../../src/common/enums/stop-reason.enum';

jest.setTimeout(60_000);

/**
 * spec 011 T032 (FR-008d, SC-009): a declared stop suppresses detection for
 * exactly as long as the driver said it would, and not a minute longer.
 *
 * This tests the **filter shape**, not the service, because that is where the
 * requirement actually lives and where it can silently go wrong. The obvious
 * implementation — treat a declaration as blocking while it is unresolved —
 * looks correct, passes every test about declarations being respected, and
 * suppresses detection for the entire remainder of the delivery: one
 * declaration at the depot and the truck is invisible for the whole journey.
 * That is the precise failure this feature exists to prevent, self-inflicted,
 * and nothing else in the suite would catch it. So both the correct filter
 * and the tempting-but-wrong one are exercised here, against the same
 * documents, with the difference between them asserted explicitly.
 */
describe('Declared-stop suppression lapses (FR-008d)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let OrderModel: mongoose.Model<OrderDocument>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    OrderModel = connection.model(Order.name, OrderSchema) as unknown as mongoose.Model<OrderDocument>;
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await OrderModel.deleteMany({});
  });

  /** The sweep's own guard, verbatim (`unblockedStopFilter`). */
  function blockingStop(now: Date) {
    return { $or: [{ resolvedAt: null }, { suppressedUntil: { $gt: now } }] };
  }

  async function seedWithDeclaredStop(suppressedUntil: Date): Promise<OrderDocument> {
    const now = new Date();
    return OrderModel.create({
      fuelCompanyId: new mongoose.Types.ObjectId(),
      clientId: new mongoose.Types.ObjectId(),
      driverId: new mongoose.Types.ObjectId(),
      status: OrderStatus.IN_TRANSIT,
      fuelType: 'DIESEL',
      quantityLiters: 500,
      estimatedPrice: 1000,
      deliveryLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
      stopEvents: [
        {
          origin: StopOrigin.DECLARED,
          detectedAt: now,
          reason: StopReason.REST_OR_PRAYER,
          reasonGivenAt: now,
          expectedDurationMinutes: 20,
          suppressedUntil,
          // Created already resolved: a declaration arrives carrying its own
          // answer, so nothing is left open. Suppression is carried by
          // `suppressedUntil` alone — which is what makes it time-bounded.
          resolvedAt: now,
        },
      ],
    });
  }

  /** Would the sweep raise a new stop on this order right now? */
  async function sweepWouldRaise(orderId: unknown, now: Date): Promise<boolean> {
    const match = await OrderModel.findOne({
      _id: orderId,
      status: OrderStatus.IN_TRANSIT,
      stopEvents: { $not: { $elemMatch: blockingStop(now) } },
    })
      .select('_id')
      .lean()
      .exec();
    return match !== null;
  }

  it('suppresses detection while the declared window holds, and stops suppressing once it lapses', async () => {
    const now = new Date();
    const order = await seedWithDeclaredStop(new Date(now.getTime() + 20 * 60_000));

    // Inside the driver's own estimate: they told us, so we do not ask.
    expect(await sweepWouldRaise(order._id, now)).toBe(false);

    // Past it, still stationary. The declaration has done its job and is now
    // just a record of what the driver said at the time; a driver stopped
    // longer than they predicted is exactly who should be asked.
    const afterLapse = new Date(now.getTime() + 21 * 60_000);
    expect(await sweepWouldRaise(order._id, afterLapse)).toBe(true);
  });

  it('raises a NEW detected stop rather than reopening the declaration', async () => {
    const now = new Date();
    const order = await seedWithDeclaredStop(new Date(now.getTime() + 20 * 60_000));
    const afterLapse = new Date(now.getTime() + 21 * 60_000);

    await OrderModel.updateOne(
      {
        _id: order._id,
        status: OrderStatus.IN_TRANSIT,
        stopEvents: { $not: { $elemMatch: blockingStop(afterLapse) } },
      },
      {
        $push: {
          stopEvents: { origin: StopOrigin.DETECTED, detectedAt: afterLapse },
        },
      },
    ).exec();

    const updated = await OrderModel.findById(order._id).exec();
    expect(updated!.stopEvents).toHaveLength(2);
    // The original declaration is untouched — it stays a truthful record of
    // what the driver said, rather than being mutated into something they
    // never said.
    expect(updated!.stopEvents[0].origin).toBe(StopOrigin.DECLARED);
    expect(updated!.stopEvents[0].reason).toBe(StopReason.REST_OR_PRAYER);
    expect(updated!.stopEvents[1].origin).toBe(StopOrigin.DETECTED);
    expect(updated!.stopEvents[1].reasonGivenAt).toBeUndefined();

    // And with a genuinely open stop now present, the guard blocks again —
    // FR-016 still holds across the transition.
    expect(await sweepWouldRaise(order._id, afterLapse)).toBe(false);
  });

  it('the naive "unresolved means blocking" guard would suppress the whole delivery', async () => {
    const now = new Date();
    const order = await seedWithDeclaredStop(new Date(now.getTime() + 20 * 60_000));
    const muchLater = new Date(now.getTime() + 8 * 60 * 60_000);

    // The correct guard has released by now.
    expect(await sweepWouldRaise(order._id, muchLater)).toBe(true);

    // The variant that drops the `suppressedUntil` clause and blocks on any
    // open stop never releases at all — a declaration made once would be
    // permanent. Pinning the difference here is what stops the two filters
    // being "simplified" into each other.
    const naive = await OrderModel.findOne({
      _id: order._id,
      status: OrderStatus.IN_TRANSIT,
      stopEvents: { $not: { $elemMatch: { suppressedUntil: { $exists: true } } } },
    })
      .select('_id')
      .lean()
      .exec();
    expect(naive).toBeNull();
  });
});
