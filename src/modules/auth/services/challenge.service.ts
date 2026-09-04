import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

export interface Challenge {
  seed: string;
  difficultyBits: number;
}

/**
 * spec 015 research R7 — the abstraction the sign-in code flow depends on, so
 * the self-hosted proof-of-work here can be swapped for a third-party CAPTCHA
 * (Turnstile) as a single adapter, without touching a controller or
 * `LoginCodeService`.
 */
export interface ChallengeProvider {
  /** Mint a fresh single-use challenge. */
  issue(): Promise<Challenge>;
  /** True iff `nonce` solves `seed` and `seed` was still live (then consume it). */
  verify(seed: string, nonce: string): Promise<boolean>;
}

export const CHALLENGE_PROVIDER = Symbol('CHALLENGE_PROVIDER');

const powKey = (seed: string) => `login-otp:pow:${seed}`;

/** Leading zero BITS of a hex digest string. */
export function leadingZeroBits(hexDigest: string): number {
  let bits = 0;
  for (const ch of hexDigest) {
    const nibble = parseInt(ch, 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    // clz32 of a value in 1..15 is 28..31 → 0..3 zero bits inside the nibble.
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

/**
 * Self-hosted proof-of-work (research R7). The platform mints a random
 * single-use seed with a difficulty, holds it in Redis with a short TTL, and
 * the client must find a `nonce` (decimal string) such that
 * `sha256(seed + nonce)` has `difficultyBits` leading zero bits. Verified
 * once, then the seed is deleted so a solved challenge is not replayable.
 *
 * `LOGIN_POW_DIFFICULTY_BITS=0` disables the search (any nonce satisfies
 * zero bits) — the e2e environment's value, and the production escape hatch.
 */
@Injectable()
export class ChallengeService implements ChallengeProvider {
  private readonly logger = new Logger(ChallengeService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  async issue(): Promise<Challenge> {
    const difficultyBits = this.config.get<number>('loginOtp.pow.difficultyBits') ?? 18;
    const ttl = this.config.get<number>('loginOtp.pow.seedTtlSeconds') ?? 300;
    const seed = randomBytes(32).toString('hex');
    try {
      await this.redis.set(powKey(seed), String(difficultyBits), 'EX', ttl);
    } catch (err) {
      this.logger.error(
        `proof-of-work seed store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Sign-in is temporarily unavailable');
    }
    return { seed, difficultyBits };
  }

  async verify(seed: string, nonce: string): Promise<boolean> {
    let stored: string | null;
    try {
      stored = await this.redis.get(powKey(seed));
    } catch (err) {
      this.logger.error(
        `proof-of-work seed store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Sign-in is temporarily unavailable');
    }
    if (stored === null) {
      // Unknown, expired, or already consumed — refused; the caller reissues.
      return false;
    }

    const required = Number(stored);
    const digest = createHash('sha256').update(`${seed}${nonce}`).digest('hex');
    const ok = leadingZeroBits(digest) >= required;

    if (ok) {
      // Single-use: consume so a solved challenge cannot be replayed.
      try {
        await this.redis.del(powKey(seed));
      } catch {
        // The seed will TTL out; a replay window bounded by the TTL is
        // acceptable and far better than failing a legitimate sign-in.
      }
    }
    return ok;
  }
}
