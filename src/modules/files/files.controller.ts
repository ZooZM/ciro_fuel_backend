import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { FilesService } from './files.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { UploadFileDto } from './dto/upload-file.dto';

@Controller({ path: 'files', version: '1' })
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadFileDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!user.companyId) {
      throw new BadRequestException('Only company-scoped users may upload files here');
    }
    // Request and response are both unchanged (FR-038): same field names, same
    // limit, same allowlist, and `storagePath` keeps its name and type in the
    // payload. Only its CONTENT changes — an object key rather than an absolute
    // filesystem path. It was never a stable value anyway; it previously
    // embedded `process.cwd()` and so already differed between machines.
    return this.filesService.store({
      companyId: user.companyId,
      ownerUserId: user.userId,
      purpose: dto.purpose,
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });
  }

  /**
   * spec 012 FR-039/FR-042a/FR-042c — a **302 under every driver**.
   *
   * Not "302 in production, bytes locally". Had the local driver returned bytes
   * directly, the redirect would have first executed in production — the exact
   * production-only-path defect research R1 found in the bootstrap, recreated
   * inside the story meant to be safest. Both drivers redirect; only the
   * destination differs.
   *
   * `findForDownload` runs FIRST and its tenant-scoped read is the whole
   * authorization: a signed URL is a bearer credential, so signing before
   * checking would mint a working credential for a document the caller may not
   * see. A cross-tenant id resolves to nothing and 404s, never 403.
   *
   * `Cache-Control: no-store` because the Location expires. A cached redirect
   * to an expired location fails intermittently, minutes later, and reads as a
   * storage fault rather than a caching one.
   */
  @Get(':id')
  async download(@Param('id', ObjectIdPipe) id: string, @Res() res: Response): Promise<void> {
    const file = await this.filesService.findForDownload(id);
    const location = await this.filesService.signedUrlFor(file);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, location);
  }
}
