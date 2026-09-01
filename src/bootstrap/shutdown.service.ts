import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

/**
 * The drain gate (spec 012 Story 2, FR-005/FR-012).
 *
 * Holds one process-wide flag that `GET /health/ready` reads. It exists as a
 * separate thing from Nest's own shutdown hooks because ORDERING matters and
 * Nest does not guarantee it:
 *
 *   readiness must go negative BEFORE the server stops accepting connections,
 *
 * so the proxy removes this instance from rotation while it is still able to
 * serve the requests already in flight. `OnApplicationShutdown` fires after
 * Nest has begun tearing down, which is far too late — by then the instance is
 * already refusing work it never told anyone it would refuse.
 *
 * So the flag is set by a signal handler registered in `configureApp`, before
 * `app.close()` is invoked at all.
 */
@Injectable()
export class ShutdownService {
  private readonly logger = new Logger(ShutdownService.name);
  private draining = false;
  private drainStartedAt?: number;

  constructor(private readonly scheduler: SchedulerRegistry) {}

  /** True once a termination signal has been received. */
  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Flips the gate. Idempotent: a second SIGTERM (impatient operator, or an
   * orchestrator escalating) must not restart the clock or re-log.
   */
  beginDraining(signal: string): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    this.drainStartedAt = Date.now();
    this.logger.log(
      `Received ${signal}: readiness is now negative; draining in-flight work before exit`,
    );
    this.stopScheduledWork();
  }

  /**
   * Cancels every scheduled sweep so none STARTS during the drain — spec 012
   * FR-009/FR-012.
   *
   * The same principle as BullMQ workers ceasing to fetch: draining means
   * finishing what is in flight, not beginning more. Without this, a sweep
   * firing in the drain window has its Mongo connection closed underneath it by
   * `callDestroyHook()`, the driver reports
   * `MongoClientClosedError: Operation interrupted because client was closed`,
   * and `app.close()` REJECTS — so `configureApp`'s handler takes its failure
   * branch and exits 1, recording a perfectly clean drain as a failed one.
   * FR-012 exists to make that distinction meaningful, and this is what keeps
   * it honest.
   *
   * `PresenceService`'s cron runs at second 0 of every minute, so on a busy
   * instance the odds of landing in the window are not small — it was found by
   * a test that failed roughly one run in three.
   *
   * A sweep already RUNNING is left to finish; cancelling one mid-write is the
   * thing being avoided, not the goal.
   */
  private stopScheduledWork(): void {
    try {
      for (const [, job] of this.scheduler.getCronJobs()) {
        job.stop();
      }
      // Both kinds: `PresenceService` uses a static `@Cron`, while
      // `StopDetectionService` registers a runtime interval so its period stays
      // configurable. Stopping only one of them would leave the other sweeping
      // into a closing connection.
      for (const name of this.scheduler.getIntervals()) {
        clearInterval(this.scheduler.getInterval(name));
        this.scheduler.deleteInterval(name);
      }
    } catch (err) {
      // Never allowed to derail the shutdown it is part of.
      this.logger.warn(`Could not stop all scheduled work during drain: ${String(err)}`);
    }
  }

  /** Milliseconds since draining began, for the exit record. */
  drainElapsedMs(): number {
    return this.drainStartedAt ? Date.now() - this.drainStartedAt : 0;
  }
}
