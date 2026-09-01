import { BadRequestException, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileRecord, FileRecordSchema } from './schemas/file.schema';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from './files.constants';
import { StorageDriver } from '../../common/enums/storage-driver.enum';
import { FileStorage } from '../../common/storage/file-storage.port';
import { LocalFileStorage } from '../../common/storage/local-file-storage';
import { GcsFileStorage } from '../../common/storage/gcs-file-storage';
import { LocalFileContentController } from './local-content.controller';

/**
 * spec 012 T064a: whether the local byte route exists at all.
 *
 * Read from `process.env` directly rather than `ConfigService`, for the same
 * reason `files.constants.ts` does: a module's `controllers` array is evaluated
 * when the decorator runs, at import time, before Nest's DI container exists.
 * The read is safe because Joi's default for STORAGE_DRIVER is `local` — the
 * same default `configuration.ts` applies — so an unset variable resolves both
 * here and there to the local driver, and they cannot disagree.
 *
 * This is the "absent from production" property that makes an unauthenticated,
 * document-streaming endpoint acceptable. It is not registered under the GCS
 * driver — not merely refused, not present — and a test asserts it 404s there.
 */
const LOCAL_DRIVER = (process.env.STORAGE_DRIVER ?? StorageDriver.LOCAL) !== StorageDriver.GCS;

/**
 * spec 012 T062: `memoryStorage`, not `diskStorage`.
 *
 * The previous `diskStorage` config had a `destination` callback that read
 * `req.user.companyId` and created a directory under `sys_storge` — which is
 * precisely the local-disk dependency Story 6 removes. With no filesystem
 * target the buffer reaches `FilesService`, which hands it to whichever
 * `FileStorage` driver is configured, so the SAME code path serves both
 * drivers and there is no production-only branch.
 *
 * The 10 MB limit and the MIME allowlist are unchanged, deliberately: this is
 * an operational change and must not alter what the platform accepts (FR-066).
 * Both are still evaluated at decorator time, before DI exists, which is why
 * `files.constants.ts` holds them as plain constants.
 */
const memoryUploadModule = MulterModule.register({
  storage: memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(new BadRequestException(`Unsupported file type: ${file.mimetype}`), false);
      return;
    }
    cb(null, true);
  },
});

@Module({
  imports: [
    MongooseModule.forFeature([{ name: FileRecord.name, schema: FileRecordSchema }]),
    memoryUploadModule,
  ],
  controllers: LOCAL_DRIVER ? [FilesController, LocalFileContentController] : [FilesController],
  providers: [
    FilesService,
    LocalFileStorage,
    {
      // The driver is chosen ONCE, here, by configuration — so nothing
      // downstream ever branches on it. `FilesService` and the controller both
      // depend on the abstract port and never learn which storage answered
      // (Constitution IV).
      //
      // `LocalFileStorage` is also provided directly, above, because the byte
      // route needs its `pathFor` to stream from disk; it resolves to the same
      // instance the port resolves to under the local driver.
      provide: FileStorage,
      inject: [ConfigService, LocalFileStorage],
      useFactory: (config: ConfigService, local: LocalFileStorage): FileStorage =>
        config.get<StorageDriver>('storage.driver') === StorageDriver.GCS
          ? new GcsFileStorage(config)
          : local,
    },
  ],
  // Re-exporting MulterModule so any module that imports FilesModule (e.g.
  // UsersModule, for the profile-picture endpoint) gets the SAME storage config
  // for its own bare `FileInterceptor('field')` calls — without this, NestJS
  // falls back to Multer's no-storage default and `file.buffer` is silently
  // undefined (the same bug that used to make `file.path` undefined).
  exports: [FilesService, FileStorage, memoryUploadModule],
})
export class FilesModule {}
