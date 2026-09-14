import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  uniquePhone,
  DEFAULT_PASSWORD,
} from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(120_000);

/** Spec 004 US5/FR-024/FR-025/SC-004 (T075): a credit shortfall refuses
 * approval, and placement never reserves credit — only approval consumes
 * it, including under real concurrency between two orders for the same
 * client (the credit-analogue of dispatch-race.e2e-spec.ts's driver race). */
describe('Billing — credit limit (spec 004 US5)', () => {
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

  /** A fresh CLIENT under companyA with the given credit limit — isolated
   * per test so one test's credit consumption never leaks into another's. */
  async function createClientWithCreditLimit(
    creditLimit: number,
  ): Promise<{ id: string; token: string }> {
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const email = `credit-client-${Date.now()}-${Math.random()}@companya.test`;

    const createRes = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        role: 'CLIENT',
        email,
        password: DEFAULT_PASSWORD,
        fullName: 'Credit Test Client',
        phone: uniquePhone(),
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(201);

    await request(server)
      .put(`/api/v1/users/${createRes.body._id}/credit-limit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ creditLimit })
      .expect(200);

    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: DEFAULT_PASSWORD })
      .expect(201);

    return { id: createRes.body._id, token: login.body.accessToken };
  }

  async function createCreditOrder(clientToken: string, quantityLiters: number) {
    return request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ fuelType: 'DIESEL', quantityLiters, paymentMethod: 'CREDIT' })
      .expect(201);
  }

  it("refuses approval when the order's final price exceeds available credit, naming the shortfall (FR-025)", async () => {
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const client = await createClientWithCreditLimit(300);

    // 200L * 2.5 SAR/L = 500 of fuel, + 1% service fee = 505, + 30 haul = 535,
    // + 15% VAT = 615.25 — over the 300 limit. The service fee and the VAT are
    // new here only because an order created without a quote token used to skip
    // both; the credit check has always read `finalPrice`, so it now reads the
    // same figure the invoice will carry.
    const createRes = await createCreditOrder(client.token, 200);

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(400);
    expect(approveRes.body.message).toMatch(/credit/i);
    expect(approveRes.body.message).toMatch(/615\.25/);
    expect(approveRes.body.message).toMatch(/300/);

    // Refused cleanly — order never moved, no invoice exists (FR-020/FR-025).
    const stillPending = await request(server)
      .get(`/api/v1/orders/${createRes.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    // APPROVED, not PENDING_APPROVAL. The credit check lives in invoice
    // issuance, and the invoice is now issued at ROUTING — the first moment the
    // total includes the haul. So approval itself succeeds, and the refusal
    // arrives one step later and rolls the routing back with it: the order is
    // left approved, un-routed, uninvoiced and recoverable (raise the limit,
    // then PATCH :id/route), never committed to a transporter it cannot bill.
    expect(stillPending.body.status).toBe(OrderStatus.APPROVED);
    expect(stillPending.body.transportCompanyId).toBeFalsy();
    expect(stillPending.body.invoiceId).toBeFalsy();
    expect(stillPending.body.invoiceId).toBeFalsy();
  });

  it('never reserves credit at placement — two orders each within the limit alone, together exceeding it, place fine and are resolved only at approval', async () => {
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const client = await createClientWithCreditLimit(300);

    // 80L * 2.5 = 200 of fuel, + 1% service = 202, + 30 haul = 232, + 15% VAT
    // = 266.80 each; both individually fit under 300, but not together.
    const order1 = await createCreditOrder(client.token, 80);
    const order2 = await createCreditOrder(client.token, 80);

    const approve1 = await request(server)
      .patch(`/api/v1/orders/${order1.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    // Routed AND priced, then handed back to the station owner to settle.
    expect(approve1.body.status).toBe(OrderStatus.PENDING_PAYMENT);

    // The second has only 300 - 266.80 = 33.20 left to draw on, and is refused.
    await request(server)
      .patch(`/api/v1/orders/${order2.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(400);

    const order2After = await request(server)
      .get(`/api/v1/orders/${order2.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    // Same as above: approved, then refused at routing, with routing undone.
    expect(order2After.body.status).toBe(OrderStatus.APPROVED);
    expect(order2After.body.transportCompanyId).toBeFalsy();
  });

  it('SC-004: two concurrent approvals racing the same credit limit resolve to exactly one success', async () => {
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const client = await createClientWithCreditLimit(300);

    const order1 = await createCreditOrder(client.token, 80); // 266.80 SAR
    const order2 = await createCreditOrder(client.token, 80); // 266.80 SAR — together, 533.60 > 300

    const [approve1, approve2] = await Promise.all([
      request(server)
        .patch(`/api/v1/orders/${order1.body._id}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({}),
      request(server)
        .patch(`/api/v1/orders/${order2.body._id}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({}),
    ]);

    const statuses = [approve1.status, approve2.status].sort();
    // Exactly one succeeds; the other is refused — never both, never neither.
    expect(statuses).toEqual([200, 400]);

    // The invoice ledger reflects exactly the winner — no double-commit,
    // no lost update, regardless of which of the two actually won the race.
    const invoices = await request(server)
      .get('/api/v1/invoices')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const thisClientsIssuedCredit = invoices.body.items.filter(
      (inv: { clientId: string; method: string; state: string }) =>
        inv.clientId === client.id && inv.method === 'CREDIT' && inv.state === 'ISSUED',
    );
    expect(thisClientsIssuedCredit).toHaveLength(1);
    expect(thisClientsIssuedCredit[0].amount).toBeCloseTo(266.8, 2);
  });

  it(
    'GET /users/me/credit agrees with the value the order path uses to refuse ' +
      'over-limit orders, and returns null when no facility is assigned (spec 005 T080/T081)',
    async () => {
      const { admin } = fixtures.companyA;
      const server = app.getHttpServer();
      // 400, not 300: one 100 L CREDIT order is 250 of fuel + 1% service + the
      // 30 haul + 15% VAT = 324.88, which a 300 limit no longer admits at all.
      // The limit is sized so the FIRST order fits and the second does not,
      // which is what this test is actually about.
      const client = await createClientWithCreditLimit(400);

      const beforeOrder = await request(server)
        .get('/api/v1/users/me/credit')
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);
      expect(beforeOrder.body).toEqual({
        creditLimit: 400,
        consumed: 0,
        available: 400,
      });

      // The facility is measured against what the customer will actually be
      // billed — so `consumed` is asserted against the order's OWN `finalPrice`
      // rather than a literal restated here. A literal is a second calculation
      // that can drift from the first; this is the agreement the test claims to
      // be checking.
      const createRes = await createCreditOrder(client.token, 100);
      const approved = await request(server)
        .patch(`/api/v1/orders/${createRes.body._id}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({})
        .expect(200);
      const billed: number = approved.body.finalPrice;
      expect(billed).toBeGreaterThan(0);

      const afterApproval = await request(server)
        .get('/api/v1/users/me/credit')
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);
      expect(afterApproval.body.creditLimit).toBe(400);
      expect(afterApproval.body.consumed).toBeCloseTo(billed, 2);
      expect(afterApproval.body.available).toBeCloseTo(400 - billed, 2);

      // Exactly the figure a second CREDIT order's approval would itself
      // reject against — the same derivation, not a second calculation
      // that could drift from it.
      const overLimitOrder = await createCreditOrder(client.token, 100);
      const refusedApproval = await request(server)
        .patch(`/api/v1/orders/${overLimitOrder.body._id}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({})
        .expect(400);
      expect(refusedApproval.body.message).toContain(afterApproval.body.available.toFixed(2));

      // A client with no credit facility at all — never coerced to 0.
      const { client: clientNoFacility } = fixtures.companyB;
      const noFacility = await request(server)
        .get('/api/v1/users/me/credit')
        .set('Authorization', `Bearer ${clientNoFacility.token}`)
        .expect(200);
      expect(noFacility.body).toEqual({
        creditLimit: null,
        consumed: null,
        available: null,
      });
    },
  );
});
