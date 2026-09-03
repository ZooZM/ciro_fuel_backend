import { IsNumber, Min } from 'class-validator';

export class SetCommissionCeilingDto {
  @IsNumber()
  @Min(0)
  commissionCeiling!: number;
}
