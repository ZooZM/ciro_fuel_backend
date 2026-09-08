import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { RegionCode, GovernorateCode } from '../../src/common/enums/region.enum';

type Rate = {
  regionCode: RegionCode;
  governorateCode?: GovernorateCode;
  pricePerKm: number;
  minPrice: number;
  updatedAt?: Date;
};

function buildService(existing: { type: CompanyType; deliveryRates: Rate[] } | null) {
  const saved: { deliveryRates?: Rate[] } = {};
  const companyModel = {
    findById: jest.fn().mockReturnValue({
      select: () => ({ lean: () => ({ exec: async () => existing }) }),
    }),
    findByIdAndUpdate: jest.fn().mockImplementation((_id, update) => {
      saved.deliveryRates = update.deliveryRates;
      return { exec: async () => ({ deliveryRates: update.deliveryRates }) };
    }),
  };
  return { service: new CompaniesService(companyModel as never), saved };
}

describe('Transport delivery rates — the transporter sets what delivery costs', () => {
  it('stores a rate set for a transport company', async () => {
    const { service, saved } = buildService({ type: CompanyType.TRANSPORT, deliveryRates: [] });

    await service.setDeliveryRates('t1', [
      { regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 },
    ]);

    expect(saved.deliveryRates).toHaveLength(1);
    expect(saved.deliveryRates![0].pricePerKm).toBe(1.8);
    expect(saved.deliveryRates![0].updatedAt).toBeInstanceOf(Date);
  });

  it('refuses a FUEL company outright', async () => {
    // A fuel company hauls nothing; its own delivery charge lives in pricingConfig.
    // Storing this on a FUEL document would put a price somewhere nothing reads it.
    const { service, saved } = buildService({ type: CompanyType.FUEL, deliveryRates: [] });

    await expect(
      service.setDeliveryRates('f1', [
        { regionCode: RegionCode.RIYADH, pricePerKm: 1, minPrice: 10 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved.deliveryRates).toBeUndefined();
  });

  it('leaves an unchanged area\'s updatedAt alone when another area is edited', async () => {
    // The client sends the whole set back when one row is edited, so a blind
    // overwrite would restamp every area on every save — the same defect the fuel
    // price history had, in a second place.
    const longAgo = new Date('2026-08-01T06:00:00.000Z');
    const { service, saved } = buildService({
      type: CompanyType.TRANSPORT,
      deliveryRates: [
        { regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120, updatedAt: longAgo },
        { regionCode: RegionCode.EASTERN_PROVINCE, pricePerKm: 2.0, minPrice: 150, updatedAt: longAgo },
      ],
    });

    await service.setDeliveryRates('t1', [
      { regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 },
      { regionCode: RegionCode.EASTERN_PROVINCE, pricePerKm: 2.2, minPrice: 150 },
    ]);

    const makkah = saved.deliveryRates!.find((r) => r.regionCode === RegionCode.MAKKAH)!;
    const eastern = saved.deliveryRates!.find((r) => r.regionCode === RegionCode.EASTERN_PROVINCE)!;
    expect(makkah.updatedAt).toBe(longAgo);
    expect(eastern.updatedAt).not.toBe(longAgo);
  });

  it('treats a governorate rate as a different area from its region', async () => {
    // Most-specific-first resolution depends on these being separate entries; if the
    // key ignored the governorate, pricing one governorate would silently overwrite
    // the region-wide rate.
    const longAgo = new Date('2026-08-01T06:00:00.000Z');
    const { service, saved } = buildService({
      type: CompanyType.TRANSPORT,
      deliveryRates: [
        { regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120, updatedAt: longAgo },
      ],
    });

    await service.setDeliveryRates('t1', [
      { regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 },
      { regionCode: RegionCode.MAKKAH, governorateCode: GovernorateCode.JEDDAH, pricePerKm: 2.4, minPrice: 200 },
    ]);

    expect(saved.deliveryRates).toHaveLength(2);
    const regionWide = saved.deliveryRates!.find((r) => !r.governorateCode)!;
    expect(regionWide.updatedAt).toBe(longAgo);
  });

  it('accepts an empty set as a withdrawal from every area', async () => {
    const { service, saved } = buildService({
      type: CompanyType.TRANSPORT,
      deliveryRates: [{ regionCode: RegionCode.MAKKAH, pricePerKm: 1.8, minPrice: 120 }],
    });

    await service.setDeliveryRates('t1', []);

    expect(saved.deliveryRates).toEqual([]);
  });

  it('refuses an unknown company before writing', async () => {
    const { service, saved } = buildService(null);

    await expect(service.setDeliveryRates('missing', [])).rejects.toBeInstanceOf(NotFoundException);
    expect(saved.deliveryRates).toBeUndefined();
  });
});
