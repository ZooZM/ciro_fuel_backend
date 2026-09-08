import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CompaniesService } from '../../companies/companies.service';
import { TransportPricingService, DeliveryTarget } from './transport-pricing.service';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { DEFAULT_CURRENCY, roundCurrency } from '../../../common/constants/money.constants';
import { PriceBreakdown } from '../schemas/order.schema';

export interface Quote {
  breakdown: PriceBreakdown;
  quoteToken: string;
  expiresAt: Date;
}

/** The pricing inputs a quote token commits to — everything redemption re-checks against the live config. */
interface QuotePayload {
  fuelCompanyId: string;
  fuelType: FuelType;
  quantityLiters: number;
  unitPrice: number;
  deliveryFee: number;
  serviceFeePercent: number;
  taxRatePercent: number;
  expiresAt: string;
}

/**
 * Derives the itemised order price (spec 005 D3) and issues/validates the
 * quote token that detects a price change between quotation and
 * confirmation (research R10).
 *
 * The token is deliberately unsigned, opaque base64 JSON — it does not need
 * to be tamper-proof, because redemption never trusts a figure it carries.
 * Every input the token names is re-read from the LIVE `PricingConfig` at
 * redemption time and compared; the server always recomputes the breakdown
 * from its own current configuration. A forged or stale token can only
 * ever cause a `QUOTE_STALE`/`QUOTE_EXPIRED` rejection, never an
 * under-priced order — there is no value in signing a token that carries
 * no authority of its own.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly transportPricing: TransportPricingService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Derivation order fixed by FR-011g: fuel line total, then delivery fee,
   * then service fee (percentage of the fuel line), then tax (percentage
   * of the sum of the preceding three). Each component is rounded before
   * the next is derived from it — not just at the end — so a compounding
   * component (service fee, tax) is built from an already-rounded figure,
   * the same way a human accountant would compute it line by line.
   */
  private derive(
    unitPrice: number,
    quantityLiters: number,
    deliveryFee: number,
    serviceFeePercent: number,
    taxRatePercent: number,
  ): Omit<PriceBreakdown, 'currency' | 'pricedAt'> {
    const fuelLineTotal = roundCurrency(unitPrice * quantityLiters);
    const roundedDeliveryFee = roundCurrency(deliveryFee);
    const serviceFee = roundCurrency((fuelLineTotal * serviceFeePercent) / 100);
    const tax = roundCurrency(
      ((fuelLineTotal + roundedDeliveryFee + serviceFee) * taxRatePercent) / 100,
    );
    // The sum of the four ALREADY-ROUNDED components — never a separately
    // rounded sum of the raw figures (FR-011b/research R2).
    //
    // The outer `roundCurrency` is not a second rounding of the arithmetic:
    // every operand is already at 2dp, so it cannot change the value. It
    // only normalises IEEE-754 addition noise — 10900 + 50 + 272.5 +
    // 1683.38 evaluates to 12905.880000000001 in binary floating point,
    // which is what the client would otherwise be shown and what the
    // invoice would be asserted against.
    const total = roundCurrency(fuelLineTotal + roundedDeliveryFee + serviceFee + tax);

    return {
      fuelLineTotal,
      deliveryFee: roundedDeliveryFee,
      serviceFee,
      tax,
      total,
      unitPrice,
      serviceFeePercent,
      taxRatePercent,
    };
  }

  /**
   * Looks up the fuel company's current price and configuration and
   * throws `PRICING_NOT_CONFIGURED` (409) when either is missing — FR-011j:
   * a company with no configuration must never have an order priced
   * against it, and the client is told so rather than shown a total
   * derived from defaults or zeros.
   */
  private async currentRates(
    fuelCompanyId: string,
    fuelType: FuelType,
    target: DeliveryTarget,
  ): Promise<{
    unitPrice: number;
    deliveryFee: number;
    serviceFeePercent: number;
    taxRatePercent: number;
  }> {
    const [unitPrice, pricingConfig] = await Promise.all([
      this.companiesService.getBasePrice(fuelCompanyId, fuelType),
      this.companiesService.getPricingConfig(fuelCompanyId),
    ]);

    if (unitPrice === undefined || !pricingConfig) {
      throw new ConflictException({
        error: ErrorCode.PRICING_NOT_CONFIGURED,
        message: 'Pricing is not yet configured for this fuel company',
      });
    }

    // The delivery leg is priced by the company that performs it. `null` means no
    // transporter of this fuel company serves the region at all (FR-016) — the
    // pre-existing "held at AWAITING_ROUTING and routed by hand" case, where the fuel
    // company's own configured fee remains the only figure anyone has. Every other
    // outcome either resolves to a transporter's own rate or refuses outright; nothing
    // here averages, guesses, or silently prefers one transporter over another.
    const transport = await this.transportPricing.resolve(fuelCompanyId, target, fuelType);

    return {
      unitPrice,
      deliveryFee: transport ? transport.fee : pricingConfig.deliveryFee,
      serviceFeePercent: pricingConfig.serviceFeePercent,
      taxRatePercent: pricingConfig.taxRatePercent,
    };
  }

  /** Quote expiry — short enough that a genuinely stale price is caught, long enough for a client to review a screen (default 10 minutes). */
  private quoteExpiryMinutes(): number {
    return this.config.get<number>('order.quoteExpiryMinutes') ?? 10;
  }

  async quote(
    fuelCompanyId: string,
    fuelType: FuelType,
    quantityLiters: number,
    target: DeliveryTarget,
  ): Promise<Quote> {
    const rates = await this.currentRates(fuelCompanyId, fuelType, target);
    const breakdown = this.derive(
      rates.unitPrice,
      quantityLiters,
      rates.deliveryFee,
      rates.serviceFeePercent,
      rates.taxRatePercent,
    );
    const expiresAt = new Date(Date.now() + this.quoteExpiryMinutes() * 60_000);

    const payload: QuotePayload = {
      fuelCompanyId,
      fuelType,
      quantityLiters,
      unitPrice: rates.unitPrice,
      deliveryFee: rates.deliveryFee,
      serviceFeePercent: rates.serviceFeePercent,
      taxRatePercent: rates.taxRatePercent,
      expiresAt: expiresAt.toISOString(),
    };
    const quoteToken = Buffer.from(JSON.stringify(payload)).toString('base64url');

    return {
      breakdown: { ...breakdown, currency: DEFAULT_CURRENCY, pricedAt: new Date() },
      quoteToken,
      expiresAt,
    };
  }

  /**
   * Redeems a quote token at order creation. Re-derives the breakdown from
   * the LIVE configuration — never from the token's own figures — and only
   * accepts the token when every rate it named still matches. On a
   * mismatch, throws `QUOTE_STALE` carrying the CURRENT breakdown so the
   * app can re-prompt without a second round trip (contract §4).
   */
  async redeem(
    quoteToken: string,
    fuelCompanyId: string,
    fuelType: FuelType,
    quantityLiters: number,
    target: DeliveryTarget,
  ): Promise<PriceBreakdown> {
    const payload = this.decode(quoteToken);

    if (new Date(payload.expiresAt) <= new Date()) {
      throw new ConflictException({
        error: ErrorCode.QUOTE_EXPIRED,
        message: 'This quote has expired',
      });
    }
    if (
      payload.fuelCompanyId !== fuelCompanyId ||
      payload.fuelType !== fuelType ||
      payload.quantityLiters !== quantityLiters
    ) {
      // A token quoted for different inputs is treated the same as a rate
      // change — the honest answer is "re-quote", not a silent substitution.
      const current = await this.quote(fuelCompanyId, fuelType, quantityLiters, target);
      throw new ConflictException({
        error: ErrorCode.QUOTE_STALE,
        message: 'Pricing has changed since this quote',
        currentBreakdown: current.breakdown,
      });
    }

    const rates = await this.currentRates(fuelCompanyId, fuelType, target);
    const ratesChanged =
      rates.unitPrice !== payload.unitPrice ||
      rates.deliveryFee !== payload.deliveryFee ||
      rates.serviceFeePercent !== payload.serviceFeePercent ||
      rates.taxRatePercent !== payload.taxRatePercent;

    if (ratesChanged) {
      const current = this.derive(
        rates.unitPrice,
        quantityLiters,
        rates.deliveryFee,
        rates.serviceFeePercent,
        rates.taxRatePercent,
      );
      throw new ConflictException({
        error: ErrorCode.QUOTE_STALE,
        message: 'Pricing has changed since this quote',
        currentBreakdown: { ...current, currency: DEFAULT_CURRENCY, pricedAt: new Date() },
      });
    }

    const breakdown = this.derive(
      rates.unitPrice,
      quantityLiters,
      rates.deliveryFee,
      rates.serviceFeePercent,
      rates.taxRatePercent,
    );
    return { ...breakdown, currency: DEFAULT_CURRENCY, pricedAt: new Date() };
  }

  private decode(token: string): QuotePayload {
    try {
      const json = Buffer.from(token, 'base64url').toString('utf8');
      return JSON.parse(json) as QuotePayload;
    } catch {
      throw new ConflictException({
        error: ErrorCode.QUOTE_EXPIRED,
        message: 'This quote token is not valid',
      });
    }
  }
}
