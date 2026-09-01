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
    actorRole: UserRole.FUEL_COMPANY_ADMIN,
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
      fuelCompanyId: new mongoose.Types.ObjectId(),
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
    // spec 004: APPROVED branches into routing rather than assigning a
    // driver directly.
    // spec 004 US5: a DIRECT invoice sends APPROVED to PENDING_PAYMENT
    // first (FR-020a); DEFERRED/CREDIT route immediately, same as before.
    [OrderStatus.APPROVED, OrderStatus.PENDING_PAYMENT, false],
    [OrderStatus.APPROVED, OrderStatus.AWAITING_ROUTING, false],
    [OrderStatus.APPROVED, OrderStatus.ROUTED_TO_TRANSPORT, false],
    [OrderStatus.APPROVED, OrderStatus.CANCELLED, false],
    [OrderStatus.AWAITING_ROUTING, OrderStatus.ROUTED_TO_TRANSPORT, false],
    [OrderStatus.AWAITING_ROUTING, OrderStatus.CANCELLED, false],
    [OrderStatus.ROUTED_TO_TRANSPORT, OrderStatus.ASSIGNED_TO_DRIVER, false],
    [OrderStatus.ROUTED_TO_TRANSPORT, OrderStatus.CANCELLED, false],
    // spec 008 FR-046a: assignment no longer auto-advances to IN_TRANSIT —
    // it stops here pending departure verification (or an override), which
    // is what reaches LOADING.
    [OrderStatus.ASSIGNED_TO_DRIVER, OrderStatus.LOADING, false],
    [OrderStatus.ASSIGNED_TO_DRIVER, OrderStatus.CANCELLED, false],
    // Settlement and the payment-deadline timeout share this edge (both land
    // back on APPROVED — settlement then resumes routing, a timeout awaits redispatch).
    [OrderStatus.PENDING_PAYMENT, OrderStatus.APPROVED, false],
    [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, false],
    // spec 008 FR-046d/FR-046e: loading confirmation (or override) reaches
    // IN_TRANSIT; cancellation stays reachable; DELIVERED is force-complete only.
    [OrderStatus.LOADING, OrderStatus.IN_TRANSIT, false],
    [OrderStatus.LOADING, OrderStatus.CANCELLED, false],
    [OrderStatus.LOADING, OrderStatus.DELIVERED, true],
    [OrderStatus.IN_TRANSIT, OrderStatus.UNLOADING, false],
    [OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED, true], // force-complete only
    [OrderStatus.UNLOADING, OrderStatus.DELIVERED, false],
  ];

  // spec 008 FR-046a: the edge assignDriver used to auto-traverse is
  // removed outright — asserted separately from LEGAL_EDGES since this is
  // a NEGATIVE case, not a row that would ever belong in that table.
  it('rejects ASSIGNED_TO_DRIVER -> IN_TRANSIT (removed — LOADING sits between them now)', async () => {
    const order = await seedOrder(OrderStatus.ASSIGNED_TO_DRIVER);
    await expect(
      service.transition(
        String(order._id),
        OrderStatus.ASSIGNED_TO_DRIVER,
        OrderStatus.IN_TRANSIT,
        actor,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects LOADING -> DELIVERED without manualOverride (must go through IN_TRANSIT/UNLOADING)', async () => {
    const order = await seedOrder(OrderStatus.LOADING);
    await expect(
      service.transition(String(order._id), OrderStatus.LOADING, OrderStatus.DELIVERED, actor),
    ).rejects.toThrow(ConflictException);
  });

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
