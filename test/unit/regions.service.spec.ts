import { RegionsService } from '../../src/modules/regions/regions.service';
import {
  governorateBelongsToRegion,
  isValidGovernorateCode,
  isValidRegionCode,
} from '../../src/modules/regions/regions.constants';
import { GovernorateCode, RegionCode } from '../../src/common/enums/region.enum';

describe('RegionsService / region reference data', () => {
  const service = new RegionsService();

  it('lists exactly the 13 Saudi regions', () => {
    const regions = service.list();
    expect(regions).toHaveLength(13);
    expect(new Set(regions.map((r) => r.code)).size).toBe(13);
  });

  it('gives every region both an Arabic and an English name', () => {
    for (const region of service.list()) {
      expect(region.nameAr.length).toBeGreaterThan(0);
      expect(region.nameEn.length).toBeGreaterThan(0);
    }
  });

  it('gives every region at least one governorate', () => {
    for (const region of service.list()) {
      expect(region.governorates.length).toBeGreaterThan(0);
    }
  });

  it('flattens every governorate exactly once, matching its parent region', () => {
    const flat = service.listGovernorates();
    const nested = service.list().flatMap((r) => r.governorates.map((g) => ({ g, r: r.code })));
    expect(flat).toHaveLength(nested.length);
    for (const { g, r } of nested) {
      const entry = flat.find((f) => f.code === g);
      expect(entry).toBeDefined();
      expect(entry!.region).toBe(r);
    }
  });

  it('validates a real region code and rejects an unknown one', () => {
    expect(isValidRegionCode(RegionCode.RIYADH)).toBe(true);
    expect(isValidRegionCode('NOT_A_REGION')).toBe(false);
  });

  it('validates a real governorate code and rejects an unknown one', () => {
    expect(isValidGovernorateCode(GovernorateCode.JEDDAH)).toBe(true);
    expect(isValidGovernorateCode('NOT_A_GOVERNORATE')).toBe(false);
  });

  it('confirms governorate-to-region membership correctly, both ways', () => {
    expect(governorateBelongsToRegion(GovernorateCode.JEDDAH, RegionCode.MAKKAH)).toBe(true);
    expect(governorateBelongsToRegion(GovernorateCode.JEDDAH, RegionCode.RIYADH)).toBe(false);
  });
});
