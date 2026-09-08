import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedThreeFuelCompanies, ThreeFuelCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 016 (broadcast fuel exchange offers) T087/FR-025/FR-026/FR-027/FR-028/SC-008 —
 * the destination detail the approved design asks for: city, district, a location link
 * and notes, round-tripped exactly and rendered as literal text, never markup.
 */
describe('Exchange offer destination fields (US5)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: ThreeFuelCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedThreeFuelCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  function raiseBody(overrides: Record<string, unknown> = {}) {
    return {
      fuelType: 'PETROL_95',
      quantityLitres: 10000,
      deliveryAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      city: 'JEDDAH',
      ...overrides,
    };
  }

  it('round-trips district, locationUrl and notes exactly as entered, to every recipient (FR-026)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(
        raiseBody({
          district: 'Al Rawdah',
          locationUrl: 'https://maps.example.com/warehouse-3',
          notes: 'Loading bay 3, ask for the shift supervisor',
        }),
      )
      .expect(201);
    const id = created.body._id as string;
    expect(created.body.district).toBe('Al Rawdah');
    expect(created.body.locationUrl).toBe('https://maps.example.com/warehouse-3');
    expect(created.body.notes).toBe('Loading bay 3, ask for the shift supervisor');

    const detailForB = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${id}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(detailForB.body.district).toBe('Al Rawdah');
    expect(detailForB.body.locationUrl).toBe('https://maps.example.com/warehouse-3');
    expect(detailForB.body.notes).toBe('Loading bay 3, ask for the shift supervisor');
    expect(detailForB.body.city).toBe('JEDDAH');
  });

  it('refuses a non-http(s) locationUrl at the API — a javascript: scheme never reaches storage (FR-028)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody({ locationUrl: 'javascript:alert(1)' }))
      .expect(400);
  });

  it('stores and returns markup-looking notes literally, never interpreted (FR-027, SC-008)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;
    const markupLike = '<script>alert(1)</script> & "quoted" <b>bold</b>';

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody({ notes: markupLike }))
      .expect(201);
    expect(created.body.notes).toBe(markupLike);

    const detailForB = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${created.body._id}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(detailForB.body.notes).toBe(markupLike);
  });

  it('district, locationUrl and notes are all optional', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    expect(created.body.district).toBeUndefined();
    expect(created.body.locationUrl).toBeUndefined();
    expect(created.body.notes).toBeUndefined();
  });
});
