import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { PlatformAccountService } from '../../src/modules/platform-account/platform-account.service';
import {
  AccountMovement,
  AccountMovementSchema,
  AccountMovementDocument,
} from '../../src/modules/platform-account/schemas/account-movement.schema';
import { AccountMovementKind } from '../../src/common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../src/common/enums/account-movement-state.enum';
import { SettlementMethod } from '../../src/common/enums/settlement-method.enum';

jest.setTimeout(60_000);

/**
 * spec 013 T169 — the balance is `sum(amount) where state = CONFIRMED`, computed live
 * (FR-068, SC-012): a `RECORDED` movement contributes nothing, and a reversal
 * (`reversalOfId` set) nets OUT rather than being modeled as a negative `amount`. Plus
 * `recordPayment`'s evidence requirement (FR-067) and `confirmPayment`'s conditional
 * idempotency (FR-067a, FR-069) — the two entry points the balance formula depends on.
 */
describe('PlatformAccountService (balance derivation)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let service: PlatformAccountService;
  let companyId: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    const model = connection.model(
      AccountMovement.name,
      AccountMovementSchema,
    ) as unknown as mongoose.Model<AccountMovementDocument>;
    service = new PlatformAccountService(model);
    companyId = new mongoose.Types.ObjectId().toString();
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  it('sums only CONFIRMED movements, ignoring RECORDED ones entirely', async () => {
    const freshCompany = new mongoose.Types.ObjectId().toString();
    await service.createMovement({
      companyId: freshCompany,
      kind: AccountMovementKind.PAYMENT_RECORDED,
      amount: 100,
      currency: 'SAR',
      state: AccountMovementState.CONFIRMED,
    });
    await service.createMovement({
      companyId: freshCompany,
      kind: AccountMovementKind.PAYMENT_RECORDED,
      amount: 999,
      currency: 'SAR',
      state: AccountMovementState.RECORDED,
    });

    const balance = await service.getConfirmedBalance(freshCompany, AccountMovementKind.PAYMENT_RECORDED);
    expect(balance).toBe(100);
  });

  it('nets a reversal OUT of the sum rather than adding a negative amount', async () => {
    const freshCompany = new mongoose.Types.ObjectId().toString();
    const original = await service.createMovement({
      companyId: freshCompany,
      kind: AccountMovementKind.COMMISSION_CHARGED,
      amount: 50,
      currency: 'SAR',
      state: AccountMovementState.CONFIRMED,
    });
    await service.createMovement({
      companyId: freshCompany,
      kind: AccountMovementKind.COMMISSION_CHARGED,
      amount: 50,
      currency: 'SAR',
      state: AccountMovementState.CONFIRMED,
      reversalOfId: original._id as mongoose.Types.ObjectId,
    });

    const balance = await service.getConfirmedBalance(freshCompany, AccountMovementKind.COMMISSION_CHARGED);
    expect(balance).toBe(0);
  });

  it('recordPayment refuses a payment with neither a reference nor a document (FR-067)', async () => {
    await expect(
      service.recordPayment(companyId, { amount: 10, method: SettlementMethod.BANK_TRANSFER }, 'SAR'),
    ).rejects.toThrow(BadRequestException);
  });

  it('recordPayment accepts a reference alone and creates a RECORDED movement that does not affect the balance', async () => {
    const movement = await service.recordPayment(
      companyId,
      { amount: 25, method: SettlementMethod.BANK_TRANSFER, reference: 'ref-1' },
      'SAR',
    );
    expect(movement.state).toBe(AccountMovementState.RECORDED);
    const balance = await service.getConfirmedBalance(companyId, AccountMovementKind.PAYMENT_RECORDED);
    expect(balance).toBe(0);
  });

  it('confirmPayment moves a RECORDED movement into the balance exactly once, refusing a second confirmation', async () => {
    const freshCompany = new mongoose.Types.ObjectId().toString();
    const confirmerId = new mongoose.Types.ObjectId().toString();
    const movement = await service.recordPayment(
      freshCompany,
      { amount: 75, method: SettlementMethod.NATIONAL_PAYMENT_SERVICE, reference: 'ref-2' },
      'SAR',
    );

    const confirmed = await service.confirmPayment(String(movement._id), confirmerId);
    expect(confirmed.state).toBe(AccountMovementState.CONFIRMED);
    expect(String(confirmed.confirmedBy)).toBe(confirmerId);

    const balance = await service.getConfirmedBalance(freshCompany, AccountMovementKind.PAYMENT_RECORDED);
    expect(balance).toBe(75);

    await expect(service.confirmPayment(String(movement._id), confirmerId)).rejects.toThrow(ConflictException);
    const balanceAfterRetry = await service.getConfirmedBalance(freshCompany, AccountMovementKind.PAYMENT_RECORDED);
    expect(balanceAfterRetry).toBe(75);
  });
});
