/** spec 013 T182/FR-097 — every way a `LitreBalance.movements` entry can arise. */
export enum LitreMovementKind {
  SHORTFALL_CREDIT = 'SHORTFALL_CREDIT',
  EXCESS_DEBIT = 'EXCESS_DEBIT',
  ORDER_DRAWDOWN = 'ORDER_DRAWDOWN',
  DRAWDOWN_RETURNED = 'DRAWDOWN_RETURNED',
  CORRECTION = 'CORRECTION',
}
