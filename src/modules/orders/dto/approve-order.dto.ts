import { IsMongoId, IsNumber, IsOptional, Min } from 'class-validator';

export class ApproveOrderDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  finalPrice?: number;

  // Only required when routing resolves more than one Transportation
  // Company for the client's region (spec 004 FR-014) — the caller learns
  // the candidate list from this same call's response and resubmits.
  @IsOptional()
  @IsMongoId()
  transportCompanyId?: string;
}
