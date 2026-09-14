import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

import { CompaniesService } from '../../src/modules/companies/companies.service';
import { RegionCode } from '../../src/common/enums/region.enum';
jest.setTimeout(120_000);

/** Spec 004 User Story 4 — routing resolution outcomes: none, one, and
 * several serving Transportation Companies (FR-014/FR-015/FR-016). */
describe('Order routing (spec 004 US4)', () => {
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

  it("parks an order AWAITING_ROUTING and notifies the Fuel Company when no transporter serves the client's region (FR-016)", async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    // Withdraw the fixture transporter's coverage of RIYADH — its own
    // region assignment becomes empty, so nothing serves this client anymore.
    await request(server)
      .put(`/api/v1/companies/${fixtures.companyA.transportCompanyId}/regions`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ regionCodes: [] })
      .expect(200);

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.AWAITING_ROUTING);
    expect(approveRes.body.transportCompanyId).toBeFalsy();

    const notifications = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(
      notifications.body.items.some(
        (n: { type: string; orderId: string }) =>
          n.type === 'NO_DRIVER_AVAILABLE' && n.orderId === createRes.body._id,
      ),
    ).toBe(true);

    // Coverage is restored later; the Fuel Company manually routes the
    // parked order (FR-016's "manually resolves a transporter later").
    await request(server)
      .put(`/api/v1/companies/${fixtures.companyA.transportCompanyId}/regions`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ regionCodes: ['RIYADH'] })
      .expect(200);

    const routeRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/route`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ transportCompanyId: fixtures.companyA.transportCompanyId })
      .expect(200);
    expect(routeRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(routeRes.body.transportCompanyId).toBe(fixtures.companyA.transportCompanyId);
  });

  it('rejects PATCH :id/route on an order that is not AWAITING_ROUTING', async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);

    // Still PENDING_APPROVAL — never reached AWAITING_ROUTING.
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/route`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ transportCompanyId: fixtures.companyA.transportCompanyId })
      .expect(409);
  });

  it("routes automatically to the sole transporter serving the client's region, with no admin choice required", async () => {
    const { client, admin, transportCompanyId } = fixtures.companyA;
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);

    const approveRes = await request(app.getHttpServer())
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(approveRes.body.transportCompanyId).toBe(transportCompanyId);
  });

  it('when several transporters serve the region, parks AWAITING_ROUTING with candidates until the Fuel Company chooses (FR-014)', async () => {
    const { client, admin, companyId } = fixtures.companyA;
    const server = app.getHttpServer();

    // A second transporter under the SAME Fuel Company, also serving RIYADH
    // — now two candidates exist for this client's region.
    const secondTransporter = await request(server)
      .post(`/api/v1/companies/${companyId}/transporters`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'Second Transporter ' + Date.now(),
        contactEmail: `second-${Date.now()}@ordertest.test`,
        contactPhone: '+966500000006',
        adminEmail: `second-admin-${Date.now()}@ordertest.test`,
        adminFullName: 'Second Transporter Admin',
        adminPhone: '+966500000007',
        adminPassword: 'Password123!',
      })
      .expect(201);
    await request(server)
      .put(`/api/v1/companies/${secondTransporter.body.company._id}/regions`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ regionCodes: ['RIYADH'] })
      .expect(200);
    // Covering a region and pricing it are two distinct acts: routing to a
    // transporter that has set no rate is refused, because the delivery leg is
    // priced by the company that performs it. Written by the TRANSPORT admin —
    // a fuel company may read what its transporter charges but never set it.
    await app
      .get(CompaniesService)
      .setDeliveryRates(String(secondTransporter.body.company._id), [
        { regionCode: RegionCode.RIYADH, pricePerKm: 0, minPrice: 30 },
      ]);

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);

    const approveRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);
    expect(approveRes.body.status).toBe(OrderStatus.AWAITING_ROUTING);
    expect(approveRes.body.routingCandidates).toHaveLength(2);
    const candidateIds = approveRes.body.routingCandidates.map((c: { id: string }) => c.id);
    expect(candidateIds).toEqual(
      expect.arrayContaining([
        fixtures.companyA.transportCompanyId,
        String(secondTransporter.body.company._id),
      ]),
    );

    // Approving again with an explicit choice resolves it.
    const routedRes = await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/route`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ transportCompanyId: String(secondTransporter.body.company._id) })
      .expect(200);
    expect(routedRes.body.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(routedRes.body.transportCompanyId).toBe(String(secondTransporter.body.company._id));

    // Withdraw this test's second transporter so it doesn't leak a lingering
    // RIYADH candidate into later tests' zero-coverage assumptions.
    await request(server)
      .put(`/api/v1/companies/${secondTransporter.body.company._id}/regions`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ regionCodes: [] })
      .expect(200);
  });

  it('rejects routing to a transportCompanyId that does not actually serve the region', async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();

    // Withdraw coverage so the order parks AWAITING_ROUTING.
    await request(server)
      .put(`/api/v1/companies/${fixtures.companyA.transportCompanyId}/regions`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ regionCodes: [] })
      .expect(200);

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100, paymentMethod: 'DEFERRED' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    // companyB's transporter is a different Fuel Company's tenant entirely —
    // never a valid choice for companyA's order, regardless of region.
    await request(server)
      .patch(`/api/v1/orders/${createRes.body._id}/route`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ transportCompanyId: fixtures.companyB.transportCompanyId })
      .expect(400);

    // Restore coverage for subsequent tests' isolation.
    await request(server)
      .put(`/api/v1/companies/${fixtures.companyA.transportCompanyId}/regions`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ regionCodes: ['RIYADH'] })
      .expect(200);
  });
});
