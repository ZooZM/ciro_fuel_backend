import { OtpPrimitivesService, OtpVerifyResult } from '../../src/common/otp/otp-primitives.service';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
  };
}

describe('OtpPrimitivesService', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let service: OtpPrimitivesService;

  beforeEach(() => {
    redis = fakeRedis();
    service = new OtpPrimitivesService(redis as never);
  });

  describe('issue', () => {
    it('never stores the plaintext code in the returned record (hash at rest)', async () => {
      const { record, plaintext } = await service.issue('subject:1', 30);
      expect(record.hash).not.toBe(plaintext);
      expect(JSON.stringify(record)).not.toContain(plaintext);
    });

    it('caches the plaintext so it can be read back once, keyed by the caller-supplied subject', async () => {
      const { plaintext } = await service.issue('subject:1', 30);
      await expect(service.getCachedPlaintext('subject:1')).resolves.toBe(plaintext);
      await expect(service.getCachedPlaintext('subject:2')).resolves.toBeNull();
    });

    it('caches with a TTL matching the requested expiry window', async () => {
      await service.issue('subject:1', 30);
      expect(redis.set).toHaveBeenCalledWith('subject:1', expect.any(String), 'EX', 30 * 60);
    });

    it('produces a 6-digit zero-padded code and a record expiring in the future', async () => {
      const { record, plaintext } = await service.issue('subject:1', 30);
      expect(plaintext).toMatch(/^\d{6}$/);
      expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(record.attempts).toBe(0);
    });
  });

  describe('verify', () => {
    it('matches the correct code against its own record (single-use readiness — caller marks usedAt)', async () => {
      const { record, plaintext } = await service.issue('subject:1', 30);
      expect(service.verify(record, plaintext, 5)).toBe(OtpVerifyResult.MATCH);
    });

    it('rejects an incorrect code without mutating the record', async () => {
      const { record } = await service.issue('subject:1', 30);
      expect(service.verify(record, '000000', 5)).toBe(OtpVerifyResult.MISMATCH);
      expect(record.attempts).toBe(0); // pure — no side effect
    });

    it('reports NOT_FOUND for an absent or already-used record', () => {
      expect(service.verify(undefined, '123456', 5)).toBe(OtpVerifyResult.NOT_FOUND);
      const used = {
        hash: 'x',
        salt: 'y',
        expiresAt: new Date(Date.now() + 60_000),
        attempts: 0,
        usedAt: new Date(),
      };
      expect(service.verify(used, '123456', 5)).toBe(OtpVerifyResult.NOT_FOUND);
    });

    it('reports EXPIRED once past expiresAt, even with a correct code', async () => {
      const { record, plaintext } = await service.issue('subject:1', 30);
      record.expiresAt = new Date(Date.now() - 1000);
      expect(service.verify(record, plaintext, 5)).toBe(OtpVerifyResult.EXPIRED);
    });

    it('reports LOCKED_OUT once attempts reach the caller-supplied maximum', async () => {
      const { record, plaintext } = await service.issue('subject:1', 30);
      record.attempts = 5;
      expect(service.verify(record, plaintext, 5)).toBe(OtpVerifyResult.LOCKED_OUT);
    });
  });

  describe('clearCache', () => {
    it('removes the cached plaintext', async () => {
      await service.issue('subject:1', 30);
      await service.clearCache('subject:1');
      await expect(service.getCachedPlaintext('subject:1')).resolves.toBeNull();
    });
  });

  describe('hash', () => {
    it('is deterministic for the same code and salt, and differs across salts', () => {
      const salt1 = service.generateSalt();
      const salt2 = service.generateSalt();
      expect(service.hash('123456', salt1)).toBe(service.hash('123456', salt1));
      expect(service.hash('123456', salt1)).not.toBe(service.hash('123456', salt2));
    });
  });
});
