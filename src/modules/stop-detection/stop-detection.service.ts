import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { StopOrigin } from '../../common/enums/stop-origin.enum';
import { StopReason } from '../../common/enums/stop-reason.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { StopEscalationQueueService } from './queues/stop-escalation-queue.service';
import { SchedulerLeaseService } from '../../common/scheduler/scheduler-lease.service';
import { SWEEP_NAMES } from '../../common/scheduler/sweep-names.const';

const SWEEP_INTERVAL_NAME = 'stop-detection-sweep';

/**
 * The two — and only two — conditions under which an existing stop event
 * blocks a new one being raised (FR-016, FR-008b/d). Written once and shared
 * by the sweep and by `declareStop`, because the two must agree exactly: if
 * the sweep considered a stop blocking that the declare path did not, a
 * driver could declare over a stop the sweep would then refuse to re-raise,
 * and the delivery would carry two open stops the invariant says cannot
 * coexist.
 *
 * 1. `resolvedAt: null` — an open stop, still awaiting an answer.
 * 2. `suppressedUntil > now` — a declared stop still in effect. This one is
 *    time-bounded on purpose (FR-008d): once the driver's own estimate
 *    lapses, the declaration stops blocking and ordinary detection resumes,
 *    so no single declaration can silence a whole delivery.
 *
 * Note this is an `$elemMatch` body, so both clauses are evaluated against
 * the *same* array element — a resolved declaration whose window has lapsed
 * blocks on neither.
 */
function unblockedStopFilter(now: Date = new Date()) {
  return { $or: [{ resolvedAt: null }, { suppressedUntil: { $gt: now } }] };
}

/**
 * spec 011 US1 (research R1): finds deliveries whose truck has stopped
 * moving, and asks the driver why.
 *
 * **Why a sweep rather than a per-order timer.** The obvious design — a
 * delayed job per delivery, rescheduled whenever the driver moves, exactly
 * as feature 010's escalation works — does not survive the numbers. A truck
 * at 60 km/h crosses the 50 m movement threshold roughly every 3 seconds,
 * so every *moving* driver would generate a job cancel-plus-add every 3
 * seconds for their whole journey: thrash proportional to movement, in
 * order to detect the absence of it. A sweep costs one query per interval
 * regardless of how fast anyone is driving.
 *
 * **Tenant scoping.** Like `PresenceService.sweepOfflineDrivers`, this runs
 * as a background job with no acting user and therefore no
 * AsyncLocalStorage context — so it queries across all companies
 * explicitly rather than relying on the scoping plugins, which have no
 * "actor" to scope to. Every *write* it performs is still addressed to one
 * specific order it found.
 */
@Injectable()
export class StopDetectionService implements OnModuleInit {
  private readonly logger = new Logger(StopDetectionService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly notificationsService: NotificationsService,
    private readonly escalationQueue: StopEscalationQueueService,
    private readonly lease: SchedulerLeaseService,
  ) {}

  /**
   * Registered dynamically rather than via a static `@Cron` expression so
   * `STOP_DETECTION_SWEEP_SECONDS` is genuinely honoured — the quickstart
   * walkthrough and the e2e suite both lower it so neither waits a real
   * minute, which a decorator's compile-time constant could not support.
   */
  onModuleInit(): void {
    const seconds = this.config.get<number>('stopDetection.sweepSeconds') ?? 60;
    const interval = setInterval(() => {
      void this.sweepStalledDeliveries().catch((err) =>
        this.logger.error(`Stop-detection sweep failed: ${err}`),
      );
    }, seconds * 1000);
    this.schedulerRegistry.addInterval(SWEEP_INTERVAL_NAME, interval);
  }

  /**
   * Public so tests drive it directly instead of waiting for the interval —
   * the same affordance `PresenceService.sweepOfflineDrivers` provides.
   *
   * spec 012 FR-056b: the interval fires on EVERY instance, so with two
   * replicas this ran twice per tick. The lease makes exactly one instance
   * sweep, and a dead holder's lease expires in time for another instance to
   * take the next tick with no operator action. `SCHEDULER_LEASE_ENABLED=false`
   * bypasses it entirely, which is how the existing suites keep driving this
   * method directly without a Redis round trip changing their timing.
   */
  async sweepStalledDeliveries(): Promise<void> {
    await this.lease.runExclusively(SWEEP_NAMES.STOP_DETECTION, () =>
      this.detectStalledDeliveries(),
    );
  }

  /**
   * IDEMPOTENT AGAINST A CONCURRENT SECOND RUN (spec 012 T094), and it was
   * already so before this feature — which is what makes the at-most-once lease
   * sufficient rather than merely reassuring.
   *
   * The read below is not the guarantee and does not need to be: two sweeps
   * racing will both find the same stalled driver. `raiseStopFor` then performs
   * ONE conditional `updateOne` whose filter requires an IN_TRANSIT order with
   * no unresolved stop, so the database decides which of the two wins and the
   * loser writes nothing — no duplicate stop event, and therefore no duplicate
   * driver prompt or transporter escalation.
   *
   * If this is ever refactored into read-then-write in application code, the
   * lease will NOT save it.
   */
  private async detectStalledDeliveries(): Promise<void> {
    const windowMinutes = this.config.get<number>('stopDetection.windowMinutes') ?? 10;
    const cutoff = new Date(Date.now() - windowMinutes * 60_000);

    // Driver-first: the selective predicate lives here, and at any moment
    // nearly every driver on a delivery is moving. `lastMovedAt: { $lt }`
    // deliberately does NOT match documents where the field is absent —
    // a driver who never granted location permission has never sent a fix,
    // so they have no `lastMovedAt` at all and must never be reported as
    // stopped (FR-020). Do not "helpfully" add `$or: [{ lastMovedAt: null }]`.
    const stalledDrivers = await this.userModel
      .find({
        role: UserRole.DRIVER,
        activeOrderId: { $exists: true },
        lastMovedAt: { $lt: cutoff },
      })
      .select('_id activeOrderId location')
      .lean()
      .exec();

    for (const driver of stalledDrivers) {
      await this.raiseStopFor(driver as never);
    }

    // FR-058a's stall alert has nothing to observe without this record, and
    // this sweep is the one whose silence actually harms someone: a Redis
    // outage stalls it while the platform keeps serving and reporting itself
    // healthy, so a stalled delivery goes unnoticed — the precise harm feature
    // 011 exists to prevent. Emitted at `info` so a production LOG_LEVEL of
    // `info` still sees it, and only by the instance that actually ran.
    this.logger.log(
      {
        sweep: SWEEP_NAMES.STOP_DETECTION,
        event: 'sweep.completed',
        stalledDrivers: stalledDrivers.length,
      },
      'sweep.completed',
    );
  }

  private async raiseStopFor(driver: {
    _id: Types.ObjectId;
    activeOrderId: Types.ObjectId;
    location?: { type: string; coordinates: [number, number] };
  }): Promise<void> {
    const stopId = new Types.ObjectId();

    // The whole guarantee in one write (FR-016, research R6): only an
    // IN_TRANSIT order (FR-002 — a truck parked at the warehouse or the
    // customer's gate is expected, not an incident) with no unresolved stop
    // gets one. Two sweeps racing, or a sweep racing a driver's own
    // declaration, cannot both succeed — the condition is evaluated by the
    // database at write time, never read-then-written in application code.
    const result = await this.orderModel
      .updateOne(
        {
          _id: driver.activeOrderId,
          status: OrderStatus.IN_TRANSIT,
          stopEvents: { $not: { $elemMatch: unblockedStopFilter() } },
        },
        {
          $push: {
            stopEvents: {
              _id: stopId,
              origin: StopOrigin.DETECTED,
              detectedAt: new Date(),
              ...(driver.location ? { location: driver.location } : {}),
            },
          },
        },
      )
      .exec();

    if (result.modifiedCount === 0) {
      // Not in transit, or a stop is already open — both entirely normal.
      return;
    }

    const order = await this.orderModel.findById(driver.activeOrderId).exec();
    if (!order) return;

    await this.notificationsService.notify({
      companyId: order.fuelCompanyId,
      recipientUserId: String(driver._id),
      type: NotificationType.DRIVER_STOP_DETECTED,
      orderId: order._id as never,
      // The app needs `stopId` to open the prompt for this specific stop —
      // and to answer it, since the reason endpoint is addressed by it.
      payload: { stopId: String(stopId) },
    });

    await this.escalationQueue.schedule(
      String(stopId),
      String(order._id),
      this.config.get<number>('stopDetection.responseWindowMinutes') ?? 5,
    );

    this.logger.debug(`Raised stop ${stopId} on order ${String(order._id)}`);
  }

  /**
   * spec 011 FR-008a-d: the driver announces a stop before anyone asks.
   *
   * **A declared stop is created already resolved.** It arrives carrying its
   * own answer — `reason` and `reasonGivenAt` are set at creation — so there
   * is nothing left for anyone to do about it, which is exactly why it never
   * prompts and never escalates (FR-008b). Leaving it unresolved instead
   * would break FR-016's invariant the moment its suppression lapsed: the
   * sweep is required to raise a *new* detected stop at that point
   * (data-model.md's state diagram), and the delivery would then carry two
   * unresolved stops at once. Suppression is therefore carried by
   * `suppressedUntil`, a separate and time-bounded field, not by leaving the
   * event open.
   *
   * `resolvedBy` stays absent — the platform's convention for "the driver
   * answered", as opposed to an administrator marking something handled.
   */
  async declareStop(
    orderId: string,
    driverId: string,
    input: { reason: StopReason; reasonText?: string; expectedDurationMinutes: number },
  ): Promise<OrderDocument> {
    const now = new Date();
    const stopId = new Types.ObjectId();

    // Same conditional-write discipline as `raiseStopFor`: ownership, status
    // and the one-open-stop invariant are all evaluated by the database in
    // the write itself. A declaration racing the sweep cannot produce two
    // open stops, because whichever lands second fails its own condition.
    const result = await this.orderModel
      .updateOne(
        {
          _id: new Types.ObjectId(orderId),
          driverId: new Types.ObjectId(driverId),
          status: OrderStatus.IN_TRANSIT,
          stopEvents: { $not: { $elemMatch: unblockedStopFilter(now) } },
        },
        {
          $push: {
            stopEvents: {
              _id: stopId,
              origin: StopOrigin.DECLARED,
              detectedAt: now,
              reason: input.reason,
              ...(input.reasonText ? { reasonText: input.reasonText } : {}),
              reasonGivenAt: now,
              expectedDurationMinutes: input.expectedDurationMinutes,
              suppressedUntil: new Date(now.getTime() + input.expectedDurationMinutes * 60_000),
              resolvedAt: now,
            },
          },
        },
      )
      .exec();

    if (result.modifiedCount === 0) {
      // The write's condition covers three distinct refusals, so which one
      // fired has to be established by a follow-up read. It is only ever
      // taken on the failure path, so the happy path stays a single write.
      await this.explainDeclineRefusal(orderId, driverId, now);
    }

    return this.requireOrder(orderId);
  }

  /**
   * spec 011 FR-007/FR-010: the driver answers a detected stop.
   *
   * **A late answer is a success.** If the response window already elapsed
   * and the transporter was already told, the reason is still recorded and
   * still resolves the stop — `escalatedAt` is deliberately left in place as
   * a truthful record that the alert did go out. Treating a late answer as
   * a conflict is the reflex this method exists to not have.
   */
  async submitReason(
    orderId: string,
    driverId: string,
    stopId: string,
    input: { reason: StopReason; reasonText?: string },
  ): Promise<OrderDocument> {
    const now = new Date();

    // `$elemMatch` scopes both criteria to the same array element, so the
    // positional `$` below updates the stop actually named — matching
    // `_id` and `reasonGivenAt` as independent top-level criteria would let
    // one stop satisfy the id and a different one satisfy the emptiness.
    const result = await this.orderModel
      .updateOne(
        {
          _id: new Types.ObjectId(orderId),
          driverId: new Types.ObjectId(driverId),
          stopEvents: { $elemMatch: { _id: new Types.ObjectId(stopId), reasonGivenAt: null } },
        },
        {
          $set: {
            'stopEvents.$.reason': input.reason,
            ...(input.reasonText ? { 'stopEvents.$.reasonText': input.reasonText } : {}),
            'stopEvents.$.reasonGivenAt': now,
            // Answering a detected stop resolves it: an explained stop needs
            // no administrator action. `resolvedBy` stays absent, which is
            // what distinguishes this from an admin marking it handled.
            'stopEvents.$.resolvedAt': now,
          },
        },
      )
      .exec();

    if (result.modifiedCount === 0) {
      await this.explainReasonRefusal(orderId, driverId, stopId);
    }

    // Nothing left to escalate. Cancelling after the write, never before:
    // a cancel issued first would leave the timer gone if the write then
    // failed its condition, silently disarming the very fallback FR-009
    // exists to provide.
    await this.escalationQueue.cancel(stopId);

    return this.requireOrder(orderId);
  }

  /**
   * spec 011 FR-012: the transport administrator marks a stop handled.
   *
   * "Handled" means *I have dealt with this*, never *delete it*: the event
   * stays on the delivery's record in full, and `resolvedBy` is what
   * distinguishes an administrator closing it from the driver having
   * answered. An escalated stop closed this way keeps its `escalatedAt` for
   * the same reason — the record has to stay a truthful account of what
   * happened, including that nobody answered.
   *
   * Tenant scoping is the multi-party plugin's job on the `findById` the
   * caller performs; this only enforces that the stop is actually still
   * open.
   */
  async resolveByAdmin(
    orderId: string,
    stopId: string,
    adminUserId: string,
  ): Promise<OrderDocument> {
    const result = await this.orderModel
      .updateOne(
        {
          _id: new Types.ObjectId(orderId),
          stopEvents: { $elemMatch: { _id: new Types.ObjectId(stopId), resolvedAt: null } },
        },
        {
          $set: {
            'stopEvents.$.resolvedAt': new Date(),
            'stopEvents.$.resolvedBy': new Types.ObjectId(adminUserId),
          },
        },
      )
      .exec();

    if (result.modifiedCount === 0) {
      const order = await this.orderModel.findById(orderId).exec();
      const stop = order?.stopEvents.find((s) => String((s as { _id?: unknown })._id) === stopId);
      if (!stop) {
        throw new NotFoundException('Stop not found');
      }
      throw new ConflictException({
        error: ErrorCode.STOP_ALREADY_RESOLVED,
        message: 'This stop has already been resolved',
      });
    }

    // Whatever the administrator just did, nothing is waiting on the driver
    // any more.
    await this.escalationQueue.cancel(stopId);

    return this.requireOrder(orderId);
  }

  /** Distinguishes the three reasons a declaration's conditional write can fail. */
  private async explainDeclineRefusal(
    orderId: string,
    driverId: string,
    _now: Date,
  ): Promise<never> {
    const order = await this.orderModel.findById(orderId).exec();
    // FR-069 discipline, platform-wide: not-found and not-yours are the same
    // answer, so ownership can never be probed by watching status codes.
    if (!order || String(order.driverId) !== driverId) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== OrderStatus.IN_TRANSIT) {
      throw new ConflictException({
        error: ErrorCode.STOP_NOT_IN_TRANSIT,
        message: 'A stop can only be declared while the delivery is in transit',
      });
    }
    throw new ConflictException({
      error: ErrorCode.STOP_ALREADY_OPEN,
      message: 'This delivery already has an open stop — answer that one first',
    });
  }

  /** Distinguishes an unknown stop from one already answered. */
  private async explainReasonRefusal(
    orderId: string,
    driverId: string,
    stopId: string,
  ): Promise<never> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order || String(order.driverId) !== driverId) {
      throw new NotFoundException('Order not found');
    }
    const stop = order.stopEvents.find((s) => String((s as { _id?: unknown })._id) === stopId);
    if (!stop) {
      throw new NotFoundException('Stop not found');
    }
    // Reached only when the stop already carries a reason — a genuine
    // duplicate submission. A *late* answer never lands here: it has no
    // `reasonGivenAt`, so its conditional write succeeds regardless of
    // `escalatedAt` (FR-010).
    throw new ConflictException({
      error: ErrorCode.STOP_ALREADY_ANSWERED,
      message: 'This stop has already been explained',
    });
  }

  private async requireOrder(orderId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }
}
