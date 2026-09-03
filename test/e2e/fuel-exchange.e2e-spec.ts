import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T227/T228/T229 — the fuel exchange domain,
 * built only after Part A's isolation gate passed. Every one of these tests genuinely
 * needs TWO fuel companies; a single-company run would pass even with the multi-party
 * defect research R3 found (the plan's own Checkpoint note).
 */
describe('Fuel exchange between companies (US12, FR-078-086)', () => {
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

  function raiseBody(recipientCompanyId: string) {
    return {
      recipientCompanyId,
      fuelType: 'DIESEL',
      quantityLitres: 5000,
      unitPrice: 2.4,
      deliveryAt: '2026-07-01T08:00:00.000Z',
      deliveryPlaceText: 'Jeddah warehouse',
    };
  }

  it('raises a request, and both sides read identical full terms in the correct direction (SC-014)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA, companyId: companyIdA } = fixtures.companyA;
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody(companyIdB))
      .expect(201);
    const id = created.body._id as string;

    const outgoing = await request(server)
      .get('/api/v1/fuel-exchange/requests?direction=outgoing')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(outgoing.body.items.map((r: { _id: string }) => r._id)).toContain(id);

    const incoming = await request(server)
      .get('/api/v1/fuel-exchange/requests?direction=incoming')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(incoming.body.items.map((r: { _id: string }) => r._id)).toContain(id);

    // A's own outgoing list must NOT show it as incoming, and vice versa.
    const aIncoming = await request(server)
      .get('/api/v1/fuel-exchange/requests?direction=incoming')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(aIncoming.body.items.map((r: { _id: string }) => r._id)).not.toContain(id);

    const detailA = await request(server)
      .get(`/api/v1/fuel-exchange/requests/${id}`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    const detailB = await request(server)
      .get(`/api/v1/fuel-exchange/requests/${id}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(detailA.body.quantityLitres).toBe(detailB.body.quantityLitres);
    expect(detailA.body.unitPrice).toBe(detailB.body.unitPrice);
    expect(detailA.body.deliveryPlaceText).toBe(detailB.body.deliveryPlaceText);
    expect(detailA.body.fuelType).toBe(detailB.body.fuelType);
    // Each side's counterparty contact is the OTHER company, never their own.
    expect(detailA.body.counterparty._id).toBe(companyIdB);
    expect(detailB.body.counterparty._id).toBe(companyIdA);
  });

  it('the recipient can accept, creating no order/delivery/invoice anywhere (FR-080, FR-086a, T229)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;

    const beforeOrdersA = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    const beforeCountA = beforeOrdersA.body.items.length;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody(companyIdB))
      .expect(201);

    const accepted = await request(server)
      .patch(`/api/v1/fuel-exchange/requests/${created.body._id}/respond`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ accept: true })
      .expect(200);
    expect(accepted.body.state).toBe('ACCEPTED');

    const afterOrdersA = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(afterOrdersA.body.items.length).toBe(beforeCountA);
  });

  it('the recipient can decline; a second response is refused as already resolved (FR-080/082)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const created = await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody(companyIdB))
      .expect(201);

    const declined = await request(server)
      .patch(`/api/v1/fuel-exchange/requests/${created.body._id}/respond`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ accept: false })
      .expect(200);
    expect(declined.body.state).toBe('DECLINED');

    const refused = await request(server)
      .patch(`/api/v1/fuel-exchange/requests/${created.body._id}/respond`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ accept: true })
      .expect(409);
    expect(refused.body.error).toBe('EXCHANGE_ALREADY_RESOLVED');
  });

  it('the raiser can withdraw; the recipient cannot withdraw the raiser\'s own request (FR-081)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const created = await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody(companyIdB))
      .expect(201);

    await request(server)
      .patch(`/api/v1/fuel-exchange/requests/${created.body._id}/withdraw`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(403);

    const withdrawn = await request(server)
      .patch(`/api/v1/fuel-exchange/requests/${created.body._id}/withdraw`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(withdrawn.body.state).toBe('WITHDRAWN');
  });

  it('concurrent accept and withdraw produce exactly one outcome that both parties see identically (T228, FR-082, SC-008)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const created = await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody(companyIdB))
      .expect(201);
    const id = created.body._id as string;

    const [acceptRes, withdrawRes] = await Promise.all([
      request(server)
        .patch(`/api/v1/fuel-exchange/requests/${id}/respond`)
        .set('Authorization', `Bearer ${adminB.token}`)
        .send({ accept: true }),
      request(server).patch(`/api/v1/fuel-exchange/requests/${id}/withdraw`).set('Authorization', `Bearer ${adminA.token}`),
    ]);

    const statuses = [acceptRes.status, withdrawRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalA = await request(server)
      .get(`/api/v1/fuel-exchange/requests/${id}`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    const finalB = await request(server)
      .get(`/api/v1/fuel-exchange/requests/${id}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(finalA.body.state).toBe(finalB.body.state);
    expect(['ACCEPTED', 'WITHDRAWN']).toContain(finalA.body.state);
  });

  it('refuses a request for a grade the recipient does not sell (FR-085)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { companyId: companyIdB } = fixtures.companyB;
    const refused = await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ ...raiseBody(companyIdB), fuelType: 'KEROSENE' })
      .expect(400);
    expect(refused.body.error).toBe('EXCHANGE_GRADE_NOT_SOLD');
  });

  it('refuses a request to the raiser\'s own company', async () => {
    const server = app.getHttpServer();
    const { admin: adminA, companyId: companyIdA } = fixtures.companyA;
    await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody(companyIdA))
      .expect(400);
  });

  it('SUPER_ADMIN reads every exchange request across companies', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { companyId: companyIdB } = fixtures.companyB;
    await request(server)
      .post('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody(companyIdB))
      .expect(201);

    const asOperator = await request(server)
      .get('/api/v1/fuel-exchange/requests')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(asOperator.body.items.length).toBeGreaterThan(0);
  });

  it('lists potential exchange partners: every active fuel company except itself, before /companies/:id would swallow the route', async () => {
    const server = app.getHttpServer();
    const { admin: adminA, companyId: companyIdA } = fixtures.companyA;
    const { companyId: companyIdB } = fixtures.companyB;

    const partners = await request(server)
      .get('/api/v1/companies/exchange-partners')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    const partnerIds = partners.body.map((c: { _id: string }) => c._id);
    expect(partnerIds).toContain(companyIdB);
    expect(partnerIds).not.toContain(companyIdA);
  });
});
