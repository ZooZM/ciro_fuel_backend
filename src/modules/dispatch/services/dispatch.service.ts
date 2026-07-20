import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { UserRole } from '../../../common/enums/user-role.enum';
import { OrderStateService } from '../../orders/services/order-state.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { PaymentTimeoutQueueService } from '../../payments/queues/payment-timeout-queue.service';
import { SYSTEM_ACTOR } from '../../../common/constants/system-actor';

export interface DispatchResult {
  assigned: boolean;
  driverId?: string;
  distanceMeters?: number;
  reason?: 'NO_ELIGIBLE_DRIVER';
}

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @InjectModel(Order.name) protected readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) protected readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly orderStateService: OrderStateService,
    private readonly notificationsService: NotificationsService,
    private readonly paymentTimeoutQueue: PaymentTimeoutQueueService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Finds and atomically books the nearest eligible driver for an APPROVED
   * order, then advances the order APPROVED -> ASSIGNED_TO_DRIVER ->
   * PENDING_PAYMENT, all inside one Mongo transaction (FR-012, R4).
   * Candidates come back distance-sorted (findCandidates); if the nearest
   * is raced away by a concurrent dispatch, the loop falls through to the
   * next-nearest automatically (FR-013).
   */
  async assignDriver(orderId: string): Promise<DispatchResult> {
    // Tenant-scoped lookup: a cross-company id is indistinguishable from a
    // missing one (FR-002) — both 404, never leaking existence via a 409.
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== OrderStatus.APPROVED) {
      throw new ConflictException(
        `Order ${orderId} is not eligible for dispatch (status must be APPROVED)`,
      );
    }

    const paymentDeadlineMinutes = this.config.get<number>('payment.deadlineMinutes') ?? 30;
    const candidates = await this.findCandidates(
      String(order.companyId),
      order.quantityLiters,
      order.fuelType,
      order.deliveryLocation.coordinates,
    );

    for (const candidate of candidates) {
      const session = await this.connection.startSession();
      let result: DispatchResult | undefined;
      try {
        result = await session.withTransaction(async () => {
          const bookedDriver = await this.userModel
            .findOneAndUpdate(
              { _id: candidate._id, isAvailable: true, activeOrderId: { $exists: false } },
              { $set: { isAvailable: false, activeOrderId: order._id } },
              { new: true, session },
            )
            .exec();

          if (!bookedDriver) {
            // Raced away by a concurrent dispatch — try the next candidate outside this txn.
            return undefined;
          }

          const paymentDeadline = new Date(Date.now() + paymentDeadlineMinutes * 60_000);

          await this.orderStateService.transition(
            order._id as Types.ObjectId,
            OrderStatus.APPROVED,
            OrderStatus.ASSIGNED_TO_DRIVER,
            SYSTEM_ACTOR,
            { session, extraSet: { driverId: bookedDriver._id } },
          );
          await this.orderStateService.transition(
            order._id as Types.ObjectId,
            OrderStatus.ASSIGNED_TO_DRIVER,
            OrderStatus.PENDING_PAYMENT,
            SYSTEM_ACTOR,
            { session, extraSet: { paymentDeadline } },
          );

          const bookedResult: DispatchResult = {
            assigned: true,
            driverId: String(bookedDriver._id),
            distanceMeters: candidate.distanceMeters,
          };
          return bookedResult;
        });
      } finally {
        await session.endSession();
      }

      if (result) {
        await this.paymentTimeoutQueue.schedule(String(order._id), paymentDeadlineMinutes);
        await this.notificationsService.notify({
          companyId: order.companyId,
          recipientUserId: result.driverId!,
          type: NotificationType.ORDER_ASSIGNED,
          orderId: order._id as Types.ObjectId,
        });
        return result;
      }
    }

    await this.notifyNoDriverAvailable(order);
    return { assigned: false, reason: 'NO_ELIGIBLE_DRIVER' };
  }

  /**
   * Single index-served, distance-sorted candidate query (FR-011, R8). $near
   * cannot follow a $lookup, so trucks are denormalized onto the driver
   * document (data-model.md) — this is why capacity/fuelType can live in the
   * same $geoNear `query` pre-filter as availability, in one pass. The
   * tenant plugin auto-inserts a $match immediately after $geoNear (verified
   * in tenant-scope.plugin.spec.ts), so company scoping needs no explicit
   * filter here. Results are plain objects (aggregate, not hydrated
   * documents) but retain `_id` and every filtered field.
   */
  protected findCandidates(
    _companyId: string,
    quantityLiters: number,
    fuelType: string,
    deliveryCoordinates: [number, number],
  ): Promise<Array<UserDocument & { distanceMeters?: number }>> {
    return this.userModel.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: deliveryCoordinates },
          distanceField: 'distanceMeters',
          spherical: true,
          query: {
            role: UserRole.DRIVER,
            isActive: true,
            isOnline: true,
            isAvailable: true,
            activeOrderId: { $exists: false },
            'truck.maxCapacityLiters': { $gte: quantityLiters },
            'truck.fuelTypes': fuelType,
          },
        },
      },
    ]);
  }

  private async notifyNoDriverAvailable(order: OrderDocument): Promise<void> {
    const admins = await this.userModel
      .find({ companyId: order.companyId, role: UserRole.COMPANY_ADMIN, isActive: true })
      .exec();
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId: order.companyId,
          recipientUserId: admin._id as Types.ObjectId,
          type: NotificationType.NO_DRIVER_AVAILABLE,
          orderId: order._id as Types.ObjectId,
        }),
      ),
    );
    this.logger.warn(`No eligible driver for order ${order._id}`);
  }
}
