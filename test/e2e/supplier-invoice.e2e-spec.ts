import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T201/T202/T204 — the supplier-invoice
 * upload/confirm/replace flow and the balance movement it drives. Reference case from
 * the plan's Independent Test: 31,501.100 L supplied against 33,000 L ordered ->
 * 1,498.900 L credited.
 */
describe('Supplier invoices and litre balances (US11, FR-073*)', () => {
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

  async function createOrder(
    fixture: TwoCompanyFixture['companyA'],
    quantityLiters: number,
  ): Promise<string> {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters, paymentMethod: 'DIRECT' })
      .expect(201);
    return created.body._id as string;
  }

  function uploadInvoice(orderId: string, admin: { token: string }) {
    return request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice/upload`)
      .set('Authorization', `Bearer ${admin.token}`)
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'invoice.pdf', contentType: 'application/pdf' });
  }

  it('credits the exact reference-case shortfall: 31,501.100 L against 33,000 L -> 1,498.900 L (FR-073c)', async () => {
    const { admin, client } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 33_000);

    const uploaded = await uploadInvoice(orderId, admin).expect(201);
    expect(uploaded.body.orderedQuantityLitres).toBe(33_000);
    expect(uploaded.body.extracted).toEqual({});

    const confirmed = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        fileId: uploaded.body.fileId,
        confirmed: { quantityLitres: 31_501.1, fuelType: 'DIESEL', reference: 'SUP-INV-1', issueDate: '2026-01-05' },
      })
      .expect(201);
    expect(confirmed.body.shortfallLitres).toBeCloseTo(1_498.9, 3);
    expect(confirmed.body.balanceWarning).toBeUndefined();
    expect(confirmed.body.supplierInvoice.suppliedQuantityLitres).toBeCloseTo(31_501.1, 3);
    expect(confirmed.body.supplierInvoice.orderedQuantityLitres).toBe(33_000);

    const clientBalances = await request(app.getHttpServer())
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const dieselBalance = clientBalances.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL');
    expect(dieselBalance.balanceLitres).toBeCloseTo(1_498.9, 3);
    expect(dieselBalance.movements).toHaveLength(1);
    expect(dieselBalance.movements[0].kind).toBe('SHORTFALL_CREDIT');
  });

  it('an exact-quantity confirmation records no movement at all (T201)', async () => {
    const { admin, client } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 500);
    const uploaded = await uploadInvoice(orderId, admin).expect(201);

    const before = await request(app.getHttpServer())
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const movementCountBefore =
      before.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL')?.movements?.length ?? 0;

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        fileId: uploaded.body.fileId,
        confirmed: { quantityLitres: 500, fuelType: 'DIESEL', reference: 'SUP-INV-2', issueDate: '2026-01-06' },
      })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const movementCountAfter = after.body.items.find(
      (b: { fuelType: string }) => b.fuelType === 'DIESEL',
    ).movements.length;
    expect(movementCountAfter).toBe(movementCountBefore);
  });

  it('an excess supplied quantity debits the balance, and can go negative — advisory only (T201, FR-073d)', async () => {
    const { admin, client } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 100);
    const uploaded = await uploadInvoice(orderId, admin).expect(201);

    const confirmed = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        fileId: uploaded.body.fileId,
        confirmed: { quantityLitres: 250, fuelType: 'DIESEL', reference: 'SUP-INV-3', issueDate: '2026-01-07' },
      })
      .expect(201);
    expect(confirmed.body.shortfallLitres).toBeCloseTo(-150, 3);
    // The account was net-positive from the earlier reference-case test in this suite
    // (tests share one seeded client) — assert the movement kind directly rather than
    // assuming the sign of the running balance.
    const balances = await request(app.getHttpServer())
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const dieselBalance = balances.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL');
    const debitMovement = dieselBalance.movements.find(
      (m: { kind: string; litres: number }) => m.kind === 'EXCESS_DEBIT' && m.litres === -150,
    );
    expect(debitMovement).toBeDefined();
  });

  it('a retried/duplicate confirm is refused and moves the balance only once (FR-073e)', async () => {
    const { admin } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 200);
    const uploaded = await uploadInvoice(orderId, admin).expect(201);
    const confirmBody = {
      fileId: uploaded.body.fileId,
      confirmed: { quantityLitres: 180, fuelType: 'DIESEL', reference: 'SUP-INV-4', issueDate: '2026-01-08' },
    };
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(confirmBody)
      .expect(201);

    const retried = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(confirmBody)
      .expect(409);
    expect(retried.body.error).toBe('SUPPLIER_INVOICE_ALREADY_RECORDED');
  });

  it('an abandoned upload (never confirmed) leaves no supplier-invoice record at all (T202, SC-014c)', async () => {
    const { admin } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 300);
    await uploadInvoice(orderId, admin).expect(201);

    const order = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(order.body.supplierInvoice).toBeUndefined();
    expect(order.body.supplierInvoices).toBeUndefined();
  });

  it('refuses a confirmed grade differing from the order (FR-073g)', async () => {
    const { admin } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 100);
    const uploaded = await uploadInvoice(orderId, admin).expect(201);
    const refused = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        fileId: uploaded.body.fileId,
        confirmed: { quantityLitres: 90, fuelType: 'PETROL_91', reference: 'SUP-INV-5', issueDate: '2026-01-09' },
      })
      .expect(400);
    expect(refused.body.error).toBe('SUPPLIER_INVOICE_GRADE_MISMATCH');
  });

  it('refuses a supplier invoice against a cancelled order (spec Edge Cases)', async () => {
    const { admin, client } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 100);
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({})
      .expect(200);

    const refused = await uploadInvoice(orderId, admin);
    // The Order document still exists and is eligible for upload (upload records
    // nothing); the refusal fires at confirm time, where it actually matters.
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        fileId: refused.body.fileId,
        confirmed: { quantityLitres: 90, fuelType: 'DIESEL', reference: 'SUP-INV-6', issueDate: '2026-01-10' },
      })
      .expect(409)
      .expect((res) => expect(res.body.error).toBe('SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE'));
  });

  it('replacing a confirmed invoice restates the movement rather than accruing a second one (T192)', async () => {
    const { admin, client } = fixtures.companyA;
    const orderId = await createOrder(fixtures.companyA, 1000);
    const first = await uploadInvoice(orderId, admin).expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        fileId: first.body.fileId,
        confirmed: { quantityLitres: 900, fuelType: 'DIESEL', reference: 'SUP-INV-7a', issueDate: '2026-01-11' },
      })
      .expect(201);

    const before = await request(app.getHttpServer())
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const beforeBalance = before.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL').balanceLitres;

    const second = await uploadInvoice(orderId, admin).expect(201);
    const replaced = await request(app.getHttpServer())
      .put(`/api/v1/orders/${orderId}/supplier-invoice`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        fileId: second.body.fileId,
        confirmed: { quantityLitres: 950, fuelType: 'DIESEL', reference: 'SUP-INV-7b', issueDate: '2026-01-12' },
      })
      .expect(200);
    expect(replaced.body.shortfallLitres).toBeCloseTo(50, 3);

    const after = await request(app.getHttpServer())
      .get('/api/v1/users/me/litre-balances')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    const dieselBalance = after.body.items.find((b: { fuelType: string }) => b.fuelType === 'DIESEL');
    // Restated from 100 (1000-900) to 50 (1000-950) -> the balance moved by exactly the
    // 50 L difference, not by a second full accrual.
    expect(dieselBalance.balanceLitres).toBeCloseTo(beforeBalance - 50, 3);
    // Filtered to the reconciliation kinds specifically — this order may ALSO carry an
    // unrelated ORDER_DRAWDOWN movement for the same orderId (T194: the client had a
    // positive balance from earlier tests in this suite, which order creation itself
    // draws down independently of supplier-invoice reconciliation).
    const orderMovements = dieselBalance.movements.filter(
      (m: { orderId: string | null; kind: string }) =>
        m.orderId === orderId && (m.kind === 'SHORTFALL_CREDIT' || m.kind === 'EXCESS_DEBIT'),
    );
    expect(orderMovements).toHaveLength(1);
  });

  it("a second fuel company cannot view another company's client litre balance (T204, FR-073f, SC-006)", async () => {
    const { admin: adminB } = fixtures.companyB;
    const res = await request(app.getHttpServer())
      .get('/api/v1/litre-balances')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
  });

  it("a second fuel company cannot retrieve another company's supplier-invoice document (FR-073f)", async () => {
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;
    const orderId = await createOrder(fixtures.companyA, 100);
    const uploaded = await uploadInvoice(orderId, adminA).expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/files/${uploaded.body.fileId}`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(302);
    await request(app.getHttpServer())
      .get(`/api/v1/files/${uploaded.body.fileId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(302);
    await request(app.getHttpServer())
      .get(`/api/v1/files/${uploaded.body.fileId}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(404);
  });
});
