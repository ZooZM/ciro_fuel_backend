import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, uniquePhone } from '../utils/fixtures';

jest.setTimeout(120_000);

/** Spec 004 User Story 3: a client's station is captured as region →
 * governorate → pin → editable address text, created by the Fuel Company
 * only (FR-004a). No `GOOGLE_MAPS_API_KEY` is set in the test environment
 * (test-app.factory.ts), so every geocoding call here genuinely exercises
 * the "lookup unavailable" path (FR-013) rather than mocking it away. */
describe('Client station registration (spec 004 US3)', () => {
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

  it('creates a client with station data, and the stored addressText is exactly what was submitted (never re-derived)', async () => {
    const server = app.getHttpServer();

    const res = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        role: 'CLIENT',
        email: `station-client-${Date.now()}@stationtest.test`,
        password: 'Password123!',
        fullName: 'Station Client',
        phone: uniquePhone(),
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
          addressText: 'طريق الملك فهد، حي العليا — edited by admin',
          name: 'محطة الاختبار',
        },
      })
      .expect(201);

    expect(res.body.station.regionCode).toBe('RIYADH');
    expect(res.body.station.governorateCode).toBe('RIYADH_CITY');
    expect(res.body.station.addressText).toBe('طريق الملك فهد، حي العليا — edited by admin');
    expect(res.body.station.name).toBe('محطة الاختبار');
    expect(res.body.station.location.coordinates).toEqual([46.6753, 24.7136]);

    // The client's own /auth/me exposes it too (T044).
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ phone: res.body.phone, password: 'Password123!' })
      .expect(201);
    const me = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(me.body.station.addressText).toBe('طريق الملك فهد، حي العليا — edited by admin');
  });

  it('creation succeeds with no addressText at all — a failed/unavailable lookup never blocks registration (FR-013)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        role: 'CLIENT',
        email: `no-address-${Date.now()}@stationtest.test`,
        password: 'Password123!',
        fullName: 'No Address Client',
        phone: uniquePhone(),
        station: {
          regionCode: 'MAKKAH',
          governorateCode: 'JEDDAH',
          location: { longitude: 39.1925, latitude: 21.4858 },
          // addressText omitted entirely.
        },
      })
      .expect(201);

    expect(res.body.station.addressText).toBe('');
  });

  it('the reverse-geocode lookup itself is genuinely unavailable in this environment and fails soft, not with an error response', async () => {
    // No GOOGLE_MAPS_API_KEY is set for e2e — this proves the failure path
    // end-to-end through the real endpoint, not just GeocodingService in
    // isolation (already covered by test/unit/geocoding.service.spec.ts).
    const res = await request(app.getHttpServer())
      .post('/api/v1/geocoding/reverse')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ latitude: 24.7136, longitude: 46.6753 })
      .expect(201);

    expect(res.body).toEqual({ addressText: '' });
  });

  it('rejects a governorate that does not belong to the given region', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        role: 'CLIENT',
        email: `mismatched-${Date.now()}@stationtest.test`,
        password: 'Password123!',
        fullName: 'Mismatched Client',
        phone: uniquePhone(),
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'JEDDAH', // belongs to MAKKAH, not RIYADH
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(400);
  });

  it('rejects an unknown region or governorate code', async () => {
    const server = app.getHttpServer();
    const base = {
      role: 'CLIENT',
      password: 'Password123!',
      fullName: 'Bad Code Client',
    };

    await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        ...base,
        email: `bad-region-${Date.now()}@stationtest.test`,
        phone: uniquePhone(),
        station: {
          regionCode: 'ATLANTIS',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(400);

    await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        ...base,
        email: `bad-governorate-${Date.now()}@stationtest.test`,
        phone: uniquePhone(),
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'ATLANTIS_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(400);
  });

  // --- T043: only the Fuel Company creates clients (spec 004 FR-004a) -----

  it('a Transportation Company admin cannot create a client', async () => {
    const server = app.getHttpServer();

    const transporter = await request(server)
      .post(`/api/v1/companies/${fixtures.companyA.companyId}/transporters`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({
        name: `Station Test Transporter ${Date.now()}`,
        contactEmail: `contact-${Date.now()}@stationtransporter.test`,
        contactPhone: '+966500000001',
        adminEmail: `admin-${Date.now()}@stationtransporter.test`,
        adminFullName: 'Station Transporter Admin',
        adminPhone: '+966500000002',
        adminPassword: 'Password123!',
      })
      .expect(201);

    const transportLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: transporter.body.admin.email, password: 'Password123!' })
      .expect(201);

    await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${transportLogin.body.accessToken}`)
      .send({
        role: 'CLIENT',
        email: `should-not-exist-${Date.now()}@stationtest.test`,
        password: 'Password123!',
        fullName: 'Should Not Exist',
        phone: uniquePhone(),
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(403);
  });

  it('CLIENT and DRIVER cannot create a client either', async () => {
    const server = app.getHttpServer();
    const payload = {
      role: 'CLIENT',
      password: 'Password123!',
      fullName: 'Should Not Exist Either',
      station: {
        regionCode: 'RIYADH',
        governorateCode: 'RIYADH_CITY',
        location: { longitude: 46.6753, latitude: 24.7136 },
      },
    };

    await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .send({ ...payload, email: `x1-${Date.now()}@stationtest.test`, phone: uniquePhone() })
      .expect(403);

    await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${fixtures.companyA.driver.token}`)
      .send({ ...payload, email: `x2-${Date.now()}@stationtest.test`, phone: uniquePhone() })
      .expect(403);
  });

  // --- spec 005 US8: station write-side (T104-T106) ------------------------

  /** A second CLIENT under companyA — the same fuel company as
   * `fixtures.companyA.client` but a distinct account, needed to prove
   * cross-client isolation isn't just cross-*company* isolation (T105). */
  async function createSecondClient(): Promise<{ id: string; token: string }> {
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const email = `station-sibling-${Date.now()}-${Math.random()}@stationtest.test`;

    const created = await request(server)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        role: 'CLIENT',
        email,
        password: 'Password123!',
        fullName: 'Sibling Client',
        phone: uniquePhone(),
        station: {
          regionCode: 'RIYADH',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.6753, latitude: 24.7136 },
        },
      })
      .expect(201);

    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(201);

    return { id: created.body._id, token: login.body.accessToken };
  }

  async function ownStationId(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get('/api/v1/stations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body.items[0]._id ?? res.body.items[0].id;
  }

  it(
    'a CLIENT has no create/rename/delete route for stations (FR-036b), and the favourite ' +
      'route rejects any other field (T104)',
    async () => {
      const server = app.getHttpServer();
      const { client } = fixtures.companyA;
      const stationId = await ownStationId(client.token);

      // No CLIENT-reachable create route exists at all — POST /stations isn't
      // even registered (404), distinct from a role check (403).
      await request(server)
        .post('/api/v1/stations')
        .set('Authorization', `Bearer ${client.token}`)
        .send({ name: 'New Station' })
        .expect(404);

      // The FUEL_COMPANY_ADMIN-only rename/delete routes exist but refuse a
      // CLIENT caller.
      await request(server)
        .patch(`/api/v1/stations/${stationId}`)
        .set('Authorization', `Bearer ${client.token}`)
        .send({ name: 'Renamed' })
        .expect(403);
      await request(server)
        .delete(`/api/v1/stations/${stationId}`)
        .set('Authorization', `Bearer ${client.token}`)
        .expect(403);

      // The one CLIENT-writable field is isFavourite alone — anything else on
      // that same route is a 400, not a silently-ignored extra field.
      await request(server)
        .patch(`/api/v1/stations/${stationId}/favourite`)
        .set('Authorization', `Bearer ${client.token}`)
        .send({ isFavourite: true, name: 'Sneaky Rename' })
        .expect(400);

      const ok = await request(server)
        .patch(`/api/v1/stations/${stationId}/favourite`)
        .set('Authorization', `Bearer ${client.token}`)
        .send({ isFavourite: true })
        .expect(200);
      expect(ok.body.isFavourite).toBe(true);
    },
  );

  it(
    "a CLIENT cannot read or favourite another client's station, including one in " +
      'their own fuel company (T105)',
    async () => {
      const server = app.getHttpServer();
      const { client: ownerClient } = fixtures.companyA;
      const sibling = await createSecondClient();
      const ownerStationId = await ownStationId(ownerClient.token);

      // GET /stations is self-scoped — the sibling never sees the owner's
      // station in their own list.
      const siblingList = await request(server)
        .get('/api/v1/stations')
        .set('Authorization', `Bearer ${sibling.token}`)
        .expect(200);
      expect(
        siblingList.body.items.some(
          (s: { _id?: string; id?: string }) => (s._id ?? s.id) === ownerStationId,
        ),
      ).toBe(false);

      // Attempting to favourite it directly by id is a 404 (never a 403 —
      // cross-boundary ids don't reveal existence, contract convention),
      // whether the target belongs to a different client in the SAME company
      // or (via companyB.client below) a different company entirely.
      await request(server)
        .patch(`/api/v1/stations/${ownerStationId}/favourite`)
        .set('Authorization', `Bearer ${sibling.token}`)
        .send({ isFavourite: true })
        .expect(404);

      await request(server)
        .patch(`/api/v1/stations/${ownerStationId}/favourite`)
        .set('Authorization', `Bearer ${fixtures.companyB.client.token}`)
        .send({ isFavourite: true })
        .expect(404);
    },
  );

  it(
    'deleting the last active station yields 409 LAST_STATION; deleting the default ' +
      'promotes the next (T106)',
    async () => {
      const server = app.getHttpServer();
      const { admin } = fixtures.companyA;
      const client = await createSecondClient();
      const firstStationId = await ownStationId(client.token);

      // A single-station client cannot be reduced to zero.
      const refused = await request(server)
        .delete(`/api/v1/stations/${firstStationId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(409);
      expect(refused.body.error).toBe('LAST_STATION');

      // A second station via the admin route promotes nothing yet — the
      // first remains default.
      const secondStation = await request(server)
        .post(`/api/v1/users/${client.id}/stations`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          regionCode: 'RIYADH',
          governorateCode: 'RIYADH_CITY',
          location: { longitude: 46.7, latitude: 24.8 },
        })
        .expect(201);
      expect(secondStation.body.isDefault).toBe(false);

      // Removing the default (first) station now succeeds and promotes the
      // second to default.
      await request(server)
        .delete(`/api/v1/stations/${firstStationId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(204);

      const remaining = await request(server)
        .get('/api/v1/stations')
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);
      expect(remaining.body.items).toHaveLength(1);
      expect(remaining.body.items[0].isDefault).toBe(true);
      expect(remaining.body.items[0]._id ?? remaining.body.items[0].id).toBe(
        secondStation.body._id ?? secondStation.body.id,
      );
    },
  );

  it('FUEL_COMPANY_ADMIN can list and create stations for a client via /users/:id/stations (T108)', async () => {
    const server = app.getHttpServer();
    const { admin } = fixtures.companyA;
    const client = await createSecondClient();

    const list = await request(server)
      .get(`/api/v1/users/${client.id}/stations`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);

    const created = await request(server)
      .post(`/api/v1/users/${client.id}/stations`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'محطة جديدة',
        regionCode: 'MAKKAH',
        governorateCode: 'JEDDAH',
        location: { longitude: 39.19, latitude: 21.49 },
        addressText: 'جدة',
      })
      .expect(201);
    expect(created.body.name).toBe('محطة جديدة');
    expect(created.body.isDefault).toBe(false);

    const updated = await request(server)
      .patch(`/api/v1/stations/${created.body._id ?? created.body.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ addressText: 'جدة - عنوان محدث' })
      .expect(200);
    expect(updated.body.addressText).toBe('جدة - عنوان محدث');
  });
});
