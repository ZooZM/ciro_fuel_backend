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
   * What THIS transport company charges to haul THIS order.
   *
   * The delivery leg is priced by the company that performs it, and that
   * company is chosen at routing — so this is called once, by
   * `RoutingService`, at the moment routing resolves, and never before.
   *
   * It replaces the old `resolve()`, which had to answer the same question
   * before anyone knew who the hauler would be. That forced two rules the
   * platform no longer needs: it REFUSED the whole quote when any serving
   * transporter had not set a rate (`TRANSPORT_PRICE_NOT_SET`, even when the
   * order would never be routed to that one), and it refused again when two
   * candidates priced the same haul differently (`TRANSPORT_PRICE_AMBIGUOUS`),
   * because choosing between them is the fuel company's call and had not been
   * made yet. Asking after the choice makes both questions disappear.
   *
   * Still throws `TRANSPORT_PRICE_NOT_SET` when the CHOSEN company has no rate
   * for this area — a price it never set is not a price, and routing to it
   * would leave an order nobody can bill.
   */
  async feeForCompany(
    transportCompanyId: string,
    target: DeliveryTarget,
    fuelType: FuelType,
  ): Promise<number> {
    const company = await this.companiesService.findById(transportCompanyId);
    const rate = this.rateFor(company.deliveryRates ?? [], target);
    if (!rate) {
      throw new ConflictException({
        error: ErrorCode.TRANSPORT_PRICE_NOT_SET,
        message:
          'The transport company this order was routed to has not set a delivery price for this area',
      });
    }

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

    return roundCurrency(Math.max(rate.minPrice, distanceKm * rate.pricePerKm));
  }
}
