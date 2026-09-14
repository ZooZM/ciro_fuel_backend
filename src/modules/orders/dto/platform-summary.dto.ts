import { OrderStatusBucket } from '../../../common/constants/order-status-buckets';

/**
 * spec 017 (operator dashboard) T048/FR-023 — the THIRD summary shape, for
 * `SUPER_ADMIN`.
 *
 * Until this feature the operator fell through to `OrderSummaryDto`, the
 * TRANSPORT company's shape: `awaitingAssignment` and `driversOnDuty` computed
 * platform-wide. Those are real numbers answering a transporter's questions —
 * "which of MY routed orders still needs a driver", "how many of MY drivers are
 * on duty" — and neither is a decision the platform operator makes (research
 * R5). This is a genuinely different summary, exactly as feature 013 added
 * `FuelCompanySummaryDto` rather than zeroing the fields that did not apply.
 *
 * Every one of the six buckets is present, including zeros (FR-023d), and
 * `total` equals their sum. `REJECTED` and `CANCELLED` are separate keys the
 * platform never sums into one figure (FR-023b); `NEEDS_ATTENTION` is its own
 * key and is never folded into `NEW` (FR-023c).
 */
export interface PlatformSummaryDto {
  /** Echoed back so a caller can tell which period the counts were taken over. */
  from: string;
  to: string;
  /**
   * Total over `OrderStatusBucket` — all six keys, never a partial record. A
   * bucket with no orders in it reports `0`; a missing key would leave a chart
   * segment unable to tell "none" from "not computed".
   */
  buckets: Record<OrderStatusBucket, number>;
  /** The sum of the six above (FR-023d). */
  total: number;
}
