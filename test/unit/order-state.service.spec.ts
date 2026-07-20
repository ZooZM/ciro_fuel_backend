import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStateService } from '../../src/modules/orders/services/order-state.service';
import { RealtimeGatewayService } from '../../src/common/realtime/realtime-gateway.service';
import { Order, OrderSchema, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';

jest.setTimeout(60_000);

describe('OrderStateService', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let OrderModel: mongoose.Model<OrderDocument>;
  let service: OrderStateService;

  const actor = {
    actorId: new mongoose.Types.ObjectId().toString(),
    actorRole: UserRole.COMPANY_ADMIN,
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    OrderModel = connection.model(
      Order.name,
      OrderSchema,
    ) as unknown as mongoose.Model<OrderDocument>;
    service = new OrderStateService(OrderModel, new RealtimeGatewayService());
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await OrderModel.deleteMany({});
  });

  async function seedOrder(status: OrderStatus): Promise<OrderDocument> {
    return OrderModel.create({
      companyId: new mongoose.Types.ObjectId(),
      clientId: new mongoose.Types.ObjectId(),
      fuelType: FuelType.DIESEL,
      quantityLiters: 1000,
      deliveryLocation: { type: 'Point', coordinates: [46.6, 24.7] },
      status,
      estimatedPrice: 2500,
    });
  }

  // NOTE: every row MUST have the same arity as the it.each callback below
  // (3 elements). jest-each treats a callback with MORE declared parameters
  // than the row provides as an old-style `(done) => {}` async test, and
  // silently waits 60s for a `done()` that never comes — even though the
  // returned promise already resolved. Explicit `false` avoids that trap.
  const LEGAL_EDGES: Array<[OrderStatus, OrderStatus, boolean]> = [
    [OrderStatus.PENDING_APPROVAL, OrderStatus.APPROVED, false],
    [OrderStatus.PENDING_APPROVAL, OrderStatus.REJECTED, false],
    [OrderStatus.PENDING_APPROVAL, OrderStatus.CANCELLED, false],
    [OrderStatus.APPROVED, OrderStatus.ASSIGNED_TO_DRIVER, false],
    [OrderStatus.APPROVED, OrderStatus.CANCELLED, false],
    [OrderStatus.ASSIGNED_TO_DRIVER, OrderStatus.PENDING_PAYMENT, false],
    [OrderStatus.ASSIGNED_TO_DRIVER, OrderStatus.CANCELLED, false],
    [OrderStatus.PENDING_PAYMENT, OrderStatus.IN_TRANSIT, false],
    [OrderStatus.PENDING_PAYMENT, OrderStatus.APPROVED, false],
    [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, false],
    [OrderStatus.IN_TRANSIT, OrderStatus.UNLOADING, false],
    [OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED, true], // force-complete only
    [OrderStatus.UNLOADING, OrderStatus.DELIVERED, false],
  ];

  it.each(LEGAL_EDGES)('allows %s -> %s (manualOverride=%s)', async (from, to, manualOverride) => {
    const order = await seedOrder(from);
    const updated = await service.transition(
      String(order._id),
      from,
      to,
      actor,
      manualOverride ? { manualOverride: true, overrideReason: 'hardware failure at station' } : {},
    );
    expect(updated.status).toBe(to);
    expect(updated.statusHistory).toHaveLength(1);
    expect(updated.statusHistory[0]).toMatchObject({ from, to, actorRole: actor.actorRole });
    if (manualOverride) {
      expect(updated.statusHistory[0].manualOverride).toBe(true);
      expect(updated.statusHistory[0].overrideReason).toBe('hardware failure at station');
    }
  });

  it('rejects IN_TRANSIT -> DELIVERED without manualOverride (must go through UNLOADING)', async () => {
    const order = await seedOrder(OrderStatus.IN_TRANSIT);
    await expect(
      service.transition(String(order._id), OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED, actor),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects skipping a stage (PENDING_APPROVAL -> IN_TRANSIT)', async () => {
    const order = await seedOrder(OrderStatus.PENDING_APPROVAL);
    await expect(
      service.transition(
        String(order._id),
        OrderStatus.PENDING_APPROVAL,
        OrderStatus.IN_TRANSIT,
        actor,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects any transition out of a terminal state (DELIVERED, REJECTED, CANCELLED)', async () => {
    for (const terminal of [OrderStatus.DELIVERED, OrderStatus.REJECTED, OrderStatus.CANCELLED]) {
      const order = await seedOrder(terminal);
      await expect(
        service.transition(String(order._id), terminal, OrderStatus.APPROVED, actor),
      ).rejects.toThrow(ConflictException);
    }
  });

  it('rejects a transition when the order is not actually in the expected `from` status (stale/race)', async () => {
    const order = await seedOrder(OrderStatus.APPROVED);
    await expect(
      service.transition(
        String(order._id),
        OrderStatus.PENDING_APPROVAL,
        OrderStatus.APPROVED,
        actor,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException for a non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      service.transition(fakeId, OrderStatus.PENDING_APPROVAL, OrderStatus.APPROVED, actor),
    ).rejects.toThrow(NotFoundException);
  });

  it('applies extraSet fields atomically with the status change', async () => {
    const order = await seedOrder(OrderStatus.PENDING_APPROVAL);
    const updated = await service.transition(
      String(order._id),
      OrderStatus.PENDING_APPROVAL,
      OrderStatus.APPROVED,
      actor,
      { extraSet: { finalPrice: 3000, approvedBy: actor.actorId } },
    );
    expect(updated.finalPrice).toBe(3000);
    expect(String(updated.approvedBy)).toBe(actor.actorId);
  });
});
