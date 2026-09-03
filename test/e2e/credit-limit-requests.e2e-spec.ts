import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T069/FR-029/FR-030/FR-031/SC-006/SC-008 — a
 * station owner's request for a higher credit limit, and the administrator's
 * resolution: exactly once, with the granted amount possibly differing from what was
 * requested, and isolated per fuel company.
 */
describe('Credit limit requests (FR-029, FR-030, FR-031)', () => {
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

  it('raises a request, refuses a second while one is pending, and resolves it at a granted amount different from requested', async () => {
    const server = app.getHttpServer();
    const { client, admin } = fixtures.companyA;

    const created = await request(server)
      .post('/api/v1/users/me/credit-limit-requests')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ requestedAmount: 100000 })
      .expect(201);
    expect(created.body.state).toBe('PENDING');
    expect(created.body.requestedAmount).toBe(100000);

    // FR-029: a second request while one is pending is refused.
    await request(server)
      .post('/api/v1/users/me/credit-limit-requests')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ requestedAmount: 50000 })
      .expect(409);

    // The administrator sees it in their queue.
    const queue = await request(server)
      .get('/api/v1/credit-limit-requests?state=PENDING')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const ids = (queue.body.items as { _id: string }[]).map((r) => r._id);
    expect(ids).toContain(created.body._id);

    // FR-030: accepted at a LOWER amount than requested.
    const resolved = await request(server)
      .patch(`/api/v1/credit-limit-requests/${created.body._id}/resolve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ accept: true, grantedAmount: 75000 })
      .expect(200);
    expect(resolved.body.state).toBe('ACCEPTED');
    expect(resolved.body.grantedAmount).toBe(75000);

    // The granted amount became the client's real limit.
    const credit = await request(server)
      .get('/api/v1/users/me/credit')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(credit.body.creditLimit).toBe(75000);
  });

  it('refuses a second resolution as already resolved (409, SC-008)', async () => {
    const server = app.getHttpServer();
    const { client, admin } = fixtures.companyA;

    const created = await request(server)
      .post('/api/v1/users/me/credit-limit-requests')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ requestedAmount: 20000 })
      .expect(201);

    await request(server)
      .patch(`/api/v1/credit-limit-requests/${created.body._id}/resolve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ accept: false })
      .expect(200);

    await request(server)
      .patch(`/api/v1/credit-limit-requests/${created.body._id}/resolve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ accept: true, grantedAmount: 999 })
      .expect(409);
  });

  it("a second fuel company's queue never contains another company's request (SC-006)", async () => {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/users/me/credit-limit-requests')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ requestedAmount: 30000 })
      .expect(201);

    const otherQueue = await request(server)
      .get('/api/v1/credit-limit-requests')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(200);
    const ids = (otherQueue.body.items as { _id: string }[]).map((r) => r._id);
    expect(ids).not.toContain(created.body._id);

    // And company B's admin cannot resolve it either (404 — isolation, never revealing).
    await request(server)
      .patch(`/api/v1/credit-limit-requests/${created.body._id}/resolve`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .send({ accept: true })
      .expect(404);

    // Clean up: this suite's fixture client is shared across `it` blocks, and FR-029
    // refuses a second request while one is pending — resolve this one so later tests
    // in this file aren't blocked by it.
    await request(server)
      .patch(`/api/v1/credit-limit-requests/${created.body._id}/resolve`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ accept: false })
      .expect(200);
  });

  it('CLIENT and DRIVER cannot resolve a request; only FUEL_COMPANY_ADMIN can', async () => {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/users/me/credit-limit-requests')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ requestedAmount: 15000 })
      .expect(201);

    await request(server)
      .patch(`/api/v1/credit-limit-requests/${created.body._id}/resolve`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ accept: true })
      .expect(403);
    await request(server)
      .patch(`/api/v1/credit-limit-requests/${created.body._id}/resolve`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ accept: true })
      .expect(403);
  });
});
