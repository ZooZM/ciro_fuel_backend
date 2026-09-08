import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedThreeFuelCompanies, ThreeFuelCompanyFixture } from '../utils/fixtures';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { FuelType } from '../../src/common/enums/fuel-type.enum';

jest.setTimeout(120_000);

/**
 * spec 016 (broadcast fuel exchange offers) T071/FR-014a/SC-005/research R4 — the SAME
 * class of race feature 009's concurrent assignment hit, where two transactions each
 * passed their own read-time filter under snapshot isolation and collided only at
 * commit. The award transaction's conditional `findOneAndUpdate({ state: OPEN }, ...)`
 * is the guard; this test proves it holds under genuine concurrency, not merely that
 * the code path exists.
 */
describe('Exchange offer award — the race (US3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: ThreeFuelCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedThreeFuelCompanies(app);
    // Both B and C answer the same PETROL_95 offer in this suite — C is granted the
    // grade for this file alone (research R11's shared fixture keeps "C is
    // diesel-only" for every other suite).
    const companiesService = app.get(CompaniesService);
    await companiesService.setFuelPrices(fixtures.companyC.companyId, [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 },
      { fuelType: FuelType.PETROL_95, basePricePerLiter: 2.6 },
    ]);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  function raiseBody() {
    return {
      fuelType: 'PETROL_95',
      quantityLitres: 10000,
      deliveryAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      city: 'JEDDAH',
    };
  }

  it('two simultaneous awards of DIFFERENT proposals on the same offer: exactly one stands, the other is refused as already resolved', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;
    const { admin: adminC } = fixtures.companyC;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;

    const proposalB = await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ unitPrice: 2.2 })
      .expect(201);
    const proposalC = await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminC.token}`)
      .send({ unitPrice: 2.3 })
      .expect(201);

    const [awardB, awardC] = await Promise.all([
      request(server)
        .post(`/api/v1/fuel-exchange/offers/${id}/award`)
        .set('Authorization', `Bearer ${adminA.token}`)
        .send({ proposalId: proposalB.body._id }),
      request(server)
        .post(`/api/v1/fuel-exchange/offers/${id}/award`)
        .set('Authorization', `Bearer ${adminA.token}`)
        .send({ proposalId: proposalC.body._id }),
    ]);

    const statuses = [awardB.status, awardC.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = awardB.status === 409 ? awardB : awardC;
    expect(loser.body.error).toBe('EXCHANGE_ALREADY_RESOLVED');

    const final = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${id}`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(final.body.state).toBe('AWARDED');
    // Exactly one of B/C's proposals is AWARDED, the other NOT_SELECTED.
    const outcomes = final.body.proposals.map((p: { outcome: string }) => p.outcome).sort();
    expect(outcomes).toEqual(['AWARDED', 'NOT_SELECTED']);
  });

  it('a second award attempt on an already-awarded offer is refused (FR-014a)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;
    const proposal = await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ unitPrice: 2.2 })
      .expect(201);

    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/award`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ proposalId: proposal.body._id })
      .expect(200);

    const second = await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/award`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ proposalId: proposal.body._id })
      .expect(409);
    expect(second.body.error).toBe('EXCHANGE_ALREADY_RESOLVED');
  });
});
