import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, DEFAULT_PASSWORD } from '../utils/fixtures';

jest.setTimeout(120_000);

function connectSocket(url: string, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${url}/tracking`, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * spec 006 US5 (T078/T079) — a driver holds at most one live session
 * (FR-042), and every way it can end mid-use (displacement, deactivation)
 * must reach the device immediately (FR-035/036) with a distinguishable
 * `cause`, and refuse it if it was never told (FR-035a).
 */
describe('Session revocation (spec 006 US5)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    openSockets.forEach((s) => s.disconnect());
    await ctx.close();
  }, 30_000);

  it('signing in on a second device ends the session on the first, with cause SIGNED_IN_ELSEWHERE (FR-042)', async () => {
    const server = app.getHttpServer();
    const first = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);

    // The first token works right up until the second sign-in.
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .expect(200);

    const second = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);

    const staleAttempt = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .expect(401);
    expect(staleAttempt.body.error).toBe('SESSION_REVOKED');
    expect(staleAttempt.body.cause).toBe('SIGNED_IN_ELSEWHERE');

    // The new session is unaffected.
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .expect(200);
  });

  it(
    'deactivation pushes session:revoked over the live socket within 5 seconds (SC-008) and ' +
      'refuses the HTTP session with cause ACCOUNT_DEACTIVATED',
    async () => {
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: fixtures.companyB.driver.email, password: DEFAULT_PASSWORD })
        .expect(201);

      const socket = await connectSocket(ctx.url, login.body.accessToken);
      openSockets.push(socket);
      const revokedEvent = waitForEvent<{ cause: string }>(socket, 'session:revoked');

      const deactivateStartedAt = Date.now();
      await request(server)
        .patch(`/api/v1/users/${fixtures.companyB.driver.id}/deactivate`)
        .set('Authorization', `Bearer ${fixtures.companyB.transportAdmin.token}`)
        .send({})
        .expect(200);

      const payload = await revokedEvent;
      const elapsedMs = Date.now() - deactivateStartedAt;
      expect(payload).not.toBeNull();
      expect(payload?.cause).toBe('ACCOUNT_DEACTIVATED');
      expect(elapsedMs).toBeLessThan(5000);

      const staleAttempt = await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(401);
      expect(staleAttempt.body.error).toBe('SESSION_REVOKED');
      expect(staleAttempt.body.cause).toBe('ACCOUNT_DEACTIVATED');

      // Restore fixture state (companyB.driver is shared across tests in
      // this suite run) so later tests aren't affected by the deactivation.
      const { getModelToken } = await import('@nestjs/mongoose');
      const { User } = await import('../../src/modules/users/schemas/user.schema');
      const userModel = app.get(getModelToken(User.name));
      await userModel.updateOne({ _id: fixtures.companyB.driver.id }, { $set: { isActive: true } });
    },
  );

  it('a socket reconnecting on a revoked session is rejected at the handshake (FR-035a fallback)', async () => {
    const server = app.getHttpServer();
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);

    // Displace it (any revocation exercises the same handshake check).
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);

    await expect(connectSocket(ctx.url, login.body.accessToken)).rejects.toBeDefined();
  });

  it('a deactivated driver signing in is refused with the same body a wrong password gets (FR-037)', async () => {
    const server = app.getHttpServer();
    const { getModelToken } = await import('@nestjs/mongoose');
    const { User } = await import('../../src/modules/users/schemas/user.schema');
    const userModel = app.get(getModelToken(User.name));

    const wrongPassword = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: 'WrongPassword1!' })
      .expect(401);

    await userModel.updateOne({ _id: fixtures.companyA.driver.id }, { $set: { isActive: false } });
    const deactivated = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(401);

    expect(deactivated.body).toEqual(wrongPassword.body);

    await userModel.updateOne({ _id: fixtures.companyA.driver.id }, { $set: { isActive: true } });
  });

  /**
   * spec 013 FR-090/Edge Cases: "refused, with the reason stated rather than an empty
   * dashboard." Mirrors the deactivation test above exactly, but for company-level
   * suspension — and additionally asserts the login boundary stays generic, the same
   * property the account-deactivation test above already proves for that case.
   */
  it('suspending a fuel company refuses its administrator with cause COMPANY_SUSPENDED — on a live session, never at login', async () => {
    const server = app.getHttpServer();
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.admin.email, password: DEFAULT_PASSWORD })
      .expect(201);

    // Live session works before suspension.
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);

    await request(server)
      .patch(`/api/v1/companies/${fixtures.companyA.companyId}/status`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ status: 'SUSPENDED' })
      .expect(200);

    // The live session immediately reveals the specific reason.
    const staleAttempt = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(401);
    expect(staleAttempt.body.error).toBe('SESSION_REVOKED');
    expect(staleAttempt.body.cause).toBe('COMPANY_SUSPENDED');

    // A FRESH login attempt (no live session yet) stays generic — distinguishing
    // "company suspended" from "wrong password" at the raw login boundary would hand a
    // password-guessing attacker an oracle for exactly the case anti-enumeration exists
    // to deny (see SessionRevocationCause.COMPANY_SUSPENDED's own comment).
    const wrongPassword = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.admin.email, password: 'WrongPassword1!' })
      .expect(401);
    const suspendedLoginAttempt = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.admin.email, password: DEFAULT_PASSWORD })
      .expect(401);
    expect(suspendedLoginAttempt.body).toEqual(wrongPassword.body);

    // Restore fixture state — companyA is shared across the whole suite run.
    await request(server)
      .patch(`/api/v1/companies/${fixtures.companyA.companyId}/status`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
  });
});
