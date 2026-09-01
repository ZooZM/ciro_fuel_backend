import { BadRequestException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Connection, Model } from 'mongoose';
import { randomBytes, createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { PasswordReset, PasswordResetDocument } from '../schemas/password-reset.schema';
import { UsersService } from '../../users/users.service';
import { OtpPrimitivesService, OtpVerifyResult } from '../../../common/otp/otp-primitives.service';
import { SmsSender, SMS_SENDER } from '../../../common/sms/sms-sender.port';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { SessionRevocationCause } from '../../../common/enums/session-revocation-cause.enum';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { SessionAuditService } from '../../sessions/session-audit.service';

function resetTokenCacheKey(userId: string): string {
  return `password-reset:${userId}`;
}

function rateLimitKey(phone: string): string {
  return `password-reset:rate:${phone}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A third consumer of `OtpPrimitivesService` (spec 005 research R4),
 * alongside order handover OTPs and `PhoneVerificationService` — same
 * hash/salt/cache/lockout behaviour, applied to an anonymous, pre-
 * authentication caller instead of a signed-in one.
 *
 * That one difference — no acting user — is what makes this service
 * diverge from `PhoneVerificationService` in two places FR-021
 * (enumeration safety) requires: `requestReset` returns an identical
 * response for every outcome (unregistered number, successful send,
 * failed send), and `verify` never reports an attempt count back to the
 * caller (research R3).
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @InjectModel(PasswordReset.name)
    private readonly passwordResetModel: Model<PasswordResetDocument>,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
    private readonly otpPrimitives: OtpPrimitivesService,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tenantContext: TenantContextService,
    private readonly sessionAudit: SessionAuditService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * FR-021: returns the identical shape whether or not `phone` belongs to
   * an account, and whether or not the SMS send actually succeeded. Any
   * variation in status, body, or timing would tell an anonymous caller
   * which phone numbers have accounts — that guarantee matters more here
   * than reporting a send failure precisely, which is the opposite
   * tradeoff `PhoneVerificationService` makes for its authenticated caller
   * (research R3).
   */
  async requestReset(
    phone: string,
  ): Promise<{ expiresInMinutes: number; attemptsAllowed: number }> {
    // Rate-limited by the submitted phone string itself, BEFORE the
    // account lookup below and unconditionally on whether one is found —
    // gating this only for known accounts would make the rate limit
    // itself an enumeration oracle (FR-025).
    await this.checkRateLimit(phone);

    const expiryMinutes = this.config.get<number>('passwordReset.expiryMinutes') ?? 5;
    const maxAttempts = this.config.get<number>('passwordReset.maxAttempts') ?? 5;
    const response = { expiresInMinutes: expiryMinutes, attemptsAllowed: maxAttempts };

    const holder = await this.tenantContext.runUnscoped(() =>
      this.usersService.findByPhoneForAuth(phone),
    );
    if (!holder) {
      return response;
    }

    const userId = (holder._id as { toString(): string }).toString();
    const { record, plaintext } = await this.otpPrimitives.issue(
      resetTokenCacheKey(userId),
      expiryMinutes,
    );

    // Supersedes any prior unconsumed record for this user (FR-023) —
    // dropped before the new one is created, same invariant
    // PhoneVerificationService.requestVerification applies.
    await this.passwordResetModel.deleteMany({ userId, consumedAt: { $exists: false } }).exec();
    await this.passwordResetModel.create({
      userId,
      phone,
      hash: record.hash,
      salt: record.salt,
      expiresAt: record.expiresAt,
      attempts: 0,
    });

    try {
      await this.smsSender.send(
        phone,
        `Your CIRO Fuel password reset code is ${plaintext}. It expires in ${expiryMinutes} minutes.`,
      );
    } catch {
      // FR-021: the response must not change on a send failure — logged
      // for operators only. The driver recovers by tapping resend, which
      // supersedes this record and tries again.
      this.logger.warn(`Password reset SMS failed for user ${userId}`);
    }

    await this.sessionAudit.recoveryRequested({
      userId,
      companyId: holder.companyId?.toString(),
      role: holder.role,
      generation: holder.sessionGeneration ?? 0,
    });

    return response;
  }

  /**
   * FR-022/024: one `RESET_CODE_INVALID` for wrong, expired, superseded,
   * or attempt-locked-out alike — distinguishing them would tell an
   * attacker which wall they hit and confirm the account exists.
   *
   * Returns an opaque, single-use `resetToken` on success. Deliberately
   * not the record's own `_id`: a Mongo ObjectId is not cryptographically
   * random, so it is unsuitable as a bearer secret. A fresh random token
   * is generated here; only its hash is stored (data-model.md).
   */
  async verify(phone: string, code: string): Promise<{ resetToken: string }> {
    const record = await this.passwordResetModel
      .findOne({ phone, consumedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .exec();

    const maxAttempts = this.config.get<number>('passwordReset.maxAttempts') ?? 5;
    const result = this.otpPrimitives.verify(
      record ? { ...record.toObject(), usedAt: record.consumedAt } : undefined,
      code,
      maxAttempts,
    );

    if ((result === OtpVerifyResult.MISMATCH || result === OtpVerifyResult.LOCKED_OUT) && record) {
      if (result === OtpVerifyResult.MISMATCH) {
        await this.passwordResetModel
          .updateOne({ _id: record._id }, { $inc: { attempts: 1 } })
          .exec();
      }
      await this.sessionAudit.recoveryVerifyFailed(await this.subjectFor(record.userId));
    }

    if (result !== OtpVerifyResult.MATCH) {
      throw new BadRequestException({
        error: ErrorCode.RESET_CODE_INVALID,
        message: 'Incorrect or expired code',
      });
    }

    const resetToken = randomBytes(32).toString('hex');
    await this.passwordResetModel
      .updateOne(
        { _id: record!._id },
        { $set: { verifiedAt: new Date(), resetTokenHash: hashToken(resetToken) } },
      )
      .exec();
    await this.otpPrimitives.clearCache(resetTokenCacheKey(String(record!.userId)));

    return { resetToken };
  }

  /**
   * All four writes commit together or none do (Principle V): a
   * consumed code without a changed password, or a changed password
   * whose old sessions survive, are both exactly the partial write a
   * transaction here prevents.
   */
  async complete(resetToken: string, newPassword: string): Promise<void> {
    const record = await this.passwordResetModel
      .findOne({ resetTokenHash: hashToken(resetToken), consumedAt: { $exists: false } })
      .exec();
    if (!record || !record.verifiedAt || record.expiresAt <= new Date()) {
      throw new BadRequestException({
        error: ErrorCode.RESET_CODE_INVALID,
        message: 'This reset link is invalid or has expired',
      });
    }

    const passwordHash = await UsersService.hashPassword(newPassword);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const user = await this.usersService.revokeAndSetPassword(
          String(record.userId),
          passwordHash,
          session,
        );
        await this.passwordResetModel
          .updateOne({ _id: record._id }, { $set: { consumedAt: new Date() } }, { session })
          .exec();
        await this.sessionAudit.revoked(
          {
            userId: String(record.userId),
            companyId: user.companyId?.toString(),
            role: user.role,
            generation: user.sessionGeneration ?? 0,
          },
          SessionRevocationCause.PASSWORD_RESET,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }

  private async subjectFor(userId: unknown) {
    const user = await this.usersService.findById(String(userId));
    return {
      userId: String(userId),
      companyId: user.companyId?.toString(),
      role: user.role,
      generation: user.sessionGeneration ?? 0,
    };
  }

  private async checkRateLimit(phone: string): Promise<void> {
    const windowMinutes = this.config.get<number>('passwordReset.windowMinutes') ?? 15;
    const maxRequests = this.config.get<number>('passwordReset.maxRequestsPerWindow') ?? 3;
    const key = rateLimitKey(phone);

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowMinutes * 60);
    }
    if (count > maxRequests) {
      const ttl = await this.redis.ttl(key);
      throw new HttpException(
        {
          error: ErrorCode.RESET_RATE_LIMITED,
          message: 'Too many requests — please wait before trying again',
          retryAfterSeconds: Math.max(1, ttl),
        },
        429,
      );
    }
  }
}
