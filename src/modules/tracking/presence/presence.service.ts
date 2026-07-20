import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { UserRole } from '../../../common/enums/user-role.enum';

/**
 * Presence is tracked separately from the tenant plugin: the sweep is a
 * single idempotent bulk update running with no AsyncLocalStorage context
 * (a background cron, not a request), so it must query across ALL
 * companies explicitly rather than relying on scoping — there is no "actor"
 * whose company it could be scoped to (FR-024, research R6a).
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly config: ConfigService,
  ) {}

  /** Called on every driver signal (handshake, accepted or below-threshold location frame). */
  async touch(driverId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: driverId }, { $set: { isOnline: true, lastSeenAt: new Date() } })
      .exec();
  }

  @Cron('*/60 * * * * *') // every 60s (research R6a) — overridable via config for tests
  async sweepOfflineDrivers(): Promise<void> {
    const thresholdMinutes = this.config.get<number>('presence.offlineThresholdMinutes') ?? 6;
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
    const result = await this.userModel
      .updateMany(
        { role: UserRole.DRIVER, isOnline: true, lastSeenAt: { $lt: cutoff } },
        { $set: { isOnline: false } },
      )
      .exec();
    if (result.modifiedCount > 0) {
      this.logger.debug(
        `Marked ${result.modifiedCount} driver(s) offline (silent > ${thresholdMinutes}m)`,
      );
    }
  }
}
