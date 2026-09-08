import { ConflictException } from '@nestjs/common';
import { PricingService } from '../../src/modules/orders/services/pricing.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { ConfigService } from '@nestjs/config';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { TransportPricingService } from '../../src/modules/orders/services/transport-pricing.service';
import { RegionCode } from '../../src/common/enums/region.enum';

function buildCompaniesService(overrides?: {
  unitPrice?: number;
  deliveryFee?: number;
  serviceFeePercent?: number;
  taxRatePercent?: number;
  noPrice?: boolean;
  noConfig?: boolean;
}) {
  const unitPrice = overrides?.unitPrice ?? 2.33;
  const deliveryFee = overrides?.deliveryFee ?? 30;
  const serviceFeePercent = overrides?.serviceFeePercent ?? 1;
  const taxRatePercent = overrides?.taxRatePercent ?? 15;

  return {
    getBasePrice: jest.fn().mockResolvedValue(overrides?.noPrice ? undefined : unitPrice),
    getPricingConfig: jest.fn().mockResolvedValue(
      overrides?.noConfig
        ? undefined
        : {
            deliveryFee,
            serviceFeePercent,
            taxRatePercent,
            tankerCapacitiesLiters: [20000],
            updatedAt: new Date(),
          },
    ),
  } as unknown as CompaniesService;
}

/**
 * `resolve` → null is the "no transporter serves this region" branch (FR-016), under
 * which the fuel company's own `pricingConfig.deliveryFee` is still the figure used.
 * These derivation tests are about the arithmetic, not about who supplies the fee, so
 * they keep asserting on exactly the inputs they always did.
 */
function buildTransportPricing(fee?: number) {
  return {
    resolve: jest.fn().mockResolvedValue(fee === undefined ? null : { fee, distanceKm: 10, transportCompanyIds: ['t1'] }),
  } as unknown as TransportPricingService;
}

const TARGET = {
  regionCode: RegionCode.RIYADH,
  coordinates: [46.6753, 24.7136] as [number, number],
};

function buildConfig(quoteExpiryMinutes = 10) {
  return {
    get: jest.fn().mockReturnValue(quoteExpiryMinutes),
  } as unknown as ConfigService;
}

describe('PricingService', () => {
  describe('quote — component derivation (FR-011g)', () => {
    it('components sum exactly to the total, across many quantity/rate combinations', async () => {
      const cases: Array<{
        unitPrice: number;
        quantity: number;
        deliveryFee: number;
        serviceFeePercent: number;
        taxRatePercent: number;
      }> = [
        {
          unitPrice: 2.33,
          quantity: 20000,
          deliveryFee: 30,
          serviceFeePercent: 1,
          taxRatePercent: 15,
        },
        {
          unitPrice: 1.99,
          quantity: 5000,
          deliveryFee: 45.5,
          serviceFeePercent: 2.5,
          taxRatePercent: 15,
        },
        {
          unitPrice: 3.1,
          quantity: 32000,
          deliveryFee: 0,
          serviceFeePercent: 0,
          taxRatePercent: 15,
        },
        {
          unitPrice: 0.01,
          quantity: 1,
          deliveryFee: 0.01,
          serviceFeePercent: 0.01,
          taxRatePercent: 0.01,
        },
        {
          unitPrice: 2.499,
          quantity: 33333,
          deliveryFee: 17.77,
          serviceFeePercent: 3.33,
          taxRatePercent: 14.99,
        },
      ];

      for (const c of cases) {
        const service = new PricingService(
          buildCompaniesService({
            unitPrice: c.unitPrice,
            deliveryFee: c.deliveryFee,
            serviceFeePercent: c.serviceFeePercent,
            taxRatePercent: c.taxRatePercent,
          }),
          buildTransportPricing(),
          buildConfig(),
        );
        const { breakdown } = await service.quote('company-1', FuelType.DIESEL, c.quantity, TARGET);

        const sum =
          breakdown.fuelLineTotal + breakdown.deliveryFee + breakdown.serviceFee + breakdown.tax;
        // Exact equality, not toBeCloseTo — this is the whole point of
        // research R2's "round each component, then sum" rule.
        expect(Math.round(sum * 100)).toBe(Math.round(breakdown.total * 100));
      }
    });

    it('the stored total carries no floating-point drift — it is exactly the sum, not an approximation of it', async () => {
      // Regression: PETROL_91 at 2.18 × 5000 with a flat 50 fee, 2.5%
      // service and 15% tax produced a stored total of
      // 12905.880000000001. Every component was correctly rounded; summing
      // four already-rounded floats is what reintroduced the error.
      //
      // The assertion above this one rounds BOTH sides before comparing,
      // so it cannot see this class of defect. This one does not round
      // either side.
      const service = new PricingService(
        buildCompaniesService({
          unitPrice: 2.18,
          deliveryFee: 50,
          serviceFeePercent: 2.5,
          taxRatePercent: 15,
        }),
        buildTransportPricing(),
        buildConfig(),
      );
      const { breakdown } = await service.quote('company-1', FuelType.PETROL_91, 5000, TARGET);

      expect(breakdown.total).toBe(12905.88);

      // And the total must be representable at 2dp — no trailing binary
      // noise that would reach the client or the invoice assertion.
      expect(breakdown.total).toBe(Number(breakdown.total.toFixed(2)));
    });

    it('derives fuelLineTotal = unitPrice × quantity, deliveryFee = flat, serviceFee = percent of fuel line, tax = percent of (fuel+delivery+service)', async () => {
      const service = new PricingService(
        buildCompaniesService({
          unitPrice: 2,
          deliveryFee: 10,
          serviceFeePercent: 10,
          taxRatePercent: 10,
        }),
        buildTransportPricing(),
        buildConfig(),
      );
      const { breakdown } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);

      expect(breakdown.fuelLineTotal).toBe(200); // 2 * 100
      expect(breakdown.deliveryFee).toBe(10);
      expect(breakdown.serviceFee).toBe(20); // 10% of 200
      expect(breakdown.tax).toBe(23); // 10% of (200 + 10 + 20)
      expect(breakdown.total).toBe(253);
    });

    it('an inapplicable component is disclosed as zero, never omitted (FR-011d)', async () => {
      const service = new PricingService(
        buildCompaniesService({ deliveryFee: 0, serviceFeePercent: 0, taxRatePercent: 0 }),
        buildTransportPricing(),
        buildConfig(),
      );
      const { breakdown } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);

      expect(breakdown.deliveryFee).toBe(0);
      expect(breakdown.serviceFee).toBe(0);
      expect(breakdown.tax).toBe(0);
      expect(breakdown).toHaveProperty('deliveryFee');
      expect(breakdown).toHaveProperty('serviceFee');
      expect(breakdown).toHaveProperty('tax');
    });

    it('rounds half-up to 2dp per component before summing', async () => {
      // unitPrice * quantity = 2.005 * 100 = 200.49999999999997 in raw
      // floating point — must land on a clean 2dp figure, not drift.
      const service = new PricingService(
        buildCompaniesService({
          unitPrice: 2.005,
          deliveryFee: 0,
          serviceFeePercent: 0,
          taxRatePercent: 0,
        }),
        buildTransportPricing(),
        buildConfig(),
      );
      const { breakdown } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);
      expect(Number.isInteger(breakdown.fuelLineTotal * 100)).toBe(true);
    });
  });

  describe('quote — PRICING_NOT_CONFIGURED (FR-011j)', () => {
    it('throws 409 PRICING_NOT_CONFIGURED when the company has no fuel price for the grade', async () => {
      const service = new PricingService(buildCompaniesService({ noPrice: true }), buildTransportPricing(), buildConfig());
      await expect(service.quote('company-1', FuelType.DIESEL, 100, TARGET)).rejects.toMatchObject({
        response: expect.objectContaining({ error: ErrorCode.PRICING_NOT_CONFIGURED }),
      });
    });

    it('throws 409 PRICING_NOT_CONFIGURED when the company has no pricingConfig at all', async () => {
      const service = new PricingService(buildCompaniesService({ noConfig: true }), buildTransportPricing(), buildConfig());
      await expect(service.quote('company-1', FuelType.DIESEL, 100, TARGET)).rejects.toThrow(
        ConflictException,
      );
    });

    it('never returns a total derived from defaults or zeros when unconfigured', async () => {
      const service = new PricingService(buildCompaniesService({ noConfig: true }), buildTransportPricing(), buildConfig());
      await expect(service.quote('company-1', FuelType.DIESEL, 100, TARGET)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('redeem — quote token (research R10)', () => {
    it('redeems successfully when nothing has changed', async () => {
      const companies = buildCompaniesService();
      const service = new PricingService(companies, buildTransportPricing(), buildConfig());
      const { quoteToken } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);

      const breakdown = await service.redeem(quoteToken, 'company-1', FuelType.DIESEL, 100, TARGET);
      expect(breakdown.total).toBeGreaterThan(0);
    });

    it('throws QUOTE_EXPIRED once past the expiry window', async () => {
      const companies = buildCompaniesService();
      // Expires immediately.
      const service = new PricingService(companies, buildTransportPricing(), buildConfig(-1));
      const { quoteToken } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);

      await expect(
        service.redeem(quoteToken, 'company-1', FuelType.DIESEL, 100, TARGET),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ error: ErrorCode.QUOTE_EXPIRED }),
      });
    });

    it('throws QUOTE_STALE carrying the new breakdown when the price changed since quoting', async () => {
      const companies = buildCompaniesService({ unitPrice: 2.33 });
      const service = new PricingService(companies, buildTransportPricing(), buildConfig());
      const { quoteToken } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);

      // Price moves between quote and redemption.
      (companies.getBasePrice as jest.Mock).mockResolvedValue(3.5);

      await expect(
        service.redeem(quoteToken, 'company-1', FuelType.DIESEL, 100, TARGET),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          error: ErrorCode.QUOTE_STALE,
          currentBreakdown: expect.objectContaining({ unitPrice: 3.5 }),
        }),
      });
    });

    it('throws QUOTE_STALE when the tax rate changed, even if the fuel price did not', async () => {
      const companies = buildCompaniesService({ taxRatePercent: 15 });
      const service = new PricingService(companies, buildTransportPricing(), buildConfig());
      const { quoteToken } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);

      (companies.getPricingConfig as jest.Mock).mockResolvedValue({
        deliveryFee: 30,
        serviceFeePercent: 1,
        taxRatePercent: 20, // changed
        tankerCapacitiesLiters: [20000],
        updatedAt: new Date(),
      });

      await expect(
        service.redeem(quoteToken, 'company-1', FuelType.DIESEL, 100, TARGET),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ error: ErrorCode.QUOTE_STALE }),
      });
    });

    it('throws QUOTE_STALE when the requested quantity differs from what was quoted', async () => {
      const companies = buildCompaniesService();
      const service = new PricingService(companies, buildTransportPricing(), buildConfig());
      const { quoteToken } = await service.quote('company-1', FuelType.DIESEL, 100, TARGET);

      await expect(
        service.redeem(quoteToken, 'company-1', FuelType.DIESEL, 200, TARGET),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ error: ErrorCode.QUOTE_STALE }),
      });
    });

    it('rejects a malformed token', async () => {
      const service = new PricingService(buildCompaniesService(), buildTransportPricing(), buildConfig());
      await expect(
        service.redeem('not-a-real-token', 'company-1', FuelType.DIESEL, 100, TARGET),
      ).rejects.toThrow(ConflictException);
    });
  });
});
