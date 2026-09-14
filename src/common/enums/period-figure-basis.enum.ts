/**
 * spec 017 (operator dashboard) FR-001a — which event a period figure is
 * bounded by.
 *
 * The platform overview's three period figures do **not** share one basis, and
 * saying so in the response is the point of this enum. The order count is
 * bounded by `createdAt` across every state; trading value and litres moved
 * count delivered orders only, bounded by `deliveredAt`.
 *
 * That split is forced, not a preference. Value and volume are meaningless for
 * an order that has not been delivered — but a delivered-only ORDER count would
 * by definition equal the `COMPLETED` bucket, forcing the other five buckets of
 * FR-006 structurally to zero, so the six-segment chart could never sum to the
 * card above it. Two figures presented under one date range on two different
 * bases, with nothing saying which is which, reads as a bug in one of them —
 * hence `PeriodFigureBasis` travels in the response rather than living only in
 * a comment.
 */
export enum PeriodFigureBasis {
  /** Bounded by `createdAt`, counted across every order state. */
  RAISED_IN_PERIOD = 'RAISED_IN_PERIOD',
  /** Bounded by `deliveredAt`, counted over `DELIVERED` orders only. */
  DELIVERED_IN_PERIOD = 'DELIVERED_IN_PERIOD',
}
