import { ArrayUnique, IsArray, IsEnum } from 'class-validator';
import { RegionCode } from '../../../common/enums/region.enum';

/**
 * Replaces (not merges) a Transportation Company's served regions (spec 004
 * FR-014). `@IsEnum` alone rejects any code outside the 13 real regions —
 * the reference list in `regions.constants.ts` is the source of truth for
 * which values are valid; this only needs to check membership.
 */
export class AssignRegionsDto {
  @IsArray()
  @ArrayUnique()
  @IsEnum(RegionCode, { each: true })
  regionCodes!: RegionCode[];
}
