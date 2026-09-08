import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { Company, CompanyDocument } from '../../src/modules/companies/schemas/company.schema';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(120_000);

/** spec 005 US2/T046-T048a — itemised pricing, quote tokens, and their
 * agreement across the quote, the order, and the issued invoice. */
describe('Pricing breakdown (spec 005 D3/FR-011)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let companyModel: Model<CompanyDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    companyModel = app.get(getModelToken(Company.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  async function ownStation(clientToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get('/api/v1/stations')
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    return res.body.items[0].id ?? res.body.items[0]._id;
  }

  it('T046: 409 PRICING_NOT_CONFIGURED when the company has no pricingConfig — never a total of zero', async () => {
    const { client } = fixtures.companyA;
    const stationId = await ownStation(client.token);
    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      { $unset: { pricingConfig: '' } },
    );

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 20000, stationId })
      .expect(409);
    expect(res.body.error).toBe(ErrorCode.PRICING_NOT_CONFIGURED);

    // Restore for the remaining tests in this file.
    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      {
        $set: {
          pricingConfig: {
            deliveryFee: 30,
            serviceFeePercent: 1,
            taxRatePercent: 15,
            tankerCapacitiesLiters: [20000, 22000, 32000],
            updatedAt: new Date(),
          },
        },
      },
    );
  });

  it("T047: changing pricingConfig after an order is placed leaves that order's priceBreakdown untouched (FR-011i)", async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const stationId = await ownStation(client.token);

    const quote = await request(server)
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 20000, stationId })
      .expect(201);

    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        fuelType: 'DIESEL',
        quantityLiters: 20000,
        paymentMethod: 'DEFERRED',
        stationId,
        quoteToken: quote.body.quoteToken,
      })
      .expect(201);
    const originalBreakdown = created.body.priceBreakdown;
    expect(originalBreakdown.total).toBeGreaterThan(0);

    // The company changes its rates after the order was placed.
    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      {
        $set: {
          'pricingConfig.deliveryFee': 999,
          'pricingConfig.serviceFeePercent': 50,
          'pricingConfig.taxRatePercent': 50,
        },
      },
    );

    const reread = await request(server)
      .get(`/api/v1/orders/${created.body._id}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(reread.body.priceBreakdown).toEqual(originalBreakdown);

    // Restore for the remaining tests.
    await companyModel.updateOne(
      { _id: fixtures.companyA.transportCompanyId },
      { $set: { 'deliveryRates.0.minPrice': 30 } },
    );
    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      {
        $set: {
          'pricingConfig.deliveryFee': 30,
          'pricingConfig.serviceFeePercent': 1,
          'pricingConfig.taxRatePercent': 15,
        },
      },
    );
    void admin;
  });

  it('T048: a stale quote token yields 409 QUOTE_STALE carrying the new breakdown; an expired one yields 409 QUOTE_EXPIRED', async () => {
    const { client } = fixtures.companyA;
    const server = app.getHttpServer();
    const stationId = await ownStation(client.token);

    // --- QUOTE_STALE: rates change between quote and redemption ---
    const quote = await request(server)
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 20000, stationId })
      .expect(201);

    // The delivery leg is priced by the TRANSPORT company that performs it, so the
    // rate that must move to stale a quote is the transporter's — changing the fuel
    // company's own `pricingConfig.deliveryFee` no longer affects a quote at all
    // wherever a transporter serves the region, and asserting on it here would have
    // gone on passing for the wrong reason. `pricePerKm: 0` keeps the fee distance-
    // independent, so 77 is exactly what the re-quote must come back with.
    await companyModel.updateOne(
      { _id: fixtures.companyA.transportCompanyId },
      { $set: { 'deliveryRates.0.minPrice': 77 } },
    );

    const staleRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        fuelType: 'DIESEL',
        quantityLiters: 20000,
        paymentMethod: 'DEFERRED',
        stationId,
        quoteToken: quote.body.quoteToken,
      })
      .expect(409);
    expect(staleRes.body.error).toBe(ErrorCode.QUOTE_STALE);
    expect(staleRes.body.currentBreakdown.deliveryFee).toBe(77);

    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      { $set: { 'pricingConfig.deliveryFee': 30 } },
    );

    // --- QUOTE_EXPIRED: a malformed/garbage token decodes to nonsense and
    // is rejected the same way an expired one would be (both 409, both
    // signal "get a fresh quote").
    const expiredRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        fuelType: 'DIESEL',
        quantityLiters: 20000,
        paymentMethod: 'DEFERRED',
        stationId,
        quoteToken: 'not-a-real-token',
      })
      .expect(409);
    expect(expiredRes.body.error).toBe(ErrorCode.QUOTE_EXPIRED);
  });

  it("T048a: the quote, the order's stored priceBreakdown and the issued invoice's priceBreakdown are identical, and each total equals the invoice amount (FR-011e, SC-008a)", async () => {
    const { client, admin } = fixtures.companyA;
    const server = app.getHttpServer();
    const stationId = await ownStation(client.token);

    const quote = await request(server)
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 20000, stationId })
      .expect(201);

    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        fuelType: 'DIESEL',
        quantityLiters: 20000,
        paymentMethod: 'DEFERRED',
        stationId,
        quoteToken: quote.body.quoteToken,
      })
      .expect(201);

    expect(created.body.priceBreakdown).toEqual(
      expect.objectContaining({
        fuelLineTotal: quote.body.breakdown.fuelLineTotal,
        deliveryFee: quote.body.breakdown.deliveryFee,
        serviceFee: quote.body.breakdown.serviceFee,
        tax: quote.body.breakdown.tax,
        total: quote.body.breakdown.total,
      }),
    );

    const approved = await request(server)
      .patch(`/api/v1/orders/${created.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const invoice = await request(server)
      .get(`/api/v1/invoices/${approved.body.invoiceId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    expect(invoice.body.priceBreakdown).toEqual(created.body.priceBreakdown);
    expect(invoice.body.priceBreakdown.total).toBe(invoice.body.amount);
  });
});
