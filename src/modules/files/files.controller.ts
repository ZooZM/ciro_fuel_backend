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
    return this.filesService.recordUpload({
      companyId: user.companyId,
      ownerUserId: user.userId,
      purpose: dto.purpose,
      storagePath: file.path,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      originalName: file.originalname,
    });
  }

  @Get(':id')
  async download(@Param('id', ObjectIdPipe) id: string, @Res() res: Response): Promise<void> {
    const file = await this.filesService.findForDownload(id);
    res.sendFile(file.storagePath);
  }
}
