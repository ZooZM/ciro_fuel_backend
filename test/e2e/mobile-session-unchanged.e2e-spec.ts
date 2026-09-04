import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, DEFAULT_PASSWORD } from '../utils/fixtures';
import { RealtimeGatewayService } from '../../src/common/realtime/realtime-gateway.service';

jest.setTimeout(120_000);

/**
 * spec 015 FR-033 / SC-013 / SC-020 — the regression guard for Slice 0. The
 * session model gains per-session identity for ADMIN roles ONLY. DRIVER and
 * CLIENT behaviour must be bit-for-bit unchanged:
 *   - a second sign-in still displaces the first (single session);
 *   - neither role's token carries a `sid` claim;
 *   - `session:revoked` is still emitted and the socket still disconnected
 *     for the displaced device.
 * And the negative: an admin sign-in does NOT emit `session:revoked` and does
 * NOT disconnect the admin's sockets (research R3 — the room is per-user).
 */
describe('Mobile session behaviour unchanged (spec 015 FR-033)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let emitSpy: jest.SpyInstance;
  let disconnectSpy: jest.SpyInstance;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    const realtime = app.get(RealtimeGatewayService);
    emitSpy = jest.spyOn(realtime, 'emitToUser');
    disconnectSpy = jest.spyOn(realtime, 'disconnectUser');
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const server = () => app.getHttpServer();

  function decode(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  }

  async function login(email: string): Promise<{ access: string; refresh: string }> {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: DEFAULT_PASSWORD })
      .expect(201);
    return { access: res.body.accessToken, refresh: res.body.refreshToken };
  }

  beforeEach(() => {
    emitSpy.mockClear();
    disconnectSpy.mockClear();
  });

  it("a DRIVER's second sign-in displaces the first; the token carries no sid; session:revoked is emitted and the socket disconnected", async () => {
    const driverId = fixtures.companyA.driver.id;
    const first = await login(fixtures.companyA.driver.email);
    expect(decode(first.access).sid).toBeUndefined();

    await login(fixtures.companyA.driver.email);

    // Displacement: the first session no longer authorises.
    const refused = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${first.access}`)
      .expect(401);
    expect(refused.body.error).toBe('SESSION_REVOKED');

    // The push and the forced disconnect both still fire for a driver.
    expect(emitSpy).toHaveBeenCalledWith(
      driverId,
      'session:revoked',
      expect.objectContaining({ cause: 'SIGNED_IN_ELSEWHERE' }),
    );
    expect(disconnectSpy).toHaveBeenCalledWith(driverId);
  });

  it("a CLIENT's second sign-in displaces the first; the token carries no sid", async () => {
    const first = await login(fixtures.companyA.client.email);
    expect(decode(first.access).sid).toBeUndefined();

    await login(fixtures.companyA.client.email);

    await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${first.access}`)
      .expect(401);
  });

  it('an ADMIN sign-in neither emits session:revoked nor disconnects the admin sockets (research R3)', async () => {
    const adminId = fixtures.companyA.admin.id;
    await login(fixtures.companyA.admin.email);
    await login(fixtures.companyA.admin.email);
    await login(fixtures.companyA.admin.email);

    expect(emitSpy).not.toHaveBeenCalledWith(adminId, 'session:revoked', expect.anything());
    expect(disconnectSpy).not.toHaveBeenCalledWith(adminId);
  });
});
