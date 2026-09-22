import mongoose, { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConflictException } from '@nestjs/common';
import { CreditLimitRequestsService } from '../../src/modules/users/services/credit-limit-requests.service';
import {
  CreditLimitRequest,
  CreditLimitRequestSchema,
  CreditLimitRequestDocument,
} from '../../src/modules/users/schemas/credit-limit-request.schema';
import { CreditLimitRequestState } from '../../src/common/enums/credit-limit-request-state.enum';
import { UsersService } from '../../src/modules/users/users.service';

jest.setTimeout(60_000);

/**
 * spec 013 T070 — the non-transactional half of `CreditLimitRequestsService`
 * (`create`'s pending-request guard, `findForCompany`/`findForClient`'s filters).
 * `resolve()`'s conditional-update-inside-a-transaction behaviour needs a real replica
 * set and is covered thoroughly at the e2e level instead
 * (`test/e2e/credit-limit-requests.e2e-spec.ts`) — this repository's established
 * convention for every transactional service (see `order-state.service.spec.ts` for
 * the non-transactional precedent this file follows).
 */
describe('CreditLimitRequestsService (non-transactional paths)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let RequestModel: mongoose.Model<CreditLimitRequestDocument>;
  let service: CreditLimitRequestsService;

  const companyId = new mongoose.Types.ObjectId().toString();
  const clientId = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    RequestModel = connection.model(
      CreditLimitRequest.name,
      CreditLimitRequestSchema,
    ) as unknown as mongoose.Model<CreditLimitRequestDocument>;
    // `create`/`findForCompany`/`findForClient` never touch usersService or connection —
    // only `resolve` does, which this file deliberately does not exercise.
    service = new CreditLimitRequestsService(RequestModel, {} as UsersService, {} as Connection);
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await RequestModel.deleteMany({}).exec();
  });

  it('creates a PENDING request with the requested amount', async () => {
    const created = await service.create(clientId, companyId, 50000);
    expect(created.state).toBe(CreditLimitRequestState.PENDING);
    expect(created.requestedAmount).toBe(50000);
    expect(created.grantedAmount).toBeUndefined();
  });

  it('refuses a second request while one is already PENDING (FR-029)', async () => {
    await service.create(clientId, companyId, 50000);
    await expect(service.create(clientId, companyId, 20000)).rejects.toThrow(ConflictException);
  });

  it('permits a new request once the prior one is no longer PENDING', async () => {
    const first = await service.create(clientId, companyId, 50000);
    await RequestModel.updateOne(
      { _id: first._id },
      { $set: { state: CreditLimitRequestState.REJECTED } },
    ).exec();

    await expect(service.create(clientId, companyId, 20000)).resolves.toMatchObject({
      requestedAmount: 20000,
      state: CreditLimitRequestState.PENDING,
    });
  });

  it('findForCompany filters by state when given, and returns all when omitted', async () => {
    const a = await service.create(clientId, companyId, 10000);
    await RequestModel.updateOne(
      { _id: a._id },
      { $set: { state: CreditLimitRequestState.ACCEPTED, grantedAmount: 10000 } },
    ).exec();
    const otherClient = new mongoose.Types.ObjectId().toString();
    await service.create(otherClient, companyId, 5000);

    const pendingOnly = await service.findForCompany(CreditLimitRequestState.PENDING);
    expect(pendingOnly).toHaveLength(1);
    expect(pendingOnly[0].requestedAmount).toBe(5000);

    const all = await service.findForCompany();
    expect(all).toHaveLength(2);
  });

  it("findForClient returns only that client's requests, most recent first", async () => {
    const otherClient = new mongoose.Types.ObjectId().toString();
    await service.create(otherClient, companyId, 1000);
    await service.create(clientId, companyId, 2000);

    const mine = await service.findForClient(clientId);
    expect(mine).toHaveLength(1);
    expect(mine[0].requestedAmount).toBe(2000);
  });
});
