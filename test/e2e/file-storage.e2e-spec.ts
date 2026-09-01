import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { FileStorage } from '../../src/common/storage/file-storage.port';
import { FilesService } from '../../src/modules/files/files.service';
import { FilePurpose } from '../../src/modules/files/schemas/file.schema';
import { getModelToken } from '@nestjs/mongoose';
import { FileRecord } from '../../src/modules/files/schemas/file.schema';
import type { Model } from 'mongoose';

jest.setTimeout(180_000);

/**
 * Spec 012 Story 6 (FR-036 – FR-042e) — the properties that are ABOUT the
 * storage seam rather than about access control (which `file-access` covers).
 */
describe('Durable document storage (spec 012 US6)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let fileId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);

    const upload = await request(app.getHttpServer())
      .patch(`/api/v1/users/${fixtures.companyA.client.id}/profile-picture`)
      .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
      })
      .expect(200);
    fileId = upload.body.profilePictureFileId as string;
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 60_000);

  describe('the upload response is frozen (FR-038)', () => {
    it('still carries storagePath, with its name and type unchanged', async () => {
      const record = await app
        .get<Model<FileRecord>>(getModelToken(FileRecord.name))
        .findById(fileId)
        .exec();

      expect(typeof record!.storagePath).toBe('string');
      // Only the CONTENT changed — an object key rather than an absolute
      // filesystem path. Renaming it to `objectKey` would read better and would
      // break the payload freeze, so it keeps the name it has.
      expect(record!.storagePath.startsWith('/')).toBe(false);
      expect(record!.storagePath).toContain('sys_storge/');
      expect(record!.storagePath).toContain(fixtures.companyA.companyId);
    });
  });

  describe('any instance can serve any document (FR-037, SC-011)', () => {
    it('a SECOND app instance serves a file the first one received', async () => {
      // The point of the story: documents outlive the machine that received
      // them. A second app is booted against the SAME database and the same
      // storage root — which is what two replicas behind nginx are — and asked
      // for a file it never handled.
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../../src/app.module')).AppModule],
      }).compile();
      const second = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
      const { configureApp } = await import('../../src/bootstrap/configure-app');
      configureApp(second, { registerSignalHandlers: false });
      await second.init();

      try {
        const redirect = await request(second.getHttpServer())
          .get(`/api/v1/files/${fileId}`)
          .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
          .expect(302);

        const bytes = await request(second.getHttpServer())
          .get(redirect.headers.location)
          .expect(200);
        expect(Buffer.from(bytes.body)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      } finally {
        await second.close();
      }
    }, 120_000);
  });

  describe('a failed write leaves no record (FR-041)', () => {
    it('persists no FileRecord when the storage write throws', async () => {
      const filesService = app.get(FilesService);
      const storage = app.get(FileStorage);
      const model = app.get<Model<FileRecord>>(getModelToken(FileRecord.name));

      const before = await model.countDocuments({}).exec();
      const put = jest
        .spyOn(storage, 'put')
        .mockRejectedValueOnce(new Error('object store unavailable'));

      await expect(
        filesService.store({
          companyId: fixtures.companyA.companyId,
          purpose: FilePurpose.COMMERCIAL_REGISTER,
          buffer: Buffer.from('doomed'),
          mimeType: 'application/pdf',
          originalName: 'doomed.pdf',
        }),
      ).rejects.toThrow();

      // Order is the requirement: bytes first, record second. A record pointing
      // at an object that does not exist is WORSE than a failed upload — it
      // fails later, to a different person, and looks like corruption.
      expect(await model.countDocuments({}).exec()).toBe(before);
      put.mockRestore();
    });
  });

  describe('the local byte route is absent under the GCS driver (FR-042b)', () => {
    it('is not registered when STORAGE_DRIVER=gcs', async () => {
      // "Absent from production" is one of the three properties that make an
      // unauthenticated document-streaming endpoint acceptable, so it is
      // asserted rather than assumed. The controller is chosen at module-
      // definition time from STORAGE_DRIVER, so this reboots the module graph
      // with the variable flipped and confirms the route is not merely refused
      // but not there.
      jest.resetModules();
      const previous = process.env.STORAGE_DRIVER;
      process.env.STORAGE_DRIVER = 'gcs';
      process.env.GCS_BUCKET = 'test-bucket-not-contacted';
      try {
        const { FilesModule } = await import('../../src/modules/files/files.module');
        const controllers = Reflect.getMetadata('controllers', FilesModule) as unknown[];
        expect(controllers).toHaveLength(1);
        expect((controllers[0] as { name: string }).name).toBe('FilesController');
      } finally {
        process.env.STORAGE_DRIVER = previous;
        delete process.env.GCS_BUCKET;
        jest.resetModules();
      }
    });
  });
});
