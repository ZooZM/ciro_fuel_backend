import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedThreeFuelCompanies, ThreeFuelCompanyFixture, uniquePhone, DEFAULT_PASSWORD } from '../utils/fixtures';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { UsersService } from '../../src/modules/users/users.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';

jest.setTimeout(120_000);

/**
 * Every number anywhere in a payload, so a price leak is caught by VALUE.
 *
 * `JSON.stringify(body).not.toContain('2.2')` ALSO matches an ISO timestamp
 * whose milliseconds read `…:32.210Z`, and `'9.99'` matches `…:09.990Z` — the
 * assertion fails on the clock rather than on a leak. Feature 011 hit exactly
 * this with `not.toContain('950')` (~14% of runs) and fixed it the same way;
 * these two suites were written before that fix and never adopted it.
 *
 * An ObjectId is still checked as a substring: 24 hex characters cannot
 * collide with a timestamp.
 */
function numericValuesIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numericValuesIn);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(numericValuesIn);
  }
  return [];
}

/**
 * spec 016 (broadcast fuel exchange offers) T055/T055a/T056/research R12 — FR-011b is a
 * property of what a company can OBTAIN, so every assertion here reads the RAW response
 * body rather than trusting that a screen chose not to render a field.
 */
describe('Exchange proposal blindness (US2)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: ThreeFuelCompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedThreeFuelCompanies(app);
    // C does not sell PETROL_95 by default (research R11's fixture is "diesel-only"
    // FOR THE GRADE-RELEVANCE tests). Every test in THIS file needs a genuine SECOND
    // grade-eligible proposer to prove blindness against, so it is granted once here
    // for the whole suite — never touching the shared fixture other suites rely on.
    const companiesService = app.get(CompaniesService);
    await companiesService.setFuelPrices(fixtures.companyC.companyId, [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 },
      { fuelType: FuelType.PETROL_95, basePricePerLiter: 2.6 },
    ]);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  function raiseBody(overrides: Record<string, unknown> = {}) {
    return {
      fuelType: 'PETROL_95',
      quantityLitres: 10000,
      deliveryAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      city: 'JEDDAH',
      ...overrides,
    };
  }

  it('a responder\'s offer read, list and detail contain no proposal array, no rival price, no rival count, no rival name, in the RAW payload (FR-011b, SC-004, research R12)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const { admin: adminC, companyId: companyIdC } = fixtures.companyC;

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
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminC.token}`)
      .send({ unitPrice: 9.99 })
      .expect(201);

    const detailForB = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${id}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    const rawB = JSON.stringify(detailForB.body);
    expect(numericValuesIn(detailForB.body)).not.toContain(9.99);
    expect(rawB).not.toContain(companyIdC);
    expect(detailForB.body).not.toHaveProperty('proposals');
    expect(detailForB.body).not.toHaveProperty('proposalCount');
    expect(detailForB.body).not.toHaveProperty('declineCount');
    expect(detailForB.body.myProposal).toMatchObject({ unitPrice: 2.2 });

    const listForB = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=incoming')
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    const rawListB = JSON.stringify(listForB.body);
    expect(numericValuesIn(listForB.body)).not.toContain(9.99);
    expect(rawListB).not.toContain(companyIdC);
    for (const item of listForB.body.items) {
      expect(item).not.toHaveProperty('proposalCount');
      expect(item).not.toHaveProperty('declineCount');
    }

    // The raiser, by contrast, sees both.
    const detailForA = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${id}`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(detailForA.body.proposals).toHaveLength(2);
    expect(detailForA.body.proposalCount).toBe(2);
    expect(detailForA.body.declineCount).toBe(0);
  });

  it('while OPEN, no viewer\'s payload carries the raising company\'s CONTACT details — only its name (FR-019, T055a)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA, companyId: companyIdA } = fixtures.companyA;
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

    const detailForB = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${id}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .expect(200);
    expect(detailForB.body.raisedByCompanyName).toBeTruthy();
    expect(detailForB.body).not.toHaveProperty('raiserContact');
    const raw = JSON.stringify(detailForB.body);
    const companiesService = app.get(CompaniesService);
    const companyA = await companiesService.findById(companyIdA);
    expect(raw).not.toContain(companyA.contactEmail);
    expect(raw).not.toContain(companyA.contactPhone);
  });

  it('a company onboarded AFTER the offer was raised can still see and answer it (FR-006a)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;

    // Onboarded strictly AFTER the offer exists — proves the audience is never
    // materialised at raise time (R1's rejected alternative).
    const companiesService = app.get(CompaniesService);
    const usersService = app.get(UsersService);
    const authService = app.get(AuthService);
    const newCompany = await companiesService.create({
      name: 'LateJoinerCo',
      type: CompanyType.FUEL,
      status: CompanyStatus.ACTIVE,
      contactEmail: 'contact@latejoiner.test',
      contactPhone: '+966500000005',
      fuelPrices: [{ fuelType: FuelType.PETROL_95, basePricePerLiter: 2.28 }],
    });
    const phone = uniquePhone();
    const admin = await usersService.create({
      companyId: newCompany._id as never,
      role: UserRole.FUEL_COMPANY_ADMIN,
      email: 'admin@latejoiner.test',
      password: DEFAULT_PASSWORD,
      fullName: 'Late Joiner Admin',
      phone,
      isActive: true,
    });
    const { accessToken } = await authService.login({ email: admin.email, password: DEFAULT_PASSWORD });

    const incoming = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=incoming')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(incoming.body.items.map((o: { _id: string }) => o._id)).toContain(id);

    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ unitPrice: 2.3 })
      .expect(201);
  });

  it("a non-winner's offer payload and notification payload identify neither the winner nor the winning price (SC-007, T073)", async () => {
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
    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminC.token}`)
      .send({ unitPrice: 9.99 })
      .expect(201);

    // C is the non-winner: B's proposal is awarded.
    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/award`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ proposalId: proposalB.body._id })
      .expect(200);

    const detailForC = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${id}`)
      .set('Authorization', `Bearer ${adminC.token}`)
      .expect(200);
    expect(detailForC.body.state).toBe('AWARDED');
    const rawC = JSON.stringify(detailForC.body);
    expect(numericValuesIn(detailForC.body)).not.toContain(2.2); // the winning price
    expect(rawC).not.toContain(String(fixtures.companyB.companyId)); // the winner's identity
    expect(detailForC.body).not.toHaveProperty('agreedUnitPrice');
    expect(detailForC.body).not.toHaveProperty('awardedCompanyId');
    expect(detailForC.body).not.toHaveProperty('raiserContact');

    const notificationsForC = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${adminC.token}`)
      .expect(200);
    const closedNotice = notificationsForC.body.items.find(
      (n: { type: string }) => n.type === 'EXCHANGE_OFFER_CLOSED',
    );
    expect(closedNotice).toBeDefined();
    const rawNotice = JSON.stringify(closedNotice);
    expect(numericValuesIn(closedNotice)).not.toContain(2.2);
    expect(rawNotice).not.toContain(String(fixtures.companyB.companyId));
  });

  it('declineCount is a number alone: no declining company is identifiable from any payload the raiser receives (FR-021, FR-021a, T081a)', async () => {
    const server = app.getHttpServer();
    const { admin: adminA } = fixtures.companyA;
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const { admin: adminC, companyId: companyIdC } = fixtures.companyC;

    const created = await request(server)
      .post('/api/v1/fuel-exchange/offers')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send(raiseBody())
      .expect(201);
    const id = created.body._id as string;

    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ decline: true })
      .expect(201);
    await request(server)
      .post(`/api/v1/fuel-exchange/offers/${id}/proposals`)
      .set('Authorization', `Bearer ${adminC.token}`)
      .send({ decline: true })
      .expect(201);

    const detailForA = await request(server)
      .get(`/api/v1/fuel-exchange/offers/${id}`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    expect(detailForA.body.declineCount).toBe(2);
    expect(detailForA.body.proposalCount).toBe(0);
    // Every declining proposal in the raiser's own detail payload names no company —
    // the outcome and timestamp only.
    for (const p of detailForA.body.proposals) {
      expect(p.outcome).toBe('DECLINED');
      expect(p).not.toHaveProperty('company');
      expect(p).not.toHaveProperty('unitPrice');
    }

    const listForA = await request(server)
      .get('/api/v1/fuel-exchange/offers?direction=outgoing')
      .set('Authorization', `Bearer ${adminA.token}`)
      .expect(200);
    const item = listForA.body.items.find((o: { _id: string }) => o._id === id);
    expect(item.declineCount).toBe(2);
    expect(item.proposalCount).toBe(0);
    const rawList = JSON.stringify(item);
    expect(rawList).not.toContain(companyIdB);
    expect(rawList).not.toContain(companyIdC);
  });
});
