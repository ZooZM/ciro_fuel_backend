import { ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * The platform-wide rate limiter (spec 012 Story 4, FR-021 – FR-027).
 *
 * Two problems it fixes, and one trap it avoids.
 *
 * ── Problem 1: behind a proxy, every request looks like it came from the same
 * place. `app.set('trust proxy', …)` in `configureApp` restores the real client
 * address, so `req.ip` is the client rather than nginx.
 *
 * ── Problem 2: an address is the wrong key for an authenticated user anyway.
 * One user can dodge their own limit by changing networks, and everyone in one
 * office shares a bucket. So an authenticated request is counted against the
 * USER (FR-023).
 *
 * ── The trap, which is the whole reason this class exists rather than a
 * one-line `getTracker`:
 *
 * `common.module.ts` registers the throttler guard BEFORE `JwtAuthGuard`,
 * deliberately, with a comment explaining the order. So at the moment this
 * runs, **`req.user` does not exist yet**. A tracker written as
 * `req.user?.userId ?? req.ip` compiles, passes review, passes tests — and
 * silently keys every single request by address, having done nothing at all.
 *
 * Two ways out were rejected before this one:
 *
 *   · Reorder the guards so Jwt runs first. WORSE: a request bearing a
 *     malformed token would then be rejected by `JwtAuthGuard` before the
 *     throttler ever counted it, so an attacker bypasses rate limiting entirely
 *     by sending garbage tokens. That converts a rate-limit fix into a
 *     rate-limit removal.
 *
 *   · Decode the token without verifying, to read `sub` cheaply. WORSE STILL:
 *     the tracker key becomes attacker-controlled, so anyone could forge a
 *     `sub` and exhaust a named user's budget — a targeted denial of service
 *     introduced by the fix.
 *
 * So the signature is VERIFIED here. It is an HMAC over a short string, which
 * costs microseconds, and a failed verification simply falls through to the
 * address branch — where `JwtAuthGuard` will reject the request a moment later
 * anyway.
 */
@Injectable()
export class GlobalThrottlerGuard extends ThrottlerGuard {
  /**
   * The base class's three constructor arguments must be declared and passed
   * through explicitly. `UserThrottlerGuard` gets away with declaring no
   * constructor precisely because it inherits this signature; a subclass that
   * adds dependencies has to forward them, or it is detached from the module
   * options it needs to function.
   */
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = this.verifiedUserId(req);
    if (userId) {
      return `user:${userId}`;
    }
    // Unauthenticated (or unverifiable): fall back to the originating address.
    // `trust proxy` is what makes this the client rather than the proxy.
    return (req.ip as string) ?? 'unknown';
  }

  /**
   * Returns the subject of a *signature-verified* bearer token, or undefined.
   * Never trusts an unverified claim — see the class comment.
   */
  private verifiedUserId(req: Record<string, unknown>): string | undefined {
    const headers = req.headers as Record<string, string | undefined> | undefined;
    const auth = headers?.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return undefined;
    }
    try {
      const payload = this.jwtService.verify<JwtPayload>(auth.slice(7), {
        secret: this.configService.get<string>('jwt.secret'),
      });
      return payload.sub;
    } catch {
      // Expired, forged, or malformed — count it by address. The request is
      // about to be rejected by JwtAuthGuard regardless, and counting it under
      // an unverified identity is exactly the attack described above.
      return undefined;
    }
  }

  /**
   * The 429 body shape the platform already returns (FR-027), matching
   * `UserThrottlerGuard` exactly so no client sees a difference.
   */
  protected async throwThrottlingException(
    _context: ExecutionContext,
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
