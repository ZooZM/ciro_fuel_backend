import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, type Bucket } from '@google-cloud/storage';
import { FileStorage } from './file-storage.port';

/**
 * Production document storage — spec 012 FR-036 – FR-040c.
 *
 * **No key file.** The client is constructed with no credentials argument, so
 * it uses the VM's attached service identity via the metadata server. There is
 * therefore no credential in any image, snapshot, backup or environment
 * variable — nothing to leak and nothing to rotate (FR-043's reasoning applied
 * to storage). A key file would reintroduce exactly the class of exposure
 * Story 7 exists to remove.
 *
 * The bucket's own configuration carries guarantees this code cannot
 * (operations-contract §4): regional and in the same region as compute
 * (FR-064c), public access prevention ENFORCED (FR-040b), uniform bucket-level
 * access, and CORS naming the dashboard's origins explicitly rather than `*`
 * (FR-040c). None of those is verifiable from here, which is why each is a
 * pre-launch checklist item rather than a comment claiming it is done.
 */
@Injectable()
export class GcsFileStorage extends FileStorage {
  private readonly logger = new Logger(GcsFileStorage.name);
  private readonly bucket: Bucket;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService) {
    super();
    // Application Default Credentials — on a Compute Engine VM that resolves to
    // the attached service identity.
    this.bucket = new Storage().bucket(config.get<string>('storage.gcsBucket')!);
    this.ttlSeconds = config.get<number>('storage.signedUrlTtlSeconds')!;
  }

  async put(params: { key: string; buffer: Buffer; mimeType: string }): Promise<void> {
    try {
      await this.bucket.file(params.key).save(params.buffer, {
        contentType: params.mimeType,
        // The object is never public; it is only ever reached through a signed
        // URL. `resumable: false` because these are single small documents and
        // a resumable session is a second round trip for no benefit.
        resumable: false,
      });
    } catch (err) {
      // Thrown, never swallowed: the caller writes the metadata record only
      // after this resolves, so a failed upload leaves no `FileRecord` pointing
      // at an object that does not exist (FR-041).
      this.logger.error({ key: params.key, err }, 'Object storage write failed');
      throw new InternalServerErrorException('Failed to store file');
    }
  }

  async signedUrl(params: { key: string }): Promise<string> {
    try {
      const [url] = await this.bucket.file(params.key).getSignedUrl({
        version: 'v4',
        // GET only and one object only. A signed URL is a bearer credential:
        // anything wider than "read this specific object" is a credential that
        // can do more than the request that produced it (FR-040).
        action: 'read',
        expires: Date.now() + this.ttlSeconds * 1000,
      });
      return url;
    } catch (err) {
      this.logger.error({ key: params.key, err }, 'Signing a read URL failed');
      throw new InternalServerErrorException('Failed to prepare file download');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
      this.logger.error({ key, err }, 'Object storage delete failed');
      throw new InternalServerErrorException('Failed to delete file');
    }
  }
}
