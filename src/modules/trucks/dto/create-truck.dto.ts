import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTruckDto {
  @IsString()
  @MinLength(1)
  plateNumber!: string;

  @IsOptional()
  @IsString()
  model?: string;
}
