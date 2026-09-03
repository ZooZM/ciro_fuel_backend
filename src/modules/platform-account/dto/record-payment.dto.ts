import { IsEnum, IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { SettlementMethod } from '../../../common/enums/settlement-method.enum';

// spec 013 T161/FR-065/FR-072 — full or partial, so `amount` carries no upper bound tied
// to the outstanding balance; the ledger just accumulates confirmed movements (FR-068).
export class RecordPaymentDto {
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsEnum(SettlementMethod)
  method!: SettlementMethod;

  // T162/FR-067: at least one of `reference`/`documentFileId` is required — enforced in
  // the service, not here, since "at least one of two optional fields" is a cross-field
  // rule class-validator's per-property decorators can't express cleanly.
  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsMongoId()
  documentFileId?: string;
}
