import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedThreeFuelCompanies, ThreeFuelCompanyFixture } from '../utils/fixtures';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { FuelExchangeService } from '../../src/modules/fuel-exchange/fuel-exchange.service';
import {
  ExchangeOffer,
  ExchangeOfferDocument,
} from '../../src/modules/fuel-exchange/schemas/exchange-offer.schema';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(120_000);

/**
 * spec 016 (broadcast fuel exchange offers) T038/T038a — US1's independent test: one
 * submission reaches the whole eligible market, with no recipient and no price.
 */
describe('Exchange offers — raise to the market (US1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: ThreeFuelCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedThreeFuelCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  function raiseBody(overrides: Record<string, unknown> = {}) {
    return {
      fuelType: 'PETROL_95',
      quantityLitres: 20000,
      deliveryAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      city: 'JEDDAH',
      ...overrides,
    };
  }

  it('raise once produces exactly one offer, reaching B (eligible) but not C (diesel-only); A sees it outgoing; no price/recipient anywhere (SC-002)', async () => {
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
    expect(created.body.openToMarket).toBe(true);
    expect(created.body.state).toBe('OPEN');
    expect(created.body).not.toHaveProperty('unitPrice');
    expect(JSON.stringify(created.body)).not.toMatch(/recipientCompanyId/);

    const outgoing = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=outgoing')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(outgoing.body.items.map((o: { _id: string }) => o._id)).toEqual([id]);

    const incomingB = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=incoming')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(incomingB.body.items.map((o: { _id: string }) => o._id)).toContain(id);

    const incomingC = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=incoming')
      .set('Authorization', `Bearer ${adminC.token}`)
      .expect(200);
    expect(incomingC.body.items.map((o: { _id: string }) => o._id)).not.toContain(id);

    // A's own outgoing offer must never appear in A's own incoming list (FR-009).
    const incomingA = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=incoming')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(incomingA.body.items.map((o: { _id: string }) => o._id)).not.toContain(id);

    // T036b/FR-029/SC-006 — the fan-out reached B's OWN administrator (a different
    // tenant from the raiser), never the raiser's own staff. This is the assertion
    // that distinguishes a working cross-tenant resolution from research R6's
    // documented trap, where a faithful copy of `SupportService.notifyFuelCompanyAdmins`
    // would have notified A's own administrators and told B nothing — silently, with
    // "a notification was created" still true.
    const notificationsForB = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(
      notificationsForB.body.items.some(
        (n: { type: string }) => n.type === 'EXCHANGE_OFFER_AVAILABLE',
      ),
    ).toBe(true);

    const notificationsForA = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(
      notificationsForA.body.items.some(
        (n: { type: string }) => n.type === 'EXCHANGE_OFFER_AVAILABLE',
      ),
    ).toBe(false);
  });

  it('refuses a grade nobody on the platform sells (KEROSENE) with EXCHANGE_NO_ELIGIBLE_COMPANY', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const refused = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody({ fuelType: 'KEROSENE' }))
      .expect(400);
    expect(refused.body.error).toBe('EXCHANGE_NO_ELIGIBLE_COMPANY');
  });

  it('SUPER_ADMIN reads every offer, read-only, and is refused raising one (FR-023)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);

    const asOperator = await request(server)
      .get('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);
    expect(asOperator.body.items.length).toBeGreaterThan(0);

    await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send(raiseBody())
      .expect(403);
  });

  it("a suspended raiser's open offer disappears from another company's incoming list, but the offer itself remains a readable record (FR-010, research R13)", async () => {
    const server = app.getHttpServer();
    const { admin: adminA, companyId: companyIdA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;

    const companiesService = app.get(CompaniesService);
    await companiesService.setStatus(companyIdA, CompanyStatus.SUSPENDED);
    try {
      const incomingAfterSuspension = await request(server)
        .get('/api/v1/fuel-exchange/offers?direction=incoming')
        .set('Authorization', `Bearer ${adminB.token}`)
        .expect(200);
      expect(incomingAfterSuspension.body.items.map((o: { _id: string }) => o._id)).not.toContain(
        id,
      );

      // Suspension excludes the offer from OTHER companies' listings (a service-layer
      // relevance rule, research R13) — it never revokes the underlying record's
      // isolation-level readability, which is a structural property of the document
      // itself (party-set-scope.plugin.ts), not something `Company.status` can flip.
      // A's own admin cannot even authenticate while suspended, so this is asserted
      // directly against the service rather than over HTTP with A's token.
      const fuelExchangeService = app.get(FuelExchangeService);
      const tenantContext = app.get(TenantContextService);
      const stillReadable = await tenantContext.run(
        { userId: adminA.id, role: UserRole.FUEL_COMPANY_ADMIN, companyId: companyIdA },
        () => fuelExchangeService.findOne(id, companyIdA, UserRole.FUEL_COMPANY_ADMIN),
      );
      expect(stillReadable._id).toBeDefined();
    } finally {
      await companiesService.setStatus(companyIdA, CompanyStatus.ACTIVE);
    }
  });

  it('after an award, no order, invoice or litre-balance movement exists anywhere on the platform (FR-017, SC-009, T072)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    const [ordersBeforeA, invoicesBeforeA, balancesBeforeA] = await Promise.all([
      request(server)
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${adminA.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${adminA.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/litre-balances')
        .set('Authorization', `Bearer ${adminA.token}`)
        .expect(200),
    ]);
    const [ordersBeforeB, invoicesBeforeB, balancesBeforeB] = await Promise.all([
      request(server)
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${adminB.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${adminB.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/litre-balances')
        .set('Authorization', `Bearer ${adminB.token}`)
        .expect(200),
    ]);

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

    const [ordersAfterA, invoicesAfterA, balancesAfterA] = await Promise.all([
      request(server)
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${adminA.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${adminA.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/litre-balances')
        .set('Authorization', `Bearer ${adminA.token}`)
        .expect(200),
    ]);
    const [ordersAfterB, invoicesAfterB, balancesAfterB] = await Promise.all([
      request(server)
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${adminB.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${adminB.token}`)
        .expect(200),
      request(server)
        .get('/api/v1/litre-balances')
        .set('Authorization', `Bearer ${adminB.token}`)
        .expect(200),
    ]);

    expect(ordersAfterA.body.items.length).toBe(ordersBeforeA.body.items.length);
    expect(invoicesAfterA.body.items.length).toBe(invoicesBeforeA.body.items.length);
    expect(balancesAfterA.body.items.length).toBe(balancesBeforeA.body.items.length);
    expect(ordersAfterB.body.items.length).toBe(ordersBeforeB.body.items.length);
    expect(invoicesAfterB.body.items.length).toBe(invoicesBeforeB.body.items.length);
    expect(balancesAfterB.body.items.length).toBe(balancesBeforeB.body.items.length);
  });

  // ==========================================================================
  // US4 — withdraw (T082)
  // ==========================================================================

  it('withdrawal leaves every incoming list, and the offer becomes unanswerable afterwards (FR-016)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;

    const withdrawn = await request(server)
      .patch(`/api/v1/fuel-exchange/offers/${id}/withdraw`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(withdrawn.body.state).toBe('WITHDRAWN');

    const incomingB = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=incoming')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(incomingB.body.items.map((o: { _id: string }) => o._id)).not.toContain(id);

    const answerAttempt = await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ unitPrice: 2.2 })
      .expect(409);
    expect(answerAttempt.body.error).toBe('EXCHANGE_OFFER_NOT_OPEN');
  });

  it('withdrawing an already-awarded offer is refused; a non-raiser cannot withdraw at all', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;

    // A non-raiser attempting to withdraw reveals nothing about the offer (404, the
    // same discipline `award` uses — T065's rule applied consistently to withdraw).
    await request(server)
      .patch(`/api/v1/fuel-exchange/offers/${id}/withdraw`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(404);

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

    const refused = await request(server)
      .patch(`/api/v1/fuel-exchange/offers/${id}/withdraw`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(409);
    expect(refused.body.error).toBe('EXCHANGE_ALREADY_RESOLVED');
  });

  it('withdrawal notifies every company that had a live (priced) proposal (FR-016, FR-030a)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;
    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ unitPrice: 2.2 })
      .expect(201);

    await request(server)
      .patch(`/api/v1/fuel-exchange/offers/${id}/withdraw`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);

    const notificationsForB = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(
      notificationsForB.body.items.some(
        (n: { type: string }) => n.type === 'EXCHANGE_OFFER_CLOSED',
      ),
    ).toBe(true);
  });

  // ==========================================================================
  // US6 — summary counts (T094)
  // ==========================================================================

  it("summary counts every matching offer across the whole set, not only a loaded page, and excludes a previous month's award (SC-012)", async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB } = fixtures.companyB;

    // Raise more offers than fit one page.
    for (let i = 0; i < 25; i++) {
      await request(server)
        .post('/api/v1/fuel-exchange/offers')
        .set('Authorization', `Bearer ${adminA.token}`)
        .send(raiseBody())
        .expect(201);
    }

    const summaryBefore = await request(server)
      .get('/api/v1/fuel-exchange/offers/summary')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(summaryBefore.body.outgoingOpen).toBeGreaterThanOrEqual(25);

    const list = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=outgoing')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(list.body.items.length).toBeLessThan(summaryBefore.body.outgoingOpen);

    // Award one, then backdate its resolution into the previous calendar month —
    // it must be excluded from "awarded this month".
    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const offerId = created.body._id as string;
    const proposal = await request(server)
      .post(`/api/v1/fuel-exchange/offers/${offerId}/proposals`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ unitPrice: 2.2 })
      .expect(201);
    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${offerId}/award`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ proposalId: proposal.body._id })
      .expect(200);

    const summaryAfterAward = await request(server)
      .get('/api/v1/fuel-exchange/offers/summary')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(summaryAfterAward.body.awardedThisMonth).toBeGreaterThanOrEqual(1);

    const offerModel = app.get<Model<ExchangeOfferDocument>>(getModelToken(ExchangeOffer.name));
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    await offerModel.updateOne({ _id: offerId }, { $set: { resolvedAt: lastMonth } }).exec();

    const summaryAfterBackdate = await request(server)
      .get('/api/v1/fuel-exchange/offers/summary')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(summaryAfterBackdate.body.awardedThisMonth).toBe(
      summaryAfterAward.body.awardedThisMonth - 1,
    );
  });
});
