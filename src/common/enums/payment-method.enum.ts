/** How an order's invoice is settled (spec 004 FR-021). */
export enum PaymentMethod {
  /** The client pays directly; the order waits in `PENDING_PAYMENT` until settled. */
  DIRECT = 'DIRECT',
  /** The Transportation Company pays on the client's behalf; order proceeds immediately. */
  DEFERRED = 'DEFERRED',
  /** Drawn against the client's Fuel-Company-set credit limit; order proceeds immediately. */
  CREDIT = 'CREDIT',
}
