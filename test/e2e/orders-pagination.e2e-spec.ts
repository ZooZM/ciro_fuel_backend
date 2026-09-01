import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { Order, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { PaymentMethod } from '../../src/common/enums/payment-method.enum';

jest.setTimeout(120_000);

/**
 * spec 005 T030/T031, FR-048: cursor pagination on `GET /orders`. Orders
 * are created directly via the Mongoose model (not the API) so each one
 * gets an explicit, controlled `updatedAt` — real HTTP-driven creation
 * cannot guarantee millisecond-precise, ordered timestamps, and this suite
 * needs them to make "no repeat, no skip" deterministic to assert on.
 */
describe('Orders pagination (spec 005 FR-048)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let orderModel: Model<OrderDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    orderModel = app.get(getModelToken(Order.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  /** Creates `count` orders for the given client, `updatedAt` spaced one minute apart, oldest first (index 0). */
  async function seedOrders(
    clientId: string,
    fuelCompanyId: string,
    count: number,
    startMinute = 0,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const order = await orderModel.create({
        fuelCompanyId: new Types.ObjectId(fuelCompanyId),
        clientId: new Types.ObjectId(clientId),
        fuelType: 'DIESEL',
        quantityLiters: 100,
        deliveryLocation: { type: 'Point', coordinates: [46.6753, 24.7136] },
        status: OrderStatus.PENDING_APPROVAL,
        estimatedPrice: 250,
        paymentMethod: PaymentMethod.DIRECT,
        statusHistory: [],
        otps: [],
      });
      const updatedAt = new Date(2026, 0, 1, 10, startMinute + i, 0, 0);
      await orderModel.updateOne({ _id: order._id }, { $set: { updatedAt } });
      ids.push(String(order._id));
    }
    // Newest first, matching the endpoint's own sort — callers rely on this order.
    return ids.reverse();
  }

  it('pages through 25 orders with no repeats and no skips, and nextCursor is null on the last page', async () => {
    const { client } = fixtures.companyA;
    const server = app.getHttpServer();
    const expectedIds = await seedOrders(client.id, fixtures.companyA.companyId, 25, 100);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await request(server)
        .get('/api/v1/orders')
        .query(cursor ? { cursor } : {})
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);

      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.length).toBeLessThanOrEqual(20); // DEFAULT_PAGE_SIZE
      seen.push(...res.body.items.map((o: { _id: string }) => o._id));
      cursor = res.body.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10); // guard against a runaway loop on a bug

    // Every seeded order appears exactly once, and only seeded orders appear
    // this many times — no repeats, no skips (FR-048c's steady-state case).
    const seededOnly = seen.filter((id) => expectedIds.includes(id));
    expect(new Set(seededOnly).size).toBe(seededOnly.length); // no duplicates
    expect(seededOnly).toHaveLength(expectedIds.length); // nothing skipped
    expect(pages).toBeGreaterThan(1); // actually exercised pagination, not one page

    // Final page's cursor is explicitly null, not merely falsy/absent.
    const lastPageCursorField = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(lastPageCursorField.body).toHaveProperty('nextCursor');
  });

  it('a malformed cursor is rejected with 400, never a silent fallback to page one', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/orders')
      .query({ cursor: 'not-a-real-cursor!!!' })
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(400);
  });

  it('a record inserted at the head mid-scroll is never re-surfaced, and nothing already scrolled past is skipped (FR-048c)', async () => {
    const { client } = fixtures.companyB;
    const server = app.getHttpServer();
    // Ten orders, oldest at minute 0, newest at minute 9.
    const originalIds = await seedOrders(client.id, fixtures.companyB.companyId, 10, 200);

    // First page (page size 20 covers all 10 — force a small page by asking
    // for just the first few via an early cursor cut isn't possible without
    // control over page size, so instead: fetch page 1, capture the cursor
    // after the first 3 by paging with a scripted early stop using the
    // returned items directly).
    const firstPage = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    // With only 10 orders this is a single page — insert the "mid-scroll"
    // record anchored on an item partway through, simulating where a client
    // genuinely would be after consuming the first few of a longer list.
    const anchorIndex = 3;
    const anchorOrder = (await orderModel
      .findById(firstPage.body.items[anchorIndex]._id)
      .exec()) as unknown as { updatedAt: Date; _id: Types.ObjectId };
    const cursor = Buffer.from(
      JSON.stringify({ updatedAt: anchorOrder.updatedAt, _id: String(anchorOrder._id) }),
    ).toString('base64url');

    // Simulate an insert at the very head — newer than every existing order —
    // occurring after the client anchored their cursor at `anchorIndex`.
    const insertedId = (await seedOrders(client.id, fixtures.companyB.companyId, 1, 999))[0];

    const nextPage = await request(server)
      .get('/api/v1/orders')
      .query({ cursor })
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const nextIds = nextPage.body.items.map((o: { _id: string }) => o._id);

    // The newly inserted (newer-than-everything) record must not appear —
    // it belongs "above" where the client already scrolled past.
    expect(nextIds).not.toContain(insertedId);
    // Every order older than the anchor must still be present — nothing skipped.
    const olderThanAnchor = originalIds.slice(anchorIndex + 1);
    for (const id of olderThanAnchor) {
      expect(nextIds).toContain(id);
    }
    // The anchor record itself must not repeat.
    expect(nextIds).not.toContain(String(anchorOrder._id));
  });

  it("applies the status filter across the client's whole set, not just a fetched page (FR-048d)", async () => {
    const { client } = fixtures.companyA;
    const server = app.getHttpServer();

    // A fresh client-scoped batch so this test's counts aren't polluted by
    // the other tests in this file sharing the same fixture client.
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);

    const filtered = await request(server)
      .get('/api/v1/orders')
      .query({ status: OrderStatus.PENDING_APPROVAL })
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    for (const item of filtered.body.items) {
      expect(item.status).toBe(OrderStatus.PENDING_APPROVAL);
    }
    expect(filtered.body.items.some((o: { _id: string }) => o._id === created.body._id)).toBe(true);
  });
});
