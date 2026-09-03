/**
 * Rounding precision for every derived monetary figure (feature 005,
 * research R2). Each `PriceBreakdown` component is rounded to this many
 * places individually, and the total is the sum of the rounded components —
 * never the rounded sum of unrounded components — or FR-011b's "components
 * sum to the total" fails intermittently by a fraction of a currency unit.
 */
export const CURRENCY_DECIMAL_PLACES = 2;

/** Default and, for now, only currency the platform prices in. */
export const DEFAULT_CURRENCY = 'SAR';

/**
 * Feature 013 FR-098 — every quantity this feature states MUST name its
 * unit. The platform has represented volume by field naming alone until now
 * (`quantityLiters`), never as an explicit string; this is the first
 * response shape (litre balances, movements, exchange requests) that states
 * a unit value directly rather than only encoding it in a field name.
 */
export const LITRE_UNIT = 'L';

/**
 * Rounds to `CURRENCY_DECIMAL_PLACES`, half-up. Every `PriceBreakdown`
 * component MUST be rounded through this before being summed into the
 * total (research R2) — rounding the sum of unrounded components instead
 * produces the intermittent one-halala drift FR-011b forbids.
 */
export function roundCurrency(value: number): number {
  const factor = 10 ** CURRENCY_DECIMAL_PLACES;
  return Math.round(value * factor) / factor;
}
