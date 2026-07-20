import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileRecord, FileRecordDocument, FilePurpose } from './schemas/file.schema';
import { STORAGE_DIR } from './files.constants';

@Injectable()
export class FilesService {
  constructor(
    @InjectModel(FileRecord.name) private readonly fileModel: Model<FileRecordDocument>,
  ) {}

  /** Records metadata for a file Multer has already written to disk (regular authenticated upload path). */
  recordUpload(params: {
    companyId: string | Types.ObjectId;
    ownerUserId: string | Types.ObjectId;
    purpose: FilePurpose;
    storagePath: string;
    mimeType: string;
    sizeBytes: number;
    originalName: string;
  }): Promise<FileRecordDocument> {
    return this.fileModel.create(params);
  }

  /**
   * Writes a buffered upload to sys_storge and records it — used only by the
   * company-registration flow (T058), where the company (and thus its id,
   * which the storage path is keyed on) doesn't exist yet when Multer
   * receives the file, so it's buffered in memory rather than streamed
   * straight to a disk path.
   */
  async writeBufferAndRecord(params: {
    companyId: string | Types.ObjectId;
    ownerUserId?: string | Types.ObjectId;
    purpose: FilePurpose;
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  }): Promise<FileRecordDocument> {
    const dir = join(process.cwd(), STORAGE_DIR, String(params.companyId));
    await mkdir(dir, { recursive: true });
    const filename = `${randomUUID()}${extname(params.originalName)}`;
    const storagePath = join(dir, filename);
    await writeFile(storagePath, params.buffer);

    return this.fileModel.create({
      companyId: params.companyId,
      ownerUserId: params.ownerUserId,
      purpose: params.purpose,
      storagePath,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      originalName: params.originalName,
    });
  }

  async findForDownload(id: string): Promise<FileRecordDocument> {
    const file = await this.fileModel.findById(id).exec();
    if (!file) {
      throw new NotFoundException('File not found');
    }
    return file;
  }
}
