import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { ExchangeRequest, ExchangeRequestDocument } from '../../src/modules/fuel-exchange/schemas/exchange-request.schema';
import { UserRole } from '../../src/common/enums/user-role.enum';

jest.setTimeout(120_000);

/**
 * spec 013 T215/T217 — Part A's gate: the party-set isolation mechanism proven against
 * the REAL `ExchangeRequest` collection, through the full app stack (real MongoDB
 * transactions, real `TenantContextService`), before any fuel-exchange service or
 * controller exists (`fuel-exchange.module.ts` registers only the schema at this point —
 * see its own comment). Every row of `contracts/isolation-contract.md`'s Required tests
 * table. The FIRST test is non-negotiable: it is the exact defect research R3 found when
 * `ExchangeRequest` was (hypothetically) marked multi-party instead.
 */
describe('Party-set isolation (US12 Part A gate, research R3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let model: Model<ExchangeRequestDocument>;
  let tenantContext: TenantContextService;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    model = app.get(getModelToken(ExchangeRequest.name));
    tenantContext = app.get(TenantContextService);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  afterEach(async () => {
    await model.deleteMany({});
  });

  function fields(companyA: string, companyB: string, raisedByUserId: string) {
    return {
      partyCompanyIds: [new Types.ObjectId(companyA), new Types.ObjectId(companyB)],
      raisedByCompanyId: new Types.ObjectId(companyA),
      recipientCompanyId: new Types.ObjectId(companyB),
      raisedByUserId: new Types.ObjectId(raisedByUserId),
      fuelType: 'DIESEL',
      quantityLitres: 1000,
      unitPrice: 2.5,
      currency: 'SAR',
      deliveryAt: new Date('2026-06-01'),
      deliveryPlaceText: 'Riyadh warehouse',
    };
  }

  async function createAsCompanyA() {
    const { admin, companyId } = fixtures.companyA;
    return tenantContext.run(
      { userId: admin.id, role: UserRole.FUEL_COMPANY_ADMIN, companyId },
      () => model.create(fields(companyId, fixtures.companyB.companyId, admin.id)),
    );
  }

  it('THE recipient reads a request raised by the counterparty (non-negotiable)', async () => {
    await createAsCompanyA();
    const { admin, companyId } = fixtures.companyB;
    await tenantContext.run({ userId: admin.id, role: UserRole.FUEL_COMPANY_ADMIN, companyId }, async () => {
      const results = await model.find({});
      expect(results).toHaveLength(1);
    });
  });

  it('the raiser reads their own', async () => {
    await createAsCompanyA();
    const { admin, companyId } = fixtures.companyA;
    await tenantContext.run({ userId: admin.id, role: UserRole.FUEL_COMPANY_ADMIN, companyId }, async () => {
      const results = await model.find({});
      expect(results).toHaveLength(1);
    });
  });

  it('a third fuel company reads neither', async () => {
    await createAsCompanyA();
    // A genuine third tenant: reuse the platform's superAdmin-created company id space by
    // minting a fresh, never-a-party id — no fixture provides a real third company, and
    // none is needed: the isolation filter only ever compares against `partyCompanyIds`.
    const thirdCompanyId = new Types.ObjectId().toString();
    await tenantContext.run(
      { userId: 'admin-c', role: UserRole.FUEL_COMPANY_ADMIN, companyId: thirdCompanyId },
      async () => {
        const results = await model.find({});
        expect(results).toHaveLength(0);
      },
    );
  });

  it('create with the acting company absent from parties is refused', async () => {
    const outsiderCompanyId = new Types.ObjectId().toString();
    const outsiderUserId = new Types.ObjectId().toString();
    await expect(
      tenantContext.run(
        { userId: outsiderUserId, role: UserRole.FUEL_COMPANY_ADMIN, companyId: outsiderCompanyId },
        () => model.create(fields(fixtures.companyA.companyId, fixtures.companyB.companyId, outsiderUserId)),
      ),
    ).rejects.toThrow();
  });

  it('create with one party is refused', async () => {
    const { admin, companyId } = fixtures.companyA;
    await expect(
      tenantContext.run({ userId: admin.id, role: UserRole.FUEL_COMPANY_ADMIN, companyId }, () =>
        model.create({ ...fields(companyId, fixtures.companyB.companyId, admin.id), partyCompanyIds: [new Types.ObjectId(companyId)] }),
      ),
    ).rejects.toThrow();
  });

  it('create with three parties is refused', async () => {
    const { admin, companyId } = fixtures.companyA;
    await expect(
      tenantContext.run({ userId: admin.id, role: UserRole.FUEL_COMPANY_ADMIN, companyId }, () =>
        model.create({
          ...fields(companyId, fixtures.companyB.companyId, admin.id),
          partyCompanyIds: [companyId, fixtures.companyB.companyId, new Types.ObjectId().toString()].map(
            (p) => new Types.ObjectId(p),
          ),
        }),
      ),
    ).rejects.toThrow();
  });

  it('SUPER_ADMIN reads all', async () => {
    await createAsCompanyA();
    await tenantContext.run({ userId: fixtures.superAdmin.id, role: UserRole.SUPER_ADMIN }, async () => {
      const results = await model.find({});
      expect(results).toHaveLength(1);
    });
  });

  it('anonymous/public-route traffic bypasses without throwing', async () => {
    await createAsCompanyA();
    const results = await model.find({});
    expect(results).toHaveLength(1);
  });
});
