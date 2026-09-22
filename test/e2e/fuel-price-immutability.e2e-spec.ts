import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T098/FR-039, quickstart 1.16 — a fuel price
 * change must never retroactively alter the cost already recorded on an order placed
 * before it. The platform already guarantees this by construction
 * (`OrdersService.create` reads `Company.fuelPrices` once via `getBasePrice` and snapshots
 * the result onto `estimatedPrice`; nothing ever re-derives it later) — this test asserts
 * that property rather than adding it.
 */
describe('Fuel price changes do not alter orders already placed (FR-039)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it("leaves a pre-existing order's estimatedPrice untouched after the grade price changes, while a new order picks up the new price", async () => {
    const server = app.getHttpServer();
    const { admin, client, companyId } = fixtures.companyA;

    // Fixture seeds DIESEL at 2.5/L with a 1% service fee and 15% VAT
    // (test/utils/fixtures.ts). An order placed without a quote token is priced
    // through the same derivation as a quoted one, so the estimate is the full
    // total rather than the bare fuel line it used to be. Expressed as a
    // function of the unit price, because what this test is about is which
    // PRICE applies, not what the surrounding fees happen to be.
    const pricedAt = (unitPrice: number) => Math.round(unitPrice * 500 * 1.01 * 1.15 * 100) / 100;

    const before = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500 })
      .expect(201);
    expect(before.body.estimatedPrice).toBeCloseTo(pricedAt(2.5), 2);

    // Replace the whole fuelPrices set (PUT is a full-array write) — DIESEL jumps to 9.99,
    // PETROL_91 carried forward unchanged so this isn't mistaken for clearing it.
    await request(server)
      .put(`/api/v1/companies/${companyId}/fuel-prices`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        prices: [
          { fuelType: 'DIESEL', basePricePerLiter: 9.99 },
          { fuelType: 'PETROL_91', basePricePerLiter: 2.2 },
        ],
      })
      .expect(200);

    // The order placed before the change is untouched.
    const reread = await request(server)
      .get(`/api/v1/orders/${before.body._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    // Unchanged — asserted against the order's own earlier value, so this
    // cannot pass merely because both sides were recomputed the same new way.
    expect(reread.body.estimatedPrice).toBe(before.body.estimatedPrice);

    // A new order placed after the change picks up the new rate — proving the earlier
    // order's stability isn't because the price write silently failed.
    const after = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500 })
      .expect(201);
    expect(after.body.estimatedPrice).toBeCloseTo(pricedAt(9.99), 2);
  });
});
