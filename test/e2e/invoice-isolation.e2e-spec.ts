import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T107/FR-041/FR-042/SC-006 — `GET /invoices`
 * list-level isolation across two fuel companies (not exercised anywhere else;
 * `billing-methods.e2e-spec.ts` covers per-method settlement gating and reads single
 * invoices by id, never the list) and, rounding out that file's DEFERRED case, that a
 * settlement performed by the transporter it names is visible back to the issuing Fuel
 * Company — the counterparty on the other side of the same invoice.
 */
describe('Invoice list isolation and cross-party settlement visibility (FR-041, FR-042, SC-006)', () => {
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

  it("company B's invoice list never contains an invoice issued by company A, and company B cannot read it directly", async () => {
    const server = app.getHttpServer();
    const { client, admin } = fixtures.companyA;

    await request(server)
      .put(`/api/v1/users/${client.id}/credit-limit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ creditLimit: 1000 })
      .expect(200);

    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'CREDIT' })
      .expect(201);
    const approved = await request(server)
      .patch(`/api/v1/orders/${created.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    const invoiceId = approved.body.invoiceId as string;
    expect(invoiceId).toBeTruthy();

    // The issuing company sees it in its own list.
    const listA = await request(server)
      .get('/api/v1/invoices')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((listA.body.items as { _id: string }[]).map((i) => i._id)).toContain(invoiceId);

    // A second, unrelated fuel company's list never contains it.
    const listB = await request(server)
      .get('/api/v1/invoices')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(200);
    expect((listB.body.items as { _id: string }[]).map((i) => i._id)).not.toContain(invoiceId);

    // Nor can company B read it directly — isolation, never revealing (404, not 403).
    await request(server)
      .get(`/api/v1/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(404);
  });

  it('a DEFERRED invoice settled by the transporter it names reads back as SETTLED for the Fuel Company that issued it', async () => {
    const server = app.getHttpServer();
    const { client, admin, transportAdmin } = fixtures.companyA;

    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    const approved = await request(server)
      .patch(`/api/v1/orders/${created.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    const invoiceId = approved.body.invoiceId as string;

    await request(server)
      .post(`/api/v1/invoices/${invoiceId}/settle`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ paymentReference: 'counterparty-visibility-check' })
      .expect(201);

    // The issuing Fuel Company — the counterparty on the other side of this invoice —
    // reads the settlement back without needing to be the one who performed it.
    const rereadByIssuer = await request(server)
      .get(`/api/v1/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(rereadByIssuer.body.state).toBe('SETTLED');
    expect(rereadByIssuer.body.paymentReference).toBe('counterparty-visibility-check');

    // It also shows SETTLED in the issuer's own list, not just the single-document read.
    const listAfter = await request(server)
      .get('/api/v1/invoices?state=SETTLED')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((listAfter.body.items as { _id: string }[]).map((i) => i._id)).toContain(invoiceId);
  });
});
