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
