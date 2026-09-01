import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConfigService } from '@nestjs/config';
import { EtaService } from '../../src/modules/orders/eta.service';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { Order, OrderSchema, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(60_000);

/** spec 004 FR-029/US6/T082: ETA is derived live from the driver's last
 * known position — never fabricated when that position is unknown. */
describe('EtaService', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let OrderModel: mongoose.Model<OrderDocument>;
  let UserModel: mongoose.Model<UserDocument>;
  let config: ConfigService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    OrderModel = connection.model(
      Order.name,
      OrderSchema,
    ) as unknown as mongoose.Model<OrderDocument>;
    UserModel = connection.model(User.name, UserSchema) as unknown as mongoose.Model<UserDocument>;
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await OrderModel.deleteMany({});
    await UserModel.deleteMany({});
  });

  function buildService(averageSpeedKmh = 60): EtaService {
    config = { get: jest.fn().mockReturnValue(averageSpeedKmh) } as unknown as ConfigService;
    return new EtaService(UserModel, config, new TenantContextService());
  }

  async function seedDriver(location?: [number, number]): Promise<UserDocument> {
    return UserModel.create({
      companyId: new mongoose.Types.ObjectId(),
      role: UserRole.DRIVER,
      email: `driver-${new mongoose.Types.ObjectId()}@test.test`,
      passwordHash: 'x',
      fullName: 'ETA Driver',
      phone: `+9665${Math.floor(Math.random() * 100000000)}`,
      isActive: true,
      isAvailable: false,
      isOnline: true,
      ...(location ? { location: { type: 'Point', coordinates: location } } : {}),
      truck: { plateNumber: 'ETA-1', maxCapacityLiters: 5000, fuelTypes: [FuelType.DIESEL] },
    });
  }

  async function seedOrder(opts: {
    driverId?: mongoose.Types.ObjectId;
    destination: [number, number];
  }): Promise<OrderDocument> {
    return OrderModel.create({
      fuelCompanyId: new mongoose.Types.ObjectId(),
      clientId: new mongoose.Types.ObjectId(),
      fuelType: FuelType.DIESEL,
      quantityLiters: 100,
      deliveryLocation: { type: 'Point', coordinates: opts.destination },
      status: OrderStatus.IN_TRANSIT,
      estimatedPrice: 250,
      driverId: opts.driverId,
    });
  }

  it('omits ETA when the order has no assigned driver (never fabricated)', async () => {
    const service = buildService();
    const order = await seedOrder({ destination: [46.6753, 24.7136] });

    expect(await service.computeEtaMinutes(order)).toBeUndefined();
  });

  it("omits ETA when the assigned driver has no location on file (hasn't connected to tracking yet)", async () => {
    const service = buildService();
    const driver = await seedDriver(); // no location
    const order = await seedOrder({
      driverId: driver._id as mongoose.Types.ObjectId,
      destination: [46.6753, 24.7136],
    });

    expect(await service.computeEtaMinutes(order)).toBeUndefined();
  });

  it("computes minutes from the driver's last known position, the destination, and the configured average speed", async () => {
    const service = buildService(60); // 60 km/h -> 1 km/min
    // ~0.009 degrees of latitude ≈ 1km at the equator; use a small, known offset.
    const driver = await seedDriver([46.6753, 24.7136]);
    const order = await seedOrder({
      driverId: driver._id as mongoose.Types.ObjectId,
      destination: [46.6753, 24.7136 + 0.18], // ≈ 20km due north
    });

    const eta = await service.computeEtaMinutes(order);
    expect(eta).toBeDefined();
    // 20km at 60km/h = 20 minutes, allowing for haversine/rounding slack.
    expect(eta).toBeGreaterThanOrEqual(18);
    expect(eta).toBeLessThanOrEqual(22);
  });

  it('scales inversely with the configured average speed', async () => {
    const driver = await seedDriver([46.6753, 24.7136]);
    const order = await seedOrder({
      driverId: driver._id as mongoose.Types.ObjectId,
      destination: [46.6753, 24.7136 + 0.18],
    });

    const slow = await buildService(30).computeEtaMinutes(order); // half the speed
    const fast = await buildService(60).computeEtaMinutes(order);
    expect(slow).toBeDefined();
    expect(fast).toBeDefined();
    expect(slow!).toBeGreaterThan(fast!);
    expect(Math.round(slow! / 2)).toBeCloseTo(fast!, 0);
  });

  it('returns 0 when the driver is already essentially at the destination', async () => {
    const service = buildService();
    const driver = await seedDriver([46.6753, 24.7136]);
    const order = await seedOrder({
      driverId: driver._id as mongoose.Types.ObjectId,
      destination: [46.6753, 24.7136],
    });

    expect(await service.computeEtaMinutes(order)).toBe(0);
  });
});
