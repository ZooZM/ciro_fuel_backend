import { ConflictException } from '@nestjs/common';
import { TransportPricingService } from '../../src/modules/orders/services/transport-pricing.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { WarehousesService } from '../../src/modules/warehouses/warehouses.service';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { RegionCode, GovernorateCode } from '../../src/common/enums/region.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

const TARGET = {
  regionCode: RegionCode.MAKKAH,
  governorateCode: GovernorateCode.JEDDAH,
  coordinates: [39.1925, 21.4858] as [number, number],
};

function build(deliveryRates: unknown[], distanceMeters: number | null = 50_000) {
  const companies = {
    findById: jest.fn().mockResolvedValue({ _id: 't1', deliveryRates }),
  } as unknown as CompaniesService;
  const warehouses = {
    findNearestSupplying: jest
      .fn()
      .mockResolvedValue(distanceMeters === null ? null : { distanceMeters }),
  } as unknown as WarehousesService;
  return new TransportPricingService(companies, warehouses);
}

/**
 * The question this service answers changed shape.
 *
 * It used to be "what does the haul cost?" asked at QUOTE time, before anyone
 * knew who would haul it — so it had to reason about every transporter serving
 * the region at once, and two of its rules existed only to cope with not
 * knowing: it refused outright when two candidates priced the same haul
 * differently (`TRANSPORT_PRICE_AMBIGUOUS`, because choosing between them is
 * the fuel company's call and had not been made), and it returned `null` when
 * none served the region, so the caller could fall back to the FUEL company's
 * own flat fee for a haul that company does not perform.
 *
 * It is now asked at ROUTING time, of ONE named company — the one that will
 * actually do it. Both of those rules, and the tests that pinned them, are gone
 * with the uncertainty that required them. What survives is everything about
 * how a single company's rate turns into a fee.
 */
describe('Transport price for the company that will actually haul it', () => {
  it("prices from the company's own rate, floored by its minimum", async () => {
    // 50 km × 1.8 = 90, below the 120 minimum: a short haul still costs a truck
    // and a driver, so the floor is what is charged.
    const service = build([{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }]);

    expect(await service.feeForCompany('t1', TARGET, FuelType.DIESEL)).toBe(120);
  });

  it('uses per-km once it exceeds the floor', async () => {
    const service = build(
      [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }],
      200_000,
    );

    expect(await service.feeForCompany('t1', TARGET, FuelType.DIESEL)).toBe(360);
  });

  it("prefers a governorate rate over its own region's", async () => {
    // Without most-specific-first, a transporter could not charge more for one
    // hard-to-reach governorate without re-pricing the whole region.
    const service = build([
      { regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 },
      {
        regionCode: RegionCode.MAKKAH,
        governorateCode: GovernorateCode.JEDDAH,
        pricePerKm: 2.4,
        minPrice: 500,
      },
    ]);

    expect(await service.feeForCompany('t1', TARGET, FuelType.DIESEL)).toBe(500);
  });

  it('REFUSES when the chosen company has priced no covering area', async () => {
    // The one refusal that survives, and it matters more than before: this
    // company is the one that will haul the order. A price it never set is not
    // a price, and routing to it would leave an order nobody can bill.
    const service = build([]);

    await expect(service.feeForCompany('t1', TARGET, FuelType.DIESEL)).rejects.toMatchObject({
      response: expect.objectContaining({ error: ErrorCode.TRANSPORT_PRICE_NOT_SET }),
    });
  });

  it('refuses when no warehouse supplies the grade, since there is no distance', async () => {
    const service = build([{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }], null);

    await expect(service.feeForCompany('t1', TARGET, FuelType.DIESEL)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
