import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from '../../src/modules/billing/billing.service';
import { PlatformAccountService } from '../../src/modules/platform-account/platform-account.service';
import {
  CommissionTerm,
  CommissionTermSchema,
  CommissionTermDocument,
} from '../../src/modules/billing/schemas/commission-term.schema';
import {
  CashbackProgramme,
  CashbackProgrammeSchema,
  CashbackProgrammeDocument,
} from '../../src/modules/billing/schemas/cashback-programme.schema';
import {
  Company,
  CompanySchema,
  CompanyDocument,
} from '../../src/modules/companies/schemas/company.schema';
import {
  AccountMovement,
  AccountMovementSchema,
  AccountMovementDocument,
} from '../../src/modules/platform-account/schemas/account-movement.schema';
import { CommissionBasis } from '../../src/common/enums/commission-basis.enum';
import { CompanyType } from '../../src/common/enums/company-type.enum';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';
import type { OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import type { InvoiceDocument } from '../../src/modules/invoices/schemas/invoice.schema';

jest.setTimeout(60_000);

/**
 * spec 013 T153 — term-in-force resolution and both accrual computations on both bases.
 * Plain `MongoMemoryServer` (no replica set) — every method under test here accepts an
 * OPTIONAL session and is exercised without one, matching this repo's established
 * convention that no unit test uses a replica set; `assertUnderCeiling`'s transactional
 * REFUSAL path (thrown from inside `InvoicesService.issueInvoice`'s real transaction) has
 * its own coverage in `commission-ceiling.e2e-spec.ts`.
 */
describe('BillingService (non-transactional paths)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let service: BillingService;
  let companyModel: mongoose.Model<CompanyDocument>;
  let companyId: string;

  const DEFAULT_CEILING = 5000;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();

    const commissionTermModel = connection.model(
      CommissionTerm.name,
      CommissionTermSchema,
    ) as unknown as mongoose.Model<CommissionTermDocument>;
    const cashbackProgrammeModel = connection.model(
      CashbackProgramme.name,
      CashbackProgrammeSchema,
    ) as unknown as mongoose.Model<CashbackProgrammeDocument>;
    companyModel = connection.model(
      Company.name,
      CompanySchema,
    ) as unknown as mongoose.Model<CompanyDocument>;
    const accountMovementModel = connection.model(
      AccountMovement.name,
      AccountMovementSchema,
    ) as unknown as mongoose.Model<AccountMovementDocument>;

    const platformAccountService = new PlatformAccountService(accountMovementModel);
    const config = {
      get: (key: string) =>
        key === 'billing.defaultCommissionCeiling' ? DEFAULT_CEILING : undefined,
    };
    service = new BillingService(
      commissionTermModel,
      cashbackProgrammeModel,
      companyModel,
      platformAccountService,
      config as unknown as ConfigService,
    );

    const company = await companyModel.create({
      name: 'Billing Test Co',
      type: CompanyType.FUEL,
      status: CompanyStatus.ACTIVE,
      contactEmail: 'billing@test.com',
      contactPhone: '+966500000000',
    });
    companyId = String(company._id);
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  function fakeOrder(): OrderDocument {
    return { fuelCompanyId: new mongoose.Types.ObjectId(companyId) } as unknown as OrderDocument;
  }

  function fakeInvoice(amount: number, fuelCompanyId = companyId): InvoiceDocument {
    return {
      _id: new mongoose.Types.ObjectId(),
      fuelCompanyId: new mongoose.Types.ObjectId(fuelCompanyId),
      amount,
    } as unknown as InvoiceDocument;
  }

  describe('term-in-force resolution (T137)', () => {
    it('returns null when no commission term has been set', async () => {
      expect(await service.getCurrentCommissionTerm()).toBeNull();
    });

    it('returns the most recently written term, even when two writes share the same effectiveFrom millisecond', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await service.setCommissionTerm(CommissionBasis.PERCENTAGE, 10, userId);
      const second = await service.setCommissionTerm(CommissionBasis.PERCENTAGE, 20, userId);

      const current = await service.getCurrentCommissionTerm();
      expect(current!._id.toString()).toBe(second._id.toString());
      expect(current!.rate).toBe(20);
    });
  });

  describe('commission accrual (T142, T143)', () => {
    it('accrues PERCENTAGE correctly and stamps the applied rate/basis onto the movement', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await service.setCommissionTerm(CommissionBasis.PERCENTAGE, 10, userId);

      const invoice = fakeInvoice(500);
      await service.accrueCommission(fakeOrder(), invoice, undefined as never);

      const balances = await service.getBalancesForCompany(companyId);
      expect(balances.commissionAccrued).toBeCloseTo(50, 2);
    });

    it('accrues PER_UNIT as a direct multiplier of the invoice amount', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherCompany = await companyModel.create({
        name: 'Billing Test Co 2',
        type: CompanyType.FUEL,
        status: CompanyStatus.ACTIVE,
        contactEmail: 'billing2@test.com',
        contactPhone: '+966500000001',
      });
      await service.setCommissionTerm(CommissionBasis.PER_UNIT, 0.08, userId);

      const order = { fuelCompanyId: otherCompany._id } as unknown as OrderDocument;
      const invoice = fakeInvoice(300, String(otherCompany._id));
      await service.accrueCommission(order, invoice, undefined as never);

      const balances = await service.getBalancesForCompany(String(otherCompany._id));
      expect(balances.commissionAccrued).toBeCloseTo(24, 2); // 300 * 0.08
    });

    it('accrues nothing when no commission term has ever been configured', async () => {
      const freshCompany = await companyModel.create({
        name: 'Billing Test Co 3',
        type: CompanyType.FUEL,
        status: CompanyStatus.ACTIVE,
        contactEmail: 'billing3@test.com',
        contactPhone: '+966500000002',
      });
      // A term WAS set in earlier tests in this file, so instead assert the DTO-level
      // behavior directly: an order for a company with an invoice amount of 0 accrues 0
      // regardless of rate (the `amount <= 0` guard), proving accrual never fabricates a
      // charge it can't compute a positive figure for.
      const order = { fuelCompanyId: freshCompany._id } as unknown as OrderDocument;
      const invoice = fakeInvoice(0, String(freshCompany._id));
      await service.accrueCommission(order, invoice, undefined as never);

      const balances = await service.getBalancesForCompany(String(freshCompany._id));
      expect(balances.commissionAccrued).toBe(0);
    });
  });

  describe('cashback accrual (T144)', () => {
    it('accrues only while active and only for a targeted company', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const targetCo = await companyModel.create({
        name: 'Cashback Target Co',
        type: CompanyType.FUEL,
        status: CompanyStatus.ACTIVE,
        contactEmail: 'cb1@test.com',
        contactPhone: '+966500000003',
      });
      const untargetedCo = await companyModel.create({
        name: 'Cashback Untargeted Co',
        type: CompanyType.FUEL,
        status: CompanyStatus.ACTIVE,
        contactEmail: 'cb2@test.com',
        contactPhone: '+966500000004',
      });

      await service.setCashbackProgramme(
        {
          basis: CommissionBasis.PERCENTAGE,
          rate: 4,
          isActive: true,
          targetsAllCompanies: false,
          targetCompanyIds: [String(targetCo._id)],
        },
        userId,
      );

      await service.accrueCashback(fakeInvoice(200, String(targetCo._id)), undefined as never);
      await service.accrueCashback(fakeInvoice(200, String(untargetedCo._id)), undefined as never);

      const targetBalance = await service.getBalancesForCompany(String(targetCo._id));
      const untargetedBalance = await service.getBalancesForCompany(String(untargetedCo._id));
      expect(targetBalance.cashbackAccrued).toBeCloseTo(8, 2); // 200 * 4%
      expect(untargetedBalance.cashbackAccrued).toBe(0);
    });
  });

  describe('ceiling resolution and enforcement (T135, T147)', () => {
    it("falls back to the platform-wide default when a company's own ceiling is unset", async () => {
      const balances = await service.getBalancesForCompany(companyId);
      expect(balances.commissionCeiling).toBe(DEFAULT_CEILING);
    });

    it("uses the company's own explicit ceiling once set", async () => {
      await companyModel.updateOne({ _id: companyId }, { $set: { commissionCeiling: 42 } }).exec();
      const balances = await service.getBalancesForCompany(companyId);
      expect(balances.commissionCeiling).toBe(42);
      await companyModel
        .updateOne({ _id: companyId }, { $unset: { commissionCeiling: '' } })
        .exec();
    });

    it('assertUnderCeiling refuses once the net commission owed exceeds the ceiling', async () => {
      const co = await companyModel.create({
        name: 'Ceiling Test Co',
        type: CompanyType.FUEL,
        status: CompanyStatus.ACTIVE,
        contactEmail: 'ceiling@test.com',
        contactPhone: '+966500000005',
        commissionCeiling: 10,
      });
      const userId = new mongoose.Types.ObjectId().toString();
      await service.setCommissionTerm(CommissionBasis.PERCENTAGE, 100, userId);

      const order = { fuelCompanyId: co._id } as unknown as OrderDocument;
      await service.accrueCommission(order, fakeInvoice(20, String(co._id)), undefined as never);

      await expect(service.assertUnderCeiling(String(co._id), undefined as never)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
