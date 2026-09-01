import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { startOfDayInTimezone } from '../../common/utils/day-boundary.util';

export interface DriverSummary {
  /** Omitted entirely when the driver has never been rated (FR-031) — never `0`/`null`. */
  ratingAverage?: number;
  ratingCount: number;
  deliveriesToday: number;
  readyForWork: boolean;
}

@Injectable()
export class DriversService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly config: ConfigService,
  ) {}

  async summaryFor(driverId: string): Promise<DriverSummary> {
    const driver = await this.userModel.findById(driverId).exec();
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const timezone = this.config.get<string>('platform.dayBoundaryTimezone') ?? 'Asia/Riyadh';
    const startOfDay = startOfDayInTimezone(new Date(), timezone);

    // spec 007 T068/research R8: DELIVERED via the normal OTP flow and via
    // an admin `forceComplete` override both set `deliveredAt` identically
    // (order-state.service.ts) — an override-completed delivery counts
    // toward the driver's day exactly like any other.
    const deliveriesToday = await this.orderModel
      .countDocuments({
        driverId: driver._id,
        status: OrderStatus.DELIVERED,
        deliveredAt: { $gte: startOfDay },
      })
      .exec();

    return {
      ...(driver.ratingAverage !== undefined ? { ratingAverage: driver.ratingAverage } : {}),
      ratingCount: driver.ratingCount ?? 0,
      deliveriesToday,
      // spec 007 FR-035/T069: the same predicate DispatchService.findCandidates
      // filters candidates on — never a second, independently-set duty flag
      // that could drift from actual dispatch eligibility.
      readyForWork: Boolean(
        driver.isActive && driver.isOnline && driver.isAvailable && !driver.activeOrderId,
      ),
    };
  }
}
