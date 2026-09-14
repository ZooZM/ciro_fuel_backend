/** spec 013 T134/FR-064 — one entry in a company's ledger with the platform. */
export enum AccountMovementKind {
  COMMISSION_CHARGED = 'COMMISSION_CHARGED',
  CASHBACK_CREDITED = 'CASHBACK_CREDITED',
  PAYMENT_RECORDED = 'PAYMENT_RECORDED',
  /**
   * spec 017 (operator dashboard) T137/FR-066 — the platform paying a fuel
   * company an accrued cashback balance.
   *
   * A NEW kind, and the reason it is worth reading about: what the platform
   * OWES is not readable from any single kind. `getConfirmedBalance` is
   * per-kind, so a payout recorded here leaves
   * `getConfirmedBalance(CASHBACK_CREDITED)` entirely unchanged while still
   * returning a perfectly plausible number. The owed figure is a two-kind
   * derivation — see `getCashbackOwed` (research R11).
   *
   * The only OUTBOUND kind on the platform today, which is what
   * `AccountMovementDirection` exists to make visible in a ledger row.
   */
  CASHBACK_PAID_OUT = 'CASHBACK_PAID_OUT',
}
