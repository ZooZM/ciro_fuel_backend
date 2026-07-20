import { IsEnum } from 'class-validator';
import { FilePurpose } from '../schemas/file.schema';

export class UploadFileDto {
  @IsEnum(FilePurpose)
  purpose!: FilePurpose;
}
