import { BadRequestException, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { FileRecord, FileRecordSchema } from './schemas/file.schema';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, STORAGE_DIR } from './files.constants';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';

const diskUploadModule = MulterModule.register({
  storage: diskStorage({
    destination: (req: Request, _file, cb) => {
      const user = (req as Request & { user?: AuthenticatedUser }).user;
      if (!user?.companyId) {
        cb(new BadRequestException('Only company-scoped users may upload files here'), '');
        return;
      }
      const dir = join(process.cwd(), STORAGE_DIR, user.companyId);
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}${extname(file.originalname)}`);
    },
  }),
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
    diskUploadModule,
  ],
  controllers: [FilesController],
  providers: [FilesService],
  // Re-exporting MulterModule so any module that imports FilesModule (e.g.
  // UsersModule, for the profile-picture endpoint) gets the SAME disk-storage
  // config for its own bare `FileInterceptor('field')` calls — without this,
  // NestJS falls back to Multer's no-storage default and `file.path` is
  // silently undefined (the bug this fixes).
  exports: [FilesService, diskUploadModule],
})
export class FilesModule {}
