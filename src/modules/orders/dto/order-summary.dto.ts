/**
 * Feature 009 FR-067/FR-059-061: the dashboard overview's whole home in one request —
 * cursor pagination cannot yield a total, so this is computed from scoped `countDocuments`
 * calls rather than paging the underlying lists (contracts/rest-api-delta.md Part 1,
 * data-model.md R6). Response-only; no incoming validation needed.
 */
export interface OutstandingSettlementsSummary {
  amount: number;
  currency: string;
  count: number;
}

export interface OrderSummaryDto {
  awaitingAssignment: number;
  inProgress: number;
  completedInPeriod: number;
  driversOnDuty: number;
  outstandingSettlements: OutstandingSettlementsSummary;
}

/**
 * spec 013 (fuel company admin dashboard) T111/FR-046 — a separate shape from
 * `OrderSummaryDto` above rather than reusing it with optional fields: `driversOnDuty`
 * (always zero for a FUEL_COMPANY_ADMIN — drivers belong to transport companies) and
 * `awaitingAssignment` (ROUTED_TO_TRANSPORT — a transporter's own decision point, not a
 * fuel company's) are meaningless for this role, and `pendingApproval` /
 * `stationOwnersCount` / `stationsCount` / `creditOutstanding` have no equivalent for a
 * TRANSPORT_COMPANY_ADMIN. Two roles, two genuinely different summaries.
 */
export interface FuelCompanySummaryDto {
  pendingApproval: number;
  inProgress: number;
  completedInPeriod: number;
  stationOwnersCount: number;
  stationsCount: number;
  creditOutstanding: OutstandingSettlementsSummary;
}
