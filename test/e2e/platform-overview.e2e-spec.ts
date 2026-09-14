import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, superAdminActor } from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { OrderStatusBucket } from '../../src/common/constants/order-status-buckets';
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { PeriodFigureBasis } from '../../src/common/enums/period-figure-basis.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) US1 / FR-001–FR-009 / SC-001.
 *
 * The platform overview is the first cross-company aggregate on this platform.
 * Its correctness rests on two things that are easy to get plausibly wrong:
 *
 *  1. the period figures and the point-in-time figures must be bounded
 *     differently (FR-002) — a company that exists, exists, whatever date range
 *     the operator picked; and
 *  2. the three period figures do **not** share one basis (FR-001a). The order
 *     count is `createdAt`-bounded over every state, while value and volume are
 *     `deliveredAt`-bounded over delivered orders only. An earlier draft made
 *     all three delivered-only, which is wrong with no visible error: the count
 *     would BE the COMPLETED bucket and the other five would be structurally
 *     zero.
 */
describe('GET /platform/overview reconciles against the platform (US1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const overview = (token: string, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/platform/overview${query}`)
      .set('Authorization', `Bearer ${token}`);

  /** Places one order as the given company's client; returns its id. */
  async function placeOrder(
    fixture: TwoCompanyFixture['companyA'],
    quantityLiters = 100,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters, paymentMethod: 'DEFERRED' })
      .expect(201);
    return String(res.body._id);
  }

  /**
   * Marks an order delivered directly in the database. The full delivery
   * journey is exercised by its own suites; what this one needs is a known
   * `deliveredAt`, `finalPrice` and `quantityLiters` to reconcile against.
   */
  async function markDelivered(orderId: string, deliveredAt: Date, finalPrice: number) {
    await connection
      .collection('orders')
      .updateOne(
        { _id: new (require('mongoose').Types.ObjectId)(orderId) },
        { $set: { status: OrderStatus.DELIVERED, deliveredAt, finalPrice } },
      );
  }

  describe('the six figures reconcile against independently derived counts (SC-001, FR-001)', () => {
    it('reports the platform`s own counts, not one company`s', async () => {
      const res = await overview(fixtures.superAdmin.token).expect(200);

      const fuelCompanies = await connection
        .collection('companies')
        .countDocuments({ type: CompanyType.FUEL });
      const transportCompanies = await connection
        .collection('companies')
        .countDocuments({ type: CompanyType.TRANSPORT });
      const stations = await connection.collection('stations').countDocuments({});

      expect(res.body.pointInTime.fuelCompanies).toBe(fuelCompanies);
      expect(res.body.pointInTime.transportCompanies).toBe(transportCompanies);
      expect(res.body.pointInTime.stations).toBe(stations);
      // Two fixture companies, each with its own transporter — proof this is
      // not one tenant's view leaking through as a platform figure.
      expect(fuelCompanies).toBeGreaterThanOrEqual(2);
      expect(transportCompanies).toBeGreaterThanOrEqual(2);
    });

    it('the period order count equals the orders raised in it', async () => {
      const res = await overview(fixtures.superAdmin.token).expect(200);
      const raised = await connection.collection('orders').countDocuments({
        createdAt: {
          $gte: new Date(res.body.period.from),
          $lte: new Date(res.body.period.to),
        },
      });
      expect(res.body.period.orderCount).toBe(raised);
    });
  });

  describe('period and point-in-time are bounded differently (FR-002, scenario 2)', () => {
    it('changing the range moves the period figures and leaves the rest alone', async () => {
      const current = await overview(fixtures.superAdmin.token).expect(200);
      // A window closing before this platform existed: nothing can fall in it.
      const empty = await overview(
        fixtures.superAdmin.token,
        '?from=2000-01-01T00:00:00.000Z&to=2000-01-31T23:59:59.999Z',
      ).expect(200);

      expect(empty.body.period.orderCount).toBe(0);
      expect(empty.body.period.orderValue).toBe(0);
      expect(empty.body.period.litresMoved).toBe(0);

      // Unchanged — a company that exists, exists.
      expect(empty.body.pointInTime).toEqual(current.body.pointInTime);
      expect(empty.body.breakdown.byCompanyType).toEqual(current.body.breakdown.byCompanyType);
    });
  });

  describe('an empty period reports zero, never absent and never null (FR-008, scenario 4)', () => {
    it('every period field is present and 0', async () => {
      const res = await overview(
        fixtures.superAdmin.token,
        '?from=2000-01-01T00:00:00.000Z&to=2000-01-31T23:59:59.999Z',
      ).expect(200);

      for (const field of ['orderCount', 'orderValue', 'litresMoved'] as const) {
        expect(res.body.period).toHaveProperty(field);
        expect(res.body.period[field]).toBe(0);
        expect(res.body.period[field]).not.toBeNull();
      }
      // And the six buckets are all present as zeros, not an empty array.
      expect(res.body.breakdown.byOrderBucket).toHaveLength(6);
      for (const segment of res.body.breakdown.byOrderBucket) {
        expect(segment.count).toBe(0);
      }
    });
  });

  describe('the default period is the current calendar month and says so (FR-005)', () => {
    it('resolves to this month with isDefault true', async () => {
      const res = await overview(fixtures.superAdmin.token).expect(200);
      const now = new Date();
      const expectedFrom = new Date(now.getFullYear(), now.getMonth(), 1);

      expect(res.body.period.isDefault).toBe(true);
      expect(new Date(res.body.period.from).toISOString()).toBe(expectedFrom.toISOString());
      expect(new Date(res.body.period.to).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    });

    it('reports isDefault false once a range is supplied', async () => {
      const res = await overview(
        fixtures.superAdmin.token,
        '?from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z',
      ).expect(200);
      expect(res.body.period.isDefault).toBe(false);
    });
  });

  describe('the breakdowns sum to the totals above them (FR-006)', () => {
    it('byOrderBucket carries all six buckets and sums to period.orderCount EXACTLY', async () => {
      const res = await overview(fixtures.superAdmin.token).expect(200);
      const segments = res.body.breakdown.byOrderBucket as {
        bucket: string;
        count: number;
      }[];

      expect(segments.map((s) => s.bucket).sort()).toEqual(
        Object.values(OrderStatusBucket).sort(),
      );
      const sum = segments.reduce((total, s) => total + s.count, 0);
      expect(sum).toBe(res.body.period.orderCount);
    });

    it('byCompanyType sums to the two company counts', async () => {
      const res = await overview(fixtures.superAdmin.token).expect(200);
      const segments = res.body.breakdown.byCompanyType as {
        type: string;
        count: number;
      }[];
      const sum = segments.reduce((total, s) => total + s.count, 0);
      expect(sum).toBe(
        res.body.pointInTime.fuelCompanies + res.body.pointInTime.transportCompanies,
      );
      expect(segments.map((s) => s.type).sort()).toEqual(
        [CompanyType.FUEL, CompanyType.TRANSPORT].sort(),
      );
    });
  });

  /**
   * T021a — **the test that would have caught the delivered-only order count.**
   *
   * Seeds a period containing orders raised but NOT delivered, then asserts the
   * count includes them while value and volume do not. Under the wrong
   * implementation `orderCount` would equal the COMPLETED bucket, five of the
   * six segments would be structurally zero, and every other test in this file
   * would still pass.
   */
  describe('the three period figures do NOT share one basis (FR-001a)', () => {
    const WINDOW_FROM = '2026-03-01T00:00:00.000Z';
    const WINDOW_TO = '2026-03-31T23:59:59.999Z';
    const DELIVERED_LITRES = 700;
    const DELIVERED_VALUE = 1234.5;

    beforeAll(async () => {
      const { Types } = require('mongoose');
      // One order raised AND delivered inside the window.
      const deliveredId = await placeOrder(fixtures.companyA, DELIVERED_LITRES);
      await connection
        .collection('orders')
        .updateOne(
          { _id: new Types.ObjectId(deliveredId) },
          { $set: { createdAt: new Date('2026-03-05T10:00:00.000Z') } },
        );
      await markDelivered(deliveredId, new Date('2026-03-06T10:00:00.000Z'), DELIVERED_VALUE);

      // Two orders raised inside the window and never delivered. These are the
      // ones that separate the two bases.
      for (const liters of [250, 400]) {
        const id = await placeOrder(fixtures.companyA, liters);
        await connection
          .collection('orders')
          .updateOne(
            { _id: new Types.ObjectId(id) },
            { $set: { createdAt: new Date('2026-03-10T10:00:00.000Z') } },
          );
      }
    });

    it('orderCount counts undelivered orders; orderValue and litresMoved do not', async () => {
      const res = await overview(
        fixtures.superAdmin.token,
        `?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      ).expect(200);

      // Three raised in the window — one delivered, two not.
      expect(res.body.period.orderCount).toBe(3);
      // Only the delivered one contributes value and volume.
      expect(res.body.period.orderValue).toBeCloseTo(DELIVERED_VALUE, 2);
      expect(res.body.period.litresMoved).toBe(DELIVERED_LITRES);
    });

    it('the six segments still sum to the count, with COMPLETED strictly smaller', async () => {
      const res = await overview(
        fixtures.superAdmin.token,
        `?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      ).expect(200);
      const segments = res.body.breakdown.byOrderBucket as {
        bucket: string;
        count: number;
      }[];
      const completed = segments.find((s) => s.bucket === OrderStatusBucket.COMPLETED)!;

      expect(segments.reduce((t, s) => t + s.count, 0)).toBe(res.body.period.orderCount);
      // This is the assertion the wrong basis fails: under a delivered-only
      // count these two would be equal and every other bucket zero.
      expect(completed.count).toBeLessThan(res.body.period.orderCount);
      expect(completed.count).toBe(1);
    });

    it('names both bases in the response rather than leaving them to be inferred', async () => {
      const res = await overview(fixtures.superAdmin.token).expect(200);
      expect(res.body.period.basis).toEqual({
        orderCount: PeriodFigureBasis.RAISED_IN_PERIOD,
        orderValue: PeriodFigureBasis.DELIVERED_IN_PERIOD,
        litresMoved: PeriodFigureBasis.DELIVERED_IN_PERIOD,
      });
    });
  });

  describe('the overview is the operator`s alone (FR-007, SC-012)', () => {
    it.each([
      ['FUEL_COMPANY_ADMIN', () => fixtures.companyA.admin.token],
      ['TRANSPORT_COMPANY_ADMIN', () => fixtures.companyA.transportAdmin.token],
      ['CLIENT', () => fixtures.companyA.client.token],
      ['DRIVER', () => fixtures.companyA.driver.token],
    ])('refuses a %s with 403', async (_role, token) => {
      await overview(token()).expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer()).get('/api/v1/platform/overview').expect(401);
    });
  });

  describe('the response carries no trend, delta or percentage anywhere (FR-009)', () => {
    it('no such key exists at any nesting level', async () => {
      const res = await overview(fixtures.superAdmin.token).expect(200);

      const forbidden = [
        'trend',
        'trendUp',
        'delta',
        'percent',
        'percentage',
        'change',
        'previous',
        'comparison',
      ];
      const keys: string[] = [];
      const walk = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            keys.push(key.toLowerCase());
            walk(value);
          }
        }
      };
      walk(res.body);

      for (const word of forbidden) {
        expect(keys.some((key) => key.includes(word))).toBe(false);
      }
    });
  });
});

/**
 * The SUPER_ADMIN summary shape (US3 T045, kept here because it is the same
 * computation the overview delegates to). The operator used to fall through to
 * the TRANSPORT company's shape (research R5).
 */
describe('GET /orders/summary gives the operator its own shape (FR-023, research R5)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const summary = (token: string) =>
    request(app.getHttpServer())
      .get('/api/v1/orders/summary')
      .set('Authorization', `Bearer ${token}`);

  it('returns the six buckets and a total equal to their sum', async () => {
    const res = await summary(fixtures.superAdmin.token).expect(200);
    expect(Object.keys(res.body.buckets).sort()).toEqual(
      Object.values(OrderStatusBucket).sort(),
    );
    const sum = Object.values(res.body.buckets as Record<string, number>).reduce(
      (total, count) => total + count,
      0,
    );
    expect(res.body.total).toBe(sum);
  });

  it('no longer answers a transporter`s questions to the operator', async () => {
    const res = await summary(fixtures.superAdmin.token).expect(200);
    expect(res.body).not.toHaveProperty('awaitingAssignment');
    expect(res.body).not.toHaveProperty('driversOnDuty');
  });

  it('keeps REJECTED and CANCELLED as separate keys (FR-023b)', async () => {
    const res = await summary(fixtures.superAdmin.token).expect(200);
    expect(res.body.buckets).toHaveProperty(OrderStatusBucket.REJECTED);
    expect(res.body.buckets).toHaveProperty(OrderStatusBucket.CANCELLED);
  });

  // FR-075 — the negative guarantee. Neither existing shape may change.
  it('leaves the TRANSPORT_COMPANY_ADMIN shape field-for-field unchanged', async () => {
    const res = await summary(fixtures.companyA.transportAdmin.token).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'awaitingAssignment',
        'completedInPeriod',
        'driversOnDuty',
        'inProgress',
        'outstandingSettlements',
      ].sort(),
    );
  });

  it('leaves the FUEL_COMPANY_ADMIN shape field-for-field unchanged', async () => {
    const res = await summary(fixtures.companyA.admin.token).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'completedInPeriod',
        'creditOutstanding',
        'inProgress',
        'pendingApproval',
        'stationOwnersCount',
        'stationsCount',
      ].sort(),
    );
  });

  it('still refuses a CLIENT and a DRIVER', async () => {
    await summary(fixtures.companyA.client.token).expect(403);
    await summary(fixtures.companyA.driver.token).expect(403);
  });

  // Guards against a future reader "tidying" the platform branch away.
  it('a freshly created operator with no company still gets the platform shape', async () => {
    const operator = await superAdminActor(app, 'second-operator@platform.test');
    const res = await summary(operator.token).expect(200);
    expect(res.body).toHaveProperty('buckets');
    expect(UserRole.SUPER_ADMIN).toBe('SUPER_ADMIN');
  });
});
