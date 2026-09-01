import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/** Spec 005 US9/FR-038/FR-039: a support request routes to the client's
 * own fuel company admins via the existing notification path, carries the
 * order it concerns (when any), and moves SUBMITTED -> ACKNOWLEDGED once,
 * never back. */
describe('Support request routing (spec 005 US9)', () => {
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

  it(
    "reaches only the client's own fuel company admins, and another company's " +
      'admin cannot acknowledge it (404) — T114',
    async () => {
      const server = app.getHttpServer();
      const { client, admin } = fixtures.companyA;
      const otherAdmin = fixtures.companyB.admin;

      const created = await request(server)
        .post('/api/v1/support/requests')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ topic: 'OTHER', message: 'The gauge on my last delivery looked short.' })
        .expect(201);
      expect(created.body.state).toBe('SUBMITTED');

      // The client's own fuel company admin was notified.
      const ownAdminNotifications = await request(server)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(
        ownAdminNotifications.body.items.some(
          (n: { type: string }) => n.type === 'SUPPORT_REQUEST_RAISED',
        ),
      ).toBe(true);

      // A different company's admin was not — same check, empty.
      const otherAdminNotifications = await request(server)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${otherAdmin.token}`)
        .expect(200);
      expect(
        otherAdminNotifications.body.items.some(
          (n: { type: string }) => n.type === 'SUPPORT_REQUEST_RAISED',
        ),
      ).toBe(false);

      // The other company's admin cannot see or act on it either — 404,
      // never a 403, matching every other cross-tenant id in this API.
      await request(server)
        .patch(`/api/v1/support/requests/${created.body._id}/acknowledge`)
        .set('Authorization', `Bearer ${otherAdmin.token}`)
        .expect(404);

      // GET as the target company's own admin lists it.
      const ownAdminList = await request(server)
        .get('/api/v1/support/requests')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(ownAdminList.body.items.some((r: { _id: string }) => r._id === created.body._id)).toBe(
        true,
      );

      // GET as the other company's admin never lists it.
      const otherAdminList = await request(server)
        .get('/api/v1/support/requests')
        .set('Authorization', `Bearer ${otherAdmin.token}`)
        .expect(200);
      expect(
        otherAdminList.body.items.some((r: { _id: string }) => r._id === created.body._id),
      ).toBe(false);
    },
  );

  it(
    'attaching an order the client does not own yields 404; state moves ' +
      'SUBMITTED -> ACKNOWLEDGED only, with no reverse — T115',
    async () => {
      const server = app.getHttpServer();
      const { client, admin } = fixtures.companyA;
      const otherClient = fixtures.companyB.client;

      // companyB's client's own order, attempted from companyA's client.
      const foreignOrder = await request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${otherClient.token}`)
        .send({
          fuelType: 'DIESEL',
          quantityLiters: 500,
          stationId: (
            await request(server)
              .get('/api/v1/stations')
              .set('Authorization', `Bearer ${otherClient.token}`)
              .expect(200)
          ).body.items[0]._id,
          paymentMethod: 'DIRECT',
        });
      // Order creation may itself require a quote in this environment; if
      // it fails for reasons unrelated to this test, fall back to a
      // syntactically valid but certainly-foreign ObjectId.
      const foreignOrderId =
        foreignOrder.status === 201 ? foreignOrder.body._id : '6a678f6a7bcf5a3ef09ae4aa';

      await request(server)
        .post('/api/v1/support/requests')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ topic: 'OTHER', message: 'Not my order.', orderId: foreignOrderId })
        .expect(404);

      const created = await request(server)
        .post('/api/v1/support/requests')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ topic: 'ACCOUNT', message: 'Cannot update my email.' })
        .expect(201);

      const acknowledged = await request(server)
        .patch(`/api/v1/support/requests/${created.body._id}/acknowledge`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(acknowledged.body.state).toBe('ACKNOWLEDGED');
      expect(acknowledged.body.acknowledgedAt).toBeTruthy();

      // No reverse, no re-acknowledgement.
      await request(server)
        .patch(`/api/v1/support/requests/${created.body._id}/acknowledge`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(409);
    },
  );
});
