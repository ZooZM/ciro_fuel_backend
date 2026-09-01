import { IsOptional, IsString } from 'class-validator';

export class SettleInvoiceDto {
  // Free-text reference for the off-platform payment being recorded (e.g. a
  // bank transfer id) — informational only, never a uniqueness/dedup key.
  @IsOptional()
  @IsString()
  paymentReference?: string;
}
