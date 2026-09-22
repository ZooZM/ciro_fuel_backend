import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CompaniesService } from '../../companies/companies.service';
import { TransportPricingService, DeliveryTarget } from './transport-pricing.service';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { DEFAULT_CURRENCY } from '../../../common/constants/money.constants';
import { PriceBreakdown } from '../schemas/order.schema';
import { derivePriceBreakdown } from '../../../common/pricing/derive-price-breakdown';

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
  // No `deliveryFee`: a quote commits to the FUEL company's rates alone. The
  // transport price is set by whichever transporter routing later picks, so a
  // quote could neither name it nor be made stale by it changing.
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
   * Delegates to the shared pure derivation — `RoutingService` re-derives the
   * same order once the transport company is known, and the two must not drift.
   */
  private derive(
    unitPrice: number,
    quantityLiters: number,
    deliveryFee: number | undefined,
    serviceFeePercent: number,
    taxRatePercent: number,
  ): Omit<PriceBreakdown, 'currency' | 'pricedAt'> {
    return derivePriceBreakdown(
      unitPrice,
      quantityLiters,
      deliveryFee,
      serviceFeePercent,
      taxRatePercent,
    );
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
  ): Promise<{
    unitPrice: number;
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

    // NO transport price is resolved here any more.
    //
    // The delivery leg is priced by the company that performs it, and which
    // company that is only becomes known at routing — after the fuel company
    // has approved the order. Quoting it earlier meant answering a question
    // nobody could answer yet, and the old answer was built out of whichever
    // transporters happened to serve the region: it refused the quote outright
    // when any one of them had not set a rate (`TRANSPORT_PRICE_NOT_SET`), and
    // fell back to the FUEL company's own configured fee when none of them
    // served it at all — a figure for a haul that company does not perform.
    //
    // The station owner is now quoted the fuel line alone and is shown the real
    // transport price once a transporter is assigned, which is the first moment
    // one exists (`RoutingService.routeOrder` -> `priceWithTransport`).
    return {
      unitPrice,
      serviceFeePercent: pricingConfig.serviceFeePercent,
      taxRatePercent: pricingConfig.taxRatePercent,
    };
  }

  /**
   * Re-derives the breakdown once the transport company is known, from the
   * SAME rates the order was quoted against plus that company's own delivery
   * fee. Called by `RoutingService` at the moment routing resolves.
   *
   * The fuel-side rates are re-read live rather than taken from the stored
   * breakdown: between quotation and routing sits a fuel company's approval,
   * and the platform's own rule is that the rates in force are what applies.
   * `unitPrice` is pinned to the one the order was quoted and approved at, so
   * the only figure this step can introduce is the transport fee itself.
   */
  async priceWithTransport(
    quoted: PriceBreakdown,
    quantityLiters: number,
    deliveryFee: number,
  ): Promise<PriceBreakdown> {
    const breakdown = this.derive(
      quoted.unitPrice,
      quantityLiters,
      deliveryFee,
      quoted.serviceFeePercent,
      quoted.taxRatePercent,
    );
    return { ...breakdown, currency: DEFAULT_CURRENCY, pricedAt: new Date() };
  }

  /**
   * The same itemised breakdown `quote()` produces, for an order created
   * WITHOUT having asked for a quote first.
   *
   * `CreateOrderDto.quoteToken` is optional and a comment on the creation path
   * asserted the real client app "always" sends it. It does — but the
   * assertion was load-bearing and unenforced, and the branch behind it priced
   * an order as `basePrice × litres` and nothing else: no service fee, no VAT.
   * The same 10,000 L order was invoiced at 21,300 that way against 24,736.50
   * through the quoted path, and nothing anywhere reported a discrepancy,
   * because the cheaper figure was written to `estimatedPrice` and every later
   * reader — approval, invoicing, credit — faithfully used it.
   *
   * An order is priced the same way whether or not the caller asked what it
   * would cost first, so both paths now derive from `currentRates`. The
   * delivery fee is still absent here for the same reason it is absent from a
   * quote: no transporter has been chosen yet, and `RoutingService` adds it the
   * moment one is.
   */
  async priceWithoutQuote(
    fuelCompanyId: string,
    fuelType: FuelType,
    quantityLiters: number,
  ): Promise<PriceBreakdown> {
    const rates = await this.currentRates(fuelCompanyId, fuelType);
    const breakdown = this.derive(
      rates.unitPrice,
      quantityLiters,
      undefined,
      rates.serviceFeePercent,
      rates.taxRatePercent,
    );
    return { ...breakdown, currency: DEFAULT_CURRENCY, pricedAt: new Date() };
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
    const rates = await this.currentRates(fuelCompanyId, fuelType);
    const breakdown = this.derive(
      rates.unitPrice,
      quantityLiters,
      // No transporter is assigned at quote time, so there is no delivery fee
      // to quote — the station owner sees the field empty (FR-011g as amended).
      undefined,
      rates.serviceFeePercent,
      rates.taxRatePercent,
    );
    const expiresAt = new Date(Date.now() + this.quoteExpiryMinutes() * 60_000);

    const payload: QuotePayload = {
      fuelCompanyId,
      fuelType,
      quantityLiters,
      unitPrice: rates.unitPrice,
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

    const rates = await this.currentRates(fuelCompanyId, fuelType);
    // A transporter's rate change can no longer make a quote stale, because a
    // quote no longer names one. Only the fuel company's own rates can.
    const ratesChanged =
      rates.unitPrice !== payload.unitPrice ||
      rates.serviceFeePercent !== payload.serviceFeePercent ||
      rates.taxRatePercent !== payload.taxRatePercent;

    if (ratesChanged) {
      const current = this.derive(
        rates.unitPrice,
        quantityLiters,
        undefined,
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
      undefined,
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
