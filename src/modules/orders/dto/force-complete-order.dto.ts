import { IsString, Length } from 'class-validator';

export class ForceCompleteOrderDto {
  @IsString()
  @Length(5, 500)
  reason!: string;
}
