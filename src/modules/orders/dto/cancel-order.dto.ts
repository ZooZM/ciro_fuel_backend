import { IsOptional, IsString, MinLength } from 'class-validator';

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  reason?: string;
}
