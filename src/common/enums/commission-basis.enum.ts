/** spec 013 T134/FR-055 — how a commission or cashback rate is expressed and applied. */
export enum CommissionBasis {
  /** `rate` is percentage points (0-100) of the invoice amount. */
  PERCENTAGE = 'PERCENTAGE',
  /** `rate` is a currency amount per unit (1 SAR) of invoice value — a direct multiplier. */
  PER_UNIT = 'PER_UNIT',
}
