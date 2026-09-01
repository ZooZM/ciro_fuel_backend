import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * The shape any caller's stored OTP record must have for
 * {@link OtpPrimitivesService.verify} to evaluate it. Deliberately not tied
 * to any one collection or embedding strategy — `OtpService` keeps its
 * records in `order.otps[]`; `PhoneVerificationService` (spec 005) keeps
 * its own top-level collection. Both satisfy this shape.
 */
export interface OtpRecordLike {
  hash: string;
  salt: string;
  expiresAt: Date;
  attempts: number;
  usedAt?: Date;
}

export enum OtpVerifyResult {
  MATCH = 'MATCH',
  NOT_FOUND = 'NOT_FOUND',
  EXPIRED = 'EXPIRED',
  LOCKED_OUT = 'LOCKED_OUT',
  MISMATCH = 'MISMATCH',
}

function hashOtp(otp: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${otp}`).digest('hex');
}

/**
 * Subject-agnostic OTP primitives, extracted from the order-bound
 * `OtpService` (spec 005 research R4) so a second security-sensitive
 * mechanism — SMS phone verification — reuses the same hash/salt/cache/
 * lockout behaviour rather than a parallel copy of it.
 *
 * Deliberately does **not** own persistence: a record's storage location
 * (an embedded array on an Order, a standalone PhoneVerification document,
 * or anything future) varies by caller, and Mongoose update semantics for
 * an embedded array element (`otps.$[i].attempts`) differ from a top-level
 * document field. Callers persist the record this service builds them and
 * apply the verdict {@link verify} returns; this service owns only the
 * primitives where a subtle bug would be a security incident: generation,
 * hashing, the plaintext cache, and lockout/expiry evaluation.
 */
@Injectable()
export class OtpPrimitivesService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** A 6-digit numeric code, zero-padded — matches the existing OTP shape exactly. */
  generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  generateSalt(): string {
    return randomBytes(16).toString('hex');
  }

  hash(code: string, salt: string): string {
    return hashOtp(code, salt);
  }

  /** Caches the plaintext so it can be read back once (e.g. a client-facing "current code" endpoint). */
  async cachePlaintext(cacheKey: string, code: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(cacheKey, code, 'EX', ttlSeconds);
  }

  async getCachedPlaintext(cacheKey: string): Promise<string | null> {
    return this.redis.get(cacheKey);
  }

  async clearCache(cacheKey: string): Promise<void> {
    await this.redis.del(cacheKey);
  }

  /**
   * Builds a fresh record and caches its plaintext. Does not persist the
   * record — the caller stores it wherever its subject lives.
   */
  async issue(
    cacheKey: string,
    expiryMinutes: number,
  ): Promise<{ record: OtpRecordLike; plaintext: string }> {
    const code = this.generateCode();
    const salt = this.generateSalt();
    const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);
    await this.cachePlaintext(cacheKey, code, expiryMinutes * 60);
    return {
      record: { hash: this.hash(code, salt), salt, expiresAt, attempts: 0 },
      plaintext: code,
    };
  }

  /**
   * Pure evaluation against an existing record — applies no side effect.
   * The caller increments `attempts` or sets `usedAt` themselves, since
   * only the caller knows how to address its own storage.
   */
  verify(
    record: OtpRecordLike | undefined,
    submittedCode: string,
    maxAttempts: number,
  ): OtpVerifyResult {
    if (!record || record.usedAt) {
      return OtpVerifyResult.NOT_FOUND;
    }
    if (record.expiresAt <= new Date()) {
      return OtpVerifyResult.EXPIRED;
    }
    if (record.attempts >= maxAttempts) {
      return OtpVerifyResult.LOCKED_OUT;
    }
    return this.hash(submittedCode, record.salt) === record.hash
      ? OtpVerifyResult.MATCH
      : OtpVerifyResult.MISMATCH;
  }
}
