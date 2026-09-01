import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, DEFAULT_PASSWORD } from '../utils/fixtures';
import {
  SessionEvent,
  SessionEventDocument,
} from '../../src/modules/sessions/schemas/session-event.schema';

jest.setTimeout(120_000);

/**
 * spec 006 US4 (T068): before this feature, a refresh token survived its
 * owner signing out — the server had no way to tell "this device chose to
 * leave" from "this token is still live". `POST /auth/logout` is the whole
 * point of the story: it must end the session server-side, not just clear
 * it locally.
 */
describe('POST /auth/logout — server-side session end (spec 006 FR-029)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let sessionEventModel: Model<SessionEventDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    sessionEventModel = app.get(getModelToken(SessionEvent.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('a refresh token captured before logout is refused afterwards, and the prior access token stops working too', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyB.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);
    const { accessToken, refreshToken } = loginRes.body;

    // Works before logout.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    // Refused afterwards — this is the entire point of the story. No
    // `cause` is expected: sign-out is the driver's own action, not one of
    // the three revocation causes the app has copy for.
    const refreshAfter = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    expect(refreshAfter.body.error).toBe('SESSION_REVOKED');
    expect(refreshAfter.body.cause).toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  it('writes a SIGNED_OUT audit row', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixtures.companyA.driver.email, password: DEFAULT_PASSWORD })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .expect(204);

    const rows = await sessionEventModel
      .find({ userId: new Types.ObjectId(fixtures.companyA.driver.id) })
      .exec();
    expect(rows.some((r) => r.type === 'SIGNED_OUT')).toBe(true);
  });
});
