import { ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

/**
 * Phone verification's rate limits (spec 005 T098, data-model.md) are per
 * *user*, not per IP — the global `ThrottlerGuard` (`common.module.ts`)
 * tracks by IP, which would let one office network's users share a bucket
 * and let one user dodge their own limit by switching networks. Applied
 * per-route via `@UseGuards(UserThrottlerGuard)`, additively alongside the
 * global guard.
 *
 * `this.throttlers` (what `canActivate` loops over) is normally populated
 * in `onModuleInit()` from the injected `THROTTLER:MODULE_OPTIONS` token —
 * and every `ThrottlerGuard` subclass that doesn't redeclare a constructor
 * receives that *same* shared module-level options object via DI. So a
 * route decorated with `@Throttle({ default: {...} })` would be read by
 * BOTH this guard AND the globally-registered default `ThrottlerGuard`
 * (`common.module.ts`'s `APP_GUARD`), which would then also enforce that
 * same limit — just IP-tracked instead of user-tracked, defeating the
 * point. Overriding `onModuleInit` to hardcode a distinct 'perUser' profile
 * (never registered in `ThrottlerModule.forRootAsync`) keeps this guard's
 * throttler list disjoint from the global guard's — the global guard's own
 * `this.throttlers` only ever contains 'default', so it never looks up
 * 'perUser'-keyed `@Throttle` metadata at all.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  async onModuleInit(): Promise<void> {
    this.throttlers = [
      { name: 'perUser', ttl: 60_000, limit: 100, getTracker: this.getTracker.bind(this) },
    ];
    // The base class's own onModuleInit wires these two fallbacks onto
    // commonOptions — skipped here since we don't call super(), so
    // handleRequest's `generateKey(...)` call would otherwise be undefined.
    this.commonOptions = {
      getTracker: this.getTracker.bind(this),
      generateKey: this.generateKey.bind(this),
    };
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    return user?.userId ? `user:${user.userId}` : (req.ip as string);
  }

  /**
   * The contract (rest-api-delta.md §7) requires `retryAfterSeconds` in
   * the 429 body, not just a header — the default `ThrottlerException`
   * carries neither.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterSeconds = Math.max(1, Math.ceil(throttlerLimitDetail.timeToExpire));
    throw new HttpException(
      {
        statusCode: 429,
        message: 'Too many requests',
        error: 'ThrottlerException',
        retryAfterSeconds,
      },
      429,
    );
  }
}
