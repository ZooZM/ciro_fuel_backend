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

function build(
  transporters: { _id: string; deliveryRates: unknown[] }[],
  distanceMeters: number | null = 50_000,
) {
  const companies = {
    findServingTransporters: jest.fn().mockResolvedValue(transporters),
  } as unknown as CompaniesService;
  const warehouses = {
    findNearestSupplying: jest
      .fn()
      .mockResolvedValue(distanceMeters === null ? null : { distanceMeters }),
  } as unknown as WarehousesService;
  return new TransportPricingService(companies, warehouses);
}

describe('Transport price resolution — refuse rather than guess', () => {
  it('prices from the transporter\'s own rate, floored by its minimum', async () => {
    // 50 km × 1.8 = 90, which is below the 120 minimum: a short haul still costs a
    // truck and a driver, so the floor is what is charged.
    const service = build([
      { _id: 't1', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }] },
    ]);

    const resolved = await service.resolve('f1', TARGET, FuelType.DIESEL);

    expect(resolved).toMatchObject({ fee: 120, distanceKm: 50, transportCompanyIds: ['t1'] });
  });

  it('uses per-km once it exceeds the floor', async () => {
    const service = build(
      [{ _id: 't1', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }] }],
      200_000,
    );

    expect((await service.resolve('f1', TARGET, FuelType.DIESEL))!.fee).toBe(360);
  });

  it('prefers a governorate rate over its own region\'s', async () => {
    // Without most-specific-first, a transporter could not charge more for one
    // hard-to-reach governorate without re-pricing the whole region.
    const service = build([
      {
        _id: 't1',
        deliveryRates: [
          { regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 },
          { regionCode: RegionCode.MAKKAH, governorateCode: GovernorateCode.JEDDAH, pricePerKm: 2.4, minPrice: 500 },
        ],
      },
    ]);

    expect((await service.resolve('f1', TARGET, FuelType.DIESEL))!.fee).toBe(500);
  });

  it('REFUSES when two serving transporters disagree on the price', async () => {
    // The choice of hauler is the fuel company's, made at routing — AFTER the invoice
    // is issued. Quoting the cheaper one would show the client a price the transporter
    // who actually hauls never agreed to.
    const service = build([
      { _id: 't1', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }] },
      { _id: 't2', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 300 }] },
    ]);

    await expect(service.resolve('f1', TARGET, FuelType.DIESEL)).rejects.toMatchObject({
      response: expect.objectContaining({ error: ErrorCode.TRANSPORT_PRICE_AMBIGUOUS }),
    });
  });

  it('does NOT refuse when several transporters agree on the price', async () => {
    // Ambiguity is about the price, not the head count — refusing here would block
    // orders for no reason a client could act on.
    const service = build([
      { _id: 't1', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }] },
      { _id: 't2', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }] },
    ]);

    const resolved = await service.resolve('f1', TARGET, FuelType.DIESEL);
    expect(resolved!.fee).toBe(120);
    expect(resolved!.transportCompanyIds).toEqual(['t1', 't2']);
  });

  it('REFUSES when a serving transporter has priced no covering area', async () => {
    // Skipping the unpriced transporter would be worse: the fuel company may route
    // this very order to it, and a price it never set is not a price.
    const service = build([
      { _id: 't1', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }] },
      { _id: 't2', deliveryRates: [] },
    ]);

    await expect(service.resolve('f1', TARGET, FuelType.DIESEL)).rejects.toMatchObject({
      response: expect.objectContaining({ error: ErrorCode.TRANSPORT_PRICE_NOT_SET }),
    });
  });

  it('returns null when no transporter serves the region at all', async () => {
    // FR-016's pre-existing case: the order is placed, held at AWAITING_ROUTING and
    // routed by hand. Refusing here would stop those clients ordering entirely — a
    // change well beyond moving who sets the price. The caller falls back.
    const service = build([]);

    expect(await service.resolve('f1', TARGET, FuelType.DIESEL)).toBeNull();
  });

  it('refuses when no warehouse supplies the grade, since there is no distance', async () => {
    const service = build(
      [{ _id: 't1', deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }] }],
      null,
    );

    await expect(service.resolve('f1', TARGET, FuelType.DIESEL)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
