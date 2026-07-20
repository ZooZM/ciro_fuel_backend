import { IsString, MinLength } from 'class-validator';

export class RejectOrderDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}
