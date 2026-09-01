import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { SweepName } from './sweep-names.const';

/**
 * Scheduler arbitration — spec 012 FR-056b/FR-057/FR-058.
 *
 * The problem it solves: `@Cron` fires on EVERY instance. With two replicas,
 * both sweeps run twice per interval — which for stop detection means the same
 * stalled delivery can raise two alerts, and for presence means two identical
 * writes. The deployment supplies no orchestration, so the arbitration has to
 * live here.
 *
 * `SET key token NX PX ttl` — one atomic operation that acquires only if
 * absent AND sets an expiry in the same round trip. The two-step alternative
 * (SETNX then EXPIRE) can crash between them and leave a lease that never
 * expires, which is a sweep that never runs again on any instance until someone
 * notices, and nothing would notice.
 *
 * The token is unique per acquisition, and release is a compare-and-delete
 * script rather than a bare DEL: without that, a holder whose lease had already
 * expired would delete the lease a DIFFERENT instance now legitimately holds,
 * so two instances would sweep concurrently at exactly the moment the mechanism
 * was supposed to prevent it.
 *
 * ---
 *
 * ⚠ **THIS IS AT-MOST-ONCE, NOT EXACTLY-ONCE, AND THAT IS THE DESIGN** (T089).
 *
 * A lease is not a distributed lock and cannot be made into one. If a holder
 * pauses — GC, a stalled disk, a hypervisor freeze — for longer than the TTL,
 * the lease expires while it still believes it holds it, another instance
 * acquires, and both run. Redis's own failover can lose an unreplicated write
 * and produce the same outcome.
 *
 * Correctness therefore rests on **the sweeps being idempotent**, which they
 * independently are (T093/T094) — not on this service. If a future sweep is
 * added whose double execution would be harmful, taking a lease is NOT
 * sufficient protection for it; that sweep needs a conditional write of its own,
 * the way `stop-escalation.processor.ts` folds `escalatedAt: null` into the
 * update that stamps it.
 *
 * The TTL must sit **above the p99 sweep duration and below the sweep interval**
 * (FR-056b): too low and a slow-but-healthy holder loses its lease mid-run to a
 * second instance; too high and a dead holder's lease outlives the next tick, so
 * a sweep is silently skipped. Measured against production data volume is a
 * pre-launch item (operations-contract §7 item 8), because a laptop's p99 is not
 * the platform's.
 */
@Injectable()
export class SchedulerLeaseService {
  private readonly logger = new Logger(SchedulerLeaseService.name);
  private readonly ttlMs: number;
  private readonly enabled: boolean;

  /**
   * Compare-and-delete. Reading the value and then deleting it in two commands
   * would race: between the read and the delete the lease can expire and be
   * taken by someone else, and the delete would then release THEIR lease.
   */
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.ttlMs = config.get<number>('scheduler.leaseTtlMs')!;
    // A single-instance deployment, a developer machine, or a suite that wants
    // the sweep to run unconditionally can turn arbitration off. It defaults ON,
    // because the failure of forgetting to enable it (duplicate sweeps in
    // production) is worse than the failure of forgetting to disable it (a
    // sweep that needs Redis on a machine that has it anyway).
    this.enabled = config.get<boolean>('scheduler.leaseEnabled') ?? true;
  }

  /**
   * Runs `work` only if this instance wins the lease for `sweep`.
   *
   * Returns whether it ran, so a caller can distinguish "did the work" from
   * "another instance is doing it" — which matters for the FR-058a stall alert:
   * the `sweep.completed` record must be emitted by whoever actually ran, and
   * exactly once per interval across the fleet.
   */
  async runExclusively(sweep: SweepName, work: () => Promise<void>): Promise<boolean> {
    if (!this.enabled) {
      await work();
      return true;
    }

    const key = `scheduler:lease:${sweep}`;
    const token = randomUUID();

    let acquired: string | null;
    try {
      acquired = await this.redis.set(key, token, 'PX', this.ttlMs, 'NX');
    } catch (err) {
      // Redis is unreachable. The sweep is SKIPPED rather than run unarbitrated:
      // running would mean every instance sweeping at once, which is the
      // condition this exists to prevent, and stop detection's alerts are
      // exactly the ones that must not be duplicated.
      //
      // Skipping is safe to choose here ONLY because the resulting silence is
      // alerted on — no `sweep.completed` for three intervals (FR-058a,
      // operations-contract §6). Without that alert this branch would be a
      // stalled delivery nobody hears about, which is the harm feature 011
      // exists to prevent.
      this.logger.error({ sweep, err }, 'Could not reach the lease store; skipping this sweep');
      return false;
    }

    if (acquired !== 'OK') {
      return false;
    }

    try {
      await work();
      return true;
    } finally {
      // Released rather than left to expire, so the NEXT interval is contested
      // fairly instead of being guaranteed to this instance for the remainder
      // of the TTL. Failure to release is not an error: the expiry is the
      // backstop and it always applies.
      try {
        await this.redis.eval(SchedulerLeaseService.RELEASE_SCRIPT, 1, key, token);
      } catch (err) {
        this.logger.warn({ sweep, err }, 'Lease release failed; falling back to its expiry');
      }
    }
  }
}
