import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Invoice, InvoiceDocument } from './schemas/invoice.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { PaymentMethod } from '../../common/enums/payment-method.enum';
import { InvoiceState } from '../../common/enums/invoice-state.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';
import { DEFAULT_CURRENCY, roundCurrency } from '../../common/constants/money.constants';
import type { OutstandingSettlementsSummary } from '../orders/dto/order-summary.dto';

// FR-048f: outstanding (ISSUED) before settled (SETTLED) before voided
// (VOID), which happens to match the enum's own alphabetical order —
// spelled out as an explicit sort key regardless, so it stays correct if
// that ever stops being a coincidence.
const INVOICE_SORT_KEYS: CursorSortField[] = [
  { field: 'state', direction: 'asc' },
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

@Injectable()
export class InvoicesService {
  constructor(
    @InjectModel(Invoice.name) private readonly invoiceModel: Model<InvoiceDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  /**
   * `creditLimit − Σ(amount of this client's still-ISSUED credit invoices)`
   * (FR-024a) — never an independently mutated counter, so it can never
   * drift from the invoices themselves. Settling or voiding a credit
   * invoice restores credit implicitly, just by leaving the ISSUED sum.
   *
   * Inside a transaction (`session` given — always the `issueInvoice` credit
   * check), the read is a no-op `findOneAndUpdate` rather than a plain
   * `findById`: it writes the client's `creditLimit` back to itself, which
   * registers a write on that document for MongoDB's conflict detection.
   * Two concurrent approvals for the SAME client would otherwise both read
   * "available" before either commits and could together over-commit credit
   * — a real race, since nothing here is a lockable per-client counter to
   * conditionally decrement (that's exactly what FR-024a forbids). This
   * write carries no credit information of its own — the value never
   * changes — so it doesn't reintroduce a mutated counter; it only makes
   * the SECOND of two concurrent transactions abort with a retryable
   * TransientTransactionError, which `session.withTransaction`'s built-in
   * retry re-runs against a fresh, now-consistent read (SC-004).
   */
  async getAvailableCredit(
    clientId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<number> {
    const client = session
      ? await this.userModel
          .findOneAndUpdate({ _id: clientId }, [{ $set: { creditLimit: '$creditLimit' } }], {
            session,
            new: true,
          })
          .exec()
      : await this.userModel.findById(clientId).exec();
    if (!client) {
      throw new NotFoundException('Client not found');
    }
    const creditLimit = client.creditLimit ?? 0;
    const [outstanding] = await this.invoiceModel
      .aggregate<{ total: number }>([
        {
          $match: {
            clientId: new Types.ObjectId(String(clientId)),
            method: PaymentMethod.CREDIT,
            state: InvoiceState.ISSUED,
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .session(session ?? null);
    // Rounded: this is both shown to the client as money and compared
    // against an order's price to admit or refuse it. Summing several
    // invoice amounts and subtracting leaves floating-point residue, and a
    // residue of a few thousandths is enough to refuse an order that sits
    // exactly at the limit — which the spec requires be permitted.
    return roundCurrency(creditLimit - (outstanding?.total ?? 0));
  }

  /**
   * Issues `order`'s invoice at approval (FR-020), inside the caller's own
   * transaction (`orders.service.ts`'s `approve()`). Throws — aborting that
   * transaction, so a refused approval leaves no partial trace (FR-025) —
   * when a CREDIT order's final price exceeds available credit.
   */
  async issueInvoice(order: OrderDocument, session: ClientSession): Promise<InvoiceDocument> {
    const method = order.paymentMethod;
    const amount = order.finalPrice ?? order.estimatedPrice;

    if (method === PaymentMethod.CREDIT) {
      const available = await this.getAvailableCredit(order.clientId, session);
      if (amount > available) {
        throw new BadRequestException(
          `Credit limit exceeded: order requires ${amount.toFixed(2)} SAR but only ` +
            `${available.toFixed(2)} SAR is available`,
        );
      }
    }

    const payerRole =
      method === PaymentMethod.DEFERRED ? UserRole.TRANSPORT_COMPANY_ADMIN : UserRole.CLIENT;

    // spec 005 FR-011e: copied from the order, never recomputed — an
    // invoice must stay self-consistent even if its order is later
    // amended. Two cases end up with no breakdown on the invoice, both
    // deliberate: an order that predates itemised pricing (research R2),
    // and one whose admin overrode `finalPrice` at approval (FR-020/
    // `ApproveOrderDto.finalPrice`) to something other than what the
    // client was quoted — carrying the OLD breakdown forward would show a
    // total that disagrees with its own line items, which is worse than
    // showing no breakdown at all. Either way the invariant holds: when a
    // breakdown IS attached, its total always equals the invoice amount.
    const priceBreakdown =
      order.priceBreakdown && order.priceBreakdown.total === amount
        ? order.priceBreakdown
        : undefined;

    const [invoice] = await this.invoiceModel.create(
      [
        {
          orderId: order._id,
          fuelCompanyId: order.fuelCompanyId,
          clientId: order.clientId,
          amount,
          priceBreakdown,
          method,
          state: InvoiceState.ISSUED,
          payerRole,
        },
      ],
      { session },
    );

    await this.orderModel
      .updateOne({ _id: order._id }, { $set: { invoiceId: invoice._id } }, { session })
      .exec();

    return invoice;
  }

  /** Stamps a DEFERRED invoice's payer once routing resolves the
   * Transportation Company (FR-022) — no-op for DIRECT/CREDIT, whose payer
   * never depends on routing, and for orders with no invoice at all. */
  async setTransportCompanyId(
    orderId: Types.ObjectId | string,
    transportCompanyId: string,
  ): Promise<void> {
    await this.invoiceModel
      .updateOne(
        { orderId, method: PaymentMethod.DEFERRED },
        { $set: { transportCompanyId: new Types.ObjectId(transportCompanyId) } },
      )
      .exec();
  }

  /** Settles the invoice belonging to `orderId`, inside the caller's
   * transaction (the payment webhook, DIRECT only). */
  async settleInvoiceForOrder(
    orderId: Types.ObjectId | string,
    paymentReference: string | undefined,
    session: ClientSession,
  ): Promise<InvoiceDocument> {
    const invoice = await this.invoiceModel.findOne({ orderId }).session(session).exec();
    if (!invoice) {
      throw new NotFoundException(`No invoice exists for order ${orderId}`);
    }
    return this.applySettlement(invoice, paymentReference, session);
  }

  /** Manual settlement by id (spec 004 FR-022's deferred "settleable only
   * by them", and the analogous Fuel-Company-recorded credit repayment) —
   * `findById` is tenant-scoped, so a cross-tenant id is 404 before this
   * even runs (`invoices.controller.ts`). */
  async settleById(id: string, paymentReference: string | undefined): Promise<InvoiceDocument> {
    const invoice = await this.findById(id);
    return this.applySettlement(invoice, paymentReference);
  }

  private async applySettlement(
    invoice: InvoiceDocument,
    paymentReference: string | undefined,
    session?: ClientSession,
  ): Promise<InvoiceDocument> {
    // Idempotent (FR-026): a repeat call — or one that lost a race to a
    // cancellation's void — is a no-op, never a second settlement.
    if (invoice.state !== InvoiceState.ISSUED) {
      return invoice;
    }
    invoice.state = InvoiceState.SETTLED;
    invoice.settledAt = new Date();
    if (paymentReference) {
      invoice.paymentReference = paymentReference;
    }
    await invoice.save({ session });
    return invoice;
  }

  /** Voids an invoice that will never be paid — its order was cancelled
   * before settlement. Idempotent: a SETTLED invoice is never silently
   * voided by a late cancellation. Voiding a CREDIT invoice implicitly
   * restores the client's available credit (FR-024/FR-027) — see
   * {@link getAvailableCredit}. */
  async voidInvoice(orderId: Types.ObjectId | string, session?: ClientSession): Promise<void> {
    await this.invoiceModel
      .updateOne(
        { orderId, state: InvoiceState.ISSUED },
        { $set: { state: InvoiceState.VOID } },
        { session },
      )
      .exec();
  }

  /** Auto-scoped per role by the multi-party plugin (T072): a
   * FUEL_COMPANY_ADMIN sees every invoice their company issued; a
   * TRANSPORT_COMPANY_ADMIN sees only DEFERRED invoices routed to them; a
   * CLIENT sees only their own. Paginated outstanding-before-settled, newest
   * first within each (FR-048f) — an outstanding invoice must never be
   * buried past the first page by a pile of newer settled ones, since it
   * keeps counting against the client's credit either way. */
  findForUser(
    filter: { method?: PaymentMethod; state?: InvoiceState; cursor?: string } = {},
  ): Promise<PaginatedResponse<InvoiceDocument>> {
    const query: Record<string, unknown> = {};
    if (filter.method !== undefined) {
      query.method = filter.method;
    }
    if (filter.state !== undefined) {
      query.state = filter.state;
    }
    return paginate(this.invoiceModel, query, INVOICE_SORT_KEYS, filter.cursor);
  }

  async findById(id: string): Promise<InvoiceDocument> {
    const invoice = await this.invoiceModel.findById(id).exec();
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    return invoice;
  }

  /**
   * Feature 009 FR-059-061: the transport dashboard's own outstanding-debt figure —
   * unsettled DEFERRED invoices routed to the acting company. `.find()` rather than
   * `.aggregate()` deliberately: the multi-party isolation plugin hooks `find`/
   * `countDocuments`/etc. (multi-party-scope.plugin.ts's `SCOPED_QUERY_OPS`) but NOT
   * `aggregate` — an aggregate pipeline on this collection would read across every
   * transport company's invoices unscoped. Outstanding counts per company are small
   * enough that summing in application code costs nothing worth an unscoped read to
   * avoid (Constitution II: isolation must be structural, not a filter remembered by
   * whoever writes the query).
   */
  async getOutstandingSettlementsSummary(): Promise<OutstandingSettlementsSummary> {
    const outstanding = await this.invoiceModel
      .find({ method: PaymentMethod.DEFERRED, state: InvoiceState.ISSUED })
      .select('amount')
      .exec();
    return {
      amount: roundCurrency(outstanding.reduce((sum, inv) => sum + inv.amount, 0)),
      currency: DEFAULT_CURRENCY,
      count: outstanding.length,
    };
  }
}
