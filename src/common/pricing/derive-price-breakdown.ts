import { roundCurrency } from '../constants/money.constants';

/**
 * The itemised derivation, as a pure function.
 *
 * It lives here rather than inside `PricingService` because two callers in two
 * modules now need it and must never disagree: `PricingService` derives the
 * quote (fuel line only, no transporter chosen yet), and `RoutingService`
 * re-derives the same order once routing has settled which transport company
 * performs the haul and therefore what the delivery leg costs. A second copy of
 * this arithmetic would be a second answer to "what does this order cost".
 *
 * Derivation order is fixed by FR-011g: fuel line total, then delivery fee,
 * then service fee (a percentage of the fuel line), then tax (a percentage of
 * the sum of the preceding three). Each component is rounded before the next is
 * derived from it — not only at the end — so a compounding component is built
 * from an already-rounded figure, the way an accountant computes line by line.
 */
export interface DerivedPriceBreakdown {
  fuelLineTotal: number;
  deliveryFee?: number;
  serviceFee: number;
  tax: number;
  total: number;
  unitPrice: number;
  serviceFeePercent: number;
  taxRatePercent: number;
}

export function derivePriceBreakdown(
  unitPrice: number,
  quantityLiters: number,
  /**
   * `undefined` until a transport company is assigned. The delivery leg is
   * priced by the company that performs it, and at quotation no such company
   * has been chosen — so there is no figure to state, and `0` would be a
   * different claim ("delivery is free") rather than an absent one. While
   * absent it contributes nothing to the tax base, and the returned breakdown
   * carries no `deliveryFee` key at all.
   */
  deliveryFee: number | undefined,
  serviceFeePercent: number,
  taxRatePercent: number,
): DerivedPriceBreakdown {
  const fuelLineTotal = roundCurrency(unitPrice * quantityLiters);
  const roundedDeliveryFee = deliveryFee === undefined ? undefined : roundCurrency(deliveryFee);
  const serviceFee = roundCurrency((fuelLineTotal * serviceFeePercent) / 100);
  const tax = roundCurrency(
    ((fuelLineTotal + (roundedDeliveryFee ?? 0) + serviceFee) * taxRatePercent) / 100,
  );
  // The sum of the ALREADY-ROUNDED components — never a separately rounded sum
  // of the raw figures (FR-011b/research R2).
  //
  // The outer `roundCurrency` is not a second rounding of the arithmetic: every
  // operand is already at 2dp, so it cannot change the value. It only
  // normalises IEEE-754 addition noise — 10900 + 50 + 272.5 + 1683.38
  // evaluates to 12905.880000000001 in binary floating point, which is what the
  // client would otherwise be shown and what the invoice would be asserted
  // against.
  const total = roundCurrency(fuelLineTotal + (roundedDeliveryFee ?? 0) + serviceFee + tax);

  return {
    fuelLineTotal,
    // Spread, so the key is ABSENT rather than present-and-undefined when no
    // transporter has been assigned.
    ...(roundedDeliveryFee === undefined ? {} : { deliveryFee: roundedDeliveryFee }),
    serviceFee,
    tax,
    total,
    unitPrice,
    serviceFeePercent,
    taxRatePercent,
  };
}
