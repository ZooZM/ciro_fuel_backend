import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { UserRole } from '../../../common/enums/user-role.enum';
import { SchedulerLeaseService } from '../../../common/scheduler/scheduler-lease.service';
import { SWEEP_NAMES } from '../../../common/scheduler/sweep-names.const';

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
    private readonly lease: SchedulerLeaseService,
  ) {}

  /** Called on every driver signal (handshake, accepted or below-threshold location frame). */
  async touch(driverId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: driverId }, { $set: { isOnline: true, lastSeenAt: new Date() } })
      .exec();
  }

  /**
   * spec 012 FR-056b: `@Cron` fires on EVERY instance, so with two replicas
   * this ran twice per interval. Guarded by a fleet-wide lease keyed by sweep
   * name — exactly one instance sweeps per tick, and if that instance dies the
   * lease expires and another takes the next one, with no operator action.
   *
   * The lease is at-most-once, not exactly-once (see `SchedulerLeaseService`),
   * so it is not what makes this safe — `runExclusively` returning false is a
   * normal outcome, and a double run must remain harmless. See the idempotency
   * note on the update below (T093).
   */
  @Cron('*/60 * * * * *') // every 60s (research R6a) — overridable via config for tests
  async sweepOfflineDrivers(): Promise<void> {
    await this.lease.runExclusively(SWEEP_NAMES.PRESENCE_OFFLINE, () => this.markSilentDriversOffline());
  }

  private async markSilentDriversOffline(): Promise<void> {
    const thresholdMinutes = this.config.get<number>('presence.offlineThresholdMinutes') ?? 6;
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);

    // IDEMPOTENT BY CONSTRUCTION (spec 012 T093), and unchanged by this feature.
    // One `updateMany` whose filter (`isOnline: true`) is falsified by its own
    // effect (`isOnline: false`): a second concurrent run matches nothing and
    // writes nothing. Two instances racing here produce the same end state as
    // one, so a lapsed lease costs a redundant query and nothing else.
    //
    // Do not add a read-then-write step. The moment "find the silent drivers"
    // and "mark them offline" become separate operations, two runs can both
    // read the same set and the property above is gone.
    const result = await this.userModel
      .updateMany(
        { role: UserRole.DRIVER, isOnline: true, lastSeenAt: { $lt: cutoff } },
        { $set: { isOnline: false } },
      )
      .exec();

    // FR-058a's alert has nothing to observe without this. Redis being
    // unreachable no longer takes instances out of rotation (Q7), so a Redis
    // outage stalls every leased sweep while the platform keeps serving and
    // reporting itself healthy — a silence that nothing else surfaces. The
    // alert is "no `sweep.completed` for this sweep within three intervals"
    // (operations-contract §6), so the record must be emitted by whoever
    // actually ran, at `info` so a production level of `info` still sees it.
    this.logger.log(
      { sweep: SWEEP_NAMES.PRESENCE_OFFLINE, event: 'sweep.completed', affected: result.modifiedCount },
      'sweep.completed',
    );
  }
}
