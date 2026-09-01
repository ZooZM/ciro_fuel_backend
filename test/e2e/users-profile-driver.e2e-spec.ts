import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 006 FR-001/002/003 — corrected during implementation to target
 * `GET /users/:id`, not `/auth/me` (research R6): `AuthUser`, the type
 * `/auth/me` populates, carries no email/phone/photo at all, so it cannot
 * be the driver identity source FR-001 needs. `GET /users/:id` is what
 * `ProfileRemoteDataSource.getProfile` already calls.
 */
describe('GET /users/:id — driver profile identity (spec 006 FR-001/002/003)', () => {
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

  it("adds companyName to a driver's own profile fetch", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/users/${fixtures.companyA.driver.id}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    // A driver's `companyId` is their Transportation Company (spec 004) —
    // fixtures.ts names it `${name} Transport`.
    expect(res.body.companyName).toBe('CompanyA Transport');
  });

  // spec 008 (research R12/FR-043): the embedded `User.truck` this test
  // used to guard as "present today" is deleted outright, not migrated —
  // a driver's vehicle is now a real Truck/Tank pair assigned per order,
  // never a field on their own profile.
  it('never returns an embedded truck field (deleted by spec 008’s cutover)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/users/${fixtures.companyA.driver.id}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    expect(res.body.truck).toBeUndefined();
  });

  it("does not add companyName to a CLIENT's own profile fetch", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/users/${fixtures.companyA.client.id}`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .expect(200);

    expect(res.body.companyName).toBeUndefined();
  });

  it('leaves every existing field on the response untouched (fullName, email, phone, isActive)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/users/${fixtures.companyA.driver.id}`)
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .expect(200);

    expect(res.body).toMatchObject({
      _id: fixtures.companyA.driver.id,
      email: fixtures.companyA.driver.email,
      isActive: true,
    });
    expect(typeof res.body.fullName).toBe('string');
    expect(typeof res.body.phone).toBe('string');
  });
});
