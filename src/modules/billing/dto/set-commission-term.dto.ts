import { IsEnum, IsNumber, Min } from 'class-validator';
import { CommissionBasis } from '../../../common/enums/commission-basis.enum';

export class SetCommissionTermDto {
  @IsEnum(CommissionBasis)
  basis!: CommissionBasis;

  @IsNumber()
  @Min(0)
  rate!: number;
}
