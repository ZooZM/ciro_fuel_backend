import request from 'supertest';
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import {
  PaymentEvent,
  PaymentEventDocument,
  PaymentEventOutcome,
  PaymentGateway,
} from '../../src/modules/payments/schemas/payment-event.schema';

jest.setTimeout(120_000);

function sign(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('GET /payments (spec 005 US4/FR-023)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let paymentEventModel: Model<PaymentEventDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    paymentEventModel = app.get(getModelToken(PaymentEvent.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  async function createApprovedOrder(
    client: { token: string },
    admin: { token: string },
  ): Promise<{ orderId: string; finalPrice: number }> {
    const server = app.getHttpServer();
    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 200 })
      .expect(201);
    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    return { orderId: createRes.body._id, finalPrice: approveRes.body.finalPrice };
  }

  /** Creates `count` CONFIRMED payment events directly (not through a real
   * webhook, which this suite's other test already exercises end to end) —
   * `createdAt` spaced a minute apart so "no repeats, no skips" is
   * deterministic to assert on, same recipe as orders-pagination. */
  async function seedPaymentEvents(
    clientId: string,
    companyId: string,
    count: number,
    startMinute = 0,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const event = await paymentEventModel.create({
        gatewayTransactionId: `SDD-hist-${clientId}-${i}`,
        gateway: PaymentGateway.SADAD,
        orderId: new Types.ObjectId(),
        companyId: new Types.ObjectId(companyId),
        clientId: new Types.ObjectId(clientId),
        amount: 100 + i,
        currency: 'SAR',
        outcome: PaymentEventOutcome.CONFIRMED,
        rawPayload: { secret: 'should-never-reach-the-client' },
      });
      const createdAt = new Date(2026, 0, 1, 10, startMinute + i, 0, 0);
      await paymentEventModel.updateOne({ _id: event._id }, { $set: { createdAt } });
      ids.push(String(event._id));
    }
    return ids.reverse(); // newest first, matching the endpoint's own sort
  }

  it('a CLIENT sees only their own payments, and rawPayload is absent from every response', async () => {
    const { client: clientA, admin: adminA } = fixtures.companyA;
    const { client: clientB } = fixtures.companyB;
    const server = app.getHttpServer();

    const { orderId, finalPrice } = await createApprovedOrder(clientA, adminA);
    const payload = {
      transactionId: `SDD-history-${orderId}`,
      orderId,
      amount: finalPrice,
      currency: 'SAR',
      status: 'PAID',
      paidAt: new Date().toISOString(),
    };
    const { rawBody, signature } = sign(payload, 'sadad-test-secret');
    await request(server)
      .post('/api/v1/payments/webhook/sadad')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody)
      .expect(201);

    const ownHistory = await request(server)
      .get('/api/v1/payments')
      .set('Authorization', `Bearer ${clientA.token}`)
      .expect(200);
    const paid = ownHistory.body.items.find((p: { orderId: string }) => p.orderId === orderId);
    expect(paid).toBeDefined();
    expect(paid.amount).toBeCloseTo(finalPrice, 2);
    expect(paid.rawPayload).toBeUndefined();
    for (const item of ownHistory.body.items) {
      expect(item.rawPayload).toBeUndefined();
    }

    const otherClientsHistory = await request(server)
      .get('/api/v1/payments')
      .set('Authorization', `Bearer ${clientB.token}`)
      .expect(200);
    expect(
      otherClientsHistory.body.items.some((p: { orderId: string }) => p.orderId === orderId),
    ).toBe(false);
  });

  it('pages through 25 payments with no repeats and no skips, and nextCursor is null on the last page', async () => {
    const { client } = fixtures.companyB;
    const server = app.getHttpServer();
    const expectedIds = await seedPaymentEvents(client.id, fixtures.companyB.companyId, 25, 200);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await request(server)
        .get('/api/v1/payments')
        .query(cursor ? { cursor } : {})
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);

      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.length).toBeLessThanOrEqual(20); // DEFAULT_PAGE_SIZE
      seen.push(...res.body.items.map((p: { _id: string }) => p._id));
      cursor = res.body.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);

    const seededSeen = seen.filter((id) => expectedIds.includes(id));
    expect(seededSeen).toEqual(expectedIds);
    expect(new Set(seededSeen).size).toBe(expectedIds.length);
    expect(cursor).toBeUndefined();
  });
});
