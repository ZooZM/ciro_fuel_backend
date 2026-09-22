import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { OrderStateService } from './services/order-state.service';
import { OtpService } from './services/otp.service';
import { EtaService } from './eta.service';
import { RouteService } from './route.service';
import { RoutingService } from '../dispatch/services/routing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ApproveOrderDto } from './dto/approve-order.dto';
import { RejectOrderDto } from './dto/reject-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { RouteOrderDto } from './dto/route-order.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ForceCompleteOrderDto } from './dto/force-complete-order.dto';
import { SubmitRatingDto } from './dto/submit-rating.dto';
import { VerifyVehicleDto } from './dto/verify-vehicle.dto';
import { OverrideVerificationDto } from './dto/override-verification.dto';
import { ReassignVehicleDto } from './dto/reassign-vehicle.dto';
import { VehicleVerificationService } from './services/vehicle-verification.service';
import { RatingsService } from '../ratings/ratings.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { VerificationStage } from '../../common/enums/verification-stage.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { parseEnumQuery } from '../../common/validation/parse-enum-query';
import {
  ORDER_STATUS_BUCKETS,
  OrderStatusBucket,
} from '../../common/constants/order-status-buckets';
import {
  FORCE_COMPLETABLE_STATUSES,
  isForceCompletable,
} from '../../common/constants/force-completable-statuses';
import { OrderDocument, OtpPurpose } from './schemas/order.schema';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { StationsService } from '../stations/stations.service';
import { PricingService } from './services/pricing.service';
import { QuoteOrderDto } from './dto/quote-order.dto';
import { StopDetectionService } from '../stop-detection/stop-detection.service';
import { DeclareStopDto } from './dto/declare-stop.dto';
import { SubmitStopReasonDto } from './dto/submit-stop-reason.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { SupplierInvoicesService } from './services/supplier-invoices.service';
import { ConfirmSupplierInvoiceDto } from './dto/confirm-supplier-invoice.dto';
import { LitreBalancesService } from '../litre-balances/litre-balances.service';
import { ReportBlockedDto } from './dto/report-blocked.dto';

@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly orderStateService: OrderStateService,
    private readonly otpService: OtpService,
    private readonly routingService: RoutingService,
    private readonly notificationsService: NotificationsService,
    private readonly etaService: EtaService,
    private readonly routeService: RouteService,
    private readonly stationsService: StationsService,
    private readonly pricingService: PricingService,
    private readonly ratingsService: RatingsService,
    private readonly vehicleVerificationService: VehicleVerificationService,
    private readonly stopDetectionService: StopDetectionService,
    private readonly supplierInvoicesService: SupplierInvoicesService,
    private readonly litreBalancesService: LitreBalancesService,
  ) {}

  @Roles(UserRole.CLIENT)
  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    // spec 013 T195/FR-074: `litreDrawdown` is additive on the response — every existing
    // reader of this endpoint (both mobile clients) keeps working against the fields it
    // already reads; this is a new field, not a reshaped one.
    const { order, litreDrawdown } = await this.ordersService.create(user, dto);
    return { ...order.toObject(), litreDrawdown };
  }

  /**
   * spec 005 US2/T054. A CLIENT's own `companyId` is their fuel company
   * (spec 004's tenancy model), so no separate lookup is needed to know
   * whose pricing to quote from. `stationId` must be the caller's own —
   * `findOwnedByClient` 404s otherwise, never revealing whether some other
   * client's station exists.
   */
  @Roles(UserRole.CLIENT)
  @Post('quote')
  async quote(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuoteOrderDto) {
    const station = await this.stationsService.findOwnedByClient(dto.stationId, user.userId);
    // The station the client is quoting FOR decides the delivery price now — the
    // transporter's rate is per area, and the haul distance is measured to this point.
    const quote = await this.pricingService.quote(
      user.companyId!,
      dto.fuelType,
      dto.quantityLiters,
      {
        regionCode: station.regionCode,
        governorateCode: station.governorateCode,
        coordinates: station.location.coordinates as [number, number],
      },
    );
    // spec 013 T196/R9: a PROJECTION only — this call never writes, so an abandoned quote
    // (the overwhelming majority of quotes, by construction — see `PricingService`'s own
    // discipline of never committing anything at quote time) leaks no litres.
    const litreDrawdown = await this.litreBalancesService.projectDrawdown(
      user.companyId!,
      user.userId,
      dto.fuelType,
      dto.quantityLiters,
    );
    return { ...quote, litreDrawdown };
  }

  /**
   * Feature 009 FR-059-061/FR-067, extended by spec 013 T109/T111/FR-044/FR-046 and
   * again by spec 017 T052/FR-023: the dashboard overview for whichever role calls it.
   * **Three roles, three shapes.** TRANSPORT_COMPANY_ADMIN keeps the original
   * `OrderSummaryDto`. FUEL_COMPANY_ADMIN gets `FuelCompanySummaryDto` instead —
   * a real, different shape, not the same fields with the meaningless ones zeroed out
   * (T111's finding: `driversOnDuty` would always be 0 for this role, since drivers
   * belong to transport companies, and `awaitingAssignment` names a decision point that
   * isn't this role's to make). SUPER_ADMIN gets `PlatformSummaryDto`, the six order
   * buckets — until spec 017 the operator fell through to the TRANSPORT shape and
   * received a transporter's questions answered platform-wide (research R5).
   * `from`/`to` default to the current month when omitted; both are read as whole-day
   * boundaries.
   */
  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN, UserRole.SUPER_ADMIN, UserRole.FUEL_COMPANY_ADMIN)
  @Get('summary')
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const now = new Date();
    const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = to ? new Date(to) : now;
    if (user.role === UserRole.FUEL_COMPANY_ADMIN) {
      return this.ordersService.getFuelCompanySummary(start, end);
    }
    // spec 017 T052/FR-023 (research R5): the operator gets a THIRD shape. Until
    // now this handler branched two ways over three roles, so a SUPER_ADMIN fell
    // through to the transport company's summary — `awaitingAssignment` and
    // `driversOnDuty` computed platform-wide, real numbers answering a
    // transporter's questions rather than the operator's. The
    // TRANSPORT_COMPANY_ADMIN branch below is deliberately untouched: FR-075
    // makes its response byte-for-byte unchanged.
    if (user.role === UserRole.SUPER_ADMIN) {
      return this.ordersService.getPlatformSummary(start, end);
    }
    return this.ordersService.getSummary(start, end);
  }

  @Get()
  async findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: OrderStatus,
    // spec 017 T050/FR-016/FR-016a — the operator's bucket filter and
    // identifier search. Both are role-agnostic: the scoping plugins still
    // apply, so a fuel company filtering by bucket gets its own orders in that
    // bucket and nobody else's (asserted by T047, which is an e2e test
    // precisely because a unit test correctly registers no plugin at all).
    @Query('bucket') bucket?: string,
    @Query('orderId') orderId?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedBucket = parseEnumQuery(OrderStatusBucket, bucket, 'bucket');
    // A contradictory pair must REFUSE, never return a silently empty page: an
    // empty page reads as "there are no such orders" when the truth is "that
    // combination cannot exist".
    if (parsedBucket && status && !ORDER_STATUS_BUCKETS[parsedBucket].includes(status)) {
      throw new BadRequestException({
        error: ErrorCode.ORDER_BUCKET_STATUS_CONFLICT,
        message: `status ${status} is not part of bucket ${parsedBucket}`,
      });
    }
    const page = await this.ordersService.findForUser(user, {
      status,
      bucket: parsedBucket,
      orderId,
      cursor,
    });
    // One query for the whole page's stations, so a list row can name the
    // destination. Without it a client whose order was placed before their
    // station had an address on file sees raw coordinates in the list —
    // `deliveryAddressText` is snapshotted at creation and stays empty.
    const stations = await this.stationsService.findManyIncludingInactive(
      page.items.map((order) => (order.stationId ? String(order.stationId) : undefined)),
    );
    const items = await Promise.all(
      page.items.map(async (order) => ({
        // Same role-scoped shape the detail endpoint returns (FR-042) — a
        // list that spread the raw document would hand a customer the
        // verification trail through a second door.
        ...this.toRoleScopedShape(order, user),
        etaMinutes: await this.etaService.computeEtaMinutes(order),
        station: order.stationId ? (stations.get(String(order.stationId)) ?? null) : null,
      })),
    );
    return { items, nextCursor: page.nextCursor };
  }

  /**
   * spec 008 FR-039/FR-041/FR-042: the verification history and the tank's
   * identity are operator/driver-facing only — a customer never sees
   * either, so they are stripped before the spread rather than filtered in.
   *
   * Shared by `findOne` AND `findMine` deliberately. Applying it in only
   * one of them is not a smaller leak, it is the same leak: a customer's
   * order list returns the very same documents, so a rule that lives at one
   * endpoint is a rule the next endpoint silently does not have. Any future
   * order-returning route for a customer belongs here too.
   */
  /**
   * spec 013 T193/FR-073b/FR-073f — the raw `supplierInvoices` array (every superseded
   * entry, `fileId`s, `extracted` values) is retrievable "by the fuel company that
   * uploaded it and by the platform operator, and by no one else" — narrower than
   * `verifications`/`tankSummary` below, which DRIVER and TRANSPORT_COMPANY_ADMIN both
   * see. Absent (key omitted entirely), not null, when nothing has been confirmed yet
   * (SC-014c) — a null-filled shape would look like a supplier invoice that was recorded
   * and simply had no values, which is a different fact.
   */
  private buildSupplierInvoiceView(
    order: OrderDocument,
    user: AuthenticatedUser,
  ): Record<string, unknown> | undefined {
    if (user.role !== UserRole.FUEL_COMPANY_ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      return undefined;
    }
    const current = order.supplierInvoices.find((si) => !si.supersededAt && si.confirmed);
    if (!current?.confirmed) {
      return undefined;
    }
    const orderedQuantityLitres = order.quantityLiters;
    const suppliedQuantityLitres = current.confirmed.quantityLitres;
    return {
      fileId: current.fileId,
      extracted: current.extracted ?? null,
      confirmed: current.confirmed,
      confirmedBy: current.confirmedBy ?? null,
      confirmedAt: current.confirmedAt ?? null,
      orderedQuantityLitres,
      suppliedQuantityLitres,
      proportionFulfilled:
        orderedQuantityLitres > 0 ? suppliedQuantityLitres / orderedQuantityLitres : 0,
      shortfallLitres: orderedQuantityLitres - suppliedQuantityLitres,
    };
  }

  private toRoleScopedShape(
    order: OrderDocument,
    user: AuthenticatedUser,
  ): Record<string, unknown> {
    const isOperatorOrDriver =
      user.role === UserRole.DRIVER ||
      user.role === UserRole.FUEL_COMPANY_ADMIN ||
      user.role === UserRole.TRANSPORT_COMPANY_ADMIN ||
      user.role === UserRole.SUPER_ADMIN;
    const base = order.toObject() as Record<string, unknown>;
    if (!isOperatorOrDriver) {
      delete base.verifications;
      delete base.tankSummary;
      // spec 010: acknowledgment/escalation state and the ineligible-
      // assignment reason are operator/driver-facing only — the same class
      // of internal-dispatch detail `verifications`/`tankSummary` already
      // strip here, never shown to the CLIENT who placed the order.
      delete base.assignmentAcknowledgedAt;
      delete base.assignmentEscalationSmsAt;
      delete base.assignmentEscalationSkippedReason;
      delete base.assignedWhileIneligible;
      delete base.assignedWhileIneligibleReason;
      // spec 011: a customer has no business reading why their driver
      // stopped, or where they were when they did. This is a privacy
      // boundary, not merely scoping — the feature is deliberately framed
      // as safety and delivery visibility for the transporter who employs
      // the driver, and widening the audience would change what it is.
      delete base.stopEvents;
      // spec 017 FR-020: force-complete is now a SUPER_ADMIN capability too,
      // and its `reason` is free text an operator writes for the platform's own
      // record — "customer unreachable, closing out", an internal ticket
      // reference. `statusHistory` is client-readable, so without this the
      // operator's internal note and the staff member's user id are published
      // to the customer whose order it is.
      //
      // The TRANSITIONS stay, and so does the `manualOverride` flag: that an
      // order was completed by an administrator rather than by the usual
      // handover is the customer's business. Who wrote what about them is not.
      if (Array.isArray(base.statusHistory)) {
        base.statusHistory = (base.statusHistory as Record<string, unknown>[]).map((entry) => {
          const {
            overrideReason: _reason,
            actorId: _actorId,
            actorRole: _actorRole,
            ...rest
          } = entry;
          return rest;
        });
      }
    }
    // spec 013 T193/FR-073f: the raw array is never exposed to anyone, under any role —
    // narrower than every field above it. The shaped `supplierInvoice` field replaces it.
    delete base.supplierInvoices;
    const supplierInvoice = this.buildSupplierInvoiceView(order, user);
    if (supplierInvoice) {
      base.supplierInvoice = supplierInvoice;
    }
    return base;
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const order = await this.ordersService.findOneForUser(user, id);
    const station = await this.stationsService.findByIdIncludingInactive(
      order.stationId ? String(order.stationId) : undefined,
    );
    // `driverLocation` lets the tracking map draw the truck the moment the
    // screen opens, instead of staying blank until the driver's next
    // throttled `location:update` arrives over the socket (spec 005).
    const { etaMinutes, driverLocation, driverLocationAt } =
      await this.etaService.driverTelemetry(order);
    // spec 007 FR-037d/FR-041: both personas read the rating off the
    // delivery it belongs to — absent until one exists, never a placeholder.
    const rating = await this.ratingsService.findByOrderId(String(order._id));

    const base = this.toRoleScopedShape(order, user);

    return {
      ...base,
      etaMinutes,
      driverLocation,
      // spec 011 FR-017a: how old that fix is. The dashboard cannot present a
      // position as stale without knowing its age, and a frozen dot with no
      // age reads exactly like a live one.
      driverLocationAt,
      station,
      // FR-047d/FR-038: an overridden stage writes no VehicleVerification
      // record at all (research R10) — so this reads as "not verified"
      // automatically, with no separate override flag needed to stay honest.
      vehicleVerified: order.verifications.some(
        (v) => v.stage === VerificationStage.DEPARTURE && v.matched,
      ),
      ...(rating ? { rating: { score: rating.score, review: rating.review ?? null } } : {}),
    };
  }

  /**
   * The road-following route from the assigned driver to the delivery
   * destination, for the client's tracking map.
   *
   * A separate call rather than a field on `GET /orders/:id`: it is an
   * outbound, billed request to Google, and the order read happens far more
   * often than the route meaningfully changes. The client refetches only
   * when the truck has moved enough to matter.
   *
   * `{ route: null }` — never an error — whenever no driver is assigned,
   * the driver has no position yet, or Directions is unavailable. The map
   * falls back to a direct line, which is honest about being an
   * approximation rather than a driven path.
   *
   * Named `driving-route` rather than `route`: `PATCH :id/route` already
   * means "assign this order to a transporter", and one path meaning two
   * unrelated things is how the wrong one gets called.
   */
  @Roles(UserRole.CLIENT)
  @Get(':id/driving-route')
  async drivingRoute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const order = await this.ordersService.findOneForUser(user, id);
    const { driverLocation } = await this.etaService.driverTelemetry(order);
    if (!driverLocation) {
      return { route: null };
    }
    const route = await this.routeService.drivingRoute(driverLocation, order.deliveryLocation);
    return { route: route ?? null };
  }

  /**
   * Sets the final price (PENDING_APPROVAL -> APPROVED) and issues the
   * order's invoice (spec 004 FR-020, `OrdersService.approve`). A DIRECT
   * order stops at PENDING_PAYMENT — FR-020a forbids routing it before
   * settlement, so routing resumes later from the payment webhook. A
   * DEFERRED/CREDIT order routes immediately, exactly as approval always
   * did before billing existed (FR-014/015/016): exactly one serving
   * transporter routes automatically; none or several-without-a-choice
   * leaves the order AWAITING_ROUTING with `routingCandidates` in the
   * response for a follow-up `PATCH :id/route` call; several with
   * `dto.transportCompanyId` routes immediately to that choice.
   */
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/approve')
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ApproveOrderDto,
  ) {
    const order = await this.ordersService.findById(id);
    const actor = { actorId: user.userId, actorRole: user.role };

    const approved = await this.ordersService.approve(order, actor, dto);

    // The client is NOT told a final price here any more — at approval there
    // isn't one. The transport company that prices the haul is chosen in the
    // routing step below, and `RoutingService` notifies the station owner once
    // it has produced a total they can actually act on.
    //
    // Routing now runs for every payment method, DIRECT included: it is what
    // makes the order priceable, so it can no longer wait behind a payment.
    const { order: routed, candidates } = await this.routingService.routeOrder(
      approved,
      actor,
      OrderStatus.APPROVED,
      dto.transportCompanyId,
    );
    return {
      ...routed.toObject(),
      ...(candidates.length > 1
        ? { routingCandidates: candidates.map((c) => ({ id: c._id, name: c.name })) }
        : {}),
    };
  }

  /**
   * Resolves an AWAITING_ROUTING order manually (spec 004 FR-014's "the
   * Fuel Company must choose" — also the only way forward after FR-016's
   * "no transporter serves the region" once one is later assigned coverage).
   */
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/route')
  async route(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: RouteOrderDto,
  ) {
    const order = await this.ordersService.findById(id);
    // APPROVED is admitted alongside AWAITING_ROUTING, and it has to be.
    //
    // Routing now issues the invoice — it is the first moment the total
    // includes the haul — and issuance can REFUSE, on a credit limit or a
    // commission ceiling. That refusal rolls its own transaction back, which
    // correctly undoes the routing but leaves the order at APPROVED, where
    // approval had already committed it.
    //
    // Without this, such an order is stranded: `:id/approve` will not make the
    // PENDING_APPROVAL -> APPROVED transition twice, and `:id/route` used to
    // demand a status it no longer has. Raising the customer's limit would fix
    // the cause and there would still be no way to move the order. An
    // APPROVED-but-unrouted order is exactly what this endpoint is for.
    if (order.status !== OrderStatus.AWAITING_ROUTING && order.status !== OrderStatus.APPROVED) {
      throw new ConflictException(
        'Order must be AWAITING_ROUTING or APPROVED to route it manually',
      );
    }
    const { order: routed } = await this.routingService.routeOrder(
      order,
      { actorId: user.userId, actorRole: user.role },
      order.status,
      dto.transportCompanyId,
    );
    // Routing FAILED to resolve a transporter if and only if the order is still
    // parked awaiting one. Asserting the positive (`=== ROUTED_TO_TRANSPORT`)
    // was equivalent before and is not now: a successfully routed order carries
    // straight on to PENDING_PAYMENT, because routing is what prices the haul
    // and the station owner settles that total before a driver is assigned. Read
    // the positive way, this guard reported every SUCCESSFUL manual routing as
    // "that transporter does not serve this region" — a 400 whose message was
    // the opposite of what had happened.
    if (routed.status === OrderStatus.AWAITING_ROUTING) {
      throw new BadRequestException(
        'transportCompanyId is not one of the transporters serving this region',
      );
    }
    return routed;
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Patch(':id/reject')
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: RejectOrderDto,
  ) {
    return this.orderStateService.transition(
      id,
      OrderStatus.PENDING_APPROVAL,
      OrderStatus.REJECTED,
      { actorId: user.userId, actorRole: user.role },
      { extraSet: { rejectedBy: user.userId, rejectionReason: dto.reason } },
    );
  }

  /**
   * The station owner accepts the total routing produced — the second half of
   * the amended flow, for the orders that have no gateway payment to make.
   *
   * A DIRECT order is confirmed by PAYING it (the gateway webhook does the same
   * transition), so this refuses one rather than offering a second, cheaper way
   * past the same gate. DEFERRED and CREDIT orders are settled against an
   * invoice, so their confirmation is this explicit acceptance.
   *
   * Refusing the total needs nothing new: `PATCH :id/cancel` below already
   * admits the CLIENT at PENDING_PAYMENT and already releases every booking.
   */
  @Roles(UserRole.CLIENT)
  @Post(':id/accept')
  async acceptFinalPrice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const order = await this.ordersService.findOneForUser(user, id);
    if (String(order.clientId) !== user.userId) {
      // Not-mine is indistinguishable from absent, as everywhere else here.
      throw new NotFoundException('Order not found');
    }
    const accepted = await this.ordersService.acceptFinalPrice(order, {
      actorId: user.userId,
      actorRole: user.role,
    });
    return this.toRoleScopedShape(accepted, user);
  }

  @Patch(':id/cancel')
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    const order = await this.ordersService.findOneForUser(user, id);
    const isClient = user.role === UserRole.CLIENT && String(order.clientId) === user.userId;
    const isAdmin = user.role === UserRole.FUEL_COMPANY_ADMIN;

    if (!isClient && !isAdmin) {
      throw new ForbiddenException('Not permitted to cancel this order');
    }

    // AWAITING_ROUTING/ROUTED_TO_TRANSPORT are pre-driver-assignment states,
    // same cancellation rights as bare APPROVED (spec 004 FR-014/FR-016).
    const CLIENT_CANCELLABLE = [
      OrderStatus.PENDING_APPROVAL,
      OrderStatus.APPROVED,
      OrderStatus.AWAITING_ROUTING,
      OrderStatus.ROUTED_TO_TRANSPORT,
      OrderStatus.PENDING_PAYMENT,
    ];
    // spec 008 FR-046d: LOADING joins ASSIGNED_TO_DRIVER as admin-only —
    // the truck hasn't left the depot yet, but a client is never the one
    // to call that off once a driver is already in motion toward it.
    const ADMIN_CANCELLABLE = [
      ...CLIENT_CANCELLABLE,
      OrderStatus.ASSIGNED_TO_DRIVER,
      OrderStatus.LOADING,
    ];

    let from: OrderStatus;
    if (isClient) {
      // Clients may cancel pre-assignment, or decline the final price while
      // awaiting payment (FR-009); anything else is admin-only.
      if (!CLIENT_CANCELLABLE.includes(order.status)) {
        throw new ForbiddenException('Clients may not cancel an order at this stage');
      }
      from = order.status;
    } else {
      if (!ADMIN_CANCELLABLE.includes(order.status)) {
        throw new ForbiddenException('This order can no longer be cancelled');
      }
      from = order.status;
    }

    return this.ordersService.cancel(
      order,
      from,
      { actorId: user.userId, actorRole: user.role },
      dto.reason,
    );
  }

  /**
   * Post-payment-timeout retry (FR-015a). A timeout reverts a DIRECT order
   * to bare APPROVED (payment-timeout.processor.ts) — this status is
   * reached only that way, since DEFERRED/CREDIT orders never expire
   * (FR-020b). This re-opens a fresh payment window
   * (`OrdersService.reopenPaymentWindow`); routing itself only resumes once
   * that window is paid, exactly like the original approval.
   */
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.CLIENT)
  @Post(':id/redispatch')
  async redispatch(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const order = await this.ordersService.findOneForUser(user, id);
    if (order.status !== OrderStatus.APPROVED) {
      throw new ConflictException('Order must be APPROVED (post payment-timeout) to redispatch');
    }
    if (user.role === UserRole.CLIENT && (order.paymentTimeoutCount ?? 0) >= 2) {
      throw new ForbiddenException(
        'Two consecutive payment timeouts occurred — only the Company Admin may redispatch now',
      );
    }
    return this.ordersService.reopenPaymentWindow(order, {
      actorId: user.userId,
      actorRole: user.role,
    });
  }

  /**
   * spec 008 US3 (FR-017/FR-020/FR-023): a delivery cannot begin, and
   * cannot progress past loading, without this. Stage is derived
   * server-side from the order's own status (research R7) — never accepted
   * from the client — so the same endpoint serves both the departure
   * verification and the loading-stage re-verification (FR-030). The two
   * are not the same check: the loading attempt is additionally geofenced
   * against the assigned warehouse (FR-030a), which is why `driverLocation`
   * is on the DTO and why this route can answer NOT_AT_WAREHOUSE.
   */
  /**
   * **Deliberately NOT throttled.** This route was `@Throttle({ limit: 5, ttl:
   * 15 min })`, which counted every outcome — including `LOCATION_REQUIRED`
   * (where nothing about the vehicle is evaluated at all) and
   * `NOT_AT_WAREHOUSE`, where the driver presented the CORRECT card and only
   * the geofence refused. A driver approaching a depot while their GPS settles,
   * or standing at the gate rather than inside the fence, could burn the budget
   * in a minute and then be locked out of starting work for fifteen — holding
   * the right card, at the right depot, with nothing they could do about it.
   *
   * The limit existed to stop credential guessing, and it is a poor fit for
   * that here: the caller is already an authenticated DRIVER who is already
   * assigned to THIS order, the QR token is 32 random characters, and a wrong
   * card is refused outright and recorded as a `VehicleVerification` either
   * way. Refusals remain auditable; they are simply no longer rationed.
   */
  @Roles(UserRole.DRIVER)
  @Post(':id/verify-vehicle')
  async verifyVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: VerifyVehicleDto,
  ) {
    const result = await this.vehicleVerificationService.verify(
      id,
      { actorId: user.userId, actorRole: user.role },
      dto.credential,
      dto.method,
      dto.driverLocation,
    );
    // FR-026: a successful DEPARTURE verification's next destination is the
    // warehouse, not the customer — returned here so the driver's app can
    // route there immediately without a second read.
    return {
      status: result.stage,
      order: result.order,
      ...(result.stage === VerificationStage.DEPARTURE
        ? { warehouseSummary: result.order.warehouseSummary ?? null }
        : { distanceMeters: result.distanceMeters }),
    };
  }

  /**
   * spec 008 US4 (FR-028/FR-031/FR-032): a plain state transition, no
   * quantity anywhere on this DTO or this method — the authoritative volume
   * arrives later via the Aramco invoice, a separate feature entirely.
   */
  @Roles(UserRole.DRIVER)
  @Post(':id/confirm-loading')
  async confirmLoading(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.LOADING);
    const loadingVerified = order.verifications.some(
      (v) => v.stage === VerificationStage.LOADING && v.matched,
    );
    if (!loadingVerified) {
      throw new ConflictException({
        error: ErrorCode.VEHICLE_NOT_VERIFIED,
        message: 'Loading must be verified before it can be confirmed',
      });
    }
    const at = new Date();
    return this.orderStateService.transition(
      id,
      OrderStatus.LOADING,
      OrderStatus.IN_TRANSIT,
      { actorId: user.userId, actorRole: user.role },
      { extraSet: { loadingConfirmedAt: at } },
    );
  }

  /**
   * spec 008 US3 (FR-047): the operator's explicit, reasoned attestation —
   * reuses `OrderStateService.transition`'s existing `manualOverride`/
   * `overrideReason` machinery (research R10), which already writes the
   * reason, actor and timestamp into `statusHistory`. Deliberately writes
   * **no** `VehicleVerification` record — that omission is what makes
   * "overridden" structurally distinct from "verified" (FR-047c/FR-047d),
   * not a naming convention. Advances exactly the one outstanding stage;
   * FR-047g — a stage that has not been reached yet is refused, same as a
   * genuine verification attempt would be (FR-025).
   */
  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
  @Post(':id/override-verification')
  async overrideVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: OverrideVerificationDto,
  ) {
    // Scoped by the multi-party plugin to the acting admin's own
    // transportCompanyId (FR-047e) — another company's order is a 404 here,
    // same as every other cross-tenant id in this controller.
    const order = await this.ordersService.findById(id);
    const actor = { actorId: user.userId, actorRole: user.role };

    if (order.status === OrderStatus.ASSIGNED_TO_DRIVER) {
      return this.orderStateService.transition(
        id,
        OrderStatus.ASSIGNED_TO_DRIVER,
        OrderStatus.LOADING,
        actor,
        { manualOverride: true, overrideReason: dto.reason },
      );
    }
    if (order.status === OrderStatus.LOADING) {
      return this.orderStateService.transition(
        id,
        OrderStatus.LOADING,
        OrderStatus.IN_TRANSIT,
        actor,
        {
          manualOverride: true,
          overrideReason: dto.reason,
          extraSet: { loadingConfirmedAt: new Date() },
        },
      );
    }
    throw new ConflictException('No verification stage is currently outstanding on this order');
  }

  /** spec 008 FR-015: pre-departure correction — scoped to the acting transporter's own orders. */
  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
  @Patch(':id/reassign-vehicle')
  async reassignVehicle(@Param('id', ObjectIdPipe) id: string, @Body() dto: ReassignVehicleDto) {
    const order = await this.ordersService.findById(id);
    return this.ordersService.reassignVehicle(order, dto.truckId, dto.tankId);
  }

  @Roles(UserRole.DRIVER)
  @Post(':id/arrive')
  async arrive(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.IN_TRANSIT);
    await this.otpService.issue(String(order._id), OtpPurpose.ARRIVAL);
    await this.notificationsService.notify({
      companyId: order.fuelCompanyId,
      recipientUserId: order.clientId,
      type: NotificationType.OTP_ISSUED,
      orderId: order._id as never,
      payload: { purpose: OtpPurpose.ARRIVAL },
    });
    return { status: 'ARRIVAL_OTP_ISSUED' };
  }

  /**
   * spec 010 FR-010/FR-014a: the explicit driver-side acknowledgment signal
   * — deliberately not `assertDriverAssigned` (which pins one specific
   * status): the driver's active-delivery screen can load this order at
   * ASSIGNED_TO_DRIVER, LOADING, or later, and acknowledgment applies at
   * any of them. Idempotent (contracts/rest-api-delta.md §3) — a second
   * call is a no-op, not an error.
   */
  @Roles(UserRole.DRIVER)
  @Post(':id/acknowledge-assignment')
  async acknowledgeAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const order = await this.ordersService.findById(id);
    if (String(order.driverId) !== user.userId) {
      // FR-069 discipline: cross-tenant/not-owned is indistinguishable from absent.
      throw new NotFoundException('Order not found');
    }
    const updated = await this.ordersService.acknowledgeAssignment(order);
    return this.toRoleScopedShape(updated, user);
  }

  /**
   * spec 011 FR-008a-d (contracts/rest-api-delta.md §1): the driver announces
   * a stop before the platform has to ask. Ownership, the IN_TRANSIT
   * requirement and the one-open-stop invariant are all enforced inside the
   * service's conditional write rather than by a guard here, so a declaration
   * racing the detection sweep cannot leave the delivery with two open stops.
   */
  @Roles(UserRole.DRIVER)
  @Post(':id/stops/declare')
  async declareStop(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: DeclareStopDto,
  ) {
    const order = await this.stopDetectionService.declareStop(id, user.userId, dto);
    return this.toRoleScopedShape(order, user);
  }

  /**
   * feature 013 US5a (contracts/rest-api-delta.md §1): the driver cannot
   * reach the destination and is asking for help. Ownership, the IN_TRANSIT
   * requirement and the one-open-stop invariant are enforced inside the
   * service's conditional write — a report racing the detection sweep cannot
   * leave two open stops. Returns the role-scoped order, like the sibling
   * stop endpoints.
   */
  @Roles(UserRole.DRIVER)
  @Post(':id/stops/blocked')
  async reportBlocked(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ReportBlockedDto,
  ) {
    const order = await this.stopDetectionService.reportBlocked(id, user.userId, dto);
    return this.toRoleScopedShape(order, user);
  }

  /**
   * spec 011 FR-007/FR-010: the driver explains a detected stop.
   *
   * An answer arriving after the response window already escalated is an
   * ordinary success here, not a conflict — see `submitReason`'s own comment.
   */
  @Roles(UserRole.DRIVER)
  @Post(':id/stops/:stopId/reason')
  async submitStopReason(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Param('stopId', ObjectIdPipe) stopId: string,
    @Body() dto: SubmitStopReasonDto,
  ) {
    const order = await this.stopDetectionService.submitReason(id, user.userId, stopId, dto);
    return this.toRoleScopedShape(order, user);
  }

  /**
   * spec 011 FR-011/FR-012: the transport administrator marks a stop handled.
   *
   * `findOneForUser` first, so the multi-party scoping plugin decides whether
   * this administrator can see the order at all — a stop on another
   * transporter's delivery must 404 exactly as the order itself would.
   */
  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN)
  @Patch(':id/stops/:stopId/resolve')
  async resolveStop(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Param('stopId', ObjectIdPipe) stopId: string,
  ) {
    const order = await this.ordersService.findOneForUser(user, id);
    const resolved = await this.stopDetectionService.resolveByAdmin(
      String(order._id),
      stopId,
      user.userId,
    );
    return this.toRoleScopedShape(resolved, user);
  }

  @Roles(UserRole.CLIENT)
  @Get(':id/otp/current')
  async currentOtp(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const order = await this.ordersService.findOneForUser(user, id);
    if (String(order.clientId) !== user.userId) {
      throw new NotFoundException('Order not found');
    }
    const purpose =
      order.status === OrderStatus.UNLOADING ? OtpPurpose.DELIVERY : OtpPurpose.ARRIVAL;
    const current = await this.otpService.peekCurrent(String(order._id), purpose);
    if (!current) {
      throw new NotFoundException('No active OTP for this order');
    }
    return current;
  }

  @Roles(UserRole.DRIVER)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @Post(':id/verify-arrival')
  async verifyArrival(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: VerifyOtpDto,
  ) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.IN_TRANSIT);
    await this.otpService.verify(String(order._id), OtpPurpose.ARRIVAL, dto.otp);
    return this.orderStateService.transition(id, OrderStatus.IN_TRANSIT, OrderStatus.UNLOADING, {
      actorId: user.userId,
      actorRole: user.role,
    });
  }

  @Roles(UserRole.DRIVER)
  @Post(':id/request-delivery-otp')
  async requestDeliveryOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.UNLOADING);
    await this.otpService.issue(String(order._id), OtpPurpose.DELIVERY);
    await this.notificationsService.notify({
      companyId: order.fuelCompanyId,
      recipientUserId: order.clientId,
      type: NotificationType.OTP_ISSUED,
      orderId: order._id as never,
      payload: { purpose: OtpPurpose.DELIVERY },
    });
    return { status: 'DELIVERY_OTP_ISSUED' };
  }

  @Roles(UserRole.DRIVER)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @Post(':id/verify-delivery')
  async verifyDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: VerifyOtpDto,
  ) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.UNLOADING);
    await this.otpService.verify(String(order._id), OtpPurpose.DELIVERY, dto.otp);
    return this.ordersService.completeDelivery(order, {
      actorId: user.userId,
      actorRole: user.role,
    });
  }

  /**
   * spec 007 US6 (FR-037/FR-040): a customer rates the driver who delivered
   * to them, from the order's own detail — no new screen, no automatic
   * prompt (FR-037c). `findOneForUser` gives the 404-not-409 ownership
   * check (Principle II); `RatingsService` enforces DELIVERED-only and
   * rate-once (ALREADY_RATED/ORDER_NOT_DELIVERED) itself.
   */
  @Roles(UserRole.CLIENT)
  @Post(':id/rating')
  async submitRating(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SubmitRatingDto,
  ) {
    const order = await this.ordersService.findOneForUser(user, id);
    const rating = await this.ratingsService.submitRating(order, user.userId, dto);
    return { score: rating.score, review: rating.review ?? null };
  }

  // spec 017 T054/FR-020: SUPER_ADMIN joins FUEL_COMPANY_ADMIN. The permitted
  // stages are unchanged — this is a one-role widening, not a new capability
  // (research R7).
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id/force-complete')
  async forceComplete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ForceCompleteOrderDto,
  ) {
    const order = await this.ordersService.findById(id);
    // The check and the refusal message now read the SAME constant. They were
    // three inline comparisons and a hand-written prose list of the identical
    // three stages, which could drift apart with nothing failing
    // (Constitution I).
    if (!isForceCompletable(order.status)) {
      throw new ConflictException(
        `Force-complete only allowed from ${FORCE_COMPLETABLE_STATUSES.join(', ')}`,
      );
    }
    return this.ordersService.forceComplete(
      order,
      order.status,
      { actorId: user.userId, actorRole: user.role },
      dto.reason,
    );
  }

  private async assertDriverAssigned(
    user: AuthenticatedUser,
    id: string,
    expectedStatus: OrderStatus,
  ) {
    const order = await this.ordersService.findById(id);
    if (String(order.driverId) !== user.userId) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== expectedStatus) {
      throw new BadRequestException(`Order is not ${expectedStatus}`);
    }
    return order;
  }

  /**
   * spec 013 T185/FR-073a-i/SC-014c — stores the document and attempts extraction.
   * Records nothing and moves no balance (a genuinely separate step from `confirm`
   * below, unlike `files.controller.ts`'s single-step upload elsewhere on the
   * platform) — the administrator reviews what came back before anything is written.
   */
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/supplier-invoice/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSupplierInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    const order = await this.ordersService.findById(id);
    return this.supplierInvoicesService.upload(order, user.userId, {
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });
  }

  /** T186/FR-073a-ii/FR-073c/FR-073d — records the confirmed invoice and applies the
   * balance movement in one transaction. Refused with `SUPPLIER_INVOICE_ALREADY_RECORDED`
   * if this order already has one — `PUT` is the replace path, immediately below. */
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/supplier-invoice')
  async confirmSupplierInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ConfirmSupplierInvoiceDto,
  ) {
    const order = await this.ordersService.findById(id);
    const {
      order: updated,
      shortfallLitres,
      wentNegative,
    } = await this.supplierInvoicesService.confirm(order, dto, user.userId);
    return {
      ...this.toRoleScopedShape(updated, user),
      shortfallLitres,
      ...(wentNegative ? { balanceWarning: ErrorCode.LITRE_BALANCE_WOULD_GO_NEGATIVE } : {}),
    };
  }

  /** T192/FR-073e — supersedes the current invoice (if any) and restates the balance
   * movement, never applying a second one for the same order. */
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Put(':id/supplier-invoice')
  async replaceSupplierInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ConfirmSupplierInvoiceDto,
  ) {
    const order = await this.ordersService.findById(id);
    const {
      order: updated,
      shortfallLitres,
      wentNegative,
    } = await this.supplierInvoicesService.replace(order, dto, user.userId);
    return {
      ...this.toRoleScopedShape(updated, user),
      shortfallLitres,
      ...(wentNegative ? { balanceWarning: ErrorCode.LITRE_BALANCE_WOULD_GO_NEGATIVE } : {}),
    };
  }
}
