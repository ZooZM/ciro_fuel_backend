import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { ErrorCode } from '../../../common/enums/error-code.enum';

const K = {
  rate: (phone: string) => `login-otp:rate:${phone}`,
  fails: (phone: string) => `login-otp:fails:${phone}`,
  blocked: (phone: string) => `login-otp:blocked:${phone}`,
  rlHits: (phone: string) => `login-otp:rlhits:${phone}`,
};

/**
 * spec 015 US3 — the four Redis key families that keep the passwordless
 * sign-in endpoints safe to expose (data-model.md §3).
 *
 * Two decisions carried from research:
 *
 * - **Keyed on the SUBMITTED phone string, before any account lookup**
 *   (research R8 / FR-027). Keying on a resolved `userId` would apply the
 *   limit only to numbers that exist, making the limit itself the
 *   enumeration oracle — the trap `PasswordResetService.checkRateLimit`
 *   already avoids and comments.
 *
 * - **Every counter operation FAILS CLOSED** (FR-030). A Redis error refuses
 *   the request with `503`. This knowingly differs from spec 012's Q7
 *   throttler fallback (which fails open into per-instance counting): there
 *   the blast radius is every request on the platform, so a cache outage
 *   erroring everything turns a degradation into a total outage. Here the
 *   blast radius is two endpoints, and these counters are the ONLY thing
 *   bounding six-digit code guessing — failing open would strip brute-force
 *   protection from an unauthenticated credential endpoint at exactly the
 *   moment the platform is already degraded.
 */
@Injectable()
export class LoginAbuseService {
  private readonly logger = new Logger(LoginAbuseService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  private cfg(key: string, fallback: number): number {
    return this.config.get<number>(key) ?? fallback;
  }

  /** Wrap every Redis call: any failure becomes a 503, never a silent pass. */
  private async closed<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      this.logger.error(
        `login-otp counter store unavailable — failing closed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException('Sign-in is temporarily unavailable');
    }
  }

  private rateLimited(ttl: number): never {
    // FR-022 — and FR-025's block refusal is DELIBERATELY byte-identical to
    // this one (see `assertNotBlocked`): distinguishing "rate limited" from
    // "blocked" tells an attacker which wall they hit.
    throw new HttpException(
      {
        error: ErrorCode.LOGIN_RATE_LIMITED,
        message: 'Too many requests — please wait before trying again',
        retryAfterSeconds: Math.max(1, ttl),
      },
      429,
    );
  }

  /**
   * Refuse if the number is under a temporary cross-code block (FR-025).
   * Called by BOTH endpoints. The refusal is indistinguishable from the
   * request-rate refusal.
   */
  async assertNotBlocked(phone: string): Promise<void> {
    const ttl = await this.closed(() => this.redis.ttl(K.blocked(phone)));
    if (ttl > 0) {
      this.rateLimited(ttl);
    }
  }

  /**
   * Count this code request against the per-phone window (FR-021/022).
   * Returns nothing on success; throws `429` when the window is exceeded,
   * and separately increments a "rate-limited hits" counter that
   * `challengeRequired` reads.
   */
  async registerCodeRequest(phone: string): Promise<void> {
    // The caller checks `assertNotBlocked` first (both endpoints do).
    const windowSeconds = this.cfg('loginOtp.windowMinutes', 15) * 60;
    const maxRequests = this.cfg('loginOtp.maxRequests', 3);

    const count = await this.closed(async () => {
      const n = await this.redis.incr(K.rate(phone));
      if (n === 1) {
        await this.redis.expire(K.rate(phone), windowSeconds);
      }
      return n;
    });

    if (count > maxRequests) {
      await this.closed(async () => {
        const n = await this.redis.incr(K.rlHits(phone));
        if (n === 1) {
          await this.redis.expire(K.rlHits(phone), windowSeconds);
        }
      });
      const ttl = await this.closed(() => this.redis.ttl(K.rate(phone)));
      this.rateLimited(ttl);
    }
  }

  /**
   * FR-023 — a proof-of-work challenge is demanded once a number has been
   * rate-limited `loginOtp.challengeAfter` times in the window.
   */
  async challengeRequired(phone: string): Promise<boolean> {
    const after = this.cfg('loginOtp.challengeAfter', 2);
    const hits = await this.closed(() => this.redis.get(K.rlHits(phone)));
    return Number(hits ?? 0) >= after;
  }

  /**
   * FR-025 — a failed verification counts across SEPARATELY issued codes
   * (which is why this lives in Redis, not on the TTL-deleted `LoginCode`
   * record — research R8). Crossing `loginOtp.failThreshold` sets a
   * temporary block that self-expires after `loginOtp.blockMinutes`
   * (FR-026), with no operator action.
   */
  async recordVerificationFailure(phone: string): Promise<void> {
    const blockSeconds = this.cfg('loginOtp.blockMinutes', 60) * 60;
    const threshold = this.cfg('loginOtp.failThreshold', 10);

    const fails = await this.closed(async () => {
      const n = await this.redis.incr(K.fails(phone));
      if (n === 1) {
        await this.redis.expire(K.fails(phone), blockSeconds);
      }
      return n;
    });

    if (fails >= threshold) {
      await this.closed(() => this.redis.set(K.blocked(phone), '1', 'EX', blockSeconds));
    }
  }

  /** FR-029 — a successful sign-in clears the number's rate and failure counters. */
  async clearOnSuccess(phone: string): Promise<void> {
    await this.closed(() =>
      this.redis.del(K.rate(phone), K.fails(phone), K.rlHits(phone), K.blocked(phone)),
    );
  }
}
