import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SubmitRatingDto {
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  // FR-037a: optional — a customer may submit a score alone.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  review?: string;
}
