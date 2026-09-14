/**
 * spec 017 (operator dashboard) FR-026a — one transport company's order volume
 * for the operator's selected period.
 *
 * Returned as an array for a whole page of companies from ONE request. The
 * column sits on every row of the transporter list; a figure per row would be
 * an N+1 over the platform's whole order collection (FR-026b, research R14).
 *
 * `orderCount` is bounded by `createdAt` across every state — the same basis as
 * `GET /platform/overview`'s own `orderCount`, so the two figures the operator
 * reads minutes apart under one date range count the same thing.
 */
export interface TransportCompanyVolumeDto {
  companyId: string;
  /** `0` for a transporter no order has ever been routed to — never omitted. */
  orderCount: number;
}
