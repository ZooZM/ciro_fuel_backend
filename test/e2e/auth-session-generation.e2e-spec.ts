import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { User, UserDocument } from '../../src/modules/users/schemas/user.schema';

jest.setTimeout(120_000);

/**
 * Phase 0 of spec 006's plan (research R1): `sessionGeneration` is the
 * choke point every revocation feature in this spec relies on. Two
 * properties must both hold before anything built on top of it is safe:
 *
 *  1. It must NOT drop a session that predates the feature (deploy safety
 *     — this is the test that guards the actual production rollout).
 *  2. It must actually revoke once bumped (otherwise every later feature
 *     — sign-out, password reset, deactivation, displacement — silently
 *     does nothing).
 */
describe('Session generation — revocation choke point (spec 006 research R1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let userModel: Model<UserDocument>;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    userModel = app.get(getModelToken(User.name));
    jwtService = app.get(JwtService);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('authenticates a token minted before this feature (no sgen) against a user document with no sessionGeneration field', async () => {
    const driverId = fixtures.companyA.driver.id;

    // Simulate the pre-migration state: a real document from before this
    // field existed. The schema default only applies to NEW documents, so
    // this $unset is the only way to reproduce what's actually in
    // production today.
    await userModel.updateOne({ _id: driverId }, { $unset: { sessionGeneration: 1 } }).exec();

    // Simulate a token minted before this feature: no `sgen` claim at all.
    // Signed with the same secret/expiry the app itself uses (test-app.factory
    // sets JWT_SECRET for the whole suite).
    const legacyToken = jwtService.sign(
      { sub: driverId, role: 'DRIVER', companyId: fixtures.companyA.transportCompanyId },
      { secret: 'test-jwt-secret-0123456789abcdef', expiresIn: '15m' },
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${legacyToken}`)
      .expect(200);

    expect(res.body.id).toBe(driverId);
  });

  it('refuses a token whose session generation no longer matches the user document (the check actually revokes)', async () => {
    const driverId = fixtures.companyA.driver.id;
    const freshToken = fixtures.companyA.driver.token;

    // The previous test in this file `$unset` this same driver's
    // `sessionGeneration` entirely to simulate a pre-migration document —
    // restore it to whatever `freshToken` (captured once, at seed time)
    // actually carries before asserting it still works. Spec 006 US5 makes
    // every login bump the generation (displacement), so that is no
    // longer necessarily 0.
    const { sgen } = jwtService.decode(freshToken) as { sgen?: number };
    await userModel.updateOne({ _id: driverId }, { $set: { sessionGeneration: sgen ?? 0 } }).exec();

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${freshToken}`)
      .expect(200);

    // Simulate a revocation event (sign-out / reset / deactivation /
    // displacement all do this same $inc, per research R1).
    await userModel.updateOne({ _id: driverId }, { $inc: { sessionGeneration: 1 } }).exec();

    // The same token — now stale — must be refused.
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${freshToken}`)
      .expect(401);
  });
});
