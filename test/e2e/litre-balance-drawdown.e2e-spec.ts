import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T203/FR-074/R9/SC-014b — a later order draws
 * an owner's litre balance down automatically, a quote never moves it, and a
 * cancellation returns what it drew.
 */
describe('Litre balance drawdown at order creation (US11, FR-074)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  async function creditShortfall(
    fixture: TwoCompanyFixture['companyA'],
    orderedLiters: number,
    suppliedLiters: number,
  ): Promise<void> {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: orderedLiters, paymentMethod: 'DIRECT' })
      .expect(201);
    const uploaded = await request(server)
      .post(`/api/v1/orders/${created.body._id}/supplier-invoice/upload`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .attach('file', Buffer.from('%PDF fake'), { filename: 'inv.pdf', contentType: 'application/pdf' })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${created.body._id}/supplier-invoice`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({
        fileId: uploaded.body.fileId,
        confirmed: { quantityLitres: suppliedLiters, fuelType: 'DIESEL', reference: 'r', issueDate: '2026-02-01' },
      })
      .expect(201);
  }

  it('draws the balance down at creation, capped by the balance and the new order size, and shows the drawn amount and remainder before placing (FR-074)', async () => {
    const { client } = fixtures.companyA;
    const server = app.getHttpServer();

    // Establish a known balance: order 1000, supply 700 -> credit 300.
    await creditShortfall(fixtures.companyA, 1000, 700);

    // A quote for a smaller order MUST project the drawdown but consume NOTHING (R9).
    const stations = await request(server)
      .get('/api/v1/stations')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const stationId = stations.body.items[0]._id as string;
    const quote = await request(server)
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, stationId })
      .expect(201);
    expect(quote.body.litreDrawdown.litresDrawn).toBeGreaterThan(0);
    expect(quote.body.litreDrawdown.litresDrawn).toBeLessThanOrEqual(100);

    const balanceRightAfterQuote = await request(server)
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    // R9: the quote above computed a non-zero projected drawdown but must not have
    // moved anything — this read is what proves it.
    const dieselRightAfterQuote = balanceRightAfterQuote.body.items.find(
      (b: { fuelType: string }) => b.fuelType === 'DIESEL',
    );
    expect(dieselRightAfterQuote.balanceLitres).toBeCloseTo(300, 3);

    const beforeBalance = await request(server)
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const dieselBefore = beforeBalance.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL');
    const balanceBeforeOrder = dieselBefore.balanceLitres;
    expect(balanceBeforeOrder).toBeGreaterThanOrEqual(300);

    // A real order for 100 L draws down min(balance, 100) = 100 L.
    const order = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DIRECT' })
      .expect(201);
    expect(order.body.litreDrawdown.litresDrawn).toBeCloseTo(100, 3);
    expect(order.body.litreDrawdown.balanceRemaining).toBeCloseTo(balanceBeforeOrder - 100, 3);

    const afterBalance = await request(server)
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const dieselAfter = afterBalance.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL');
    expect(dieselAfter.balanceLitres).toBeCloseTo(balanceBeforeOrder - 100, 3);
    const drawdownMovement = dieselAfter.movements.find(
      (m: { orderId: string; kind: string }) => m.orderId === order.body._id && m.kind === 'ORDER_DRAWDOWN',
    );
    expect(drawdownMovement).toBeDefined();
    expect(drawdownMovement.litres).toBeCloseTo(-100, 3);
  });

  it('cancelling an order that drew down a balance returns exactly what it drew (SC-014b)', async () => {
    const { client } = fixtures.companyA;
    const server = app.getHttpServer();

    await creditShortfall(fixtures.companyA, 500, 300); // +200 credit

    const before = await request(server)
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const balanceBefore = before.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL').balanceLitres;

    const order = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 50, paymentMethod: 'DIRECT' })
      .expect(201);
    expect(order.body.litreDrawdown.litresDrawn).toBeCloseTo(50, 3);

    await request(server)
      .patch(`/api/v1/orders/${order.body._id}/cancel`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({})
      .expect(200);

    const after = await request(server)
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const balanceAfter = after.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL').balanceLitres;
    expect(balanceAfter).toBeCloseTo(balanceBefore, 3);
    const dieselAfter = after.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL');
    const returned = dieselAfter.movements.find(
      (m: { orderId: string; kind: string }) => m.orderId === order.body._id && m.kind === 'DRAWDOWN_RETURNED',
    );
    expect(returned).toBeDefined();
    expect(returned.litres).toBeCloseTo(50, 3);
  });

  it('abandoning several quotes in a row never moves the balance (R9)', async () => {
    const { client } = fixtures.companyA;
    const server = app.getHttpServer();
    await creditShortfall(fixtures.companyA, 200, 100); // +100 credit

    const stations = await request(server)
      .get('/api/v1/stations')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const stationId = stations.body.items[0]._id as string;

    const before = await request(server)
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const balanceBefore = before.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL').balanceLitres;

    for (let i = 0; i < 3; i++) {
      const quote = await request(server)
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ fuelType: 'DIESEL', quantityLiters: 50, stationId })
        .expect(201);
      expect(quote.body.litreDrawdown.litresDrawn).toBeGreaterThan(0);
    }

    const after = await request(server)
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const balanceAfter = after.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL').balanceLitres;
    expect(balanceAfter).toBeCloseTo(balanceBefore, 3);
  });
});
