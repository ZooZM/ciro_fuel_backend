import { IsNumber, Min } from 'class-validator';

export class SetCreditLimitDto {
  @IsNumber()
  @Min(0)
  creditLimit!: number;
}
