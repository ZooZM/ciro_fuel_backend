import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { PhoneVerification, PhoneVerificationDocument } from '../schemas/phone-verification.schema';
import { UserDocument } from '../schemas/user.schema';
import { UsersService } from '../users.service';
import { OtpPrimitivesService, OtpVerifyResult } from '../../../common/otp/otp-primitives.service';
import { SmsSender, SMS_SENDER } from '../../../common/sms/sms-sender.port';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { TenantContextService } from '../../../common/context/tenant-context.service';

const MAX_ATTEMPTS = 5;

function plaintextCacheKey(userId: string): string {
  return `phone-verification:${userId}`;
}

/**
 * A second consumer of `OtpPrimitivesService` (spec 005 research R4),
 * alongside the order-bound `OtpService` — same hash/salt/cache/lockout
 * behaviour, a top-level `PhoneVerification` collection instead of an
 * embedded array. FR-035c/e/f/g govern everything here: the user's phone
 * is untouched until {@link confirm} succeeds, a number already in use is
 * refused before any SMS is sent, a rejected send is never reported as
 * 202, and the code itself never leaves this file.
 */
@Injectable()
export class PhoneVerificationService {
  constructor(
    @InjectModel(PhoneVerification.name)
    private readonly phoneVerificationModel: Model<PhoneVerificationDocument>,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
    private readonly otpPrimitives: OtpPrimitivesService,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    private readonly tenantContext: TenantContextService,
  ) {}

  async requestVerification(
    userId: string,
    newPhone: string,
  ): Promise<{ expiresAt: Date; attemptsRemaining: number }> {
    // FR-035e: checked before anything is sent — a message is never spent
    // on a doomed change. Phone uniqueness is a platform-wide invariant
    // (the same number can't belong to two accounts in different
    // companies either, since login-by-phone has no company to scope by),
    // so this lookup must bypass the caller's own tenant scope — otherwise
    // the tenant-scope plugin would silently confine it to the caller's
    // own company and miss a holder elsewhere.
    //
    // spec 017 T121/FR-061: this was `findByPhoneForAuth`, which is scoped to
    // CLIENT/DRIVER **on purpose** — so it could not see administrator
    // accounts, and an administrator changing onto another administrator's
    // number passed this check, SPENT an SMS, and was refused only at confirm
    // by the unique index. That is precisely the promise the comment above
    // makes and the code did not keep, ever since feature 015 extended the
    // partial unique phone index to all five roles (research R10).
    //
    // `findAnyByPhone` is role- AND active-agnostic: a deactivated account
    // still holds its number as far as the index is concerned, so a change onto
    // it would fail at confirm too.
    const holder = await this.tenantContext.runUnscoped(() =>
      this.usersService.findAnyByPhone(newPhone),
    );
    if (holder && String(holder._id) !== userId) {
      throw new ConflictException({
        error: ErrorCode.PHONE_IN_USE,
        message: 'This phone number is already registered to another account',
      });
    }

    const expiryMinutes = this.config.get<number>('otp.expiryMinutes') ?? 30;
    const { record, plaintext } = await this.otpPrimitives.issue(
      plaintextCacheKey(userId),
      expiryMinutes,
    );

    // Supersedes any prior unconsumed record for this user (data-model.md
    // invariant) — dropped before the new one is created, same "at most
    // one active record" rule OtpService.issue applies per order/purpose.
    await this.phoneVerificationModel.deleteMany({ userId, consumedAt: { $exists: false } }).exec();
    const doc = await this.phoneVerificationModel.create({
      userId,
      newPhone,
      hash: record.hash,
      salt: record.salt,
      expiresAt: record.expiresAt,
      attempts: 0,
    });

    try {
      await this.smsSender.send(
        newPhone,
        `Your CIRO Fuel verification code is ${plaintext}. It expires in ${expiryMinutes} minutes.`,
      );
    } catch {
      // FR-035f: never report a code as sent when the provider rejected
      // it — undo the record and its cached plaintext.
      await this.phoneVerificationModel.deleteOne({ _id: doc._id }).exec();
      await this.otpPrimitives.clearCache(plaintextCacheKey(userId));
      throw new HttpException(
        {
          error: ErrorCode.SMS_SEND_FAILED,
          message: 'Could not send the verification code — please try again',
        },
        502,
      );
    }

    return { expiresAt: record.expiresAt, attemptsRemaining: MAX_ATTEMPTS };
  }

  async confirm(userId: string, code: string): Promise<UserDocument> {
    const record = await this.phoneVerificationModel
      .findOne({ userId, consumedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .exec();

    const result = this.otpPrimitives.verify(
      record ? { ...record.toObject(), usedAt: record.consumedAt } : undefined,
      code,
      MAX_ATTEMPTS,
    );

    if (result === OtpVerifyResult.MISMATCH && record) {
      await this.phoneVerificationModel
        .updateOne({ _id: record._id }, { $inc: { attempts: 1 } })
        .exec();
    }

    if (result === OtpVerifyResult.LOCKED_OUT) {
      // T093/T098: 5 attempts against this one code is itself a throttle
      // outcome (429 + retryAfterSeconds), not the generic wrong/expired
      // 401 — the earliest a fresh code could be requested is once this
      // one's own expiry passes.
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((record!.expiresAt.getTime() - Date.now()) / 1000),
      );
      throw new HttpException(
        {
          statusCode: 429,
          message: 'Too many incorrect attempts — request a new code',
          error: 'ThrottlerException',
          retryAfterSeconds,
        },
        429,
      );
    }

    if (result !== OtpVerifyResult.MATCH) {
      // FR-035: never reveals whether the code was wrong, expired, or
      // missing — one generic 401 for every other non-match outcome.
      throw new UnauthorizedException('Incorrect or expired verification code');
    }

    await this.phoneVerificationModel
      .updateOne({ _id: record!._id }, { $set: { consumedAt: new Date() } })
      .exec();
    await this.otpPrimitives.clearCache(plaintextCacheKey(userId));

    return this.usersService.update(userId, { phone: record!.newPhone });
  }
}
