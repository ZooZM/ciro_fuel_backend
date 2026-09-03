import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LitreBalancesService } from '../../src/modules/litre-balances/litre-balances.service';
import {
  LitreBalance,
  LitreBalanceSchema,
  LitreBalanceDocument,
} from '../../src/modules/litre-balances/schemas/litre-balance.schema';
import { FuelType } from '../../src/common/enums/fuel-type.enum';

jest.setTimeout(60_000);

/**
 * spec 013 T205 — shortfall, excess, the negative-balance guard, correction-requires-
 * reason, and idempotency, exercised directly against `LitreBalancesService` on a plain
 * `MongoMemoryServer` (no replica set — every method here is called with `session:
 * undefined`, matching this repo's established unit-test convention).
 */
describe('LitreBalancesService', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let service: LitreBalancesService;
  let companyId: string;
  let clientId: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    const model = connection.model(
      LitreBalance.name,
      LitreBalanceSchema,
    ) as unknown as mongoose.Model<LitreBalanceDocument>;
    service = new LitreBalancesService(model);
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    companyId = new mongoose.Types.ObjectId().toString();
    clientId = new mongoose.Types.ObjectId().toString();
  });

  it('credits a shortfall (ordered > supplied) as a positive balance', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    const actorId = new mongoose.Types.ObjectId().toString();
    const result = await service.recordReconciliation(
      companyId,
      clientId,
      FuelType.DIESEL,
      orderId,
      1000,
      750,
      actorId,
      undefined as never,
    );
    expect(result.shortfallLitres).toBe(250);
    expect(result.balanceLitres).toBe(250);
    expect(result.wentNegative).toBe(false);
  });

  it('debits an excess (supplied > ordered), advisory-flagging a resulting negative balance', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    const actorId = new mongoose.Types.ObjectId().toString();
    const result = await service.recordReconciliation(
      companyId,
      clientId,
      FuelType.DIESEL,
      orderId,
      100,
      150,
      actorId,
      undefined as never,
    );
    expect(result.shortfallLitres).toBe(-50);
    expect(result.balanceLitres).toBe(-50);
    expect(result.wentNegative).toBe(true);
  });

  it('an exact match records no movement and leaves the balance untouched', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    const actorId = new mongoose.Types.ObjectId().toString();
    const result = await service.recordReconciliation(
      companyId,
      clientId,
      FuelType.DIESEL,
      orderId,
      100,
      100,
      actorId,
      undefined as never,
    );
    expect(result.shortfallLitres).toBe(0);
    expect(result.balanceLitres).toBe(0);
    const balance = await service.getBalanceLitres(companyId, clientId, FuelType.DIESEL);
    expect(balance).toBe(0);
  });

  it('a retried reconciliation for the same order is refused, never applying a second movement (FR-073e)', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    const actorId = new mongoose.Types.ObjectId().toString();
    await service.recordReconciliation(companyId, clientId, FuelType.DIESEL, orderId, 500, 400, actorId, undefined as never);
    await expect(
      service.recordReconciliation(companyId, clientId, FuelType.DIESEL, orderId, 500, 400, actorId, undefined as never),
    ).rejects.toThrow(ConflictException);
    const balance = await service.getBalanceLitres(companyId, clientId, FuelType.DIESEL);
    expect(balance).toBe(100);
  });

  it('drawdown draws min(balance, requested), never more than either', async () => {
    const actorId = new mongoose.Types.ObjectId().toString();
    const shortfallOrderId = new mongoose.Types.ObjectId().toString();
    await service.recordReconciliation(
      companyId,
      clientId,
      FuelType.DIESEL,
      shortfallOrderId,
      1000,
      800,
      actorId,
      undefined as never,
    ); // +200

    const drawdownOrderId = new mongoose.Types.ObjectId().toString();
    const smallDraw = await service.drawdown(
      companyId,
      clientId,
      FuelType.DIESEL,
      drawdownOrderId,
      50,
      actorId,
      undefined as never,
    );
    expect(smallDraw.litresDrawn).toBe(50);
    expect(smallDraw.balanceRemaining).toBe(150);

    const bigDrawOrderId = new mongoose.Types.ObjectId().toString();
    const bigDraw = await service.drawdown(
      companyId,
      clientId,
      FuelType.DIESEL,
      bigDrawOrderId,
      9999,
      actorId,
      undefined as never,
    );
    expect(bigDraw.litresDrawn).toBe(150); // capped by the remaining balance, not the request
    expect(bigDraw.balanceRemaining).toBe(0);
  });

  it('drawdown against a zero/absent balance draws nothing', async () => {
    const actorId = new mongoose.Types.ObjectId().toString();
    const orderId = new mongoose.Types.ObjectId().toString();
    const result = await service.drawdown(companyId, clientId, FuelType.DIESEL, orderId, 100, actorId, undefined as never);
    expect(result.litresDrawn).toBe(0);
    expect(result.balanceRemaining).toBe(0);
  });

  it('projectDrawdown reports what a real drawdown would do without writing anything', async () => {
    const actorId = new mongoose.Types.ObjectId().toString();
    const orderId = new mongoose.Types.ObjectId().toString();
    await service.recordReconciliation(companyId, clientId, FuelType.DIESEL, orderId, 300, 250, actorId, undefined as never); // +50

    const projection = await service.projectDrawdown(companyId, clientId, FuelType.DIESEL, 1000);
    expect(projection.litresDrawn).toBe(50);
    expect(projection.balanceRemaining).toBe(0);

    const balanceAfter = await service.getBalanceLitres(companyId, clientId, FuelType.DIESEL);
    expect(balanceAfter).toBe(50); // untouched by the projection above
  });

  it('a correction requires a reason', async () => {
    const actorId = new mongoose.Types.ObjectId().toString();
    const orderId = new mongoose.Types.ObjectId().toString();
    const balance = await service.recordReconciliation(
      companyId,
      clientId,
      FuelType.DIESEL,
      orderId,
      100,
      50,
      actorId,
      undefined as never,
    );
    void balance;
    const balanceDoc = await service.listForCompany();
    const id = String(balanceDoc[0]._id);
    await expect(service.recordCorrection(id, 10, '', actorId)).rejects.toThrow(BadRequestException);
    await expect(service.recordCorrection(id, 10, '   ', actorId)).rejects.toThrow(BadRequestException);
  });

  it('a correction against a non-existent balance is a 404', async () => {
    const actorId = new mongoose.Types.ObjectId().toString();
    await expect(
      service.recordCorrection(new mongoose.Types.ObjectId().toString(), 10, 'test reason', actorId),
    ).rejects.toThrow(NotFoundException);
  });

  it('a correction adjusts the balance and is attributed to the administrator (FR-074a)', async () => {
    const actorId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const orderId = new mongoose.Types.ObjectId().toString();
    await service.recordReconciliation(companyId, clientId, FuelType.DIESEL, orderId, 100, 50, actorId, undefined as never); // +50

    const balances = await service.listForCompany();
    const target = balances.find((b) => String(b.companyId) === companyId && String(b.clientId) === clientId)!;

    const corrected = await service.recordCorrection(String(target._id), -20, 'manual adjustment', adminId);
    expect(corrected.balanceLitres).toBe(30);
    const correctionMovement = corrected.movements.find((m) => m.kind === 'CORRECTION');
    expect(correctionMovement!.litres).toBe(-20);
    expect(correctionMovement!.reason).toBe('manual adjustment');
    expect(String(correctionMovement!.actorId)).toBe(adminId);
  });

  it('returnDrawdown reverses a prior drawdown and is a no-op when none exists', async () => {
    const actorId = new mongoose.Types.ObjectId().toString();
    const shortfallOrderId = new mongoose.Types.ObjectId().toString();
    await service.recordReconciliation(
      companyId,
      clientId,
      FuelType.DIESEL,
      shortfallOrderId,
      500,
      400,
      actorId,
      undefined as never,
    ); // +100

    const drawOrderId = new mongoose.Types.ObjectId().toString();
    await service.drawdown(companyId, clientId, FuelType.DIESEL, drawOrderId, 40, actorId, undefined as never);
    expect(await service.getBalanceLitres(companyId, clientId, FuelType.DIESEL)).toBe(60);

    await service.returnDrawdown(companyId, clientId, FuelType.DIESEL, drawOrderId, actorId, undefined as never);
    expect(await service.getBalanceLitres(companyId, clientId, FuelType.DIESEL)).toBe(100);

    // No-op: an order that never drew anything down.
    const untouchedOrderId = new mongoose.Types.ObjectId().toString();
    await service.returnDrawdown(companyId, clientId, FuelType.DIESEL, untouchedOrderId, actorId, undefined as never);
    expect(await service.getBalanceLitres(companyId, clientId, FuelType.DIESEL)).toBe(100);
  });
});
