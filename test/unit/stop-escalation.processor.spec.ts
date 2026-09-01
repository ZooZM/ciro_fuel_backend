import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Job } from 'bullmq';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { StopEscalationProcessor } from '../../src/modules/stop-detection/queues/stop-escalation.processor';
import { StopEscalationJobData } from '../../src/modules/stop-detection/queues/stop-escalation-queue.service';
import { Order, OrderSchema, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { NotificationType } from '../../src/common/enums/notification-type.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { StopOrigin } from '../../src/common/enums/stop-origin.enum';
import { StopReason } from '../../src/common/enums/stop-reason.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(60_000);

/**
 * spec 011 T043/T044 (FR-009, FR-010, SC-004, SC-008): the escalation
 * processor's own decisions.
 *
 * Driven directly rather than through Redis. What is under test is *whether
 * it should act*, not whether BullMQ delivers a delayed job — the latter is
 * already covered against real Redis by the assignment-escalation suite, and
 * it is the same queue infrastructure.
 */
describe('StopEscalationProcessor (spec 011 US3)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let OrderModel: mongoose.Model<OrderDocument>;
  let UserModel: mongoose.Model<UserDocument>;
  let notify: jest.Mock;
  let processor: StopEscalationProcessor;

  const transportCompanyId = new mongoose.Types.ObjectId();
  const fuelCompanyId = new mongoose.Types.ObjectId();
  let adminId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    OrderModel = connection.model(Order.name, OrderSchema) as unknown as mongoose.Model<OrderDocument>;
    UserModel = connection.model(User.name, UserSchema) as unknown as mongoose.Model<UserDocument>;

    const admin = await UserModel.create({
      companyId: transportCompanyId,
      role: UserRole.TRANSPORT_COMPANY_ADMIN,
      email: 'transport-admin@escalation.test',
      passwordHash: 'not-a-real-hash',
      fullName: 'Transport Admin',
      phone: '+966500000001',
      isActive: true,
    });
    adminId = admin._id as mongoose.Types.ObjectId;
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    notify = jest.fn().mockResolvedValue(undefined);
    processor = new StopEscalationProcessor(
      OrderModel,
      UserModel,
      { notify } as unknown as NotificationsService,
      new TenantContextService(),
    );
  });

  afterEach(async () => {
    await OrderModel.deleteMany({});
  });

  async function seedOrder(
    stop: Record<string, unknown>,
    status: OrderStatus = OrderStatus.IN_TRANSIT,
  ): Promise<{ orderId: string; stopId: string }> {
    const stopId = new mongoose.Types.ObjectId();
    const order = await OrderModel.create({
      fuelCompanyId,
      transportCompanyId,
      clientId: new mongoose.Types.ObjectId(),
      driverId: new mongoose.Types.ObjectId(),
      status,
      fuelType: 'DIESEL',
      quantityLiters: 500,
      estimatedPrice: 1000,
      deliveryLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
      stopEvents: [{ _id: stopId, origin: StopOrigin.DETECTED, detectedAt: new Date(), ...stop }],
    });
    return { orderId: String(order._id), stopId: String(stopId) };
  }

  function jobFor(orderId: string, stopId: string): Job<StopEscalationJobData> {
    return { data: { orderId, stopId } } as Job<StopEscalationJobData>;
  }

  it('notifies the transport admin exactly once for an unanswered stop, and stamps escalatedAt (FR-009)', async () => {
    const { orderId, stopId } = await seedOrder({});

    await processor.process(jobFor(orderId, stopId));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: String(adminId),
        type: NotificationType.ORDER_STOP_UNRESOLVED,
        payload: { stopId },
      }),
    );

    const order = await OrderModel.findById(orderId).exec();
    expect(order!.stopEvents[0].escalatedAt).toBeInstanceOf(Date);
  });

  it('does not escalate a stop the driver already answered (SC-008)', async () => {
    const { orderId, stopId } = await seedOrder({
      reason: StopReason.TRAFFIC,
      reasonGivenAt: new Date(),
      resolvedAt: new Date(),
    });

    // Reaching here at all means the cancel lost a race with the timer —
    // expected and harmless. What must not happen is the transporter being
    // told a driver went silent when they did not.
    await processor.process(jobFor(orderId, stopId));

    expect(notify).not.toHaveBeenCalled();
    const order = await OrderModel.findById(orderId).exec();
    expect(order!.stopEvents[0].escalatedAt).toBeUndefined();
  });

  it('does not escalate twice for the same stop (SC-008)', async () => {
    const { orderId, stopId } = await seedOrder({});

    await processor.process(jobFor(orderId, stopId));
    // A duplicate delivery of the same job — BullMQ's at-least-once
    // semantics make this possible, so idempotence has to be real rather
    // than assumed.
    await processor.process(jobFor(orderId, stopId));

    // This found a real defect: the processor originally guarded only on
    // `reasonGivenAt`/`resolvedAt`, so a redelivered job escalated a second
    // time and the transport admin was told twice about one silence.
    // `escalatedAt` is now part of the same conditional write that stamps
    // it, so whichever delivery wins is the only one that notifies.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not escalate once the delivery has finished (FR-014)', async () => {
    for (const status of [OrderStatus.DELIVERED, OrderStatus.CANCELLED]) {
      const { orderId, stopId } = await seedOrder({}, status);
      await processor.process(jobFor(orderId, stopId));
      expect(notify).not.toHaveBeenCalled();
    }
  });

  it('produces the notification well inside SC-004’s one-minute bound', async () => {
    const { orderId, stopId } = await seedOrder({});

    const started = Date.now();
    await processor.process(jobFor(orderId, stopId));
    const elapsed = Date.now() - started;

    // SC-004 budgets a minute from the job becoming due to the transporter
    // being told. The queue's own delivery latency is BullMQ's concern; what
    // this pins is that the handler itself spends a negligible slice of that
    // budget, so a future addition here (a synchronous lookup, an external
    // call) that quietly ate it would show up.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(5_000);
  });

  // T044 (FR-010): the late-answer case, from the processor's side.
  it('leaves escalatedAt in place when the driver answers afterwards', async () => {
    const { orderId, stopId } = await seedOrder({});
    await processor.process(jobFor(orderId, stopId));

    // The driver answers late — the same write `submitReason` performs.
    await OrderModel.updateOne(
      { _id: orderId, 'stopEvents._id': stopId },
      {
        $set: {
          'stopEvents.$.reason': StopReason.VEHICLE_PROBLEM,
          'stopEvents.$.reasonGivenAt': new Date(),
          'stopEvents.$.resolvedAt': new Date(),
        },
      },
    ).exec();

    const order = await OrderModel.findById(orderId).exec();
    const stop = order!.stopEvents[0];
    expect(stop.reason).toBe(StopReason.VEHICLE_PROBLEM);
    expect(stop.resolvedAt).toBeInstanceOf(Date);
    // Deliberately NOT cleared. The transporter genuinely was alerted, and
    // erasing that would make the delivery's record lie about what happened
    // — the administrator who acted on the alert would find no trace of why.
    expect(stop.escalatedAt).toBeInstanceOf(Date);
  });
});
