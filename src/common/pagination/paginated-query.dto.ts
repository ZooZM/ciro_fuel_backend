import { IsOptional, IsString } from 'class-validator';

/**
 * `cursor` is the only page-shaping input a client may supply — page size
 * is fixed platform-side (`DEFAULT_PAGE_SIZE`) and deliberately NOT
 * accepted here, per FR-048: a caller-chosen page size is an abuse lever
 * with no requirement asking for one.
 */
export class PaginatedQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;
}
