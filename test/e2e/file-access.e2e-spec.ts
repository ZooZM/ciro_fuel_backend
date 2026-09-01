import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import {
  deriveLocalTokenKey,
  mintLocalToken,
} from '../../src/common/storage/local-storage-token';

jest.setTimeout(120_000);

/**
 * Spec 001 US5 (tenant isolation), extended by spec 012 Story 6.
 *
 * **What this suite does NOT establish** (FR-042d): the redirect it follows is
 * SAME-ORIGIN, to a route this same app serves. It therefore says nothing about
 * bucket CORS, about clock skew between this machine and the object store's
 * signed-expiry check, or about how any particular client behaves on a
 * CROSS-ORIGIN redirect — which is the actual risk (FR-038c: browsers strip
 * `Authorization` on a cross-origin redirect and some mobile clients do not,
 * and a client that forwards it is REFUSED by the object store). CI and the
 * dashboard both pass while a real device fails. That check is
 * operations-contract §7 item 2, and it is the highest-risk item in the
 * feature.
 */
describe('File access isolation (US5)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let companyAFileId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);

    const uploadRes = await request(app.getHttpServer())
      .patch(`/api/v1/users/${fixtures.companyA.client.id}/profile-picture`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
      })
      .expect(200);
    companyAFileId = uploadRes.body.profilePictureFileId;
    expect(companyAFileId).toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('answers the owning company with a 302 to a short-lived location (FR-039, FR-042a)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/files/${companyAFileId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(302);

    // A 302 under EVERY driver, local included. Had the local driver returned
    // bytes, the redirect would have first executed in production — the exact
    // production-only-path defect research R1 found in the bootstrap,
    // reintroduced inside the story meant to be safest.
    expect(res.headers.location).toContain(`/api/v1/files/${companyAFileId}/content`);
    // The Location expires, so a cached redirect fails intermittently minutes
    // later and reads as a storage fault rather than a caching one (FR-042c).
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves the bytes when the redirect is followed, with NO Authorization header', async () => {
    const redirect = await request(app.getHttpServer())
      .get(`/api/v1/files/${companyAFileId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(302);

    // Deliberately no Authorization header on the second request: the token in
    // the URL IS the authorization (FR-042b). An authenticated byte route would
    // depend on the client forwarding the header across a redirect — the very
    // thing clients differ on.
    const bytes = await request(app.getHttpServer()).get(redirect.headers.location).expect(200);
    expect(Buffer.from(bytes.body)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it('returns 404 (never leaking existence) when another company requests the file', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/files/${companyAFileId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(404);
  });

  it('lets SUPER_ADMIN read the file across companies', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/files/${companyAFileId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(302);
  });

  describe('the token-addressed byte route (spec 012 FR-042b)', () => {
    // An UNAUTHENTICATED endpoint that streams tenant documents. Acceptable
    // only because it is scoped to one file, expires, and does not exist in
    // production — so each property is asserted, never assumed.

    it('refuses a request with no token at all', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/files/${companyAFileId}/content`)
        .expect(403);
    });

    it('refuses a forged token', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/files/${companyAFileId}/content?token=${companyAFileId}.9999999999.deadbeef`)
        .expect(403);
    });

    it('refuses a VALID token minted for a DIFFERENT file', async () => {
      // The difference between "scoped" and "looks scoped": the file id is
      // inside the signed payload, so a token cannot be replayed against
      // another document.
      const otherUpload = await request(app.getHttpServer())
        .patch(`/api/v1/users/${fixtures.companyA.admin.id}/profile-picture`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
          filename: 'other.jpg',
          contentType: 'image/jpeg',
        })
        .expect(200);
      const otherFileId = otherUpload.body.profilePictureFileId as string;

      const redirect = await request(app.getHttpServer())
        .get(`/api/v1/files/${otherFileId}`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(302);
      const token = new URL(redirect.headers.location, 'http://x').searchParams.get('token')!;

      await request(app.getHttpServer())
        .get(`/api/v1/files/${companyAFileId}/content?token=${token}`)
        .expect(403);
    });

    it('refuses an expired token', async () => {
      const key = deriveLocalTokenKey(
        process.env.LOCAL_STORAGE_TOKEN_SECRET ?? '',
        process.env.JWT_SECRET!,
      );
      // Minted with a negative TTL rather than by waiting: the expiry is a
      // property of the token, so exercising it does not need real time to pass.
      const expired = mintLocalToken(companyAFileId, key, -60);
      await request(app.getHttpServer())
        .get(`/api/v1/files/${companyAFileId}/content?token=${expired}`)
        .expect(403);
    });
  });

  it('rejects a path-traversal-shaped id before any file lookup ever occurs', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/files/..%2f..%2f..%2fetc%2fpasswd')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`);
    // The id can never resolve to a Mongo ObjectId, so ObjectIdPipe rejects
    // it (400) before any filesystem path is ever constructed from input —
    // ids only ever reach FilesService via a DB-record lookup (R10).
    expect(res.status).toBe(400);
  });

  it('rejects a disallowed file type on upload', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${fixtures.companyA.client.id}/profile-picture`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .attach('file', Buffer.from('#!/bin/sh\necho hi'), {
        filename: 'evil.sh',
        contentType: 'application/x-sh',
      })
      .expect(400);
  });
});
