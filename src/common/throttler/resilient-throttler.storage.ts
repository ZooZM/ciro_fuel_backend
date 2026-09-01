import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

/**
 * Rate-limit counters that survive Redis — spec 012 FR-061, FR-061a–c.
 *
 * ---
 * **Why this wrapper exists, which is the most important thing in this file.**
 *
 * Story 9 makes Redis load-bearing for five subsystems at once: BullMQ queues,
 * cache, throttler counters, scheduler leases and socket fan-out. Clarification
 * Q7 deliberately keeps a Redis-less instance IN rotation — readiness reports
 * Redis but never disqualifies on it — precisely so a Redis outage degrades the
 * platform instead of emptying the upstream.
 *
 * That decision is only sound if every one of the five degrades gracefully, and
 * **the shared throttler store does not**. `ThrottlerStorageRedisService` fails
 * CLOSED: a storage error propagates out of the guard, and the guard is global,
 * so that is a 500 on EVERY REQUEST ON THE PLATFORM. Redis would have become a
 * harder dependency than MongoDB, and the decision taken to prevent a total
 * outage would have been its cause.
 *
 * ---
 * **Why it does not simply fail open.** Falling through to "allow everything"
 * would strip brute-force protection from login, refresh and the OTP paths at
 * exactly the moment the platform is already degraded and least able to absorb
 * it. So the fallback still LIMITS (FR-061b), with a per-instance in-memory
 * counter: the effective budget becomes N× the configured limit across N
 * instances — bounded, not absent. With two replicas that is 2× for the
 * duration of the outage, which is a real and acceptable loosening; unbounded
 * is not.
 *
 * Entering and leaving the fallback is recorded (FR-061c), so a period of
 * degraded limiting is identifiable afterwards rather than invisible.
 */
@Injectable()
export class ResilientThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(ResilientThrottlerStorage.name);
  private degraded = false;

  /** Per-instance fallback counters, touched only while the shared store is unreachable. */
  private readonly local = new Map<string, { totalHits: number; expiresAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly shared: ThrottlerStorage) {
    // The fallback map is written only during an outage, but its entries
    // outlive one — without eviction a long-running process accumulates one per
    // tracker key seen while degraded, which for an address-keyed limiter is
    // unbounded.
    this.sweeper = setInterval(() => this.evictExpired(), 60_000);
    this.sweeper.unref();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const record = await this.shared.increment(key, ttl, limit, blockDuration, throttlerName);
      this.leaveFallback();
      return record;
    } catch (err) {
      this.enterFallback(err);
      return this.incrementLocally(key, ttl, limit, blockDuration);
    }
  }

  /**
   * The same arithmetic the shared store performs, against a local map.
   *
   * `ttl` and `blockDuration` arrive in MILLISECONDS from the module options,
   * while the returned record's `timeToExpire`/`timeToBlockExpire` are SECONDS
   * — the guard divides nothing, it renders them straight into `Retry-After`.
   * Getting that unit wrong yields a plausible-looking header off by a factor
   * of a thousand.
   */
  private incrementLocally(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): ThrottlerStorageRecord {
    const now = Date.now();
    const existing = this.local.get(key);
    const live = existing && existing.expiresAt > now ? existing : undefined;
    const entry = live
      ? { totalHits: live.totalHits + 1, expiresAt: live.expiresAt }
      : { totalHits: 1, expiresAt: now + ttl };

    const isBlocked = entry.totalHits > limit;
    if (isBlocked && !live) {
      entry.expiresAt = now + blockDuration;
    }
    this.local.set(key, entry);

    const remainingMs = entry.expiresAt - now;
    return {
      totalHits: entry.totalHits,
      timeToExpire: Math.ceil(remainingMs / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(remainingMs / 1000) : 0,
    };
  }

  private enterFallback(err: unknown): void {
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    // FR-061c. Recorded once, on the transition, not per request: at the
    // platform's request rate, logging a Redis outage per request IS a second
    // outage, in the log budget.
    this.logger.error(
      { err, event: 'throttler.fallback.entered' },
      'Shared rate-limit store unreachable — falling back to PER-INSTANCE counting; ' +
        'the effective budget is now N× the configured limit across N instances',
    );
  }

  private leaveFallback(): void {
    if (!this.degraded) {
      return;
    }
    this.degraded = false;
    // Local counters are DROPPED, not merged. Merging would double-count hits
    // other instances already recorded in Redis, and the two are not
    // reconcilable anyway — the shared store is authoritative again the moment
    // it answers.
    this.local.clear();
    this.logger.warn(
      { event: 'throttler.fallback.left' },
      'Shared rate-limit store reachable again — counters are cross-instance once more',
    );
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.local) {
      if (entry.expiresAt <= now) {
        this.local.delete(key);
      }
    }
  }

  /**
   * Clears every rate-limit counter — local and shared.
   *
   * Exists for the e2e suites, which drive several rate-limited endpoints in
   * sequence and must not have one test's requests exhaust the next test's
   * budget. Before spec 012 they reached into `ThrottlerStorageService.storage`
   * (a plain `Map`) and called `.clear()`; with counters in Redis there is no
   * such map, so the capability has to be offered deliberately rather than
   * reached into.
   *
   * SCANs a narrow pattern instead of flushing: the throttler shares its Redis
   * database with BullMQ queues, the cache and the scheduler leases, and a
   * `flushdb` here would delete scheduled payment timeouts and assignment
   * escalations along with the counters.
   */
  async reset(): Promise<void> {
    this.local.clear();

    const redis = (this.shared as { redis?: { scan: unknown; del: unknown } }).redis;
    if (!redis) {
      return;
    }
    const client = redis as {
      scan: (cursor: string, ...args: string[]) => Promise<[string, string[]]>;
      del: (...keys: string[]) => Promise<number>;
    };

    let cursor = '0';
    do {
      // `{…}` is the store's own hash-tag key shape (`{<key>:<name>}:hits` /
      // `:blocked`), which is what keeps this from matching anything else in
      // the database.
      const [next, keys] = await client.scan(cursor, 'MATCH', '{*}:*', 'COUNT', '500');
      cursor = next;
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } while (cursor !== '0');
  }

  /** True while counting per-instance. Reported in the readiness body (FR-063b). */
  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * FR-011: connections are closed deliberately on shutdown.
   *
   * Two things here, both found by test rather than reasoned about up front.
   *
   * **Forwarding is required.** The wrapped store is constructed with `new`
   * inside a factory, so it is NOT a Nest provider and Nest never calls ITS
   * lifecycle hook — only this wrapper's. Without the forward, the store's
   * ioredis connection outlives `app.close()`: a process that will not exit,
   * and in production a connection graceful shutdown was supposed to have
   * closed.
   *
   * **`onApplicationShutdown`, not `onModuleDestroy`.** Nest's `close()` runs
   * `callDestroyHook()` BEFORE `dispose()`, so a destroy hook here disconnects
   * the client while the HTTP server is still accepting requests — and every
   * request touches this store. Any command in flight is then rejected with
   * "Connection is closed" as an unhandled rejection during teardown. This
   * phase runs after `dispose()`, when nothing can still be counting.
   */
  onApplicationShutdown(): void {
    clearInterval(this.sweeper);
    const inner = this.shared as Partial<OnModuleDestroy>;
    inner.onModuleDestroy?.();
  }
}
