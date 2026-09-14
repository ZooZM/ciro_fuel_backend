import { IsEnum, IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { SettlementMethod } from '../../../common/enums/settlement-method.enum';

/**
 * spec 017 (operator dashboard) T142/FR-066/FR-070 — the operator recording
 * that the platform paid a fuel company its accrued cashback.
 *
 * Differs from {@link RecordPaymentDto} in one field, and the difference is the
 * requirement: **`reference` is REQUIRED here**, not one-of-two. A company's
 * payment can be evidenced by an uploaded receipt instead of a reference, but a
 * payout's reference is what FR-070's duplicate refusal is keyed on — an
 * optional one would leave the platform unable to tell a resubmitted form from
 * a genuine second payout, which is precisely the mistake that pays a company
 * twice.
 *
 * `amount` has no upper bound here. The real bound is the owed balance, and it
 * is checked inside the recording transaction against a figure re-read there
 * (FR-069) — a DTO constraint could only ever compare against a number the
 * client supplied.
 */
export class RecordCashbackPayoutDto {
  // Arrives as a multipart string when evidence accompanies it, so it is
  // coerced before `@IsNumber` rather than rejected as "not a number".
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsEnum(SettlementMethod)
  method!: SettlementMethod;

  /** Required — see this class's note. */
  @IsString()
  reference!: string;

  /** An already-uploaded evidence document, when one was stored separately. */
  @IsOptional()
  @IsMongoId()
  documentFileId?: string;
}
