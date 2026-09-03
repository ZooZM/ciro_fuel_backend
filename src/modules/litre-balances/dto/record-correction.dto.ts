import { IsNumber, IsString, MinLength } from 'class-validator';

// spec 013 T199/FR-074a/FR-075 — a direct administrator correction, outside the
// supplier-invoice flow. `litres` is signed (positive credits, negative debits);
// `reason` is required, never optional, unlike every other free-text reason field on
// this platform.
export class RecordCorrectionDto {
  @IsNumber()
  litres!: number;

  @IsString()
  @MinLength(1)
  reason!: string;
}
