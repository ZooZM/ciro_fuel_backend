import { IsEnum } from 'class-validator';
import { CompanyStatus } from '../../../common/enums/company-status.enum';

export class UpdateCompanyStatusDto {
  @IsEnum(CompanyStatus)
  status!: CompanyStatus;
}
