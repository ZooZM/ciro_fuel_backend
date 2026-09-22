import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Company, CompanyDocument } from '../../companies/schemas/company.schema';
import { RegionCode } from '../../../common/enums/region.enum';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { OrderStateService, TransitionActor } from '../../orders/services/order-state.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { UserRole } from '../../../common/enums/user-role.enum';
import { InvoicesService } from '../../invoices/invoices.service';
import { CompaniesService } from '../../companies/companies.service';
import { TransportPricingService } from '../../orders/services/transport-pricing.service';
import { PaymentTimeoutQueueService } from '../../payments/queues/payment-timeout-queue.service';
import { PaymentMethod } from '../../../common/enums/payment-method.enum';
import { DEFAULT_CURRENCY, roundCurrency } from '../../../common/constants/money.constants';
import { derivePriceBreakdown } from '../../../common/pricing/derive-price-breakdown';

/**
 * Resolves which Transportation Company(ies) serve a client's region, within
 * one Fuel Company (spec 004 FR-014), and owns the APPROVED ->
 * AWAITING_ROUTING | ROUTED_TO_TRANSPORT transition that follows. Routing is
 * always resolved within the client's own Fuel Company — two Fuel Companies
 * may serve the same region without conflict, since they are isolated
 * tenants (spec Assumptions).
 */
@Injectable()
export class RoutingService {
  constructor(
    @InjectModel(Company.name) private readonly companyModel: Model<CompanyDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly orderStateService: OrderStateService,
    private readonly notificationsService: NotificationsService,
    private readonly invoicesService: InvoicesService,
    private readonly companiesService: CompaniesService,
    private readonly transportPricing: TransportPricingService,
    private readonly paymentTimeoutQueue: PaymentTimeoutQueueService,
    private readonly config: ConfigService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** Active transporters of `fuelCompanyId` whose `servedRegions` include
   * `regionCode`. Empty → FR-016 (no coverage); more than one → FR-014
   * (Fuel Company must choose).
   *
   * Delegates to `CompaniesService`: `PricingService` now resolves the delivery
   * price through this same rule at quote time, and two copies of it would be two
   * places for the answer to drift. */
  findServingTransporters(
    fuelCompanyId: string | Types.ObjectId,
    regionCode: RegionCode,
  ): Promise<CompanyDocument[]> {
    return this.companiesService.findServingTransporters(fuelCompanyId, regionCode);
  }

  /**
   * Resolves and applies routing for an order already at APPROVED
   * (spec 004 FR-014/FR-015/FR-016):
   * - exactly one serving transporter -> ROUTED_TO_TRANSPORT automatically;
   * - none -> AWAITING_ROUTING, Fuel Company notified (FR-016);
   * - more than one and none `chosenTransportCompanyId` given ->
   *   AWAITING_ROUTING too (a holding state for manual resolution — the
   *   same state, whether the reason is zero candidates or an unresolved
   *   choice among several), Fuel Company notified with the candidate list
   *   so their next call can supply the choice;
   * - more than one and a valid `chosenTransportCompanyId` given ->
   *   ROUTED_TO_TRANSPORT with that choice (FR-014).
   *
   * Also used to resolve an already-AWAITING_ROUTING order once an admin
   * supplies (or a later region assignment makes possible) a transporter —
   * `from` distinguishes the two entry points at the transition layer.
   */
  async routeOrder(
    order: OrderDocument,
    actor: TransitionActor,
    from: OrderStatus.APPROVED | OrderStatus.AWAITING_ROUTING,
    chosenTransportCompanyId?: string,
  ): Promise<{ order: OrderDocument; candidates: CompanyDocument[] }> {
    const client = await this.userModel.findById(order.clientId).exec();
    const regionCode = client?.station?.regionCode;
    if (!regionCode) {
      throw new BadRequestException('Client has no station region on file — cannot route');
    }

    const candidates = await this.findServingTransporters(order.fuelCompanyId, regionCode);

    // An explicit choice is ALWAYS validated against the real candidate
    // set, regardless of how many there are — including zero: a chosen id
    // that isn't a genuine, region-serving transporter of this Fuel
    // Company must be rejected, never silently ignored back into
    // AWAITING_ROUTING as if nothing had been chosen.
    let resolvedTransportCompanyId: string | undefined;
    if (chosenTransportCompanyId) {
      const isValidChoice = candidates.some((c) => String(c._id) === chosenTransportCompanyId);
      if (!isValidChoice) {
        throw new BadRequestException(
          'transportCompanyId is not one of the transporters serving this region',
        );
      }
      resolvedTransportCompanyId = chosenTransportCompanyId;
    } else if (candidates.length === 1) {
      resolvedTransportCompanyId = String(candidates[0]._id);
    }

    if (!resolvedTransportCompanyId) {
      const updated =
        from === OrderStatus.AWAITING_ROUTING
          ? order
          : await this.orderStateService.transition(
              order._id as Types.ObjectId,
              from,
              OrderStatus.AWAITING_ROUTING,
              actor,
            );
      await this.notifyUnroutable(updated, candidates);
      return { order: updated, candidates };
    }

    // THE TRANSPORT PRICE BECOMES REAL HERE, and nowhere earlier.
    //
    // This is the first moment the platform knows which company performs the
    // haul, so it is the first moment the delivery leg can be priced at all.
    // Resolved BEFORE the transition, deliberately: a transporter with no rate
    // on file for this area must not be routed to, and refusing here leaves the
    // order exactly where it was rather than routed at a price nobody set.
    const deliveryFee = await this.transportPricing.feeForCompany(
      resolvedTransportCompanyId,
      {
        regionCode,
        governorateCode: client?.station?.governorateCode,
        coordinates: order.deliveryLocation.coordinates as [number, number],
      },
      order.fuelType,
    );

    // Routing, pricing and invoicing are ONE unit of work.
    //
    // They have to be. Issuing the invoice is what runs the CREDIT-limit and
    // DEFERRED-ceiling checks, and those can refuse — so if the routing
    // transition committed on its own first, an over-limit order would be left
    // permanently committed to a transporter, with that transporter notified,
    // and no invoice to bill it by. The refusal must undo the routing that
    // produced the figure it refused (Constitution V).
    const session = await this.connection.startSession();
    let awaiting!: OrderDocument;
    try {
      await session.withTransaction(async () => {
        const routed = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          from,
          OrderStatus.ROUTED_TO_TRANSPORT,
          actor,
          {
            session,
            extraSet: { transportCompanyId: new Types.ObjectId(resolvedTransportCompanyId) },
          },
        );
        awaiting = await this.awaitClientSettlement(routed, deliveryFee, actor, session);
      });
    } finally {
      await session.endSession();
    }

    // Everything below here is after-commit and best-effort: a notification or
    // a queued job that referenced a rolled-back transaction would be worse
    // than one that arrives a moment late.
    await this.notifyRouted(awaiting, resolvedTransportCompanyId);
    if (awaiting.paymentMethod === PaymentMethod.DIRECT) {
      await this.paymentTimeoutQueue.schedule(String(awaiting._id), this.paymentDeadlineMinutes());
    }
    await this.notifyClientPriceReady(awaiting);

    // `issueInvoice` stamps `invoiceId` onto the order with its own update, so
    // the document the transition handed back predates it.
    const fresh = await this.orderModel.findById(awaiting._id).exec();
    return { order: fresh ?? awaiting, candidates: [] };
  }

  /**
   * ROUTED_TO_TRANSPORT -> PENDING_PAYMENT: the order now has a real total, so
   * it goes back to the station owner to settle before a driver is assigned.
   *
   * **This is where the invoice is issued.** It used to be issued at approval,
   * which was the last moment the total was thought to be known; under the
   * amended flow approval happens before any transport price exists, so an
   * invoice issued there would have billed the fuel line alone. Issuing it here
   * means it is issued once, complete, and with its payer already resolved —
   * which also removes the `setTransportCompanyId` back-patch that existed
   * solely because issuance used to precede routing.
   *
   * The CREDIT-limit and DEFERRED-ceiling checks inside `issueInvoice` now run
   * against the true total rather than one missing the haul.
   */
  private async awaitClientSettlement(
    order: OrderDocument,
    deliveryFee: number,
    actor: TransitionActor,
    session: ClientSession,
  ): Promise<OrderDocument> {
    // An order created without a quote token has no itemised breakdown to
    // re-derive from — the pre-005 bare-estimate path, which several suites and
    // any non-app caller still use. It must STILL be charged for the haul: the
    // transport fee is added to the approved `finalPrice` directly. Skipping it
    // for want of a breakdown would hand those orders a free delivery, while
    // the invoice issued a moment later billed them for it.
    const quoted = order.priceBreakdown;
    const priced = quoted
      ? derivePriceBreakdown(
          quoted.unitPrice,
          order.quantityLiters,
          deliveryFee,
          quoted.serviceFeePercent,
          quoted.taxRatePercent,
        )
      : undefined;
    const finalPrice = priced
      ? priced.total
      : roundCurrency((order.finalPrice ?? order.estimatedPrice) + deliveryFee);

    const awaiting = await this.orderStateService.transition(
      order._id as Types.ObjectId,
      OrderStatus.ROUTED_TO_TRANSPORT,
      OrderStatus.PENDING_PAYMENT,
      actor,
      {
        session,
        extraSet: {
          ...(priced
            ? {
                priceBreakdown: {
                  ...priced,
                  currency: DEFAULT_CURRENCY,
                  pricedAt: new Date(),
                },
              }
            : {}),
          finalPrice,
          // A DEADLINE ONLY WHERE ONE IS ENFORCED.
          //
          // Only a DIRECT order gets a timeout job, because only a DIRECT order
          // can lapse: DEFERRED and CREDIT are settled against an invoice, and
          // auto-cancelling one because nobody opened the app would invent a
          // failure the platform never had. Stamping `paymentDeadline` on them
          // anyway would put a countdown in front of the station owner that
          // nothing would ever act on — a clock that means nothing is worse
          // than no clock.
          ...(order.paymentMethod === PaymentMethod.DIRECT
            ? {
                paymentDeadline: new Date(Date.now() + this.paymentDeadlineMinutes() * 60_000),
              }
            : {}),
        },
      },
    );

    // Runs the CREDIT-limit and DEFERRED-ceiling checks, against the TRUE total
    // rather than one missing the haul. A refusal here aborts the caller's
    // transaction, which is what undoes the routing that produced the figure.
    await this.invoicesService.issueInvoice(awaiting, session);
    return awaiting;
  }

  /**
   * `payment.deadlineMinutes` — the same key `OrdersService` reads, fed by
   * `PAYMENT_DEADLINE_MINUTES`. An earlier draft here asked for
   * `order.paymentDeadlineMinutes`, which does not exist in the configuration
   * at all: it never threw, it just fell through to the literal below, so a
   * deployment that had tuned the deadline would silently have got 30 minutes.
   */
  private paymentDeadlineMinutes(): number {
    return this.config.get<number>('payment.deadlineMinutes') ?? 30;
  }

  /**
   * The station owner is told the moment the real total exists — this
   * notification IS the "come and look at it" step of the flow.
   *
   * Reuses `ORDER_APPROVED_FINAL_PRICE`, which already means exactly this
   * ("your final price is settled, review it"); it was simply sent at approval
   * before, when the figure it named was not yet final. Deliberately NOT a new
   * `NotificationType`: the mobile app pins its own enum to these wire values
   * (spec 007's parity test), so adding one is a release gated on a repository
   * this change does not touch.
   */
  private async notifyClientPriceReady(order: OrderDocument): Promise<void> {
    await this.notificationsService.notify({
      companyId: order.fuelCompanyId,
      recipientUserId: order.clientId,
      type: NotificationType.ORDER_APPROVED_FINAL_PRICE,
      orderId: order._id as Types.ObjectId,
      payload: {
        finalPrice: order.finalPrice,
        deliveryFee: order.priceBreakdown?.deliveryFee,
        paymentMethod: order.paymentMethod,
      },
    });
  }

  private async notifyRouted(order: OrderDocument, transportCompanyId: string): Promise<void> {
    const admins = await this.userModel
      .find({
        companyId: transportCompanyId,
        role: UserRole.TRANSPORT_COMPANY_ADMIN,
        isActive: true,
      })
      .exec();
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId: transportCompanyId,
          recipientUserId: admin._id as Types.ObjectId,
          type: NotificationType.ORDER_ROUTED_TO_TRANSPORT,
          orderId: order._id as Types.ObjectId,
        }),
      ),
    );
  }

  /** FR-016: zero or ambiguous candidates — only the Fuel Company can
   * resolve it (assign regions to a transporter, or PATCH .../route). */
  private async notifyUnroutable(
    order: OrderDocument,
    candidates: CompanyDocument[],
  ): Promise<void> {
    const admins = await this.userModel
      .find({ companyId: order.fuelCompanyId, role: UserRole.FUEL_COMPANY_ADMIN, isActive: true })
      .exec();
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId: order.fuelCompanyId,
          recipientUserId: admin._id as Types.ObjectId,
          type: NotificationType.NO_DRIVER_AVAILABLE,
          orderId: order._id as Types.ObjectId,
          payload: { candidateTransportCompanyIds: candidates.map((c) => String(c._id)) },
        }),
      ),
    );
  }
}
