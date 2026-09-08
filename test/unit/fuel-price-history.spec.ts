import { NotFoundException } from '@nestjs/common';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { FuelType } from '../../src/common/enums/fuel-type.enum';

interface StoredPrice {
  fuelType: FuelType;
  basePricePerLiter: number;
  previousPricePerLiter?: number;
  priceChangedAt?: Date;
}

/**
 * `setFuelPrices` receives the WHOLE price list on every save, because the dashboard
 * sends every grade back when one is edited. That is what makes the naive
 * `findByIdAndUpdate({ fuelPrices })` wrong once history exists: it would stamp all
 * five grades as "just changed" whenever any one of them was touched, so "آخر تحديث"
 * would report when the form was last opened and every change percentage would read
 * 0.00%. These assert history advances per grade, and only on a real move.
 */
function buildService(existing: StoredPrice[] | null) {
  const saved: { fuelPrices?: StoredPrice[] } = {};
  const companyModel = {
    findById: jest.fn().mockReturnValue({
      select: () => ({
        lean: () => ({ exec: async () => (existing ? { fuelPrices: existing } : null) }),
      }),
    }),
    findByIdAndUpdate: jest.fn().mockImplementation((_id, update) => {
      saved.fuelPrices = update.fuelPrices;
      return { exec: async () => ({ fuelPrices: update.fuelPrices }) };
    }),
  };
  const service = new CompaniesService(companyModel as never);
  return { service, saved };
}

const priceFor = (list: StoredPrice[] | undefined, type: FuelType) =>
  (list ?? []).find((p) => p.fuelType === type)!;

describe('Fuel price history (spec 013 successor — the data the dashboard was missing)', () => {
  it('records no previous value the first time a grade is priced', async () => {
    // "Never changed" is not "changed by nothing": inventing a previous value here
    // would render as a permanent 0.00% change, which is exactly the fabricated
    // element this work exists to replace with a real one.
    const { service, saved } = buildService([]);

    await service.setFuelPrices('c1', [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.1 },
    ]);

    const diesel = priceFor(saved.fuelPrices, FuelType.DIESEL);
    expect(diesel.basePricePerLiter).toBe(2.1);
    expect(diesel.previousPricePerLiter).toBeUndefined();
    expect(diesel.priceChangedAt).toBeUndefined();
  });

  it('moves the current value into previous when a grade actually changes', async () => {
    const { service, saved } = buildService([
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.05 },
    ]);

    await service.setFuelPrices('c1', [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.1 },
    ]);

    const diesel = priceFor(saved.fuelPrices, FuelType.DIESEL);
    expect(diesel.previousPricePerLiter).toBe(2.05);
    expect(diesel.priceChangedAt).toBeInstanceOf(Date);
  });

  it('leaves the untouched grades\' history exactly as it was', async () => {
    // The defect this pins: editing DIESEL must not restamp PETROL_91.
    const longAgo = new Date('2026-08-01T06:00:00.000Z');
    const { service, saved } = buildService([
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.05 },
      {
        fuelType: FuelType.PETROL_91,
        basePricePerLiter: 2.33,
        previousPricePerLiter: 2.18,
        priceChangedAt: longAgo,
      },
    ]);

    await service.setFuelPrices('c1', [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.1 },
      { fuelType: FuelType.PETROL_91, basePricePerLiter: 2.33 },
    ]);

    const petrol = priceFor(saved.fuelPrices, FuelType.PETROL_91);
    expect(petrol.previousPricePerLiter).toBe(2.18);
    expect(petrol.priceChangedAt).toBe(longAgo);
  });

  it('keeps history across a second change, always against the immediately prior value', async () => {
    const { service, saved } = buildService([
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.1, previousPricePerLiter: 2.05 },
    ]);

    await service.setFuelPrices('c1', [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 1.79 },
    ]);

    expect(priceFor(saved.fuelPrices, FuelType.DIESEL).previousPricePerLiter).toBe(2.1);
  });

  it('refuses an unknown company before writing anything', async () => {
    const { service, saved } = buildService(null);

    await expect(
      service.setFuelPrices('missing', [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.1 }]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(saved.fuelPrices).toBeUndefined();
  });
});
