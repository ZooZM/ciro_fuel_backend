import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileRecord, FileRecordDocument, FilePurpose } from './schemas/file.schema';
import { STORAGE_DIR } from './files.constants';
import { FileStorage } from '../../common/storage/file-storage.port';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { buildStorageKey } from '../../common/storage/local-file-storage';

@Injectable()
export class FilesService {
  constructor(
    @InjectModel(FileRecord.name) private readonly fileModel: Model<FileRecordDocument>,
    private readonly storage: FileStorage,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The ONE write path — spec 012 T063.
   *
   * There used to be two: `recordUpload`, which recorded metadata for bytes
   * Multer had already written to disk, and `writeBufferAndRecord`, which wrote
   * a buffer itself because the company-registration flow has no companyId to
   * key a disk path on until the company exists. Multer now uses
   * `memoryStorage` under every driver, so BOTH callers arrive holding a
   * buffer and the two paths collapse into this one. Keeping two would mean
   * one of them silently continuing to write to a local disk that production no
   * longer has.
   *
   * **Order is the requirement** (FR-041): bytes first, record second. `put`
   * throws on failure, so a storage error propagates before `create` runs and
   * no `FileRecord` is ever persisted for bytes that did not land — a record
   * pointing at a missing object is worse than a failed upload, because it
   * fails later and looks like corruption.
   */
  async store(params: {
    companyId: string | Types.ObjectId;
    ownerUserId?: string | Types.ObjectId;
    purpose: FilePurpose;
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  }): Promise<FileRecordDocument> {
    const filename = `${randomUUID()}${extname(params.originalName)}`;
    const storagePath = buildStorageKey(STORAGE_DIR, String(params.companyId), filename);

    await this.storage.put({
      key: storagePath,
      buffer: params.buffer,
      mimeType: params.mimeType,
    });

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

  /**
   * The tenant boundary for downloads, and the only one.
   *
   * `FileRecordSchema` is `markTenantScoped`, so this `findById` runs through
   * the scoping plugin and a cross-tenant id resolves to nothing — a 404, never
   * a 403, which is why `files.controller.ts:download` has no explicit tenant
   * check and correctly needs none (FR-040a). The controller LOOKS unprotected;
   * removing the marker would open a cross-tenant read with no other change.
   *
   * Since spec 012 this is also what must run BEFORE any URL is signed: a
   * signed URL is a bearer credential, so signing first and checking after
   * would mint a working credential for a document the caller may not see.
   */
  async findForDownload(id: string): Promise<FileRecordDocument> {
    const file = await this.fileModel.findById(id).exec();
    if (!file) {
      throw new NotFoundException('File not found');
    }
    return file;
  }

  /**
   * The same lookup with NO tenant scoping — used only by the local driver's
   * token-addressed byte route (FR-042b).
   *
   * That route runs with no actor by design, so the scoped read above would
   * find nothing and every local download would 404. Unscoped is correct here
   * and ONLY here: the authorization already happened, in `download`, whose
   * tenant-scoped `findForDownload` had to succeed before a token was minted
   * at all. This method re-derives no permission and grants none — the token
   * is the credential, and it names one file.
   *
   * It is never reachable in production: the only caller is a controller that
   * is not registered under the GCS driver.
   */
  findForDownloadUnscoped(id: string): Promise<FileRecordDocument> {
    return this.tenantContext.runUnscoped(async () => {
      const file = await this.fileModel.findById(id).exec();
      if (!file) {
        throw new NotFoundException('File not found');
      }
      return file;
    });
  }

  /** A short-lived, single-object location for bytes the caller has been cleared to read. */
  signedUrlFor(file: FileRecordDocument): Promise<string> {
    return this.storage.signedUrl({ key: file.storagePath, fileId: String(file._id) });
  }
}
