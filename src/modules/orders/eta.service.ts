import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { OrderDocument } from './schemas/order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { haversineDistanceMeters } from '../../common/utils/geo.util';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { GeoPoint } from '../../common/schemas/geo-point.schema';

const MINUTES_PER_HOUR = 60;
const METERS_PER_KM = 1000;

/**
 * spec 004 FR-029: an estimated arrival time derived from the assigned
 * driver's last known position and the order's destination — computed live
 * on read (never stored/snapshotted, unlike `driverSummary`), since the
 * driver's position keeps changing after assignment. Omitted — never
 * fabricated — whenever there is no assigned driver, or that driver has no
 * location on file yet (e.g. hasn't connected to `/tracking` since being
 * assigned).
 */
@Injectable()
export class EtaService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The ETA and the position it was derived from, in one driver read.
   *
   * The position is disclosed (spec 005) because the client's tracking map
   * otherwise has nothing to draw until the driver's next `location:update`
   * reaches it over the socket — and the gateway throttles those to 50m of
   * movement or a 3-minute heartbeat, so a client opening the screen could
   * face a blank map for minutes while the platform already knew exactly
   * where the truck was. This grants no new visibility: the same position
   * is already streamed to whoever is authorized to watch the order.
   */
  async driverTelemetry(
    order: OrderDocument,
  ): Promise<{ etaMinutes?: number; driverLocation?: GeoPoint; driverLocationAt?: Date }> {
    if (!order.driverId) {
      return {};
    }
    // The viewer (client, Fuel Company admin) is legitimately in a
    // DIFFERENT tenant than the driver, who belongs to the Transportation
    // Company (User stays single-tenant, plan.md §1) — the same cross-tenant
    // read gap `NotificationsService.notify()` hit for writes. `driverId` is
    // itself only reachable via an order the caller was already authorized
    // to see, so this unscoped lookup grants no new access.
    const driver = await this.tenantContext.runUnscoped(() =>
      this.userModel.findById(order.driverId).exec(),
    );
    if (!driver?.location) {
      return {};
    }

    const distanceMeters = haversineDistanceMeters(
      driver.location.coordinates as [number, number],
      order.deliveryLocation.coordinates as [number, number],
    );
    const averageSpeedKmh = this.config.get<number>('order.averageSpeedKmh') ?? 60;
    const minutes = (distanceMeters / METERS_PER_KM / averageSpeedKmh) * MINUTES_PER_HOUR;
    // spec 011 FR-017a: the position's AGE travels with it. Without this a
    // viewer cannot tell a truck that stopped reporting from one parked at
    // exactly this spot — the map draws the same dot either way, and the
    // stale one is the case that matters.
    return {
      etaMinutes: Math.round(minutes),
      driverLocation: driver.location,
      driverLocationAt: driver.locationUpdatedAt,
    };
  }

  /** Kept for the list endpoint, which needs the estimate but has no map to
   * draw — one driver read per order either way. */
  async computeEtaMinutes(order: OrderDocument): Promise<number | undefined> {
    return (await this.driverTelemetry(order)).etaMinutes;
  }
}
