import { IsNumber, IsOptional, Min } from 'class-validator';

export class ApproveOrderDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  finalPrice?: number;
}
