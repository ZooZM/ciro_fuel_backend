import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { FileStorage } from './file-storage.port';
import { deriveLocalTokenKey, mintLocalToken } from './local-storage-token';

/**
 * Development and every e2e suite — spec 012 FR-042.
 *
 * Writes a REAL `sys_storge` directory (the constitution's name, retained), so
 * the local path is a genuine second implementation of the port rather than an
 * in-memory stub. The suites therefore exercise upload, key derivation,
 * signing, redirect and read-back end to end without any cloud dependency.
 *
 * `signedUrl` returns a URL to a route this platform serves, carrying an
 * expiring token scoped to one file — deliberately NOT a route behind the
 * normal auth guard. An authenticated byte route would depend on the client
 * forwarding `Authorization` across a redirect, and clients differ in exactly
 * that (FR-038c): it would pass for some and fail for others, closing one trap
 * by opening the same one in the test environment.
 */
@Injectable()
export class LocalFileStorage extends FileStorage {
  private readonly logger = new Logger(LocalFileStorage.name);
  private readonly root: string;
  private readonly tokenKey: string;
  private readonly tokenTtlSeconds: number;

  constructor(config: ConfigService) {
    super();
    this.root = resolve(process.cwd(), config.get<string>('storage.dir')!);
    this.tokenKey = deriveLocalTokenKey(
      config.get<string>('storage.localTokenSecret') ?? '',
      config.get<string>('jwt.secret')!,
    );
    // Matches the signed-URL lifetime deliberately, so the two drivers expire
    // alike and a test cannot pass locally for a timing reason that would not
    // hold in production.
    this.tokenTtlSeconds = config.get<number>('storage.localTokenTtlSeconds')!;
  }

  async put(params: { key: string; buffer: Buffer; mimeType: string }): Promise<void> {
    const absolute = this.absolutePathFor(params.key);
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, params.buffer);
    } catch (err) {
      // Thrown, never swallowed: the caller persists the metadata record only
      // after this resolves, so a failed write must leave no record pointing at
      // bytes that are not there (FR-041).
      this.logger.error({ key: params.key, err }, 'Local storage write failed');
      throw new InternalServerErrorException('Failed to store file');
    }
  }

  signedUrl(params: { key: string; fileId: string }): Promise<string> {
    const token = mintLocalToken(params.fileId, this.tokenKey, this.tokenTtlSeconds);
    // RELATIVE, deliberately. The suites follow the redirect against whatever
    // ephemeral port the test app bound, and a relative Location is the only
    // form that works for all of them without the driver being told its own
    // address. RFC 7231 permits it, and this driver never runs in production.
    return Promise.resolve(`/api/v1/files/${params.fileId}/content?token=${token}`);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.absolutePathFor(key));
    } catch {
      // Absent is the desired end state; a missing file is not a failure.
    }
  }

  /**
   * Resolves a key under the storage root, refusing anything that escapes it.
   *
   * Keys are server-generated (`sys_storge/{companyId}/{uuid}{ext}`) and never
   * derived from client input, so traversal is already structurally impossible.
   * This is the backstop that keeps it impossible if that ever stops being
   * true — the cost is one comparison and the failure it prevents is arbitrary
   * file read.
   */
  private absolutePathFor(key: string): string {
    const absolute = resolve(this.root, normalize(key).replace(/^(\.\.(\/|\\|$))+/, ''));
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
      throw new InternalServerErrorException('Invalid storage key');
    }
    return absolute;
  }

  /** Absolute path for the byte route to stream from. */
  pathFor(key: string): string {
    return this.absolutePathFor(key);
  }
}

/**
 * The object key for a document — the ONE place the layout is written, so the
 * two drivers cannot disagree about where a file lives.
 *
 * The `sys_storge/{companyId}/…` prefix is ORGANISATION ONLY and enforces
 * nothing. GCS serves any object to any holder of a valid signed URL regardless
 * of its key path; the tenant boundary is held entirely by the tenant-scoped
 * read that precedes signing (FR-040a). Any future code that reads tenancy out
 * of a key path is a defect.
 */
export function buildStorageKey(
  storageDir: string,
  companyId: string,
  filename: string,
): string {
  return join(storageDir, companyId, filename);
}
