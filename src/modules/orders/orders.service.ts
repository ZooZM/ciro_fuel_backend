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
import { CompaniesService } from '../companies/companies.service';
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
import { OrderSummaryDto } from './dto/order-summary.dto';

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
    private readonly companiesService: CompaniesService,
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

  async create(clientUser: AuthenticatedUser, dto: CreateOrderDto): Promise<OrderDocument> {
    if (!clientUser.companyId) {
      throw new ForbiddenException('Client must belong to a company');
    }

    const client = await this.usersService.findById(clientUser.userId);

    // spec 005 US2: a quoteToken (always sent by the real client app —
    // T063) buys the itemised breakdown and the station snapshot it
    // implies. Its absence falls back to the pre-005 bare-estimate path
    // unchanged, which every pre-existing e2e suite outside this feature
    // (dispatch, billing, tracking, presence) still exercises directly.
    if (dto.quoteToken) {
      return this.createPriced(clientUser, client, dto);
    }

    const basePrice = await this.companiesService.getBasePrice(clientUser.companyId, dto.fuelType);
    if (basePrice === undefined) {
      throw new BadRequestException(
        `No base price configured for fuel type ${dto.fuelType} — contact your company admin`,
      );
    }

    const deliveryLocation = dto.deliveryLocation
      ? {
          type: 'Point',
          coordinates: [dto.deliveryLocation.longitude, dto.deliveryLocation.latitude],
        }
      : client.station?.location;
    if (!deliveryLocation) {
      throw new BadRequestException(
        'No delivery location provided and client has no station location on file',
      );
    }

    const estimatedPrice = Number((basePrice * dto.quantityLiters).toFixed(2));

    return this.orderModel.create({
      fuelCompanyId: new Types.ObjectId(clientUser.companyId),
      clientId: new Types.ObjectId(clientUser.userId),
      fuelType: dto.fuelType,
      quantityLiters: dto.quantityLiters,
      deliveryLocation,
      // Snapshotted once at creation (FR-009/FR-030/FR-012) — never
      // re-derived even if the client later edits their station address.
      deliveryAddressText: client.station?.addressText ?? '',
      status: OrderStatus.PENDING_APPROVAL,
      estimatedPrice,
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
  ): Promise<OrderDocument> {
    if (!dto.stationId) {
      throw new BadRequestException('stationId is required when quoteToken is supplied');
    }
    const station = await this.stationsService.findOwnedByClient(dto.stationId, clientUser.userId);
    const priceBreakdown = await this.pricingService.redeem(
      dto.quoteToken!,
      clientUser.companyId!,
      dto.fuelType,
      dto.quantityLiters,
    );

    const deliveryLocation = dto.deliveryLocation
      ? {
          type: 'Point',
          coordinates: [dto.deliveryLocation.longitude, dto.deliveryLocation.latitude],
        }
      : station.location;

    return this.orderModel.create({
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
   */
  findForUser(
    user: AuthenticatedUser,
    filter: { status?: OrderStatus; cursor?: string },
  ): Promise<PaginatedResponse<OrderDocument>> {
    const query: Record<string, unknown> = {};
    if (filter.status) {
      query.status = filter.status;
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

        await this.invoicesService.issueInvoice(approved, session);

        if (approved.paymentMethod === PaymentMethod.DIRECT) {
          approved = await this.enterPendingPayment(approved, actor, session);
        }
      });
    } finally {
      await session.endSession();
    }

    if (approved.status === OrderStatus.PENDING_PAYMENT) {
      // Scheduled after commit, same pattern as dispatch/redispatch — a job
      // referencing a rolled-back transaction would be worse than one
      // scheduled a moment late.
      await this.paymentTimeoutQueue.schedule(
        String(approved._id),
        this.getPaymentDeadlineMinutes(),
      );
    }

    return this.findById(String(approved._id));
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
}
