import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/order.schema';
import { Truck, TruckDocument } from '../../trucks/schemas/truck.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { VerificationMethod } from '../../../common/enums/verification-method.enum';
import { VerificationStage } from '../../../common/enums/verification-stage.enum';
import { GeoPoint } from '../../../common/schemas/geo-point.schema';
import { haversineDistanceMeters } from '../../../common/utils/geo.util';
import { OrderStateService, TransitionActor } from './order-state.service';

export interface VerifyVehicleResult {
  order: OrderDocument;
  stage: VerificationStage;
  matched: true;
  /** Present only for a LOADING attempt — the departure stage is not geofenced. */
  distanceMeters?: number;
}

@Injectable()
export class VehicleVerificationService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Truck.name) private readonly truckModel: Model<TruckDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly orderStateService: OrderStateService,
    private readonly config: ConfigService,
  ) {}

  /**
   * spec 008 US3 (FR-017-025, research R7): resolves `credential` to a
   * truck, compares it to the order's assigned `truckId`, appends the
   * attempt — failed included (FR-019/FR-040) — and, only for a matched
   * DEPARTURE attempt, transitions the order in the same transaction, so a
   * recorded verification never exists against an unadvanced order. A
   * matched LOADING attempt records success but does NOT itself advance the
   * order — `confirm-loading` (US4) owns that edge, gated on this having
   * already succeeded.
   *
   * The two stages ask different questions of the same card (FR-030a). At
   * DEPARTURE the question is only "is this the assigned truck" — the
   * driver may be anywhere. At LOADING the truck has not changed, so the
   * card alone would prove nothing new; what has to be proven there is that
   * the driver reached the warehouse, and the card read is the moment the
   * platform gets to ask. So the loading attempt is additionally geofenced
   * against the assigned warehouse, and `reportedLocation` — the fix the
   * device took as the card was read — is mandatory for it.
   */
  async verify(
    orderId: string,
    actor: TransitionActor,
    credential: string,
    method: VerificationMethod,
    reportedLocation?: { longitude: number; latitude: number },
  ): Promise<VerifyVehicleResult> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (String(order.driverId) !== actor.actorId) {
      throw new NotFoundException('Order not found');
    }

    // research R7: the stage is derived from the order's own status, never
    // accepted from the client. FR-025: a stage that is not currently
    // outstanding is refused as out-of-sequence, without recording or
    // advancing anything.
    const stage = this.resolveOutstandingStage(order);
    if (!stage) {
      throw new ConflictException('No vehicle verification is currently pending for this order');
    }

    // FR-018/Principle II: "resolved to a different truck" and "resolved to
    // nothing" are deliberately the SAME outcome — telling them apart would
    // let a driver's device probe which cards/codes exist.
    const presentedTruck = await this.resolveCredential(credential, method);
    const truckMatched = Boolean(
      presentedTruck && String(presentedTruck._id) === String(order.truckId),
    );

    // FR-024: recorded honestly — absent if the driver's position isn't
    // known. The fix taken with the card read wins over the last position
    // the tracking stream happened to store, which is throttled to 50m /
    // 3 minutes and can be far older than that whenever the driver has
    // been parked or out of signal.
    const driver = await this.userModel.findById(actor.actorId).exec();
    const driverLocation: GeoPoint | undefined = reportedLocation
      ? { type: 'Point', coordinates: [reportedLocation.longitude, reportedLocation.latitude] }
      : driver?.location;

    const distanceMeters = this.measureAgainstWarehouse(order, stage, reportedLocation);
    const radiusMeters = this.geofenceRadiusMeters();
    // `undefined` at DEPARTURE, which is not geofenced at all — the truck is
    // wherever the driver's shift starts, and the platform has no opinion
    // about where that is.
    const withinGeofence = distanceMeters === undefined || distanceMeters <= radiusMeters;
    const matched = truckMatched && withinGeofence;

    const attempt = {
      stage,
      method,
      matched,
      presentedTruckId: presentedTruck?._id,
      at: new Date(),
      driverLocation,
      distanceMeters,
      actorId: new Types.ObjectId(actor.actorId),
    };

    const session = await this.connection.startSession();
    try {
      const updated = await session.withTransaction(async () => {
        // FR-019/FR-040: appended before deciding anything else — a refused
        // attempt must still be visible afterward, whether it advances the
        // order or not.
        await this.orderModel
          .updateOne({ _id: order._id }, { $push: { verifications: attempt } }, { session })
          .exec();

        if (!matched) {
          return order;
        }

        if (stage === VerificationStage.DEPARTURE) {
          return this.orderStateService.transition(
            order._id as Types.ObjectId,
            OrderStatus.ASSIGNED_TO_DRIVER,
            OrderStatus.LOADING,
            actor,
            { session },
          );
        }
        // LOADING stage success: recorded, but the order stays at LOADING —
        // confirm-loading (US4) is the one edge that advances it.
        return (await this.orderModel.findById(order._id).session(session).exec())!;
      });

      // A wrong card answers first and answers alone (FR-018): a driver who
      // presented something that is not their truck learns nothing about
      // where they are standing, whichever gate they are standing at.
      if (!truckMatched) {
        throw new ForbiddenException({
          error: ErrorCode.VEHICLE_MISMATCH,
          message: 'Presented credential does not match the assigned vehicle',
        });
      }
      if (!withinGeofence) {
        // FR-030a: the right truck, in the wrong place. Told plainly, with
        // the distance — the driver already knows the depot's name and
        // address (FR-027), so this reveals nothing they were not handed at
        // departure, and "you are 4 km short" is the only form of this
        // refusal a driver can act on.
        throw new ForbiddenException({
          error: ErrorCode.NOT_AT_WAREHOUSE,
          message: 'Loading must be verified at the assigned warehouse',
          distanceMeters,
          radiusMeters,
        });
      }
      return { order: updated, stage, matched: true, distanceMeters };
    } finally {
      await session.endSession();
    }
  }

  /**
   * The loading-stage geofence (FR-030a-c), in meters, or `undefined` when
   * the stage is not geofenced. Refuses rather than measuring when it
   * cannot: a missing fix (FR-030c) leaves the attempt unjudgeable, so it
   * is turned away before anything is recorded — the same footing as an
   * out-of-sequence attempt (FR-025), and deliberately NOT a recorded
   * failure, since nothing about the vehicle was ever evaluated.
   *
   * Never falls back to the driver's last stored position: a geofence
   * satisfied by a fix from an hour ago proves the driver's phone was near
   * the depot once, which is not the claim being made.
   */
  private measureAgainstWarehouse(
    order: OrderDocument,
    stage: VerificationStage,
    reportedLocation?: { longitude: number; latitude: number },
  ): number | undefined {
    if (stage !== VerificationStage.LOADING) {
      return undefined;
    }
    const warehouseLocation = order.warehouseSummary?.location;
    if (!warehouseLocation) {
      // `assignDriver` writes warehouseId/warehouseSummary in the same
      // transaction that writes truckId, and refuses to assign at all
      // without a supplying warehouse (FR-035f) — so an order sitting at
      // LOADING with no warehouse snapshot is not a reachable state. If one
      // ever is reached, the geofence is silently unenforceable, which is
      // the one outcome worth refusing loudly rather than passing.
      throw new ConflictException({
        error: ErrorCode.NOT_AT_WAREHOUSE,
        message: 'This delivery has no warehouse to verify loading against',
      });
    }
    if (!reportedLocation) {
      throw new BadRequestException({
        error: ErrorCode.LOCATION_REQUIRED,
        message: 'A position fix is required to verify loading at the warehouse',
      });
    }
    return Math.round(
      haversineDistanceMeters(warehouseLocation.coordinates, [
        reportedLocation.longitude,
        reportedLocation.latitude,
      ]),
    );
  }

  private geofenceRadiusMeters(): number {
    return this.config.get<number>('verification.warehouseGeofenceRadiusMeters') ?? 500;
  }

  /**
   * `undefined` when nothing is currently outstanding (FR-025). DEPARTURE is
   * outstanding exactly while the order sits at ASSIGNED_TO_DRIVER — once
   * matched, the order itself moves on, which is what makes a repeat
   * attempt naturally fall outside this. LOADING is outstanding while the
   * order sits at LOADING AND no matched LOADING attempt has been recorded
   * yet — since a matched LOADING attempt does NOT itself move the order,
   * completeness has to be read out of `verifications[]` instead.
   */
  private resolveOutstandingStage(order: OrderDocument): VerificationStage | undefined {
    if (order.status === OrderStatus.ASSIGNED_TO_DRIVER) {
      return VerificationStage.DEPARTURE;
    }
    if (order.status === OrderStatus.LOADING) {
      const alreadyVerified = order.verifications.some(
        (v) => v.stage === VerificationStage.LOADING && v.matched,
      );
      return alreadyVerified ? undefined : VerificationStage.LOADING;
    }
    return undefined;
  }

  private resolveCredential(
    credential: string,
    method: VerificationMethod,
  ): Promise<TruckDocument | null> {
    const field = method === VerificationMethod.NFC_CARD ? 'nfcCardUid' : 'qrToken';
    return this.truckModel.findOne({ [field]: credential }).exec();
  }
}
