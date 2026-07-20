import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

describe('Tenant data isolation (US2) — company A vs company B', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let orderAId: string;
  let orderBId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    const server = app.getHttpServer();

    const createA = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    orderAId = createA.body._id;

    const createB = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyB.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 100 })
      .expect(201);
    orderBId = createB.body._id;
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('never leaks company B orders into company A admin listings', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    const ids = res.body.map((o: { _id: string }) => o._id);
    expect(ids).toContain(orderAId);
    expect(ids).not.toContain(orderBId);
  });

  it('returns 404 (never 403) when company A admin fetches company B order by id directly', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);
  });

  it('returns 404 when company A admin attempts to approve a company B order', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(404);
  });

  it('returns 404 when company A admin attempts to reject a company B order', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/reject`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ reason: 'not mine to reject' })
      .expect(404);
  });

  it('returns 404 when company A admin attempts to cancel a company B order', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/cancel`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({})
      .expect(404);
  });

  it('returns 404 when company A admin attempts to manually dispatch a company B order', async () => {
    // First approve within company B so the order is a valid dispatch target for someone.
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/approve`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({})
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/dispatch/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);
  });

  it('company A client cannot see or act on company B client’s order', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderBId}/cancel`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({})
      .expect(404);
  });

  it('company A driver cannot see company B’s order or fake-arrive on it', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderBId}/arrive`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(404);
  });

  it('SUPER_ADMIN can read across both companies', async () => {
    const resA = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderAId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(resA.body._id).toBe(orderAId);

    const resB = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(resB.body._id).toBe(orderBId);
  });

  it('company A admin cannot mark company B’s notifications as read', async () => {
    const server = app.getHttpServer();
    // Approving generates an ORDER_APPROVED_FINAL_PRICE notification for the B client.
    const bNotifications = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${fixtures.companyB.client.token}`)
      .expect(200);
    expect(bNotifications.body.length).toBeGreaterThan(0);
    const notificationId = bNotifications.body[0]._id;

    await request(server)
      .patch(`/api/v1/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(404);
  });
});
