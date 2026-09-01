import mongoose, { ClientSession, Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BadRequestException } from '@nestjs/common';
import { InvoicesService } from '../../src/modules/invoices/invoices.service';
import {
  Invoice,
  InvoiceSchema,
  InvoiceDocument,
} from '../../src/modules/invoices/schemas/invoice.schema';
import { Order, OrderSchema, OrderDocument } from '../../src/modules/orders/schemas/order.schema';
import { User, UserSchema, UserDocument } from '../../src/modules/users/schemas/user.schema';
import { PaymentMethod } from '../../src/common/enums/payment-method.enum';
import { InvoiceState } from '../../src/common/enums/invoice-state.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

jest.setTimeout(60_000);

/** spec 004 US5/SC-004: credit accounting must never drift across any
 * sequence of issue/settle/void — proven here directly against
 * InvoicesService, without going through the full HTTP/approval stack
 * (that end-to-end proof lives in billing-credit.e2e-spec.ts). */
describe('InvoicesService — credit arithmetic (SC-004)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let InvoiceModel: mongoose.Model<InvoiceDocument>;
  let OrderModel: mongoose.Model<OrderDocument>;
  let UserModel: mongoose.Model<UserDocument>;
  let service: InvoicesService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    InvoiceModel = connection.model(
      Invoice.name,
      InvoiceSchema,
    ) as unknown as mongoose.Model<InvoiceDocument>;
    OrderModel = connection.model(
      Order.name,
      OrderSchema,
    ) as unknown as mongoose.Model<OrderDocument>;
    UserModel = connection.model(User.name, UserSchema) as unknown as mongoose.Model<UserDocument>;
    service = new InvoicesService(InvoiceModel, OrderModel, UserModel);
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await InvoiceModel.deleteMany({});
    await OrderModel.deleteMany({});
    await UserModel.deleteMany({});
  });

  async function seedClient(creditLimit: number): Promise<UserDocument> {
    return UserModel.create({
      companyId: new mongoose.Types.ObjectId(),
      role: UserRole.CLIENT,
      email: `client-${new mongoose.Types.ObjectId()}@test.test`,
      passwordHash: 'x',
      fullName: 'Credit Client',
      phone: `+9665${Math.floor(Math.random() * 100000000)}`,
      isActive: true,
      creditLimit,
    });
  }

  async function seedOrder(
    clientId: mongoose.Types.ObjectId,
    method: PaymentMethod,
    finalPrice: number,
  ): Promise<OrderDocument> {
    return OrderModel.create({
      fuelCompanyId: new mongoose.Types.ObjectId(),
      clientId,
      fuelType: FuelType.DIESEL,
      quantityLiters: 100,
      deliveryLocation: { type: 'Point', coordinates: [46.6, 24.7] },
      status: OrderStatus.APPROVED,
      estimatedPrice: finalPrice,
      finalPrice,
      paymentMethod: method,
    });
  }

  async function withSession<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await connection.startSession();
    try {
      return await fn(session);
    } finally {
      await session.endSession();
    }
  }

  it('returns the full credit limit when no credit invoices exist', async () => {
    const client = await seedClient(1000);
    const available = await service.getAvailableCredit(client._id as mongoose.Types.ObjectId);
    expect(available).toBe(1000);
  });

  it('reduces available credit by an ISSUED credit invoice, and ignores DIRECT/DEFERRED amounts', async () => {
    const client = await seedClient(1000);
    const creditOrder = await seedOrder(
      client._id as mongoose.Types.ObjectId,
      PaymentMethod.CREDIT,
      300,
    );
    const directOrder = await seedOrder(
      client._id as mongoose.Types.ObjectId,
      PaymentMethod.DIRECT,
      400,
    );

    await withSession((session) => service.issueInvoice(creditOrder, session));
    await withSession((session) => service.issueInvoice(directOrder, session));

    const available = await service.getAvailableCredit(client._id as mongoose.Types.ObjectId);
    expect(available).toBe(700); // 1000 - 300; the DIRECT invoice never counts
  });

  it('refuses to issue a credit invoice that exceeds available credit — no invoice created, order.invoiceId untouched (FR-025)', async () => {
    const client = await seedClient(500);
    const order = await seedOrder(client._id as mongoose.Types.ObjectId, PaymentMethod.CREDIT, 600);

    await expect(withSession((session) => service.issueInvoice(order, session))).rejects.toThrow(
      BadRequestException,
    );

    expect(await InvoiceModel.countDocuments({ orderId: order._id })).toBe(0);
    const reloaded = await OrderModel.findById(order._id).exec();
    expect(reloaded?.invoiceId).toBeUndefined();
  });

  it('settling a credit invoice restores available credit — the settled amount no longer counts (FR-024)', async () => {
    const client = await seedClient(1000);
    const order = await seedOrder(client._id as mongoose.Types.ObjectId, PaymentMethod.CREDIT, 300);

    const invoice = await withSession((session) => service.issueInvoice(order, session));
    expect(await service.getAvailableCredit(client._id as mongoose.Types.ObjectId)).toBe(700);

    await withSession((session) =>
      service.settleInvoiceForOrder(order._id as never, 'ref-1', session),
    );
    expect(await service.getAvailableCredit(client._id as mongoose.Types.ObjectId)).toBe(1000);

    const settled = await InvoiceModel.findById(invoice._id).exec();
    expect(settled?.state).toBe(InvoiceState.SETTLED);
    expect(settled?.settledAt).toBeInstanceOf(Date);
  });

  it('voiding a credit invoice restores available credit, exactly like settling (FR-024/FR-027)', async () => {
    const client = await seedClient(1000);
    const order = await seedOrder(client._id as mongoose.Types.ObjectId, PaymentMethod.CREDIT, 250);

    await withSession((session) => service.issueInvoice(order, session));
    expect(await service.getAvailableCredit(client._id as mongoose.Types.ObjectId)).toBe(750);

    await service.voidInvoice(order._id as never);
    expect(await service.getAvailableCredit(client._id as mongoose.Types.ObjectId)).toBe(1000);
  });

  it('settlement is idempotent — a second settle call on an already-SETTLED invoice is a no-op (FR-026)', async () => {
    const client = await seedClient(1000);
    const order = await seedOrder(client._id as mongoose.Types.ObjectId, PaymentMethod.CREDIT, 300);
    const invoice = await withSession((session) => service.issueInvoice(order, session));

    await withSession((session) =>
      service.settleInvoiceForOrder(order._id as never, 'ref-a', session),
    );
    const firstSettledAt = (await InvoiceModel.findById(invoice._id).exec())?.settledAt;

    await withSession((session) =>
      service.settleInvoiceForOrder(order._id as never, 'ref-b', session),
    );
    const afterSecondCall = await InvoiceModel.findById(invoice._id).exec();

    expect(afterSecondCall?.state).toBe(InvoiceState.SETTLED);
    // The second call never re-applied — the original reference/timestamp stand.
    expect(afterSecondCall?.paymentReference).toBe('ref-a');
    expect(afterSecondCall?.settledAt?.getTime()).toBe(firstSettledAt?.getTime());
  });

  it('a SETTLED invoice is never overwritten to VOID by a late cancellation (FR-027)', async () => {
    const client = await seedClient(1000);
    const order = await seedOrder(client._id as mongoose.Types.ObjectId, PaymentMethod.CREDIT, 300);
    await withSession((session) => service.issueInvoice(order, session));
    await withSession((session) =>
      service.settleInvoiceForOrder(order._id as never, 'ref', session),
    );

    await service.voidInvoice(order._id as never);

    const invoice = await InvoiceModel.findOne({ orderId: order._id }).exec();
    expect(invoice?.state).toBe(InvoiceState.SETTLED);
    // Credit stays restored (it was already excluded once SETTLED) — not
    // double-restored or re-consumed by the no-op void.
    expect(await service.getAvailableCredit(client._id as mongoose.Types.ObjectId)).toBe(1000);
  });

  it('SC-004: available credit never drifts across a long issue/settle/void sequence', async () => {
    const client = await seedClient(1000);
    const clientId = client._id as mongoose.Types.ObjectId;

    const orderA = await seedOrder(clientId, PaymentMethod.CREDIT, 200);
    await withSession((session) => service.issueInvoice(orderA, session));
    expect(await service.getAvailableCredit(clientId)).toBe(800);

    const orderB = await seedOrder(clientId, PaymentMethod.CREDIT, 150);
    await withSession((session) => service.issueInvoice(orderB, session));
    expect(await service.getAvailableCredit(clientId)).toBe(650); // 1000 - 200 - 150

    await withSession((session) =>
      service.settleInvoiceForOrder(orderA._id as never, 'ref-a', session),
    );
    expect(await service.getAvailableCredit(clientId)).toBe(850); // A settled; only B (150) still outstanding

    await service.voidInvoice(orderB._id as never);
    expect(await service.getAvailableCredit(clientId)).toBe(1000); // both cleared

    const orderC = await seedOrder(clientId, PaymentMethod.CREDIT, 1000);
    await withSession((session) => service.issueInvoice(orderC, session)); // exactly at the limit — allowed
    expect(await service.getAvailableCredit(clientId)).toBe(0);

    const orderD = await seedOrder(clientId, PaymentMethod.CREDIT, 1);
    await expect(withSession((session) => service.issueInvoice(orderD, session))).rejects.toThrow(
      BadRequestException,
    );
    expect(await service.getAvailableCredit(clientId)).toBe(0); // the refusal changed nothing
  });

  it('stamps transportCompanyId only for DEFERRED invoices — DIRECT/CREDIT are untouched (FR-022)', async () => {
    const client = await seedClient(1000);
    const deferredOrder = await seedOrder(
      client._id as mongoose.Types.ObjectId,
      PaymentMethod.DEFERRED,
      100,
    );
    const directOrder = await seedOrder(
      client._id as mongoose.Types.ObjectId,
      PaymentMethod.DIRECT,
      100,
    );
    const deferredInvoice = await withSession((session) =>
      service.issueInvoice(deferredOrder, session),
    );
    const directInvoice = await withSession((session) =>
      service.issueInvoice(directOrder, session),
    );
    expect(deferredInvoice.payerRole).toBe(UserRole.TRANSPORT_COMPANY_ADMIN);
    expect(directInvoice.payerRole).toBe(UserRole.CLIENT);

    const transportCompanyId = new mongoose.Types.ObjectId().toString();
    await service.setTransportCompanyId(deferredOrder._id as never, transportCompanyId);
    await service.setTransportCompanyId(directOrder._id as never, transportCompanyId);

    const reloadedDeferred = await InvoiceModel.findById(deferredInvoice._id).exec();
    const reloadedDirect = await InvoiceModel.findById(directInvoice._id).exec();
    expect(String(reloadedDeferred?.transportCompanyId)).toBe(transportCompanyId);
    expect(reloadedDirect?.transportCompanyId).toBeUndefined();
  });
});
