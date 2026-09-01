import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { migrateMultiTier } from '../../scripts/migrate-multi-tier';
import { migrate005Stations } from '../../scripts/migrate-005-stations';
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { InvoiceState } from '../../src/common/enums/invoice-state.enum';
import { PaymentMethod } from '../../src/common/enums/payment-method.enum';

jest.setTimeout(120_000);

/**
 * Spec 004 T093/FR-031: the migration is re-runnable and idempotent, and
 * loses no data. Seeds raw pre-004-shape documents directly into the
 * collections (bypassing every Mongoose schema/plugin — a real legacy
 * document doesn't satisfy the current required fields) so the migration
 * itself, not the test harness's own fixtures, is what's under test.
 */
describe('Multi-tier migration (spec 004 T093/FR-031)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    connection = app.get<Connection>(getConnectionToken());
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('migrates a legacy company, its drivers, orders and clients — then a second run is a true no-op', async () => {
    const db = connection.db!;
    const companyId = new Types.ObjectId();
    const clientId = new Types.ObjectId();
    const driverId = new Types.ObjectId();
    const deliveredOrderId = new Types.ObjectId();
    const pendingOrderId = new Types.ObjectId();

    // A pre-004 company: no `type`, no `servedRegions`.
    await db.collection('companies').insertOne({
      _id: companyId,
      name: 'Legacy Fuel Co',
      status: 'ACTIVE',
      contactEmail: 'legacy@migrationtest.test',
      contactPhone: '+966500000000',
      fuelPrices: [{ fuelType: 'DIESEL', basePricePerLiter: 2.5 }],
    });

    // A pre-004 client: `stationLocation`, no `station`.
    await db.collection('users').insertOne({
      _id: clientId,
      companyId,
      role: UserRole.CLIENT,
      email: 'legacy-client@migrationtest.test',
      passwordHash: 'x',
      fullName: 'Legacy Client',
      phone: '+966500000001',
      isActive: true,
      stationLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
    });

    // A pre-004 driver: belongs directly to the fuel company.
    await db.collection('users').insertOne({
      _id: driverId,
      companyId,
      role: UserRole.DRIVER,
      email: 'legacy-driver@migrationtest.test',
      passwordHash: 'x',
      fullName: 'Legacy Driver',
      phone: '+966500000002',
      isActive: true,
      isAvailable: true,
      isOnline: false,
      truck: { plateNumber: 'LEG-1', maxCapacityLiters: 5000, fuelTypes: ['DIESEL'] },
    });

    // A pre-004 delivered order: `companyId`/`assignedDriverId`, no invoice.
    await db.collection('orders').insertOne({
      _id: deliveredOrderId,
      companyId,
      clientId,
      assignedDriverId: driverId,
      fuelType: 'DIESEL',
      quantityLiters: 100,
      deliveryLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
      status: OrderStatus.DELIVERED,
      estimatedPrice: 250,
      finalPrice: 250,
      statusHistory: [],
      otps: [],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    // A pre-004 order still in flight — never invoiced by the migration,
    // since it was never actually paid.
    await db.collection('orders').insertOne({
      _id: pendingOrderId,
      companyId,
      clientId,
      fuelType: 'DIESEL',
      quantityLiters: 50,
      deliveryLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
      status: OrderStatus.PENDING_APPROVAL,
      estimatedPrice: 125,
      statusHistory: [],
      otps: [],
    });

    const firstRun = await migrateMultiTier(connection);
    expect(firstRun.companiesTaggedFuel).toBeGreaterThanOrEqual(1);
    expect(firstRun.transportersCreated).toBeGreaterThanOrEqual(1);
    expect(firstRun.driversReassigned).toBeGreaterThanOrEqual(1);
    expect(firstRun.ordersMigrated).toBeGreaterThanOrEqual(2);
    expect(firstRun.clientsMigrated).toBeGreaterThanOrEqual(1);
    expect(firstRun.historicalInvoicesCreated).toBeGreaterThanOrEqual(1);

    // 1. Company tagged FUEL.
    const migratedCompany = await db.collection('companies').findOne({ _id: companyId });
    expect(migratedCompany?.type).toBe(CompanyType.FUEL);

    // 2. Exactly one transporter created, seeded with the legacy driver.
    const transporter = await db.collection('companies').findOne({ migratedFrom: companyId });
    expect(transporter).toBeTruthy();
    expect(transporter?.type).toBe(CompanyType.TRANSPORT);
    const migratedDriver = await db.collection('users').findOne({ _id: driverId });
    expect(String(migratedDriver?.companyId)).toBe(String(transporter?._id));

    // 3. Orders: fuelCompanyId/transportCompanyId/driverId set; old fields gone.
    const migratedDeliveredOrder = await db.collection('orders').findOne({ _id: deliveredOrderId });
    expect(String(migratedDeliveredOrder?.fuelCompanyId)).toBe(String(companyId));
    expect(String(migratedDeliveredOrder?.transportCompanyId)).toBe(String(transporter?._id));
    expect(String(migratedDeliveredOrder?.driverId)).toBe(String(driverId));
    expect(migratedDeliveredOrder?.companyId).toBeUndefined();
    expect(migratedDeliveredOrder?.assignedDriverId).toBeUndefined();
    expect(migratedDeliveredOrder?.paymentMethod).toBe(PaymentMethod.DIRECT);

    const migratedPendingOrder = await db.collection('orders').findOne({ _id: pendingOrderId });
    expect(String(migratedPendingOrder?.fuelCompanyId)).toBe(String(companyId));

    // 4. Client: station.location carries the old stationLocation forward.
    const migratedClient = await db.collection('users').findOne({ _id: clientId });
    expect(migratedClient?.station).toBeTruthy();
    expect(migratedClient?.station.location.coordinates).toEqual([46.6753, 24.7136]);
    expect(migratedClient?.stationLocation).toBeUndefined();

    // 5. A settled invoice exists for the delivered order only.
    const deliveredInvoice = await db.collection('invoices').findOne({ orderId: deliveredOrderId });
    expect(deliveredInvoice).toBeTruthy();
    expect(deliveredInvoice?.state).toBe(InvoiceState.SETTLED);
    expect(deliveredInvoice?.amount).toBe(250);
    const reloadedDeliveredOrder = await db.collection('orders').findOne({ _id: deliveredOrderId });
    expect(String(reloadedDeliveredOrder?.invoiceId)).toBe(String(deliveredInvoice?._id));

    const pendingInvoice = await db.collection('invoices').findOne({ orderId: pendingOrderId });
    expect(pendingInvoice).toBeNull();

    // --- Re-run: idempotent, no duplicates, no data loss ---
    const secondRun = await migrateMultiTier(connection);
    expect(secondRun.companiesTaggedFuel).toBe(0);
    expect(secondRun.transportersCreated).toBe(0);
    expect(secondRun.driversReassigned).toBe(0);
    expect(secondRun.ordersMigrated).toBe(0);
    expect(secondRun.clientsMigrated).toBe(0);
    expect(secondRun.historicalInvoicesCreated).toBe(0);

    const transportersAfterSecondRun = await db
      .collection('companies')
      .find({ migratedFrom: companyId })
      .toArray();
    expect(transportersAfterSecondRun).toHaveLength(1);

    const invoicesAfterSecondRun = await db
      .collection('invoices')
      .find({ orderId: deliveredOrderId })
      .toArray();
    expect(invoicesAfterSecondRun).toHaveLength(1);

    // Every value asserted after the first run still holds identically.
    const orderAfterSecondRun = await db.collection('orders').findOne({ _id: deliveredOrderId });
    expect(orderAfterSecondRun).toEqual(reloadedDeliveredOrder);
    const clientAfterSecondRun = await db.collection('users').findOne({ _id: clientId });
    expect(clientAfterSecondRun).toEqual(migratedClient);
  });
});

/**
 * Spec 005 T018/T016: promotes each client's embedded `user.station` into
 * the standalone `Station` collection, and back-fills `Order.stationId` /
 * `PaymentEvent.clientId`. Seeds pre-005-shape documents directly (a client
 * with `station` embedded but no `Station` document, an order and a payment
 * event with neither back-filled field) so the migration itself is under
 * test, not the fixtures.
 */
describe('Station migration (spec 005 T016/research R1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    connection = app.get<Connection>(getConnectionToken());
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('creates one default Station per client, back-fills orders and payment events, and a second run changes nothing', async () => {
    const db = connection.db!;
    const companyId = new Types.ObjectId();
    const clientId = new Types.ObjectId();
    const orderId = new Types.ObjectId();
    const paymentEventId = new Types.ObjectId();

    await db.collection('companies').insertOne({
      _id: companyId,
      name: 'Pre-005 Fuel Co',
      type: CompanyType.FUEL,
      status: 'ACTIVE',
      contactEmail: 'pre005@migrationtest.test',
      contactPhone: '+966500000010',
      fuelPrices: [{ fuelType: 'DIESEL', basePricePerLiter: 2.5 }],
      servedRegions: [],
    });

    // A pre-005 client: embedded station, no Station document.
    await db.collection('users').insertOne({
      _id: clientId,
      companyId,
      role: UserRole.CLIENT,
      email: 'pre005-client@migrationtest.test',
      passwordHash: 'x',
      fullName: 'Pre-005 Client',
      phone: '+966500000011',
      isActive: true,
      station: {
        regionCode: 'RIYADH',
        governorateCode: 'RIYADH_CITY',
        location: { type: 'Point', coordinates: [46.6753, 24.7136] },
        addressText: 'Legacy address',
        name: 'Legacy Station',
      },
    });

    // A pre-005 order: no stationId.
    await db.collection('orders').insertOne({
      _id: orderId,
      fuelCompanyId: companyId,
      clientId,
      fuelType: 'DIESEL',
      quantityLiters: 100,
      deliveryLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
      deliveryAddressText: 'Legacy address',
      status: OrderStatus.DELIVERED,
      estimatedPrice: 250,
      finalPrice: 250,
      paymentMethod: PaymentMethod.DIRECT,
      statusHistory: [],
      otps: [],
    });

    // A pre-005 payment event: no clientId, resolvable only through the order.
    await db.collection('paymentevents').insertOne({
      _id: paymentEventId,
      gatewayTransactionId: `pre005-${Date.now()}`,
      gateway: 'SADAD',
      orderId,
      companyId,
      amount: 250,
      currency: 'SAR',
      outcome: 'CONFIRMED',
    });

    const firstRun = await migrate005Stations(connection);
    expect(firstRun.stationsCreated).toBeGreaterThanOrEqual(1);
    expect(firstRun.ordersBackfilled).toBeGreaterThanOrEqual(1);
    expect(firstRun.paymentEventsBackfilled).toBeGreaterThanOrEqual(1);

    // Exactly one default Station, carrying the embedded fields forward.
    const stations = await db.collection('stations').find({ clientId }).toArray();
    expect(stations).toHaveLength(1);
    expect(stations[0].isDefault).toBe(true);
    expect(stations[0].addressText).toBe('Legacy address');
    expect(stations[0].name).toBe('Legacy Station');
    expect(stations[0].location.coordinates).toEqual([46.6753, 24.7136]);

    // Order and payment event back-filled correctly.
    const migratedOrder = await db.collection('orders').findOne({ _id: orderId });
    expect(String(migratedOrder?.stationId)).toBe(String(stations[0]._id));
    const migratedEvent = await db.collection('paymentevents').findOne({ _id: paymentEventId });
    expect(String(migratedEvent?.clientId)).toBe(String(clientId));

    // The embedded field is left untouched — legacy data, not deleted.
    const clientAfterFirstRun = await db.collection('users').findOne({ _id: clientId });
    expect(clientAfterFirstRun?.station).toBeTruthy();

    // --- Re-run: idempotent, no duplicate default station, no data loss ---
    const secondRun = await migrate005Stations(connection);
    expect(secondRun.stationsCreated).toBe(0);
    expect(secondRun.ordersBackfilled).toBe(0);
    expect(secondRun.paymentEventsBackfilled).toBe(0);

    const stationsAfterSecondRun = await db.collection('stations').find({ clientId }).toArray();
    expect(stationsAfterSecondRun).toHaveLength(1);
    expect(stationsAfterSecondRun[0]).toEqual(stations[0]);

    const defaultStations = await db
      .collection('stations')
      .find({ clientId, isDefault: true })
      .toArray();
    expect(defaultStations).toHaveLength(1); // the partial unique index would refuse a second
  });

  it('GET /auth/me returns an unchanged response shape for CLIENT, DRIVER and both admin roles', async () => {
    // Seeded entirely through the live API (not raw documents) — every one
    // of these accounts already goes through the post-005 create path, so
    // this proves the *shape* every role sees is what it was before the
    // migration, not that the migration ran (T016's test above covers that).
    const fixtures: TwoCompanyFixture = await seedTwoCompanies(app);
    const server = app.getHttpServer();

    const asRole = async (token: string) =>
      request(server).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);

    const adminMe = await asRole(fixtures.companyA.admin.token);
    expect(adminMe.body.id).toBe(fixtures.companyA.admin.id);
    expect(adminMe.body.role).toBe(UserRole.FUEL_COMPANY_ADMIN);
    expect(adminMe.body.station).toBeUndefined();

    const clientMe = await asRole(fixtures.companyA.client.token);
    expect(clientMe.body.role).toBe(UserRole.CLIENT);
    expect(clientMe.body.station).toEqual(
      expect.objectContaining({
        regionCode: expect.any(String),
        governorateCode: expect.any(String),
        location: expect.objectContaining({ coordinates: expect.any(Array) }),
        addressText: expect.any(String),
      }),
    );
    // Exactly the historic embedded shape — no leaked internal fields
    // (_id, isDefault, isFavourite, isActive, timestamps) from the new
    // standalone collection. `name` is optional and JSON drops undefined
    // keys, so its absence here isn't itself a leak — only extra keys are.
    const allowedStationKeys = new Set([
      'regionCode',
      'governorateCode',
      'location',
      'addressText',
      'name',
    ]);
    for (const key of Object.keys(clientMe.body.station)) {
      expect(allowedStationKeys.has(key)).toBe(true);
    }

    const driverMe = await asRole(fixtures.companyA.driver.token);
    expect(driverMe.body.role).toBe(UserRole.DRIVER);
    expect(driverMe.body.station).toBeUndefined();

    const transportAdminMe = await asRole(fixtures.companyA.transportAdmin.token);
    expect(transportAdminMe.body.role).toBe(UserRole.TRANSPORT_COMPANY_ADMIN);
    expect(transportAdminMe.body.station).toBeUndefined();
  });
});
