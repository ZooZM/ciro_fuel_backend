import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { Public } from '../../common/decorators/public.decorator';
import { ShutdownService } from '../../bootstrap/shutdown.service';
import { ResilientThrottlerStorage } from '../../common/throttler/resilient-throttler.storage';

interface LivenessResponse {
  status: 'ok';
  instanceId: string;
  uptimeSeconds: number;
}

type IndicatorEntry = { status: 'up' } | { status: 'down'; message?: string };

/**
 * The two signals a monitor, a proxy or a deploy script can ask for.
 *
 * Both are `@Public()` (no token, no tenant context) and `@SkipThrottle()`: a
 * monitor polling every few seconds must never be refused, never consume a
 * rate-limit budget, and never affect anyone else's (FR-004).
 *
 * Neither discloses tenant data, configuration values, secrets or internal
 * topology (FR-007). `instanceId` is an opaque label for correlating with log
 * records — not a hostname or an address.
 */
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly config: ConfigService,
    private readonly shutdown: ShutdownService,
    private readonly throttlerStorage: ResilientThrottlerStorage,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Is this process running? Nothing more.
   *
   * Deliberately performs NO dependency checks (FR-003). A liveness probe wired
   * to dependency health makes an orchestrator *restart* an instance whose own
   * process is perfectly fine — turning a database incident into a restart storm
   * on top of a database incident. Liveness answers "should I be killed";
   * readiness answers "should I be sent traffic". Do not merge them.
   */
  @Get('live')
  @Public()
  @SkipThrottle()
  live(): LivenessResponse {
    return {
      status: 'ok',
      instanceId: this.instanceId(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  /**
   * Should a proxy send this instance traffic right now?
   *
   * MongoDB is the ONLY disqualifying dependency (Clarification Q7). Redis is
   * checked and reported but never changes the verdict — see `withRedisReported`
   * below, whose comment exists specifically to stop someone "fixing" that.
   */
  @Get('ready')
  @Public()
  @SkipThrottle()
  @HealthCheck()
  async ready(): Promise<HealthCheckResult & { instanceId: string }> {
    const timeout = this.config.get<number>('health.timeoutMs') ?? 1000;
    const redis = await this.redisStatus();

    // Draining short-circuits everything else (FR-005). An instance on its way
    // out must leave the rotation BEFORE it stops accepting connections, no
    // matter how healthy its dependencies still are — the whole point is to
    // stop new work arriving while the in-flight work finishes. Checked before
    // the Terminus check so a draining instance never waits on a database ping
    // to say what it already knows.
    if (this.shutdown.isDraining()) {
      throw new ServiceUnavailableException({
        status: 'error',
        info: {},
        error: { shutdown: { status: 'down', message: 'draining' } },
        details: { shutdown: { status: 'down', message: 'draining' }, redis },
        instanceId: this.instanceId(),
      });
    }

    // `pingCheck` pings over the EXISTING connection rather than opening its
    // own, so health checking cannot starve the pool request traffic needs
    // (FR-006a). The explicit timeout is what stops a slow primary leaving the
    // probe outstanding — a readiness endpoint that hangs is indistinguishable,
    // to a proxy, from an instance that has failed (FR-006).
    const result = await this.health.check([() => this.mongoose.pingCheck('mongodb', { timeout })]);

    return this.withRedisReported(result, redis);
  }

  /**
   * Redis reachability, bounded by the same timeout as every other check and
   * never allowed to throw — this must not be able to fail the readiness call.
   */
  private async redisStatus(): Promise<IndicatorEntry> {
    const timeout = this.config.get<number>('health.timeoutMs') ?? 1000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeout);
        timer.unref();
      });
      await Promise.race([this.redis.ping(), expiry]);
      return { status: 'up' };
    } catch (err) {
      return { status: 'down', message: err instanceof Error ? err.message : 'unreachable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Folds Redis into the response body WITHOUT letting it touch the verdict.
   *
   * ⚠ A 200 alongside a `down` entry in `error` is DELIBERATE, and it is the
   * entire point of Clarification Q7. Redis loss degrades specific capabilities
   * — queued work stalls, cross-instance realtime delivery is impaired, rate
   * limiting falls back to per-instance counting — but it does not stop this
   * instance answering a request. Disqualifying on it would take EVERY instance
   * out of rotation at the same instant and leave the proxy with an empty
   * upstream: a partial degradation converted into a total outage.
   *
   * Monitoring reads `error`. The proxy reads the status code. They are
   * different consumers, and this response answers both.
   *
   * Do NOT reconcile the apparent disagreement by making them consistent. If
   * Redis must ever become disqualifying, that needs the grace-period design
   * (spec Q7 option D), not a one-line change here.
   */
  private withRedisReported(
    result: HealthCheckResult,
    redis: IndicatorEntry,
  ): HealthCheckResult & { instanceId: string } {
    const up = redis.status === 'up';

    /**
     * spec 012 FR-063/FR-063a/FR-063b — the two Redis-backed capabilities whose
     * loss is otherwise INVISIBLE from outside, surfaced here because nothing
     * else can surface them:
     *
     * · `rateLimiting` — degraded means counters fell back to per-instance
     *   (FR-061b), so the effective budget is N× the configured limit. Requests
     *   still succeed, so no error rate moves and no request fails; without this
     *   field a period of loosened limiting leaves no external trace at all.
     *
     * · `realtimeFanout` — this is the one that CANNOT fail open. If the socket
     *   adapter is down, events still reach the emitting instance's own clients,
     *   so from that instance's vantage point delivery is indistinguishable from
     *   success: no error, no exception, no failed request. It is inferred from
     *   Redis reachability, which is the only signal available, and it is why
     *   the sweep-stall alert (operations-contract §6) exists as a separate
     *   safety net rather than relying on detection here.
     *
     * All of this is REPORTED and none of it is disqualifying — same reasoning
     * as Redis itself (Q7), and it lands in `info`/`error` alongside it so a
     * monitor reads one body. The proxy reads the status code; monitoring reads
     * the fields. Different consumers, one response.
     */
    const rateLimiting: IndicatorEntry = this.throttlerStorage.isDegraded()
      ? { status: 'down', message: 'per-instance fallback: effective budget is N× the limit' }
      : { status: 'up' };
    const realtimeFanout: IndicatorEntry = up
      ? { status: 'up' }
      : { status: 'down', message: 'events may not reach clients on other instances' };

    const degraded: Record<string, IndicatorEntry> = {
      ...(up ? {} : { redis }),
      ...(rateLimiting.status === 'up' ? {} : { rateLimiting }),
      ...(realtimeFanout.status === 'up' ? {} : { realtimeFanout }),
    };
    const healthy: Record<string, IndicatorEntry> = {
      ...(up ? { redis } : {}),
      ...(rateLimiting.status === 'up' ? { rateLimiting } : {}),
      ...(realtimeFanout.status === 'up' ? { realtimeFanout } : {}),
    };

    return {
      ...result,
      info: { ...(result.info ?? {}), ...healthy },
      error: { ...(result.error ?? {}), ...degraded },
      details: { ...result.details, redis, rateLimiting, realtimeFanout },
      instanceId: this.instanceId(),
    };
  }

  private instanceId(): string {
    return this.config.get<string>('health.instanceId') || 'unknown';
  }
}
