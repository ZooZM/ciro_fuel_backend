import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

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

  it('lets the owning company read the file', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/files/${companyAFileId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(200);
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
      .expect(200);
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
