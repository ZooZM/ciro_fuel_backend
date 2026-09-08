import { ConflictException, Injectable } from '@nestjs/common';
import { CompaniesService } from '../../companies/companies.service';
import { WarehousesService } from '../../warehouses/warehouses.service';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { GovernorateCode, RegionCode } from '../../../common/enums/region.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { roundCurrency } from '../../../common/constants/money.constants';
import { DeliveryRate } from '../../companies/schemas/company.schema';

/** Where the delivery is going — everything the transport price depends on. */
export interface DeliveryTarget {
  regionCode: RegionCode;
  governorateCode?: GovernorateCode;
  /** GeoJSON order: [longitude, latitude]. */
  coordinates: [number, number];
}

export interface ResolvedTransportPrice {
  fee: number;
  distanceKm: number;
  /** Every transporter whose rate produced this fee — one, or several that agree. */
  transportCompanyIds: string[];
}

/**
 * Resolves what delivery costs, from the rates the TRANSPORT companies set
 * themselves (`Company.deliveryRates`) rather than from the fuel company's flat
 * `pricingConfig.deliveryFee`.
 *
 * Three facts make this resolvable before any transporter has been chosen:
 *
 * 1. the client's station region is known at quote time, and
 *    `CompaniesService.findServingTransporters` — the SAME rule `RoutingService`
 *    uses to route the order later — turns it into the candidate set;
 * 2. warehouses are platform infrastructure with no owner, so
 *    `findNearestSupplying` gives a real haul distance from the same query, and
 *    with the same arguments, `DispatchService` will use at assignment; and
 * 3. where the candidates disagree on the price, the platform REFUSES rather than
 *    choosing one (FR-014 leaves that choice to the fuel company, and it is made
 *    after the invoice is issued).
 *
 * The third is the load-bearing one. Quoting the cheapest candidate would be the
 * obvious implementation and would be wrong: the client would be shown a price the
 * transporter who actually hauls never agreed to, and the difference would surface
 * as a settlement discrepancy long after anyone could connect it to this decision.
 */
@Injectable()
export class TransportPricingService {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly warehousesService: WarehousesService,
  ) {}

  /**
   * A governorate rate wins over its region's — most specific first. Without that
   * ordering a transporter could not price one hard-to-reach governorate above the
   * region it sits in.
   */
  private rateFor(rates: DeliveryRate[], target: DeliveryTarget): DeliveryRate | undefined {
    return (
      rates.find(
        (r) =>
          r.regionCode === target.regionCode &&
          target.governorateCode !== undefined &&
          r.governorateCode === target.governorateCode,
      ) ?? rates.find((r) => r.regionCode === target.regionCode && !r.governorateCode)
    );
  }

  /**
   * `null` when NO transporter of this fuel company serves the region at all.
   *
   * That is not an error here and must not be: it is the pre-existing FR-016 case,
   * where an order is placed, held at AWAITING_ROUTING, and routed by hand later.
   * Refusing it at quote time would stop clients in an unserved region from ordering
   * at all — a behaviour change well beyond moving who sets the price. The caller
   * falls back to the fuel company's own configured fee for that case alone.
   */
  async resolve(
    fuelCompanyId: string,
    target: DeliveryTarget,
    fuelType: FuelType,
  ): Promise<ResolvedTransportPrice | null> {
    const candidates = await this.companiesService.findServingTransporters(
      fuelCompanyId,
      target.regionCode,
    );
    if (candidates.length === 0) return null;

    const warehouse = await this.warehousesService.findNearestSupplying(
      target.coordinates,
      fuelType,
    );
    if (!warehouse) {
      throw new ConflictException({
        error: ErrorCode.NO_WAREHOUSE_FOR_GRADE,
        message: 'No in-service warehouse supplies this order’s fuel grade',
      });
    }
    // `$geoNear` attaches the spherical distance in metres to the returned document.
    const distanceKm =
      (warehouse as unknown as { distanceMeters?: number }).distanceMeters !== undefined
        ? (warehouse as unknown as { distanceMeters: number }).distanceMeters / 1000
        : 0;

    const priced: { companyId: string; fee: number }[] = [];
    for (const candidate of candidates) {
      const rate = this.rateFor(candidate.deliveryRates ?? [], target);
      if (!rate) {
        // One unpriced serving transporter blocks the quote, rather than being
        // quietly skipped: the fuel company may route the order to exactly that
        // transporter, and a price it never set is not a price.
        throw new ConflictException({
          error: ErrorCode.TRANSPORT_PRICE_NOT_SET,
          message: 'A transport company serving this area has not set its delivery price',
        });
      }
      priced.push({
        companyId: String(candidate._id),
        fee: roundCurrency(Math.max(rate.minPrice, distanceKm * rate.pricePerKm)),
      });
    }

    const fees = new Set(priced.map((p) => p.fee));
    if (fees.size > 1) {
      throw new ConflictException({
        error: ErrorCode.TRANSPORT_PRICE_AMBIGUOUS,
        message:
          'More than one transport company serves this area at different prices — the fuel company must choose one before this order can be priced',
      });
    }

    return {
      fee: priced[0].fee,
      distanceKm,
      transportCompanyIds: priced.map((p) => p.companyId),
    };
  }
}
