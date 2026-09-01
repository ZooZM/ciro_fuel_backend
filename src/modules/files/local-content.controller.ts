import { Controller, ForbiddenException, Get, Logger, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { FilesService } from './files.service';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { Public } from '../../common/decorators/public.decorator';
import { LocalFileStorage } from '../../common/storage/local-file-storage';
import { deriveLocalTokenKey, verifyLocalToken } from '../../common/storage/local-storage-token';

/**
 * The local driver's byte route — spec 012 FR-042b, rest-api-delta §2.1.
 *
 * **This controller is registered ONLY when `STORAGE_DRIVER=local`** (see
 * `files.module.ts`). It exists for one reason: so the local driver can
 * complete the same 302 the GCS driver does, rather than the local path
 * short-circuiting to bytes and leaving the redirect to execute for the first
 * time in production.
 *
 * ---
 *
 * It is an UNAUTHENTICATED endpoint that streams tenant documents. That is
 * acceptable only because of three properties, every one of which is
 * load-bearing and asserted by test rather than assumed:
 *
 *   1. **Scoped** — the token names one file id, inside the signed payload, so
 *      a token minted for one document cannot be replayed against another.
 *   2. **Expiring** — `LOCAL_STORAGE_TOKEN_TTL_SECONDS`, matching the signed
 *      URL lifetime so the two drivers expire alike.
 *   3. **Absent from production** — not registered at all under the GCS driver.
 *
 * **Why a token rather than the normal auth guard** (FR-042b): an authenticated
 * byte route would depend on the client forwarding `Authorization` across a
 * redirect, and clients differ in exactly that — which is the entirety of
 * FR-038c. It would pass for browsers and fail for some mobile clients,
 * closing one trap by opening the same one in the test environment. A
 * header-less, expiring, single-object URL also mirrors the production
 * credential shape, so the local path is faithful in the security-relevant
 * dimension and not only in its status code.
 *
 * `@Public()` is REQUIRED, not incidental: `JwtAuthGuard` is registered
 * globally in `common.module.ts` and refuses anything without the decorator.
 */
@Controller({ path: 'files', version: '1' })
export class LocalFileContentController {
  private readonly logger = new Logger(LocalFileContentController.name);
  private readonly tokenKey: string;

  constructor(
    private readonly filesService: FilesService,
    private readonly localStorage: LocalFileStorage,
    config: ConfigService,
  ) {
    this.tokenKey = deriveLocalTokenKey(
      config.get<string>('storage.localTokenSecret') ?? '',
      config.get<string>('jwt.secret')!,
    );
  }

  @Public()
  @Get(':id/content')
  async content(
    @Param('id', ObjectIdPipe) id: string,
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const verdict = verifyLocalToken(token, id, this.tokenKey);
    if (!verdict.ok) {
      // The REASON is recorded and never disclosed: the response is one
      // undifferentiated refusal, so a caller cannot distinguish "wrong file"
      // from "expired" from "forged" and probe the token format.
      this.logger.warn({ fileId: id, reason: verdict.reason }, 'Local content token refused');
      throw new ForbiddenException('Invalid or expired file token');
    }

    // Read WITHOUT a tenant context — this request has no actor by design, and
    // `FileRecord` is tenant-scoped, so the scoped read would find nothing.
    // The authorization already happened: the token was minted by
    // `download`, and only AFTER its tenant-scoped `findForDownload` succeeded.
    // This route re-derives no permission and must not appear to.
    const file = await this.filesService.findForDownloadUnscoped(id);

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(this.localStorage.pathFor(file.storagePath)).pipe(res);
  }
}
