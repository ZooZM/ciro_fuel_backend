import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { PaymentMethod } from '../../common/enums/payment-method.enum';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Truck, TruckDocument } from '../trucks/schemas/truck.schema';
import { Tank, TankDocument } from '../tanks/schemas/tank.schema';
import { OrderStateService, TransitionActor } from './services/order-state.service';
import { OtpService } from './services/otp.service';
import { PaymentTimeoutQueueService } from '../payments/queues/payment-timeout-queue.service';
import { StopEscalationQueueService } from '../stop-detection/queues/stop-escalation-queue.service';
import { AssignmentEscalationQueueService } from '../assignment-escalation/queues/assignment-escalation-queue.service';
import { InvoicesService } from '../invoices/invoices.service';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';
import { PricingService } from './services/pricing.service';
import { StationsService } from '../stations/stations.service';
import { OrderSummaryDto, FuelCompanySummaryDto } from './dto/order-summary.dto';
import { PlatformSummaryDto } from './dto/platform-summary.dto';
import {
  ORDER_STATUS_BUCKETS,
  OrderStatusBucket,
} from '../../common/constants/order-status-buckets';
import { LitreBalancesService, DrawdownResult } from '../litre-balances/litre-balances.service';

export interface CreateOrderResult {
  order: OrderDocument;
  litreDrawdown: DrawdownResult;
}

// Matches the `{ clientId, updatedAt, _id }` / `{ clientId, status,
// updatedAt, _id }` indexes on Order (spec 005 FR-048/research R3).
const ORDER_LIST_SORT_KEYS: CursorSortField[] = [
  { field: 'updatedAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Truck.name) private readonly truckModel: Model<TruckDocument>,
    @InjectModel(Tank.name) private readonly tankModel: Model<TankDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly tenantContext: TenantContextService,
    // `CompaniesService` is gone from here: its only use was the bare
    // `getBasePrice` the unquoted creation path multiplied by the litre count.
    // Pricing now goes through `PricingService` on both paths, which is the
    // one place that knows about service fees and VAT.
    private readonly usersService: UsersService,
    private readonly orderStateService: OrderStateService,
    private readonly otpService: OtpService,
    private readonly paymentTimeoutQueue: PaymentTimeoutQueueService,
    private readonly invoicesService: InvoicesService,
    private readonly config: ConfigService,
    private readonly pricingService: PricingService,
    private readonly stationsService: StationsService,
    private readonly assignmentEscalationQueue: AssignmentEscalationQueueService,
    private readonly stopEscalationQueue: StopEscalationQueueService,
    private readonly litreBalancesService: LitreBalancesService,
  ) {}

  private getPaymentDeadlineMinutes(): number {
    return this.config.get<number>('payment.deadlineMinutes') ?? 30;
  }

  /**
   * spec 010 FR-010/FR-014a: the explicit driver-side acknowledgment signal
   * (research R2) — never inferred from `Notification.readAt` or from
   * presence/connectivity. Idempotent: a second call for an already-
   * acknowledged assignment is a harmless no-op, not an error.
   */
  async acknowledgeAssignment(order: OrderDocument): Promise<OrderDocument> {
    if (!order.assignmentAcknowledgedAt) {
      order.assignmentAcknowledgedAt = new Date();
      await order.save();
      await this.assignmentEscalationQueue.cancel(String(order._id));
    }
    return order;
  }

  async create(clientUser: AuthenticatedUser, dto: CreateOrderDto): Promise<CreateOrderResult> {
    if (!clientUser.companyId) {
      throw new ForbiddenException('Client must belong to a company');
    }

    const client = await this.usersService.findById(clientUser.userId);

    // spec 005 US2: a quoteToken (sent by the real client app — T063) buys the
    // staleness check that a token exists for. Its absence no longer changes
    // what the order COSTS, only what has been verified about that cost:
    // `createPriced` re-validates the token against live rates, while the
    // branch below simply reads those rates now.
    if (dto.quoteToken) {
      return this.createPriced(clientUser, client, dto);
    }

    // `stationId` used to be read ONLY on the quoted path, so supplying it here
    // was silently ignored: the order was created against the client's legacy
    // embedded `client.station` instead, and carried no `stationId` at all. A
    // station owner with three sites who ordered to the second one had the fuel
    // scheduled to the first, with nothing anywhere reporting a mismatch. It is
    // honoured here now, through the same ownership-checked lookup the quoted
    // path uses — a station belonging to someone else is 404, not a silent
    // fallback to the default.
    const station = dto.stationId
      ? await this.stationsService.findOwnedByClient(dto.stationId, clientUser.userId)
      : null;

    const deliveryLocation = dto.deliveryLocation
      ? {
          type: 'Point',
          coordinates: [dto.deliveryLocation.longitude, dto.deliveryLocation.latitude],
        }
      : (station?.location ?? client.station?.location);
    if (!deliveryLocation) {
      throw new BadRequestException(
        'No delivery location provided and client has no station location on file',
      );
    }

    // Was `basePrice × litres` and nothing else — no service fee, no VAT — so
    // an order placed without a quote was invoiced roughly 16% under one placed
    // with it, and every downstream reader (approval, invoicing, credit)
    // faithfully used the lower figure. Both paths now derive from the same
    // live rates. Throws PRICING_NOT_CONFIGURED where the company has none,
    // which is the same refusal `POST /orders/quote` already gives for that gap
    // and strictly more informative than the old "no base price" message.
    const priceBreakdown = await this.pricingService.priceWithoutQuote(
      clientUser.companyId,
      dto.fuelType,
      dto.quantityLiters,
    );

    return this.createWithDrawdown(clientUser, dto.fuelType, dto.quantityLiters, {
      fuelCompanyId: new Types.ObjectId(clientUser.companyId),
      clientId: new Types.ObjectId(clientUser.userId),
      fuelType: dto.fuelType,
      quantityLiters: dto.quantityLiters,
      deliveryLocation,
      // Snapshotted once at creation (FR-009/FR-030/FR-012) — never
      // re-derived even if the client later edits their station address.
      deliveryAddressText: station?.addressText ?? client.station?.addressText ?? '',
      ...(station ? { stationId: station._id } : {}),
      priceBreakdown,
      status: OrderStatus.PENDING_APPROVAL,
      estimatedPrice: priceBreakdown.total,
      paymentMethod: dto.paymentMethod ?? PaymentMethod.DIRECT,
    });
  }

  /**
   * The real spec-005 path: `stationId` is required alongside `quoteToken`
   * (contract §4), and the token is re-validated against live pricing
   * before anything is written — `PricingService.redeem` throws
   * `QUOTE_STALE`/`QUOTE_EXPIRED` rather than ever returning a number the
   * app supplied (research R10). The resulting `priceBreakdown` is what
   * gets persisted; `estimatedPrice` is set to its `total` so every
   * existing reader of that field (approval, invoicing, credit) keeps
   * working unchanged.
   */
  private async createPriced(
    clientUser: AuthenticatedUser,
    client: UserDocument,
    dto: CreateOrderDto,
  ): Promise<CreateOrderResult> {
    if (!dto.stationId) {
      throw new BadRequestException('stationId is required when quoteToken is supplied');
    }
    const station = await this.stationsService.findOwnedByClient(dto.stationId, clientUser.userId);
    const priceBreakdown = await this.pricingService.redeem(
      dto.quoteToken!,
      clientUser.companyId!,
      dto.fuelType,
      dto.quantityLiters,
      // Redemption re-reads the delivery price from the SAME station the quote was
      // issued against, so a transporter's rate change between quote and confirmation
      // surfaces as QUOTE_STALE exactly as a fuel-price change already does.
      {
        regionCode: station.regionCode,
        governorateCode: station.governorateCode,
        coordinates: station.location.coordinates as [number, number],
      },
    );

    const deliveryLocation = dto.deliveryLocation
      ? {
          type: 'Point',
          coordinates: [dto.deliveryLocation.longitude, dto.deliveryLocation.latitude],
        }
      : station.location;

    return this.createWithDrawdown(clientUser, dto.fuelType, dto.quantityLiters, {
      fuelCompanyId: new Types.ObjectId(clientUser.companyId),
      clientId: new Types.ObjectId(clientUser.userId),
      fuelType: dto.fuelType,
      quantityLiters: dto.quantityLiters,
      deliveryLocation,
      deliveryAddressText: station.addressText ?? client.station?.addressText ?? '',
      stationId: station._id,
      priceBreakdown,
      status: OrderStatus.PENDING_APPROVAL,
      estimatedPrice: priceBreakdown.total,
      paymentMethod: dto.paymentMethod ?? PaymentMethod.DIRECT,
    });
  }

  /**
   * spec 013 T194/T195/R9/Principle V — the order and its litre-balance drawdown commit
   * in ONE transaction: an order can never exist whose drawdown was never applied, and a
   * drawdown can never be recorded against an order that failed to create. This is the
   * "existing creation transaction" T194 refers to — order creation had none before this
   * phase (a single-document `create()` needed none); litre balances are the first thing
   * that makes it a genuinely multi-document write.
   */
  private async createWithDrawdown(
    clientUser: AuthenticatedUser,
    fuelType: CreateOrderDto['fuelType'],
    quantityLiters: number,
    orderFields: Record<string, unknown>,
  ): Promise<CreateOrderResult> {
    const session = await this.connection.startSession();
    let result!: CreateOrderResult;
    try {
      await session.withTransaction(async () => {
        const [order] = await this.orderModel.create([orderFields], { session });
        const litreDrawdown = await this.litreBalancesService.drawdown(
          order.fuelCompanyId,
          order.clientId,
          fuelType,
          order._id as Types.ObjectId,
          quantityLiters,
          clientUser.userId,
          session,
        );
        result = { order, litreDrawdown };
      });
    } finally {
      await session.endSession();
    }
    return result;
  }

  async findById(id: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  /**
   * Enforces per-role visibility on top of the tenant plugin's companyId
   * scoping, and paginates by cursor (spec 005 FR-048). `status`, when
   * given, is applied as a plain equality filter across the caller's whole
   * set — never as a post-filter on an already-fetched page (FR-048d).
   *
   * Sorted `updatedAt` desc — the platform has no dedicated
   * `statusChangedAt` field; every status transition already touches
   * `updatedAt` via Mongoose's own timestamps, and the mobile app's mapper
   * already reads `updatedAt` as its fallback for exactly this reason (see
   * `order.schema.ts`'s pagination index comment).
   *
   * spec 017 (operator dashboard) FR-016/FR-016a adds `bucket` and `orderId`.
   *
   * **`bucket` expands to `status: { $in: [...] }` and NEVER to a `$or`.** Both
   * scoping plugins inject their own filter through `Query.where()`, which
   * REPLACES a top-level key of the same name rather than merging it — the
   * exact defect feature 016 hit on every `$or` it built over `ExchangeOffer`.
   * A `$or` here would be silently discarded for a `FUEL_COMPANY_ADMIN` (whose
   * scoped read injects one) and work perfectly for the operator (who bypasses
   * both plugins), so the happy-path test would pass and the leak would ship.
   * `status` collides with nothing either plugin injects, so `$in` is safe for
   * every role (research R4).
   */
  findForUser(
    user: AuthenticatedUser,
    filter: { status?: OrderStatus; bucket?: OrderStatusBucket; orderId?: string; cursor?: string },
  ): Promise<PaginatedResponse<OrderDocument>> {
    const query: Record<string, unknown> = {};
    // FR-016a: an exact identifier overrides both state filters. Search is
    // identifier-only and that is a recorded decision, not an oversight —
    // `Order` has no human reference field, its human-facing values are
    // embedded snapshots, and the platform carries no text index anywhere, so
    // free text would mean either a new index plus a migration or an unindexed
    // scan of every order on the operator's most-used screen (research R13).
    //
    // No visibility check is needed here and none is wanted: the scoping
    // plugins still apply, so a caller naming another tenant's order simply
    // gets an empty page — never that order, and never a 403 that would
    // confirm the id exists.
    if (filter.orderId) {
      // A malformed identifier is an empty page, not a 500 and not a 400. The
      // value comes from a free-text search box, so "that is not an order
      // identifier" and "no such order" are the same answer to the person
      // typing; letting it reach Mongoose would raise a CastError instead.
      if (!Types.ObjectId.isValid(filter.orderId)) {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      query._id = filter.orderId;
    } else {
      if (filter.bucket) {
        query.status = { $in: [...ORDER_STATUS_BUCKETS[filter.bucket]] };
      }
      // A `status` supplied alongside a `bucket` narrows to that one state —
      // the controller has already refused the case where it is not a member
      // of the bucket, so this can only ever narrow within it.
      if (filter.status) {
        query.status = filter.status;
      }
    }
    if (user.role === UserRole.CLIENT) {
      query.clientId = user.userId;
    } else if (user.role === UserRole.DRIVER) {
      query.driverId = user.userId;
    }
    return paginate(this.orderModel, query, ORDER_LIST_SORT_KEYS, filter.cursor);
  }

  async findOneForUser(user: AuthenticatedUser, id: string): Promise<OrderDocument> {
    const order = await this.findById(id);
    // FUEL_COMPANY_ADMIN/TRANSPORT_COMPANY_ADMIN/SUPER_ADMIN get a blanket
    // true here because the multi-party plugin's DB-level scoping already
    // did the real work: `findById` itself can only ever return an order
    // that role is legitimately a participant of (or, for SUPER_ADMIN,
    // bypasses scoping entirely) — this is just the CLIENT/DRIVER-specific
    // ownership check the plugin's own filter doesn't narrow any further.
    const isOwner =
      (user.role === UserRole.CLIENT && String(order.clientId) === user.userId) ||
      (user.role === UserRole.DRIVER && String(order.driverId) === user.userId) ||
      user.role === UserRole.FUEL_COMPANY_ADMIN ||
      user.role === UserRole.TRANSPORT_COMPANY_ADMIN ||
      user.role === UserRole.SUPER_ADMIN;
    if (!isOwner) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  /**
   * PENDING_APPROVAL -> APPROVED, then issues the order's invoice in the
   * same transaction (spec 004 FR-020) — a refused CREDIT approval
   * (FR-025) throws from inside that transaction, so the order never moves
   * off PENDING_APPROVAL. DIRECT orders continue straight into
   * PENDING_PAYMENT (FR-020a: never routed before settlement); DEFERRED and
   * CREDIT orders stop here — the caller (orders.controller.ts) routes them
   * immediately, exactly as approval did before billing existed.
   */
  async approve(
    order: OrderDocument,
    actor: TransitionActor,
    dto: { finalPrice?: number },
  ): Promise<OrderDocument> {
    const finalPrice = dto.finalPrice ?? order.estimatedPrice;
    const session = await this.connection.startSession();
    let approved!: OrderDocument;
    try {
      await session.withTransaction(async () => {
        approved = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          OrderStatus.PENDING_APPROVAL,
          OrderStatus.APPROVED,
          actor,
          { session, extraSet: { finalPrice, approvedBy: new Types.ObjectId(actor.actorId) } },
        );
      });
    } finally {
      await session.endSession();
    }

    // NEITHER the invoice NOR the payment gate happens here any more.
    //
    // Both used to, because approval was thought to be the moment the total was
    // settled. It is not: the delivery leg is priced by the transport company
    // that performs it, and that company is not chosen until routing, one step
    // later. An invoice issued here would have billed the fuel line alone, and
    // a DIRECT order would have been made to pay before anyone could tell it
    // what the haul cost.
    //
    // `RoutingService.awaitClientSettlement` now does both, at the first moment
    // the total exists. `finalPrice` set above is the fuel-side figure and is
    // superseded there — an admin's override of it still stands, and still
    // suppresses the breakdown on the invoice exactly as it always did.
    return this.findById(String(approved._id));
  }

  /**
   * The station owner has settled (DIRECT, via the payment webhook) or accepted
   * (DEFERRED/CREDIT, via `POST /orders/:id/accept`) the total that routing
   * priced. The order returns to the transporter it was already routed to, and
   * the driver assignment waiting behind it can proceed.
   */
  async settleAndResume(order: OrderDocument, actor: TransitionActor): Promise<OrderDocument> {
    const resumed = await this.orderStateService.transition(
      order._id as Types.ObjectId,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.ROUTED_TO_TRANSPORT,
      actor,
      { extraUnset: ['paymentDeadline'] },
    );
    await this.paymentTimeoutQueue.cancel(String(order._id));
    return resumed;
  }

  /**
   * FR-021 as amended: a DEFERRED or CREDIT order has no gateway payment to
   * make, so the station owner's review ends in an explicit acceptance of the
   * total instead. Refusing is the ordinary client cancellation they already
   * have — `PENDING_PAYMENT -> CANCELLED` is an edge the state machine has
   * carried since spec 004, and it releases every booked resource.
   */
  async acceptFinalPrice(order: OrderDocument, actor: TransitionActor): Promise<OrderDocument> {
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException({
        error: ErrorCode.ORDER_NOT_AWAITING_CONFIRMATION,
        message: 'This order is not awaiting your confirmation',
      });
    }
    if (order.paymentMethod === PaymentMethod.DIRECT) {
      throw new ConflictException({
        error: ErrorCode.ORDER_NOT_AWAITING_CONFIRMATION,
        message: 'A DIRECT order is confirmed by paying it, not by accepting it',
      });
    }
    return this.settleAndResume(order, actor);
  }

  /**
   * Re-opens the payment window after a timeout reverted a DIRECT order to
   * bare APPROVED (FR-015a) — this status is reached only that way, since
   * DEFERRED/CREDIT orders route immediately at approval and never expire
   * (FR-020b). A fresh `paymentDeadline` is set and the timeout job
   * rescheduled; routing itself only resumes once this window is paid
   * (the webhook calls `routingService.routeOrder`, same as approval did).
   */
  async reopenPaymentWindow(order: OrderDocument, actor: TransitionActor): Promise<OrderDocument> {
    const updated = await this.enterPendingPayment(order, actor);
    await this.paymentTimeoutQueue.schedule(String(order._id), this.getPaymentDeadlineMinutes());
    return updated;
  }

  private enterPendingPayment(
    order: OrderDocument,
    actor: TransitionActor,
    session?: ClientSession,
  ): Promise<OrderDocument> {
    const paymentDeadline = new Date(Date.now() + this.getPaymentDeadlineMinutes() * 60_000);
    return this.orderStateService.transition(
      order._id as Types.ObjectId,
      OrderStatus.APPROVED,
      OrderStatus.PENDING_PAYMENT,
      actor,
      { session, extraSet: { paymentDeadline } },
    );
  }

  /**
   * spec 008 FR-044: releases the driver, truck and tank alike — the same
   * conditional-on-`activeOrderId` release the driver already used, now
   * extended to the two resources booked alongside them (research R13).
   * Withdrawal (`isActive: false`) is deliberately untouched here — this
   * only ever clears the booking, never a truck/tank's service state.
   *
   * Runs under `tenantContext.runUnscoped` deliberately. `User`/`Truck`/
   * `Tank` are single-tenant, scoped to the TRANSPORT company that owns
   * them — but this method is also reached from `forceComplete` (a
   * FUEL_COMPANY_ADMIN action) and `cancel` (FUEL_COMPANY_ADMIN or CLIENT),
   * whose own tenant context carries the FUEL company's id. Left scoped,
   * `tenant-scope.plugin.ts`'s global `pre('updateOne')` hook unconditionally
   * overwrites the filter with the ACTING actor's companyId (by design, to
   * stop a caller smuggling a foreign one in) — which, for these two
   * callers, is never the transport company's id, so every one of these
   * three updates matches zero documents and silently no-ops. The order
   * itself still transitions correctly (it's multi-party-scoped, not
   * single-companyId-scoped), so the bug was invisible everywhere except
   * the driver/truck/tank staying permanently booked afterward — caught
   * here, not by a passing test, because the existing force-complete test
   * never asserted on the release. `completeDelivery`'s own call (the
   * driver completing their own delivery) never hit this: a driver's own
   * companyId already IS the transport company, so the plugin's rewritten
   * filter happened to match by coincidence. `runUnscoped` is the same
   * established escape hatch `DispatchService.assignDriver` already uses to
   * read the client across the same boundary (research/plan precedent) —
   * safe here because every id released was resolved from `order` itself,
   * never accepted from the caller.
   */
  private async releaseDriverIfAssigned(
    order: OrderDocument,
    session: import('mongoose').ClientSession,
  ): Promise<void> {
    await this.tenantContext.runUnscoped(async () => {
      if (order.driverId) {
        await this.userModel
          .updateOne(
            { _id: order.driverId, activeOrderId: order._id },
            { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
            { session },
          )
          .exec();
      }
      if (order.truckId) {
        await this.truckModel
          .updateOne(
            { _id: order.truckId, activeOrderId: order._id },
            { $unset: { activeOrderId: '' } },
            { session },
          )
          .exec();
      }
      if (order.tankId) {
        await this.tankModel
          .updateOne(
            { _id: order.tankId, activeOrderId: order._id },
            { $unset: { activeOrderId: '' } },
            { session },
          )
          .exec();
      }
    });
  }

  /**
   * spec 008 FR-015: swaps the assigned truck/tank before the delivery has
   * departed — releasing the old resources and booking the new ones in the
   * same transaction the original assignment used (research R13). `409
   * ALREADY_DEPARTED` once the order has moved past ASSIGNED_TO_DRIVER;
   * this is a pre-departure correction, not a mid-delivery reroute.
   */
  async reassignVehicle(
    order: OrderDocument,
    truckId: string,
    tankId: string,
  ): Promise<OrderDocument> {
    if (order.status !== OrderStatus.ASSIGNED_TO_DRIVER) {
      throw new ConflictException({
        error: ErrorCode.ALREADY_DEPARTED,
        message: 'Vehicle can only be reassigned before departure',
      });
    }

    const session = await this.connection.startSession();
    try {
      let updated!: OrderDocument;
      await session.withTransaction(async () => {
        if (order.truckId) {
          await this.truckModel
            .updateOne(
              { _id: order.truckId, activeOrderId: order._id },
              { $unset: { activeOrderId: '' } },
              { session },
            )
            .exec();
        }
        if (order.tankId) {
          await this.tankModel
            .updateOne(
              { _id: order.tankId, activeOrderId: order._id },
              { $unset: { activeOrderId: '' } },
              { session },
            )
            .exec();
        }

        const bookedTruck = await this.truckModel
          .findOneAndUpdate(
            { _id: truckId, isActive: true, activeOrderId: { $exists: false } },
            { $set: { activeOrderId: order._id } },
            { new: true, session },
          )
          .exec();
        if (!bookedTruck) {
          throw new ConflictException({
            error: ErrorCode.TRUCK_UNAVAILABLE,
            message: 'Chosen truck is no longer available',
          });
        }

        const bookedTank = await this.tankModel
          .findOneAndUpdate(
            { _id: tankId, isActive: true, activeOrderId: { $exists: false } },
            { $set: { activeOrderId: order._id } },
            { new: true, session },
          )
          .exec();
        if (!bookedTank) {
          throw new ConflictException({
            error: ErrorCode.TANK_UNAVAILABLE,
            message: 'Chosen tank is no longer available',
          });
        }
        if (bookedTank.maxCapacityLiters < order.quantityLiters) {
          throw new ConflictException({
            error: ErrorCode.TANK_CAPACITY_EXCEEDED,
            message: 'The selected tank cannot carry this order’s quantity',
          });
        }
        if (!bookedTank.fuelTypes.includes(order.fuelType)) {
          throw new ConflictException({
            error: ErrorCode.TANK_GRADE_UNSUPPORTED,
            message: 'The selected tank is not permitted to carry this order’s fuel grade',
          });
        }

        updated = (await this.orderModel
          .findOneAndUpdate(
            { _id: order._id },
            {
              $set: {
                truckId: bookedTruck._id,
                tankId: bookedTank._id,
                'driverSummary.plateNumber': bookedTruck.plateNumber,
                tankSummary: { code: bookedTank.code, material: bookedTank.material },
              },
            },
            { new: true, session },
          )
          .exec())!;
      });
      return updated;
    } finally {
      await session.endSession();
    }
  }

  async cancel(
    order: OrderDocument,
    from: OrderStatus,
    actor: TransitionActor,
    reason?: string,
  ): Promise<OrderDocument> {
    const session = await this.connection.startSession();
    try {
      let updated!: OrderDocument;
      await session.withTransaction(async () => {
        await this.releaseDriverIfAssigned(order, session);
        updated = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          from,
          OrderStatus.CANCELLED,
          actor,
          {
            session,
            extraSet: {
              cancelledBy: new Types.ObjectId(actor.actorId),
              cancellationReason: reason,
            },
          },
        );
        // A cancelled order's invoice (if one was ever issued) will never
        // be paid — void it so a late webhook/settlement can never silently
        // apply to it (FR-020a/FR-027), and so a voided CREDIT invoice
        // implicitly restores the client's available credit.
        if (order.invoiceId) {
          await this.invoicesService.voidInvoice(order._id as Types.ObjectId, session);
        }
        // spec 013 T197/spec Edge Cases: a cancelled order returns whatever it drew down
        // (a no-op if it never drew anything) — inside the same transaction as the
        // cancellation itself, so an order can never end up CANCELLED with its drawdown
        // left applied, or vice versa.
        await this.litreBalancesService.returnDrawdown(
          order.fuelCompanyId,
          order.clientId,
          order.fuelType,
          order._id as Types.ObjectId,
          actor.actorId,
          session,
        );
      });
      if (from === OrderStatus.ASSIGNED_TO_DRIVER || from === OrderStatus.PENDING_PAYMENT) {
        await this.paymentTimeoutQueue.cancel(String(order._id));
      }
      // spec 010 FR-014a: the only real "no longer applies" case — the platform has no
      // capability to reassign an order's driver, only to cancel the order outright
      // (narrowed during implementation, see data-model.md's Cancellation note). Guarded
      // the same as ADMIN_CANCELLABLE's driver-having statuses in the controller.
      if (from === OrderStatus.ASSIGNED_TO_DRIVER || from === OrderStatus.LOADING) {
        await this.assignmentEscalationQueue.cancel(String(order._id));
      }
      // Currently unreachable, and kept deliberately: `ADMIN_CANCELLABLE`
      // stops at LOADING, so an IN_TRANSIT delivery cannot be cancelled at
      // all — and IN_TRANSIT is the only status a stop can exist in. If that
      // list ever widens, this is the line that stops a cancelled delivery
      // still alerting its transporter minutes later. Costs one no-op call.
      await this.cancelPendingStopEscalations(order);
      return updated;
    } finally {
      await session.endSession();
    }
  }

  /**
   * spec 011 FR-014: once a delivery is over, nothing about it should still
   * be counting down. A stop raised minutes before the truck was cancelled
   * or force-completed would otherwise fire its escalation afterwards, and
   * the transporter would be told a finished delivery has an unexplained
   * stop — an alert about a problem that can no longer exist, and one they
   * cannot act on.
   *
   * Unlike the assignment escalation (one job per order, keyed by order id),
   * these are keyed by stop id, so the open stops have to be found first.
   * Cancelling a job that is not there is a no-op, so this is safe to call
   * unconditionally rather than guarding on prior status.
   *
   * Called after the transaction commits, matching feature 010's placement:
   * a cancel issued inside it would take effect even if the transaction then
   * rolled back, disarming a timer for a delivery that is still running.
   */
  private async cancelPendingStopEscalations(order: OrderDocument): Promise<void> {
    const open = (order.stopEvents ?? []).filter((stop) => !stop.resolvedAt);
    await Promise.all(
      open.map((stop) =>
        this.stopEscalationQueue.cancel(String((stop as never as { _id: unknown })._id)),
      ),
    );
  }

  async completeDelivery(order: OrderDocument, actor: TransitionActor): Promise<OrderDocument> {
    const session = await this.connection.startSession();
    try {
      let updated!: OrderDocument;
      await session.withTransaction(async () => {
        await this.releaseDriverIfAssigned(order, session);
        updated = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          OrderStatus.UNLOADING,
          OrderStatus.DELIVERED,
          actor,
          { session },
        );
      });
      await this.cancelPendingStopEscalations(order);
      return updated;
    } finally {
      await session.endSession();
    }
  }

  async forceComplete(
    order: OrderDocument,
    from: OrderStatus,
    actor: TransitionActor,
    reason: string,
  ): Promise<OrderDocument> {
    const session = await this.connection.startSession();
    try {
      let updated!: OrderDocument;
      await session.withTransaction(async () => {
        await this.releaseDriverIfAssigned(order, session);
        updated = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          from,
          OrderStatus.DELIVERED,
          actor,
          { session, manualOverride: true, overrideReason: reason },
        );
        await this.otpService.invalidateActive(String(order._id), session);
      });
      if (from === OrderStatus.ASSIGNED_TO_DRIVER || from === OrderStatus.PENDING_PAYMENT) {
        await this.paymentTimeoutQueue.cancel(String(order._id));
      }
      await this.cancelPendingStopEscalations(order);
      this.logger.warn(
        `Manual override (force-complete): order=${order._id} from=${from} actor=${actor.actorId} reason="${reason}"`,
      );
      return updated;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Feature 009 FR-067 / contracts/rest-api-delta.md Part 1: the whole overview home in
   * one request — cursor pagination cannot yield a total, so this is `countDocuments`
   * against the four stage groups plus one figure each for on-duty drivers and
   * outstanding settlements. Every count here goes through `countDocuments`, which the
   * multi-party (Order) and single-tenant (User) plugins both hook — `{ fuelCompanyId,
   * transportCompanyId }` or `{ companyId }` is injected structurally per the acting
   * role, with no branch in this method for which role is calling (Constitution II).
   */
  async getSummary(from: Date, to: Date): Promise<OrderSummaryDto> {
    const [
      awaitingAssignment,
      inProgress,
      completedInPeriod,
      driversOnDuty,
      outstandingSettlements,
    ] = await Promise.all([
      this.orderModel.countDocuments({ status: OrderStatus.ROUTED_TO_TRANSPORT }).exec(),
      this.orderModel
        .countDocuments({
          status: {
            $in: [
              OrderStatus.ASSIGNED_TO_DRIVER,
              OrderStatus.LOADING,
              OrderStatus.IN_TRANSIT,
              OrderStatus.UNLOADING,
            ],
          },
        })
        .exec(),
      this.orderModel
        .countDocuments({
          status: OrderStatus.DELIVERED,
          deliveredAt: { $gte: from, $lte: to },
        })
        .exec(),
      this.userModel.countDocuments({ role: UserRole.DRIVER, isOnline: true }).exec(),
      this.invoicesService.getOutstandingSettlementsSummary(),
    ]);

    return {
      awaitingAssignment,
      inProgress,
      completedInPeriod,
      driversOnDuty,
      outstandingSettlements,
    };
  }

  /**
   * spec 013 (fuel company admin dashboard) T111/T113/FR-044/FR-046 — the
   * FUEL_COMPANY_ADMIN counterpart to `getSummary` above, genuinely different fields
   * rather than a role branch inside one method (see `FuelCompanySummaryDto`'s own
   * comment). `pendingApproval`/`inProgress`/`completedInPeriod` go through
   * `orderModel.countDocuments`, scoped by the multi-party plugin exactly like
   * `getSummary`'s equivalents; `stationOwnersCount` through `userModel.countDocuments`,
   * scoped by the single-tenant plugin exactly like `getSummary`'s `driversOnDuty` (just
   * `CLIENT` instead of `DRIVER`, and meaningful for this role since clients DO belong to
   * a fuel company); `stationsCount` and `creditOutstanding` delegate to their owning
   * services rather than reaching into their models directly.
   */
  async getFuelCompanySummary(from: Date, to: Date): Promise<FuelCompanySummaryDto> {
    const [
      pendingApproval,
      inProgress,
      completedInPeriod,
      stationOwnersCount,
      stationsCount,
      creditOutstanding,
    ] = await Promise.all([
      this.orderModel.countDocuments({ status: OrderStatus.PENDING_APPROVAL }).exec(),
      this.orderModel
        .countDocuments({
          status: {
            $in: [
              OrderStatus.ASSIGNED_TO_DRIVER,
              OrderStatus.LOADING,
              OrderStatus.IN_TRANSIT,
              OrderStatus.UNLOADING,
            ],
          },
        })
        .exec(),
      this.orderModel
        .countDocuments({
          status: OrderStatus.DELIVERED,
          deliveredAt: { $gte: from, $lte: to },
        })
        .exec(),
      this.userModel.countDocuments({ role: UserRole.CLIENT }).exec(),
      this.stationsService.countForCompany(),
      this.invoicesService.getCreditOutstandingSummary(),
    ]);

    return {
      pendingApproval,
      inProgress,
      completedInPeriod,
      stationOwnersCount,
      stationsCount,
      creditOutstanding,
    };
  }

  /**
   * spec 017 (operator dashboard) T051/FR-023 — the platform-wide bucket counts
   * behind the operator's summary cards, and (via
   * `PlatformOverviewService`) behind the home screen's six-segment order
   * chart. One computation feeds both, which is what stops the two screens
   * disagreeing about what "in progress" means.
   *
   * Bounded by **`createdAt`** over **every** state — orders RAISED in the
   * period, in whatever state they have since reached. That basis is what makes
   * the six counts sum to the overview's `period.orderCount` (FR-001a): a
   * delivered-only count would BE the `COMPLETED` bucket and force the other
   * five structurally to zero, and the chart could never sum to the card above
   * it.
   *
   * Counts go through `countDocuments`, which the multi-party plugin hooks — so
   * this method needs no role branch and no unscoped mechanism. For the
   * operator the plugin bypasses and the counts are genuinely platform-wide;
   * for anyone else they would be scoped, which is why the route above it is
   * `SUPER_ADMIN`-only (research R1).
   */
  async getPlatformSummary(from: Date, to: Date): Promise<PlatformSummaryDto> {
    const buckets = Object.values(OrderStatusBucket);
    const counts = await Promise.all(
      buckets.map((bucket) =>
        this.orderModel
          .countDocuments({
            // `$in`, never `$or` — see findForUser's note (research R4).
            status: { $in: [...ORDER_STATUS_BUCKETS[bucket]] },
            createdAt: { $gte: from, $lte: to },
          })
          .exec(),
      ),
    );

    const byBucket = Object.fromEntries(
      buckets.map((bucket, index) => [bucket, counts[index]]),
    ) as Record<OrderStatusBucket, number>;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      buckets: byBucket,
      // Summed from the same six figures rather than counted separately: a
      // second `countDocuments({ createdAt })` could disagree with the sum of
      // the buckets if the mapping ever stopped being total, and the operator
      // would see a chart that does not add up to its own card with nothing
      // saying which half is wrong. The exhaustiveness test is what guarantees
      // this equals the platform's order count (FR-023d).
      total: counts.reduce((sum, count) => sum + count, 0),
    };
  }
}
