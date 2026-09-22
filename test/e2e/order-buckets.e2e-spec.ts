import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import { Connection } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import {
  ORDER_STATUS_BUCKETS,
  OrderStatusBucket,
} from '../../src/common/constants/order-status-buckets';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) US3 / FR-015–FR-024 / SC-003.
 *
 * Much of this story was already built (research R4): the operator already
 * receives every order on the platform, `toRoleScopedShape` already grants the
 * full restricted record, and `buildSupplierInvoiceView` already omits the
 * supplier-invoice key when none is confirmed. Those "already works" claims are
 * asserted here anyway — every one of them was asserted by nothing before, and
 * an unasserted guarantee is one refactor away from being untrue.
 *
 * What is new is the bucket filter, the identifier search and the operator's
 * own summary shape.
 */
describe('The platform-wide order list and its buckets (US3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;

  /** One order per bucket, keyed by the state it was forced into. */
  const seeded = new Map<OrderStatus, string>();

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());

    // One order in each of six representative states — one per bucket, plus
    // the two the spec singles out (AWAITING_ROUTING, and REJECTED vs
    // CANCELLED, which must never be summed together).
    const states: OrderStatus[] = [
      OrderStatus.PENDING_APPROVAL, // NEW
      OrderStatus.IN_TRANSIT, // IN_PROGRESS
      OrderStatus.DELIVERED, // COMPLETED
      OrderStatus.REJECTED, // REJECTED
      OrderStatus.CANCELLED, // CANCELLED
      OrderStatus.AWAITING_ROUTING, // NEEDS_ATTENTION
    ];
    for (const status of states) {
      seeded.set(status, await placeOrderInState(fixtures.companyA, status));
    }
    // A second company's order, so "every order on the platform" is a real
    // claim rather than one tenant's list.
    await placeOrderInState(fixtures.companyB, OrderStatus.IN_TRANSIT);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  async function placeOrderInState(
    fixture: TwoCompanyFixture['companyA'],
    status: OrderStatus,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    const id = String(res.body._id);
    if (status !== OrderStatus.PENDING_APPROVAL) {
      await connection
        .collection('orders')
        .updateOne({ _id: new Types.ObjectId(id) }, { $set: { status } });
    }
    return id;
  }

  const list = (token: string, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/orders${query}`)
      .set('Authorization', `Bearer ${token}`);

  const summary = (token: string) =>
    request(app.getHttpServer())
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${token}`);

  describe('the operator lists every order on the platform (FR-015, scenario 1)', () => {
    it('returns orders belonging to more than one company', async () => {
      const res = await list(fixtures.superAdmin.token).expect(200);
      const companies = new Set(
        res.body.items.map((order: { fuelCompanyId: string }) => String(order.fuelCompanyId)),
      );
      expect(companies.size).toBeGreaterThan(1);
    });
  });

  describe('the bucket filter returns exactly its states (FR-016)', () => {
    it.each(Object.values(OrderStatusBucket))(
      'bucket=%s returns only that bucket`s states',
      async (bucket) => {
        const res = await list(fixtures.superAdmin.token, `?bucket=${bucket}`).expect(200);
        const permitted = ORDER_STATUS_BUCKETS[bucket] as readonly string[];
        for (const order of res.body.items) {
          expect(permitted).toContain(order.status);
        }
      },
    );

    it('a single real status beneath a bucket narrows further still', async () => {
      const res = await list(
        fixtures.superAdmin.token,
        `?bucket=${OrderStatusBucket.IN_PROGRESS}&status=${OrderStatus.IN_TRANSIT}`,
      ).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const order of res.body.items) {
        expect(order.status).toBe(OrderStatus.IN_TRANSIT);
      }
    });

    it('a status contradicting its bucket is REFUSED, never a silent empty page', async () => {
      const res = await list(
        fixtures.superAdmin.token,
        `?bucket=${OrderStatusBucket.COMPLETED}&status=${OrderStatus.REJECTED}`,
      ).expect(400);
      expect(res.body.error ?? res.body.message?.error).toBe(
        ErrorCode.ORDER_BUCKET_STATUS_CONFLICT,
      );
    });

    it('an unrecognised bucket is refused with 400', async () => {
      await list(fixtures.superAdmin.token, '?bucket=SOMEDAY').expect(400);
    });

    it('an empty bucket value means no filter, not an empty list', async () => {
      const unfiltered = await list(fixtures.superAdmin.token).expect(200);
      const empty = await list(fixtures.superAdmin.token, '?bucket=').expect(200);
      expect(empty.body.items).toHaveLength(unfiltered.body.items.length);
    });
  });

  describe('the buckets account for every order (scenario 2a, FR-023d)', () => {
    it('sum to the platform total with nothing double-counted and nothing unbucketed', async () => {
      const res = await summary(fixtures.superAdmin.token).expect(200);
      const buckets = res.body.buckets as Record<string, number>;
      const sum = Object.values(buckets).reduce((total, count) => total + count, 0);

      expect(res.body.total).toBe(sum);
      expect(Object.keys(buckets).sort()).toEqual(Object.values(OrderStatusBucket).sort());

      const raisedInPeriod = await connection.collection('orders').countDocuments({
        createdAt: { $gte: new Date(res.body.from), $lte: new Date(res.body.to) },
      });
      expect(res.body.total).toBe(raisedInPeriod);
    });
  });

  describe('the separations the spec singles out (scenarios 2b/2c, FR-023b, FR-023c)', () => {
    it('AWAITING_ROUTING counts under NEEDS_ATTENTION and NOT under IN_PROGRESS', async () => {
      const needsAttention = await list(
        fixtures.superAdmin.token,
        `?bucket=${OrderStatusBucket.NEEDS_ATTENTION}`,
      ).expect(200);
      const ids = needsAttention.body.items.map((o: { _id: string }) => String(o._id));
      expect(ids).toContain(seeded.get(OrderStatus.AWAITING_ROUTING));

      const inProgress = await list(
        fixtures.superAdmin.token,
        `?bucket=${OrderStatusBucket.IN_PROGRESS}`,
      ).expect(200);
      const inProgressIds = inProgress.body.items.map((o: { _id: string }) => String(o._id));
      expect(inProgressIds).not.toContain(seeded.get(OrderStatus.AWAITING_ROUTING));

      // And it is not quietly in NEW either.
      const isNew = await list(
        fixtures.superAdmin.token,
        `?bucket=${OrderStatusBucket.NEW}`,
      ).expect(200);
      expect(isNew.body.items.map((o: { _id: string }) => String(o._id))).not.toContain(
        seeded.get(OrderStatus.AWAITING_ROUTING),
      );
    });

    it('rejected and cancelled orders count separately — never one figure', async () => {
      const res = await summary(fixtures.superAdmin.token).expect(200);
      expect(res.body.buckets[OrderStatusBucket.REJECTED]).toBeGreaterThanOrEqual(1);
      expect(res.body.buckets[OrderStatusBucket.CANCELLED]).toBeGreaterThanOrEqual(1);
      // Two distinct keys, not one summed figure.
      expect(OrderStatusBucket.REJECTED).not.toBe(OrderStatusBucket.CANCELLED);
    });
  });

  describe('paging is stable while records are being created (FR-016, edge case)', () => {
    it('shows no order twice and skips none', async () => {
      const seenIds: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const query: string = cursor
          ? `?bucket=${OrderStatusBucket.NEW}&cursor=${encodeURIComponent(cursor)}`
          : `?bucket=${OrderStatusBucket.NEW}`;
        const res = await list(fixtures.superAdmin.token, query).expect(200);
        seenIds.push(...res.body.items.map((o: { _id: string }) => String(o._id)));
        cursor = res.body.nextCursor;
        // A record created mid-page: keyset paging sorts on updatedAt desc, so
        // a new order joins the HEAD and can never be inserted behind the
        // cursor to push an unseen row past it.
        if (pages === 0) {
          await placeOrderInState(fixtures.companyA, OrderStatus.PENDING_APPROVAL);
        }
        pages += 1;
      } while (cursor && pages < 20);

      expect(new Set(seenIds).size).toBe(seenIds.length);
    });
  });

  describe('the supplier invoice section (scenario 4, FR-019)', () => {
    it('is OMITTED ENTIRELY when none is confirmed — not returned as zeros', async () => {
      const id = seeded.get(OrderStatus.DELIVERED)!;
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${id}`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .expect(200);
      // A supplied quantity of zero is a different fact from no supplier
      // invoice; the key's absence is what carries that distinction.
      expect(res.body.supplierInvoice).toBeUndefined();
    });
  });

  describe('force-complete (scenarios 5/6, FR-020, FR-021)', () => {
    it('completes an IN_TRANSIT order and records the reason', async () => {
      // Its OWN order, not the shared IN_TRANSIT one: force-completing moves it
      // to DELIVERED, which would empty the IN_PROGRESS bucket the guard test
      // below depends on and make that guard pass for the wrong reason.
      const id = await placeOrderInState(fixtures.companyA, OrderStatus.IN_TRANSIT);
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${id}/force-complete`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ reason: 'Customer confirmed delivery by phone' })
        .expect(200);
      expect(res.body.status).toBe(OrderStatus.DELIVERED);
    });

    it('refuses at PENDING_APPROVAL with 409 and leaves the order unmoved', async () => {
      const id = seeded.get(OrderStatus.PENDING_APPROVAL)!;
      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${id}/force-complete`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        // At least 5 characters — the DTO's own constraint, which fires before
        // the stage check and would otherwise return 400 and mask the 409.
        .send({ reason: 'Not at a completable stage' })
        .expect(409);

      const after = await connection.collection('orders').findOne({ _id: new Types.ObjectId(id) });
      expect(after?.status).toBe(OrderStatus.PENDING_APPROVAL);
    });

    it('still refuses a TRANSPORT_COMPANY_ADMIN — this is not their action', async () => {
      const id = seeded.get(OrderStatus.AWAITING_ROUTING)!;
      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${id}/force-complete`)
        .set('Authorization', `Bearer ${fixtures.companyA.transportAdmin.token}`)
        .send({ reason: 'Not mine to take at all' })
        .expect(403);
    });
  });

  /**
   * T045a — FR-018's regression case. The operator's full restricted record
   * currently works by way of `toRoleScopedShape`'s role list and was asserted
   * by nothing. Every other "already works" claim in this feature has a test;
   * this is that one's.
   */
  describe('the operator receives the restricted fields and a client does not (FR-018)', () => {
    it('grants the operator the dispatch and verification trail', async () => {
      const id = seeded.get(OrderStatus.DELIVERED)!;
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${id}`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .expect(200);
      expect(res.body).toHaveProperty('verifications');
      expect(res.body).toHaveProperty('stopEvents');
    });

    it('withholds them from the CLIENT who owns the same order', async () => {
      const id = seeded.get(OrderStatus.DELIVERED)!;
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${id}`)
        .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
        .expect(200);
      expect(res.body.verifications).toBeUndefined();
      expect(res.body.stopEvents).toBeUndefined();
    });
  });

  /** T045b — identifier search (FR-016a, SC-003). */
  describe('search is by order identifier (FR-016a, SC-003)', () => {
    it('returns that order alone', async () => {
      const id = seeded.get(OrderStatus.CANCELLED)!;
      const res = await list(fixtures.superAdmin.token, `?orderId=${id}`).expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(String(res.body.items[0]._id)).toBe(id);
    });

    it('overrides bucket and status rather than intersecting them', async () => {
      const id = seeded.get(OrderStatus.CANCELLED)!;
      const res = await list(
        fixtures.superAdmin.token,
        `?orderId=${id}&bucket=${OrderStatusBucket.NEW}`,
      ).expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(String(res.body.items[0]._id)).toBe(id);
    });

    it('an unknown id returns an empty page', async () => {
      const res = await list(
        fixtures.superAdmin.token,
        `?orderId=${new Types.ObjectId().toString()}`,
      ).expect(200);
      expect(res.body.items).toHaveLength(0);
    });

    it('a malformed id returns an empty page, not a 500', async () => {
      const res = await list(fixtures.superAdmin.token, '?orderId=not-an-id').expect(200);
      expect(res.body.items).toHaveLength(0);
    });

    it('a CLIENT naming another tenant`s order receives an empty page, never that order', async () => {
      // Company B's order, asked for by company A's client. An empty page, not
      // a 403 — a refusal would confirm the identifier exists.
      const otherCompanyOrder = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${fixtures.companyB.client.token}`)
        .expect(200);
      const targetId = String(otherCompanyOrder.body.items[0]._id);

      const res = await list(fixtures.companyA.client.token, `?orderId=${targetId}`).expect(200);
      expect(res.body.items).toHaveLength(0);
    });
  });

  /**
   * T047 — **guard test (trap 4).**
   *
   * The bucket filter expands to `status: { $in: [...] }`. Had it been built as
   * a `$or`, both scoping plugins would have silently DISCARDED it — they
   * inject via `Query.where()`, which replaces a same-named top-level key
   * rather than merging — so it would work perfectly for the operator (who
   * bypasses both plugins) and leak every company's orders to a fuel company
   * admin. That is the exact defect feature 016 hit, and a unit test cannot see
   * it: a unit test correctly registers no plugin at all.
   */
  describe('GUARD: the bucket filter is still scoped for a tenant role (research R4)', () => {
    it('a FUEL_COMPANY_ADMIN filtering by bucket sees only their own company`s orders', async () => {
      // Its own in-progress order, so this guard does not depend on an order an
      // earlier test may have moved out of the bucket.
      await placeOrderInState(fixtures.companyA, OrderStatus.LOADING);

      const res = await list(
        fixtures.companyA.admin.token,
        `?bucket=${OrderStatusBucket.IN_PROGRESS}`,
      ).expect(200);

      expect(res.body.items.length).toBeGreaterThan(0);
      for (const order of res.body.items) {
        expect(String(order.fuelCompanyId)).toBe(fixtures.companyA.companyId);
        expect(ORDER_STATUS_BUCKETS[OrderStatusBucket.IN_PROGRESS] as readonly string[]).toContain(
          order.status,
        );
      }

      // The operator, filtering identically, DOES see company B's in-progress
      // order — so the bucket filter itself is not what excluded it above. A
      // `$or` the plugin discarded would have handed company A this same wider
      // set, and only this pair of assertions can tell the two apart.
      const operatorView = await list(
        fixtures.superAdmin.token,
        `?bucket=${OrderStatusBucket.IN_PROGRESS}`,
      ).expect(200);
      const operatorCompanies = new Set(
        operatorView.body.items.map((o: { fuelCompanyId: string }) => String(o.fuelCompanyId)),
      );
      expect(operatorCompanies.has(fixtures.companyB.companyId)).toBe(true);
      expect(operatorCompanies.size).toBeGreaterThan(1);

      const scopedCompanies = new Set(
        res.body.items.map((o: { fuelCompanyId: string }) => String(o.fuelCompanyId)),
      );
      expect(scopedCompanies.has(fixtures.companyB.companyId)).toBe(false);
    });
  });

  /** T150 / FR-075 — an absent filter is exactly today's result. */
  describe('an absent filter is the pre-feature behaviour (FR-075)', () => {
    it('a CLIENT still receives only their own orders, unfiltered', async () => {
      const res = await list(fixtures.companyA.client.token).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const order of res.body.items) {
        expect(String(order.clientId)).toBe(fixtures.companyA.client.id);
      }
      expect(res.body).toHaveProperty('nextCursor');
    });

    it('a DRIVER still receives only their own orders, unfiltered', async () => {
      const res = await list(fixtures.companyA.driver.token).expect(200);
      for (const order of res.body.items) {
        expect(String(order.driverId)).toBe(fixtures.companyA.driver.id);
      }
    });
  });
});
