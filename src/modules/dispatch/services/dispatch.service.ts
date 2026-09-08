import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Connection, Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { Truck, TruckDocument } from '../../trucks/schemas/truck.schema';
import { Tank, TankDocument } from '../../tanks/schemas/tank.schema';
import { WarehousesService } from '../../warehouses/warehouses.service';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { UserRole } from '../../../common/enums/user-role.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { OrderStateService } from '../../orders/services/order-state.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { isDuplicateKeyError } from '../../../common/utils/mongo-error.util';
import { SYSTEM_ACTOR } from '../../../common/constants/system-actor';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { DriverEligibility } from '../../../common/enums/driver-eligibility.enum';
import { AssignmentEscalationQueueService } from '../../assignment-escalation/queues/assignment-escalation-queue.service';

export interface DispatchResult {
  assigned: boolean;
  driverId?: string;
  distanceMeters?: number;
  reason?: 'NO_ELIGIBLE_DRIVER';
}

type CandidateFailure = 'driver' | 'truck' | 'tank';

/**
 * Raised inside `assignDriver`'s transaction when one of the three
 * resources is no longer free, purely to ABORT it.
 *
 * Returning early instead would resolve the callback normally, and
 * `session.withTransaction` commits on normal resolution — so a refusal at
 * the truck step would commit the driver booking that preceded it, leaving
 * that driver `isAvailable: false` against an order that was never
 * assigned. Nothing would ever release them: the release paths key off an
 * order's own `driverId`, and the order never got one. Throwing is what
 * makes the booking of all three genuinely all-or-nothing (research R13).
 */
class ResourceUnavailableError extends Error {
  constructor(readonly resource: CandidateFailure) {
    super(`Resource unavailable: ${resource}`);
  }
}

// The $geoNear aggregate below returns plain objects, not hydrated
// Mongoose documents (see findCandidates' own doc comment) — this shape
// says so honestly, rather than claiming Document methods that don't exist
// on the result.
export interface DriverCandidate {
  _id: Types.ObjectId;
  distanceMeters?: number;
  [field: string]: unknown;
}

@Injectable()
export class DispatchService {
  constructor(
    @InjectModel(Order.name) protected readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) protected readonly userModel: Model<UserDocument>,
    @InjectModel(Truck.name) protected readonly truckModel: Model<TruckDocument>,
    @InjectModel(Tank.name) protected readonly tankModel: Model<TankDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly orderStateService: OrderStateService,
    private readonly notificationsService: NotificationsService,
    private readonly warehousesService: WarehousesService,
    private readonly tenantContext: TenantContextService,
    private readonly assignmentEscalationQueue: AssignmentEscalationQueueService,
    private readonly config: ConfigService,
  ) {}

  /**
   * spec 010 FR-001: the transporter's entire active driver roster for this
   * order, not a filtered eligible-only subset — each one annotated with
   * `eligibility` (research R1/data-model.md §1) so the administrator sees
   * who is genuinely pickable right now versus who is not, and why, rather
   * than a driver silently vanishing from the list. `findById` on a
   * multi-party schema auto-scopes by the acting TRANSPORT_COMPANY_ADMIN's
   * own `transportCompanyId` (plan.md §1) — an order routed to someone
   * else's transporter is 404 here, same as any other cross-tenant id.
   *
   * Each candidate carries `suggestedTruck` (spec 008 FR-009c/d, research
   * R4) — that driver's last-operated truck, derived from order history,
   * `null` when they've never driven or their last truck is withdrawn/busy
   * — computed regardless of eligibility, since it is a fact about the
   * driver, not about whether they are currently pickable.
   */
  async getCandidates(orderId: string): Promise<
    Array<
      DriverCandidate & {
        suggestedTruck: TruckDocument | null;
        eligibility: DriverEligibility;
        lastSeenAt: Date | null;
      }
    >
  > {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== OrderStatus.ROUTED_TO_TRANSPORT) {
      throw new ConflictException(
        `Order ${orderId} is not awaiting driver assignment (status must be ROUTED_TO_TRANSPORT)`,
      );
    }
    const candidates = await this.findCandidates(order.deliveryLocation.coordinates);
    const annotated = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        eligibility: this.classifyEligibility(candidate),
        lastSeenAt: (candidate.lastSeenAt as Date | undefined) ?? null,
        suggestedTruck: await this.getSuggestedTruck(String(candidate._id)),
      })),
    );
    // Stable sort (guaranteed by the JS spec since ES2019): ELIGIBLE first,
    // preserving the nearest-first order `findCandidates` already produced
    // within that group and within the rest (FR-003).
    return annotated.sort((a, b) => {
      const rank = (e: DriverEligibility) => (e === DriverEligibility.ELIGIBLE ? 0 : 1);
      return rank(a.eligibility) - rank(b.eligibility);
    });
  }

  /**
   * spec 010 FR-002/FR-004: computed, never stored — see
   * `DriverEligibility`'s own doc comment for why there are four values, not
   * a boolean.
   */
  private classifyEligibility(driver: DriverCandidate): DriverEligibility {
    if (driver.isActive === false) {
      return DriverEligibility.INACTIVE;
    }
    if (!driver.isOnline) {
      return DriverEligibility.OFFLINE;
    }
    if (driver.isAvailable === false || driver.activeOrderId) {
      return DriverEligibility.BUSY;
    }
    return DriverEligibility.ELIGIBLE;
  }

  /**
   * spec 008 research R4: the driver's most recently operated truck,
   * derived from order history alone — no `lastTruckId` field is ever added
   * to `User`. Suppressed (returns `null`) when that truck is withdrawn or
   * already committed elsewhere (FR-009c/FR-009d) rather than suggesting one
   * the operator could not actually pick.
   */
  private async getSuggestedTruck(driverId: string): Promise<TruckDocument | null> {
    const lastOrder = await this.orderModel
      .findOne({ driverId: new Types.ObjectId(driverId), truckId: { $exists: true } })
      .sort({ createdAt: -1 })
      .select('truckId')
      .exec();
    if (!lastOrder?.truckId) {
      return null;
    }
    return this.truckModel
      .findOne({ _id: lastOrder.truckId, isActive: true, activeOrderId: { $exists: false } })
      .exec();
  }

  /**
   * Commits the transporter's CHOSEN driver, truck and tank (spec 008
   * FR-009: selection is sequential — driver, then truck, then tank). All
   * three resources are booked in one transaction via conditional
   * `findOneAndUpdate` against their unique partial `activeOrderId` indexes
   * (research R13) — the same pattern the driver alone used before this
   * feature. The order now stops at ASSIGNED_TO_DRIVER (spec 008 FR-046a):
   * the auto-advance to IN_TRANSIT this method used to perform is REMOVED —
   * reaching IN_TRANSIT is now gated by departure verification (or an
   * operator override), a separate flow entirely.
   *
   * The warehouse supplying this order's grade is resolved BEFORE any
   * resource is booked (FR-035f) — a missing supplier is the operator's
   * problem to solve, never something a driver discovers after being sent
   * out with nothing to load.
   */
  async assignDriver(
    orderId: string,
    driverId: string,
    truckId: string,
    tankId: string,
    reason?: string,
  ): Promise<DispatchResult> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== OrderStatus.ROUTED_TO_TRANSPORT) {
      throw new ConflictException(
        `Order ${orderId} is not eligible for driver assignment (status must be ROUTED_TO_TRANSPORT)`,
      );
    }

    // spec 010 FR-007/FR-008: only an OFFLINE driver is ever assignable
    // without already being ELIGIBLE, and only with a reason — BUSY and
    // INACTIVE stay refused unconditionally by the existing booking filter
    // below (unchanged: `activeOrderId`/`isActive` were always guards
    // there). This is a UX gate only (did the operator supply a reason?),
    // never the actual correctness boundary — that stays the atomic
    // `findOneAndUpdate` below regardless of what this read observed.
    const driverForEligibilityCheck = await this.userModel.findById(driverId).exec();
    const requestedEligibility = driverForEligibilityCheck
      ? this.classifyEligibility(driverForEligibilityCheck as unknown as DriverCandidate)
      : undefined;
    if (requestedEligibility === DriverEligibility.OFFLINE && !reason?.trim()) {
      throw new BadRequestException({
        error: ErrorCode.ASSIGNMENT_REASON_REQUIRED,
        message: 'A reason is required to assign a driver who is currently offline',
      });
    }
    const assignedWhileIneligible = requestedEligibility === DriverEligibility.OFFLINE;

    const warehouse = await this.warehousesService.findNearestSupplying(
      order.deliveryLocation.coordinates,
      order.fuelType,
    );
    if (!warehouse) {
      throw new ConflictException({
        error: ErrorCode.NO_WAREHOUSE_FOR_GRADE,
        message: 'No in-service warehouse supplies this order’s fuel grade',
      });
    }

    const session = await this.connection.startSession();
    let result: DispatchResult | undefined;
    let failure: CandidateFailure | undefined;
    try {
      result = await session.withTransaction(async () => {
        // Tenant-scoped (User stays single-tenant): can only ever match a
        // driver belonging to the acting transporter's own company. No
        // capability predicate here any more (spec 008 research R3) — that
        // moved to the tank, validated below. `isOnline: true` DROPPED here
        // (spec 010 FR-007) — an OFFLINE driver is now a legitimate booking,
        // gated only by the reason check above; BUSY (`isAvailable`/
        // `activeOrderId`) and INACTIVE (`isActive`) still refuse exactly
        // as they always have, unchanged.
        const bookedDriver = await this.userModel
          .findOneAndUpdate(
            {
              _id: driverId,
              role: UserRole.DRIVER,
              isActive: true,
              isAvailable: true,
              activeOrderId: { $exists: false },
            },
            { $set: { isAvailable: false, activeOrderId: order._id } },
            { new: true, session },
          )
          .exec();
        if (!bookedDriver) {
          throw new ResourceUnavailableError('driver');
        }

        const bookedTruck = await this.truckModel
          .findOneAndUpdate(
            { _id: truckId, isActive: true, activeOrderId: { $exists: false } },
            { $set: { activeOrderId: order._id } },
            { new: true, session },
          )
          .exec();
        if (!bookedTruck) {
          throw new ResourceUnavailableError('truck');
        }

        const bookedTank = await this.tankModel
          .findOneAndUpdate(
            { _id: tankId, isActive: true, activeOrderId: { $exists: false } },
            { $set: { activeOrderId: order._id } },
            { new: true, session },
          )
          .exec();
        if (!bookedTank) {
          throw new ResourceUnavailableError('tank');
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

        // spec 007 FR-003a: the mirror of driverSummary below — the
        // customer's contact details, so the assigned driver can identify
        // and reach them. Same snapshot discipline: read once here, never
        // re-derived on a later read. Unscoped: the client belongs to the
        // Fuel Company, not the acting TRANSPORT_COMPANY_ADMIN's own
        // company, so the single-tenant plugin's ambient companyId filter
        // would otherwise silently match nothing (the same reasoning
        // PasswordResetService's phone lookup already documents).
        const client = await this.tenantContext.runUnscoped(() =>
          this.userModel.findById(order.clientId).session(session).exec(),
        );

        await this.orderStateService.transition(
          order._id as Types.ObjectId,
          OrderStatus.ROUTED_TO_TRANSPORT,
          OrderStatus.ASSIGNED_TO_DRIVER,
          SYSTEM_ACTOR,
          {
            session,
            extraSet: {
              driverId: bookedDriver._id,
              truckId: bookedTruck._id,
              tankId: bookedTank._id,
              // Snapshotted once, here (FR-008/FR-028) — never re-derived on
              // a later read, same discipline as deliveryAddressText. This
              // is the client's ONLY window into the driver: they can never
              // read the driver's own user record directly.
              driverSummary: {
                fullName: bookedDriver.fullName,
                phone: bookedDriver.phone,
                // spec 008 research R12: re-sourced from the assigned Truck
                // record — the driver's own embedded truck is gone. The
                // customer-facing shape does not change.
                plateNumber: bookedTruck.plateNumber,
              },
              tankSummary: {
                code: bookedTank.code,
                material: bookedTank.material,
              },
              warehouseId: warehouse._id,
              warehouseSummary: {
                name: warehouse.name,
                addressText: warehouse.addressText,
                location: warehouse.location,
              },
              ...(client
                ? {
                    clientSummary: {
                      fullName: client.fullName,
                      phone: client.phone,
                    },
                  }
                : {}),
              // spec 010 FR-008: recorded once, here, alongside
              // driverSummary — the audit trail for a deliberately
              // ineligible (OFFLINE) assignment. `reason` is validated
              // non-blank above whenever `assignedWhileIneligible` is true.
              ...(assignedWhileIneligible
                ? { assignedWhileIneligible: true, assignedWhileIneligibleReason: reason }
                : {}),
            },
          },
        );
        // spec 008 FR-046a: the auto-advance to IN_TRANSIT that used to
        // happen here is REMOVED — assignment now stops at
        // ASSIGNED_TO_DRIVER pending departure verification (or override).

        const bookedResult: DispatchResult = {
          assigned: true,
          driverId: String(bookedDriver._id),
        };
        return bookedResult;
      });
    } catch (err) {
      if (err instanceof ResourceUnavailableError) {
        // Expected contention, not a fault: the transaction has rolled back,
        // `result` stays undefined, and the mapping below turns this into
        // the operator-facing refusal it always did.
        failure = err.resource;
      } else if (isDuplicateKeyError(err)) {
        // spec 009 FR-008/SC-008: two concurrent `assignDriver` calls on the SAME order,
        // each naming a *different* driver/truck/tank, each pass their own document's
        // `activeOrderId: { $exists: false }` filter under snapshot isolation — the
        // collision only appears at commit, as a duplicate-key violation on the shared
        // unique `activeOrderId` index, never as a clean `findOneAndUpdate` miss.
        throw new ConflictException({
          error: ErrorCode.ORDER_ALREADY_ASSIGNED,
          message:
            'This order was just assigned by another operator — refresh to see the current assignment',
        });
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    if (!result) {
      if (failure === 'truck') {
        throw new ConflictException({
          error: ErrorCode.TRUCK_UNAVAILABLE,
          message: 'Chosen truck is no longer available (withdrawn or already committed)',
        });
      }
      if (failure === 'tank') {
        throw new ConflictException({
          error: ErrorCode.TANK_UNAVAILABLE,
          message: 'Chosen tank is no longer available (withdrawn or already committed)',
        });
      }
      throw new ConflictException(
        'Chosen driver is no longer eligible (already booked, deactivated, or offline) — request a fresh candidate list',
      );
    }

    await this.notificationsService.notify({
      companyId: order.fuelCompanyId,
      recipientUserId: result.driverId!,
      type: NotificationType.ORDER_ASSIGNED,
      orderId: order._id as Types.ObjectId,
    });
    // spec 010 FR-011/FR-012a: scheduled *after* the transaction commits —
    // same reasoning `PaymentTimeoutQueueService.schedule` already follows
    // ("a job referencing a rolled-back transaction would be worse than one
    // scheduled a moment late," orders.service.ts). `jobId = orderId`
    // (research R3) means this call is itself idempotent.
    await this.assignmentEscalationQueue.schedule(
      String(order._id),
      this.getAssignmentAckWindowMinutes(),
    );
    return result;
  }

  private getAssignmentAckWindowMinutes(): number {
    return this.config.get<number>('assignment.ackWindowMinutes') ?? 3;
  }

  /**
   * Single index-served, distance-sorted candidate query (FR-011/FR-017,
   * research R8). spec 008 research R3: capacity/fuelType no longer filter
   * here at all — that constraint moved to the tank, checked at tank
   * selection, a step downstream of this list. The `$geoNear`/`$lookup`
   * ordering constraint that used to force capability onto this document
   * (trucks denormalized onto the driver) no longer applies — do not
   * reintroduce that denormalization to solve a problem that no longer
   * exists. The tenant plugin auto-inserts a $match immediately after
   * $geoNear (verified in tenant-scope.plugin.spec.ts) scoped to the acting
   * transporter's own company, so no explicit companyId filter is needed
   * here. Results are plain objects (aggregate, not hydrated documents) but
   * retain `_id` and every filtered field.
   */
  protected async findCandidates(
    deliveryCoordinates: [number, number],
  ): Promise<DriverCandidate[]> {
    // spec 010 FR-001 (research R1): the match no longer filters on
    // isActive/isOnline/isAvailable/activeOrderId at all — every one of the
    // transporter's drivers is a candidate now, classified afterward
    // (`classifyEligibility`), never excluded at the query. The tenant
    // plugin still auto-inserts its own $match immediately after $geoNear
    // (verified in tenant-scope.plugin.spec.ts), scoping to the acting
    // transporter's own company exactly as before.
    const located = await this.userModel.aggregate<DriverCandidate>([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: deliveryCoordinates },
          distanceField: 'distanceMeters',
          spherical: true,
          query: { role: UserRole.DRIVER },
        },
      },
    ]);

    // $geoNear silently omits any document missing the field it sorts by
    // (the same reason a driver who has never recorded a location was
    // already invisible to dispatch before this feature) — a driver who has
    // never connected at all would otherwise never appear as "every driver"
    // requires (research R1). The tenant-scope plugin hooks plain `find`
    // queries too, so this stays scoped to the acting transporter exactly
    // like the aggregate above.
    const neverLocated = await this.userModel
      .find({ role: UserRole.DRIVER, location: { $exists: false } })
      .lean<DriverCandidate[]>()
      .exec();

    return [...located, ...neverLocated];
  }
}
