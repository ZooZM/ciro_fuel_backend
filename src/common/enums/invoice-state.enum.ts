/** Lifecycle of an `Invoice` (spec 004 FR-020). */
export enum InvoiceState {
  /** Issued at order approval with the final price; not yet settled. */
  ISSUED = 'ISSUED',
  /** Paid/settled by its payer. */
  SETTLED = 'SETTLED',
  /** Voided — e.g. the order was cancelled before settlement. */
  VOID = 'VOID',
}
