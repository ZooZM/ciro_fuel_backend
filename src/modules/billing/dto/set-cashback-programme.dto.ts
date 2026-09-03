import { ArrayUnique, IsArray, IsBoolean, IsEnum, IsMongoId, IsNumber, Min, ValidateIf } from 'class-validator';
import { CommissionBasis } from '../../../common/enums/commission-basis.enum';

export class SetCashbackProgrammeDto {
  @IsEnum(CommissionBasis)
  basis!: CommissionBasis;

  @IsNumber()
  @Min(0)
  rate!: number;

  @IsBoolean()
  isActive!: boolean;

  @IsBoolean()
  targetsAllCompanies!: boolean;

  // Meaningful only when targetsAllCompanies is false — validated but not required
  // otherwise, matching `AssignRegionsDto`'s precedent for a conditionally-relevant array.
  @ValidateIf((dto: SetCashbackProgrammeDto) => !dto.targetsAllCompanies)
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  targetCompanyIds!: string[];
}
