import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  DEFAULT_WAREHOUSE_LOCATION,
  resetFixtureDispatchState,
  seedTwoCompanies,
  TwoCompanyFixture,
  settleClientReview,
} from '../utils/fixtures';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Warehouse,
  WarehouseDocument,
} from '../../src/modules/warehouses/schemas/warehouse.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { TrucksService } from '../../src/modules/trucks/trucks.service';

jest.setTimeout(180_000);

/**
 * spec 008 US4 (T113-T116): the warehouse leg — where fuel actually comes
 * from, and the two things this feature promised NOT to do while adding it.
 *
 * T115 and T116 are both absence tests. No volume is recorded anywhere
 * (FR-028a) and no invoice is touched (FR-034) — the loading stage was
 * deliberately built to carry neither, and "we didn't add a quantity field"
 * is only true until someone adds one in good faith to make a screen more
 * useful.
 */
/** Every number anywhere in a response, however deeply nested — so an
 *  assertion about a rejected quantity can be about the quantity rather than
 *  about its digits happening to appear somewhere in a timestamp. */
function numericValuesIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numericValuesIn);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(numericValuesIn);
  }
  return [];
}

describe('Warehouse loading (spec 008 US4)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let otherTruckCard: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();
    fixtures = await seedTwoCompanies(app);

    // Same transporter, different tractor — the only credential that can
    // resolve to "not this order's truck" rather than to nothing.
    const trucksService = app.get(TrucksService);
    const other = await trucksService.create(fixtures.companyA.transportCompanyId, {
      plateNumber: 'LOADING-OTHER',
    });
    otherTruckCard = 'CARD-LOADING-OTHER';
    await trucksService.pairCard(String(other._id), otherTruckCard);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await resetFixtureDispatchState(app, fixtures.companyA);
    await app.get(ResilientThrottlerStorage).reset();
  });

  function sign(payload: Record<string, unknown>, secret: string) {
    const rawBody = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  /** Creates, approves, pays, assigns, and returns { orderId, invoiceId }. */
  async function assignedOrder(): Promise<{ orderId: string; invoiceId: string }> {
    const { client, admin, transportAdmin, driver, truck, tank } = fixtures.companyA;
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 1000 })
      .expect(201);
    const orderId = createRes.body._id as string;

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const { rawBody, signature } = sign(
      {
        transactionId: `SDD-loading-${orderId}`,
        orderId,
        amount: approveRes.body.finalPrice,
        currency: 'SAR',
        status: 'PAID',
        paidAt: new Date().toISOString(),
      },
      'sadad-test-secret',
    );
    await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);

    await settleClientReview(app, orderId);
    await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId: driver.id, truckId: truck.id, tankId: tank.id })
      .expect(201);

    const order = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    return { orderId, invoiceId: order.body.invoiceId };
  }

  const departureVerify = (orderId: string) =>
    request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ credential: fixtures.companyA.truck.nfcCardUid, method: 'NFC_CARD' });

  const loadingVerify = (orderId: string, credential: string) =>
    request(server)
      .post(`/api/v1/orders/${orderId}/verify-vehicle`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ credential, method: 'NFC_CARD', driverLocation: DEFAULT_WAREHOUSE_LOCATION });

  const confirmLoading = (orderId: string) =>
    request(server)
      .post(`/api/v1/orders/${orderId}/confirm-loading`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`);

  const readOrder = async (orderId: string) =>
    (
      await request(server)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200)
    ).body;

  // --- T113 -----------------------------------------------------------

  it('routes to a warehouse supplying the grade, gates arrival, then advances to IN_TRANSIT (SC-017, FR-031, FR-032)', async () => {
    const { orderId } = await assignedOrder();
    await departureVerify(orderId).expect(201);

    const loading = await readOrder(orderId);
    expect(loading.status).toBe(OrderStatus.LOADING);
    expect(loading.warehouseSummary).toMatchObject({ name: 'Test Central Warehouse' });

    // SC-017: not merely *a* warehouse — one that can actually fill this
    // order. Sending a driver to a depot without their grade is the failure
    // this whole selection step exists to prevent.
    const warehouse = await request(server)
      .get(`/api/v1/warehouses/${loading.warehouseId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);
    expect(warehouse.body.fuelTypes).toContain(loading.fuelType);

    // FR-031: the customer leg is unavailable while loading is outstanding.
    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));

    await loadingVerify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
    await confirmLoading(orderId)
      .expect(201)
      .then((res) => expect(res.body.status).toBe(OrderStatus.IN_TRANSIT));

    // FR-032: and only now does the customer leg open.
    await request(server)
      .post(`/api/v1/orders/${orderId}/arrive`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(201);
  });

  it('refuses to confirm loading that was never verified (FR-031)', async () => {
    const { orderId } = await assignedOrder();
    await departureVerify(orderId).expect(201);

    // Departure alone is not loading. Skipping straight to the confirmation
    // would make the second verification decorative.
    await confirmLoading(orderId)
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.VEHICLE_NOT_VERIFIED));
    expect((await readOrder(orderId)).status).toBe(OrderStatus.LOADING);
  });

  // --- T114 -----------------------------------------------------------

  it("the loading verification refuses a credential that is not the assigned truck's (FR-030)", async () => {
    const { orderId } = await assignedOrder();
    await departureVerify(orderId).expect(201);

    // Same rule as departure — being at the right depot does not make the
    // wrong tractor acceptable.
    await loadingVerify(orderId, otherTruckCard)
      .expect(403)
      .then((res) => expect(res.body.error).toBe(ErrorCode.VEHICLE_MISMATCH));

    const order = await readOrder(orderId);
    expect(order.status).toBe(OrderStatus.LOADING);
    await confirmLoading(orderId)
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.VEHICLE_NOT_VERIFIED));
  });

  // --- T115 -----------------------------------------------------------

  it('a warehouse withdrawn mid-delivery leaves that delivery pointed at it unchanged (FR-035e)', async () => {
    const { orderId } = await assignedOrder();
    await departureVerify(orderId).expect(201);
    const before = await readOrder(orderId);

    await request(server)
      .patch(`/api/v1/warehouses/${before.warehouseId}/withdraw`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);

    // The snapshot is why: a driver already en route must not have their
    // destination silently changed or blanked because the platform stopped
    // offering that depot to NEW deliveries.
    const after = await readOrder(orderId);
    expect(after.warehouseId).toBe(before.warehouseId);
    expect(after.warehouseSummary).toEqual(before.warehouseSummary);

    // …and the delivery still completes its loading leg normally.
    await loadingVerify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
    await confirmLoading(orderId).expect(201);

    // Restore it: a withdrawal is global state, and every later test in
    // this file needs a depot that still supplies DIESEL.
    await app
      .get<Model<WarehouseDocument>>(getModelToken(Warehouse.name))
      .updateOne({ _id: before.warehouseId }, { $set: { isActive: true } })
      .exec();
  });

  it('records no loaded volume anywhere on a delivery that has passed loading (FR-028a, FR-033)', async () => {
    const { orderId } = await assignedOrder();
    await departureVerify(orderId).expect(201);
    await loadingVerify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
    await confirmLoading(orderId).expect(201);

    const order = await readOrder(orderId);

    // The ordered quantity survives; an *actual* volume never appears. The
    // authoritative figure arrives later from an Aramco invoice, in a
    // feature that does not exist yet — so any volume-shaped field here
    // could only have been invented by the driver's device.
    expect(order.quantityLiters).toBe(1000);
    for (const field of [
      'loadedLiters',
      'loadedVolume',
      'actualLiters',
      'actualQuantityLiters',
      'deliveredLiters',
      'volumeLiters',
    ]) {
      expect(order).not.toHaveProperty(field);
    }
    // The confirmation itself is a timestamp and nothing more.
    expect(order.loadingConfirmedAt).toBeTruthy();
  });

  it('a quantity sent to confirm-loading reaches nothing (FR-028a)', async () => {
    const { orderId } = await assignedOrder();
    await departureVerify(orderId).expect(201);
    await loadingVerify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);

    // The endpoint has no `@Body()` at all, so a volume is not rejected —
    // it is simply never read. That is a weaker signal to a misbehaving
    // client than a 400 would be, and a stronger guarantee about storage:
    // there is no DTO field for a quantity to arrive through, so no
    // validation rule has to hold the line. What FR-028a actually requires
    // is that nothing the driver sends becomes a recorded volume, which is
    // what this asserts.
    await confirmLoading(orderId).send({ loadedLiters: 950 }).expect(201);

    const order = await readOrder(orderId);
    expect(order.status).toBe(OrderStatus.IN_TRANSIT);
    expect(order.quantityLiters).toBe(1000);
    // Was `JSON.stringify(order).not.toContain('950')`, which was flaky by
    // construction: the serialised order carries a dozen-odd ISO timestamps,
    // and any one of them landing on `.950Z` milliseconds matched the
    // substring and failed the run. What FR-028a is actually about is that no
    // *value* the driver sent was recorded, so that is what this checks.
    expect(numericValuesIn(order)).not.toContain(950);
    expect(order).not.toHaveProperty('loadedLiters');
  });

  // --- T116 -----------------------------------------------------------

  it('the invoice is byte-identical before and after the loading stage (FR-034, SC-014)', async () => {
    const { orderId, invoiceId } = await assignedOrder();
    expect(invoiceId).toBeTruthy();

    const readInvoice = async () =>
      (
        await request(server)
          .get(`/api/v1/invoices/${invoiceId}`)
          .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
          .expect(200)
      ).body;

    const before = await readInvoice();

    await departureVerify(orderId).expect(201);
    await loadingVerify(orderId, fixtures.companyA.truck.nfcCardUid).expect(201);
    await confirmLoading(orderId).expect(201);

    const after = await readInvoice();

    // Byte-identical, not merely "same total". The clarification that
    // opened this spec settled that an issued invoice is never rewritten —
    // any difference in a line item, a rate, or the state would mean the
    // loading stage had started adjusting money, which is the reconciliation
    // feature's job and explicitly not this one's.
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
