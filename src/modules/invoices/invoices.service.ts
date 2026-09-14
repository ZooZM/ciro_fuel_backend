import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
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
import { BillingService } from '../billing/billing.service';

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
    @InjectConnection() private readonly connection: Connection,
    private readonly billingService: BillingService,
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

    // spec 013 T147/FR-062d: "further DEFERRED dealing" — DIRECT orders are paid
    // immediately via gateway and never extend the fuel company's own exposure to the
    // platform, so only DEFERRED/CREDIT are gated. Thrown from inside this same
    // transaction (same pattern as the CREDIT-limit check above it), so a refused
    // approval leaves the order at PENDING_APPROVAL, never half-approved.
    if (method === PaymentMethod.DEFERRED || method === PaymentMethod.CREDIT) {
      await this.billingService.assertUnderCeiling(order.fuelCompanyId, session);
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
          // The PAYER of a DEFERRED invoice, stamped at issuance.
          //
          // It used to be back-patched by `setTransportCompanyId` immediately
          // after routing, because issuance preceded routing and the payer was
          // not yet known. Issuance now FOLLOWS routing — the transport company
          // is what makes the total knowable — so the payer is known here, and
          // one write inside this transaction replaces a second write outside
          // it that could fail on its own and leave a DEFERRED invoice nobody
          // could see or settle.
          //
          // DEFERRED only, deliberately: `transportCompanyId` is what the
          // multi-party scope reads to decide whether a transporter may see an
          // invoice at all. Stamping it on a CREDIT or DIRECT invoice — both of
          // which are now equally routed — would disclose to the transporter a
          // bill that is none of their business (FR-002).
          ...(method === PaymentMethod.DEFERRED && order.transportCompanyId
            ? { transportCompanyId: order.transportCompanyId }
            : {}),
        },
      ],
      { session },
    );

    await this.orderModel
      .updateOne({ _id: order._id }, { $set: { invoiceId: invoice._id } }, { session })
      .exec();

    // T142/T143/R4: inside the same transaction as issuance — an invoice can never exist
    // without its commission having been accrued (or genuinely skipped, no term set).
    await this.billingService.accrueCommission(order, invoice, session);

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
   * even runs (`invoices.controller.ts`).
   *
   * spec 013 T144: unlike `settleInvoiceForOrder` (already inside the payment webhook's
   * transaction), this path previously ran with no transaction at all — cashback accrual
   * needs one (Principle V: a settled invoice must never exist without its cashback
   * having been accrued, or genuinely skipped), so this now opens its own.
   */
  async settleById(id: string, paymentReference: string | undefined): Promise<InvoiceDocument> {
    const session = await this.connection.startSession();
    let settled!: InvoiceDocument;
    try {
      await session.withTransaction(async () => {
        const invoice = await this.invoiceModel.findById(id).session(session).exec();
        if (!invoice) {
          throw new NotFoundException('Invoice not found');
        }
        settled = await this.applySettlement(invoice, paymentReference, session);
      });
    } finally {
      await session.endSession();
    }
    return settled;
  }

  private async applySettlement(
    invoice: InvoiceDocument,
    paymentReference: string | undefined,
    session: ClientSession,
  ): Promise<InvoiceDocument> {
    // Idempotent (FR-026): a repeat call — or one that lost a race to a
    // cancellation's void — is a no-op, never a second settlement, and never a second
    // cashback accrual (T144's "as invoices are paid" fires exactly once).
    if (invoice.state !== InvoiceState.ISSUED) {
      return invoice;
    }
    invoice.state = InvoiceState.SETTLED;
    invoice.settledAt = new Date();
    if (paymentReference) {
      invoice.paymentReference = paymentReference;
    }
    await invoice.save({ session });
    await this.billingService.accrueCashback(invoice, session);
    return invoice;
  }

  /** Voids an invoice that will never be paid — its order was cancelled
   * before settlement. Idempotent: a SETTLED invoice is never silently
   * voided by a late cancellation. Voiding a CREDIT invoice implicitly
   * restores the client's available credit (FR-024/FR-027) — see
   * {@link getAvailableCredit}.
   *
   * spec 013 T149/FR-063: reverses commission (and cashback, on the rare invoice already
   * SETTLED-then-somehow-voided path — reversal is a no-op for a never-accrued kind
   * since `reverseMovementsForInvoice` only reverses what it finds) inside the same
   * transaction as the void itself — the accrual and its reversal are never separately
   * observable.
   */
  async voidInvoice(orderId: Types.ObjectId | string, session?: ClientSession): Promise<void> {
    const invoice = await this.invoiceModel.findOne({ orderId }).session(session ?? null).exec();
    if (!invoice || invoice.state !== InvoiceState.ISSUED) {
      return;
    }
    const result = await this.invoiceModel
      .updateOne(
        { orderId, state: InvoiceState.ISSUED },
        { $set: { state: InvoiceState.VOID } },
        { session },
      )
      .exec();
    if (result.modifiedCount === 0 || !session) {
      return;
    }
    await this.billingService.reverseAccrualsForInvoice(invoice._id as Types.ObjectId, session);
  }

  /** Auto-scoped per role by the multi-party plugin (T072): a
   * FUEL_COMPANY_ADMIN sees every invoice their company issued; a
   * TRANSPORT_COMPANY_ADMIN sees only DEFERRED invoices routed to them; a
   * CLIENT sees only their own. Paginated outstanding-before-settled, newest
   * first within each (FR-048f) — an outstanding invoice must never be
   * buried past the first page by a pile of newer settled ones, since it
   * keeps counting against the client's credit either way. */
  findForUser(
    filter: { method?: PaymentMethod; state?: InvoiceState; cursor?: string; fuelCompanyId?: string } = {},
  ): Promise<PaginatedResponse<InvoiceDocument>> {
    const query: Record<string, unknown> = {};
    if (filter.method !== undefined) {
      query.method = filter.method;
    }
    if (filter.state !== undefined) {
      query.state = filter.state;
    }
    // spec 013 T238 (US13): safe to accept unconditionally — the multi-party plugin's
    // own `.where({fuelCompanyId})` overwrites this key for FCA/TCA/CLIENT regardless of
    // what is passed (same override precedent as the plugin's own tests), so it is only
    // ever load-bearing for SUPER_ADMIN, who bypasses the plugin and otherwise sees
    // every company's invoices mixed together with no way to narrow to one.
    if (filter.fuelCompanyId !== undefined) {
      query.fuelCompanyId = filter.fuelCompanyId;
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

  /**
   * spec 013 (fuel company admin dashboard) T111/T113/FR-046 — the Fuel Company's own
   * "amounts outstanding": CREDIT invoices still ISSUED (money owed by their own
   * clients), distinct from `getOutstandingSettlementsSummary` above, which is DEFERRED
   * only (money owed by a transporter) and is what `GET /orders/summary` already returns
   * to a `TRANSPORT_COMPANY_ADMIN`. Same scoping note applies: relies on the multi-party
   * plugin's ambient scope rather than an explicit `fuelCompanyId` filter.
   */
  async getCreditOutstandingSummary(): Promise<OutstandingSettlementsSummary> {
    const outstanding = await this.invoiceModel
      .find({ method: PaymentMethod.CREDIT, state: InvoiceState.ISSUED })
      .select('amount')
      .exec();
    return {
      amount: roundCurrency(outstanding.reduce((sum, inv) => sum + inv.amount, 0)),
      currency: DEFAULT_CURRENCY,
      count: outstanding.length,
    };
  }
}
