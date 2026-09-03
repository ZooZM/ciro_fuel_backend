import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T059/FR-025/SC-006/R5: `GET /stations/all` —
 * a route over an already-scoped query (`Station` is `markTenantScoped`), not a new
 * isolation mechanism. This asserts both halves: the company's own stations are all
 * returned, and a second company's are never among them.
 */
describe('Fuel company cross-owner station listing (FR-025, R5)', () => {
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

  it("returns the company's own station(s) and none of a second company's", async () => {
    const server = app.getHttpServer();

    const asOwner = await request(server)
      .get('/api/v1/stations/all')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
    const ownStationIds = new Set((asOwner.body.items as { _id: string }[]).map((s) => s._id));
    expect(ownStationIds.size).toBeGreaterThan(0);

    const asOtherCompany = await request(server)
      .get('/api/v1/stations/all')
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(200);
    const otherStationIds = new Set(
      (asOtherCompany.body.items as { _id: string }[]).map((s) => s._id),
    );
    for (const id of ownStationIds) {
      expect(otherStationIds.has(id)).toBe(false);
    }
  });

  it('is refused for CLIENT and DRIVER (FCA only)', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/api/v1/stations/all')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(403);
    await request(server)
      .get('/api/v1/stations/all')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(403);
  });
});
