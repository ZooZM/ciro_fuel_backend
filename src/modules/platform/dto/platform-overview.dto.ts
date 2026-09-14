import { OrderStatusBucket } from '../../../common/constants/order-status-buckets';
import { CompanyType } from '../../../common/enums/company-type.enum';
import { PeriodFigureBasis } from '../../../common/enums/period-figure-basis.enum';

/**
 * spec 017 (operator dashboard) T024/§1 of contracts/rest-api-delta.md — the
 * operator's home screen in one response.
 *
 * **Every numeric field is non-optional.** On an empty period each is `0`,
 * never absent and never `null` (FR-008): a client that receives a missing key
 * has to guess whether it means "none" or "not computed", and those are
 * different facts a dashboard must render differently.
 *
 * **No trend, delta or percentage field exists at any nesting level** (FR-009).
 * The platform computes no period-over-period comparison anywhere, so the six
 * trend captions the mock rendered were fabricated; the response cannot carry
 * one for the dashboard to be tempted by.
 */
export interface PlatformOverviewDto {
  period: PlatformOverviewPeriodDto;
  pointInTime: PlatformOverviewPointInTimeDto;
  breakdown: PlatformOverviewBreakdownDto;
}

export interface PlatformOverviewPeriodDto {
  /** The resolved boundaries, echoed back so a caller never has to assume (FR-004). */
  from: string;
  to: string;
  /**
   * FR-005 — whether the period above was defaulted to the current calendar
   * month because no `from`/`to` was supplied. Stated rather than left for the
   * caller to infer by comparing dates.
   */
  isDefault: boolean;
  /** Orders RAISED in the period, in whatever state they have since reached. */
  orderCount: number;
  /** Trading value of orders DELIVERED in the period. */
  orderValue: number;
  /** Litres moved by orders DELIVERED in the period. */
  litresMoved: number;
  /**
   * FR-001a — the three figures above do not share one basis, and this says so
   * rather than leaving it to be inferred. See {@link PeriodFigureBasis}.
   */
  basis: {
    orderCount: PeriodFigureBasis;
    orderValue: PeriodFigureBasis;
    litresMoved: PeriodFigureBasis;
  };
}

/**
 * FR-002 — these are NOT bounded by the period above. Changing the date range
 * must leave every one of them unchanged; a company that exists, exists.
 */
export interface PlatformOverviewPointInTimeDto {
  fuelCompanies: number;
  transportCompanies: number;
  stations: number;
}

export interface PlatformOverviewBreakdownDto {
  /** Sums to `pointInTime.fuelCompanies + pointInTime.transportCompanies` (FR-006). */
  byCompanyType: { type: CompanyType; count: number }[];
  /**
   * All six buckets, including zeros, summing to `period.orderCount` EXACTLY
   * (FR-006, FR-023d). Both are computed from the same `createdAt`-bounded
   * match over every state, which is what makes the sum hold rather than
   * merely usually holding.
   */
  byOrderBucket: { bucket: OrderStatusBucket; count: number }[];
}
