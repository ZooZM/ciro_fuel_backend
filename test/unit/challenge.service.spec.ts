import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  ChallengeService,
  leadingZeroBits,
} from '../../src/modules/auth/services/challenge.service';

/**
 * spec 015 US3 T075 — the self-hosted proof-of-work (research R7).
 */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, val: string) {
      store.set(key, val);
      return 'OK';
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

function makeService(difficultyBits: number) {
  const redis = fakeRedis();
  const config = {
    get: (k: string) =>
      ({ 'loginOtp.pow.difficultyBits': difficultyBits, 'loginOtp.pow.seedTtlSeconds': 300 })[k],
  } as unknown as ConfigService;
  return { service: new ChallengeService(redis as never, config), redis };
}

/** Brute-force a nonce that solves `seed` at `bits` (small bits only). */
function solve(seed: string, bits: number): string {
  for (let n = 0; ; n++) {
    const digest = createHash('sha256').update(`${seed}${n}`).digest('hex');
    if (leadingZeroBits(digest) >= bits) return String(n);
  }
}

describe('ChallengeService (spec 015 R7)', () => {
  describe('leadingZeroBits', () => {
    it('counts leading zero bits of a hex digest', () => {
      expect(leadingZeroBits('ffffffff')).toBe(0);
      expect(leadingZeroBits('7fffffff')).toBe(1);
      expect(leadingZeroBits('0fffffff')).toBe(4);
      expect(leadingZeroBits('00ffffff')).toBe(8);
      expect(leadingZeroBits('001fffff')).toBe(11);
    });
  });

  it('difficultyBits: 0 accepts any nonce', async () => {
    const { service } = makeService(0);
    const { seed, difficultyBits } = await service.issue();
    expect(difficultyBits).toBe(0);
    expect(await service.verify(seed, 'whatever')).toBe(true);
  });

  it('a solved seed verifies once and is then refused (single-use)', async () => {
    const { service } = makeService(0);
    const { seed } = await service.issue();

    expect(await service.verify(seed, '1')).toBe(true);
    // consumed
    expect(await service.verify(seed, '1')).toBe(false);
  });

  it('an unknown or expired seed is refused (the caller then issues a fresh one)', async () => {
    const { service } = makeService(0);
    expect(await service.verify('0'.repeat(64), '1')).toBe(false);
  });

  it('a real (small) difficulty: a correct nonce passes, a wrong one fails and does NOT consume the seed', async () => {
    const bits = 8;
    const { service, redis } = makeService(bits);
    const { seed } = await service.issue();

    expect(await service.verify(seed, 'definitely-not-a-solution')).toBe(false);
    // still present — a failed attempt is not a consumed challenge
    expect(redis.store.has(`login-otp:pow:${seed}`)).toBe(true);

    const nonce = solve(seed, bits);
    expect(await service.verify(seed, nonce)).toBe(true);
    expect(redis.store.has(`login-otp:pow:${seed}`)).toBe(false);
  });
});
