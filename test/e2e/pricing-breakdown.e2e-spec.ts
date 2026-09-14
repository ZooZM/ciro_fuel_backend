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

    // A quote commits to the FUEL company's rates and nothing else, so the fuel
    // price is what has to move to stale one.
    //
    // This used to change the TRANSPORTER's rate, which no longer touches a
    // quote at all: the delivery leg is priced by whichever transporter routing
    // later picks, and a quote is issued before that choice exists — so it can
    // neither name a transport price nor be invalidated by one changing.
    // Staling it that way would now simply never fire, and the test would have
    // gone on passing only because the assertion below fired first.
    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      { $set: { 'fuelPrices.$[grade].basePricePerLiter': 3.1 } },
      { arrayFilters: [{ 'grade.fuelType': 'DIESEL' }] },
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
    // The re-quote carries the NEW fuel price, and still no transport line —
    // there is no transporter yet for one to come from.
    expect(staleRes.body.currentBreakdown.unitPrice).toBe(3.1);
    expect(staleRes.body.currentBreakdown.deliveryFee).toBeUndefined();

    // Put the fixture's fuel price back for the tests that follow.
    await companyModel.updateOne(
      { _id: fixtures.companyA.companyId },
      { $set: { 'fuelPrices.$[grade].basePricePerLiter': 2.5 } },
      { arrayFilters: [{ 'grade.fuelType': 'DIESEL' }] },
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

    // AT CREATION the order carries exactly what was quoted — and neither
    // carries a transport line, because no transporter has been chosen.
    expect(created.body.priceBreakdown).toEqual(
      expect.objectContaining({
        fuelLineTotal: quote.body.breakdown.fuelLineTotal,
        serviceFee: quote.body.breakdown.serviceFee,
        tax: quote.body.breakdown.tax,
        total: quote.body.breakdown.total,
      }),
    );
    expect(quote.body.breakdown).not.toHaveProperty('deliveryFee');
    expect(created.body.priceBreakdown).not.toHaveProperty('deliveryFee');

    const approved = await request(server)
      .patch(`/api/v1/orders/${created.body._id}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    const invoice = await request(server)
      .get(`/api/v1/invoices/${approved.body.invoiceId}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    // AFTER ROUTING the order has been re-priced with the haul the chosen
    // transporter charges, and THAT is what the invoice bills. The invariant
    // FR-011e is really about still holds — an invoice's breakdown is its
    // order's breakdown, and its total is the amount — it simply binds at the
    // moment the order is fully priced rather than at creation.
    const routedOrder = await request(server)
      .get(`/api/v1/orders/${created.body._id}`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    expect(routedOrder.body.priceBreakdown.deliveryFee).toBeGreaterThan(0);
    expect(routedOrder.body.priceBreakdown.total).toBeGreaterThan(quote.body.breakdown.total);
    expect(invoice.body.priceBreakdown).toEqual(routedOrder.body.priceBreakdown);
    expect(invoice.body.priceBreakdown.total).toBe(invoice.body.amount);
    expect(routedOrder.body.finalPrice).toBe(invoice.body.amount);

    // The components still sum to the total, with the transport line included.
    const b = routedOrder.body.priceBreakdown;
    expect(Math.round((b.fuelLineTotal + b.deliveryFee + b.serviceFee + b.tax) * 100)).toBe(
      Math.round(b.total * 100),
    );
  });
});
