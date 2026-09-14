import { ArrayUnique, IsArray, IsMongoId, IsOptional, IsString, Length } from 'class-validator';

/**
 * spec 017 (operator dashboard) FR-048/FR-049/FR-050 — the operator composing
 * one platform announcement.
 */
export class CreateAnnouncementDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 4000)
  body!: string;

  /**
   * **Empty (or absent) means every active company** (FR-049). See
   * `Announcement.targetCompanyIds` for why this is one field rather than an
   * array plus a `targetsAllCompanies` boolean.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  targetCompanyIds?: string[];
}
