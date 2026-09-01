import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Job } from 'bullmq';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { AssignmentEscalationProcessor } from '../../src/modules/assignment-escalation/queues/assignment-escalation.processor';
import { Order, OrderSchema, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { EscalationSkipReason } from '../../src/common/enums/escalation-skip-reason.enum';
import type { SmsSender } from '../../src/common/sms/sms-sender.port';

jest.setTimeout(60_000);

/**
 * spec 010 T024/T025 (FR-011a, FR-013, FR-015, SC-003): the processor's
 * decision logic — exactly one SMS for a genuinely-unacknowledged
 * assignment, none once acknowledged, the NO_PHONE/SEND_FAILED
 * bookkeeping, and the content bound. `AssignmentEscalationProcessor` is
 * constructed directly (same idiom `order-state.service.spec.ts` already
 * uses for this codebase's unit tests: real Mongo via mongodb-memory-server,
 * no framework DI harness) — only `SmsSender` is mocked, since it is the
 * one genuine external port (spec 005 research R4).
 */
describe('AssignmentEscalationProcessor', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let OrderModel: mongoose.Model<OrderDocument>;
  let UserModel: mongoose.Model<UserDocument>;
  let smsSender: jest.Mocked<SmsSender>;
  let processor: AssignmentEscalationProcessor;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    OrderModel = connection.model(Order.name, OrderSchema) as unknown as mongoose.Model<OrderDocument>;
    UserModel = connection.model(User.name, UserSchema) as unknown as mongoose.Model<UserDocument>;
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    smsSender = { send: jest.fn().mockResolvedValue(undefined) };
    processor = new AssignmentEscalationProcessor(
      OrderModel,
      UserModel,
      smsSender,
      new TenantContextService(),
    );
  });

  afterEach(async () => {
    await OrderModel.deleteMany({});
    await UserModel.deleteMany({});
  });

  async function seedDriver(phone: string): Promise<UserDocument> {
    return UserModel.create({
      companyId: new mongoose.Types.ObjectId(),
      role: UserRole.DRIVER,
      email: `driver-${new mongoose.Types.ObjectId().toString()}@escalationtest.test`,
      passwordHash: 'not-a-real-hash',
      fullName: 'Escalation Test Driver',
      phone,
      isActive: true,
    });
  }

  async function seedAssignedOrder(driverId: mongoose.Types.ObjectId): Promise<OrderDocument> {
    return OrderModel.create({
      fuelCompanyId: new mongoose.Types.ObjectId(),
      clientId: new mongoose.Types.ObjectId(),
      transportCompanyId: new mongoose.Types.ObjectId(),
      fuelType: FuelType.DIESEL,
      quantityLiters: 1000,
      deliveryLocation: { type: 'Point', coordinates: [46.6, 24.7] },
      status: OrderStatus.ASSIGNED_TO_DRIVER,
      estimatedPrice: 2500,
      driverId,
    });
  }

  function job(orderId: string): Job<{ orderId: string }> {
    return { data: { orderId } } as Job<{ orderId: string }>;
  }

  it('sends exactly one SMS for an unacknowledged assignment, containing only an order reference (FR-011a)', async () => {
    const driver = await seedDriver('+966501234567');
    const order = await seedAssignedOrder(driver._id as mongoose.Types.ObjectId);

    await processor.process(job(String(order._id)));

    expect(smsSender.send).toHaveBeenCalledTimes(1);
    const [sentPhone, sentMessage] = smsSender.send.mock.calls[0];
    expect(sentPhone).toBe('+966501234567');
    // FR-011a: an order reference and an instruction to open the app — no
    // customer name, address, or delivery detail could even be in scope,
    // since none of those fields were ever read to build this message.
    expect(sentMessage).toContain(String(order._id).slice(-6).toUpperCase());
    expect(sentMessage).not.toMatch(/address|customer|liter|fuel/i);

    const updated = await OrderModel.findById(order._id).exec();
    expect(updated?.assignmentEscalationSmsAt).toBeInstanceOf(Date);
  });

  it('sends no SMS when the assignment is already acknowledged', async () => {
    const driver = await seedDriver('+966501234568');
    const order = await seedAssignedOrder(driver._id as mongoose.Types.ObjectId);
    order.assignmentAcknowledgedAt = new Date();
    await order.save();

    await processor.process(job(String(order._id)));

    expect(smsSender.send).not.toHaveBeenCalled();
  });

  it('records NO_PHONE and sends nothing when the driver has no valid phone on file', async () => {
    const driver = await seedDriver('N/A');
    const order = await seedAssignedOrder(driver._id as mongoose.Types.ObjectId);

    await processor.process(job(String(order._id)));

    expect(smsSender.send).not.toHaveBeenCalled();
    const updated = await OrderModel.findById(order._id).exec();
    expect(updated?.assignmentEscalationSkippedReason).toBe(EscalationSkipReason.NO_PHONE);
    expect(updated?.assignmentEscalationSmsAt).toBeUndefined();
  });

  it('records SEND_FAILED, distinct from NO_PHONE, when the SMS provider itself throws', async () => {
    smsSender.send.mockRejectedValueOnce(new Error('provider rejected'));
    const driver = await seedDriver('+966501234569');
    const order = await seedAssignedOrder(driver._id as mongoose.Types.ObjectId);

    await processor.process(job(String(order._id)));

    const updated = await OrderModel.findById(order._id).exec();
    expect(updated?.assignmentEscalationSkippedReason).toBe(EscalationSkipReason.SEND_FAILED);
    expect(updated?.assignmentEscalationSmsAt).toBeUndefined();
  });

  it('sends nothing for a cancelled order, even though driverId is left in place for history', async () => {
    const driver = await seedDriver('+966501234570');
    const order = await seedAssignedOrder(driver._id as mongoose.Types.ObjectId);
    order.status = OrderStatus.CANCELLED;
    await order.save();

    await processor.process(job(String(order._id)));

    expect(smsSender.send).not.toHaveBeenCalled();
  });

  it('sends the SMS within one minute of processing under normal conditions (SC-003)', async () => {
    const driver = await seedDriver('+966501234571');
    const order = await seedAssignedOrder(driver._id as mongoose.Types.ObjectId);

    const startedAt = Date.now();
    await processor.process(job(String(order._id)));
    expect((Date.now() - startedAt) / 1000).toBeLessThan(60);
  });
});
