import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Connection, Model } from 'mongoose';
import { LoginCode, LoginCodeDocument } from '../schemas/login-code.schema';
import { UsersService } from '../../users/users.service';
import { AuthService, generateSid, SafeUser, TokenPair } from '../auth.service';
import { OtpPrimitivesService, OtpVerifyResult } from '../../../common/otp/otp-primitives.service';
import { SmsSender, SMS_SENDER } from '../../../common/sms/sms-sender.port';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { SessionRevocationCause } from '../../../common/enums/session-revocation-cause.enum';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { SessionAuditService, SessionSubject } from '../../sessions/session-audit.service';
import { LoginAbuseService } from './login-abuse.service';
import { CHALLENGE_PROVIDER, ChallengeProvider } from './challenge.service';
import { LoginChallengeDto } from '../dto/request-login-code.dto';

const loginCodeCacheKey = (userId: string) => `login-code:${userId}`;

/**
 * spec 015 US2 — passwordless administrator sign-in. A fourth consumer of
 * `OtpPrimitivesService` alongside order handover, phone verification and
 * password reset, and structurally the closest to `PasswordResetService`:
 * an anonymous, pre-authentication caller, so `requestCode` returns an
 * identical response for every outcome (FR-015) and `verifyCode` never
 * reports an attempt count (FR-017).
 *
 * The difference from password reset is what happens on success: instead of
 * returning a `resetToken`, `verifyCode` opens an admin `ActiveSession`
 * (US4's `openSession`) and returns a full token pair — byte-identical in
 * shape to `POST /auth/login` (FR-016).
 */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger(LoginCodeService.name);

  constructor(
    @InjectModel(LoginCode.name) private readonly loginCodeModel: Model<LoginCodeDocument>,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    private readonly otpPrimitives: OtpPrimitivesService,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    private readonly tenantContext: TenantContextService,
    private readonly sessionAudit: SessionAuditService,
    private readonly abuse: LoginAbuseService,
    @Inject(CHALLENGE_PROVIDER) private readonly challenge: ChallengeProvider,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private get expiryMinutes(): number {
    return this.config.get<number>('loginOtp.expiryMinutes') ?? 5;
  }

  private get maxAttempts(): number {
    return this.config.get<number>('loginOtp.maxAttempts') ?? 5;
  }

  /**
   * `LOGIN_CODE_REVEAL_UNKNOWN_PHONE` — opt-in, default false. See the branch in
   * `requestCode` for what turning it on gives up.
   */
  private get revealUnknownPhone(): boolean {
    return this.config.get<boolean>('loginOtp.revealUnknownPhone') === true;
  }

  /**
   * FR-015: constant status and body for every outcome — administrator,
   * driver, client, nobody, inactive, or more than one match; SMS sent or
   * failed. Any branch on the lookup result that reaches the caller is a
   * defect (the same rule `PasswordResetService.requestReset` states).
   */
  async requestCode(
    phone: string,
    challenge?: LoginChallengeDto,
  ): Promise<{ expiresInMinutes: number; attemptsAllowed: number }> {
    // All counters are keyed on the SUBMITTED phone string, BEFORE any
    // account lookup (research R8), and fail closed (FR-030).

    // 1. Temporary cross-code block (FR-025) — 429, indistinguishable from
    //    the request-rate 429.
    await this.abuse.assertNotBlocked(phone);

    // 2. Proof-of-work (FR-023). Once a number has been rate-limited
    //    `challengeAfter` times in the window, every further request must
    //    carry a solved challenge — which then BYPASSES the request-rate
    //    limit (a solved PoW is what earns the extra code). A missing,
    //    invalid, expired or replayed response yields no code and no SMS,
    //    and a FRESH seed.
    let challengeSolved = false;
    if (await this.abuse.challengeRequired(phone)) {
      challengeSolved = challenge
        ? await this.challenge.verify(challenge.seed, challenge.nonce)
        : false;
      if (!challengeSolved) {
        const fresh = await this.challenge.issue();
        throw new BadRequestException({
          error: ErrorCode.CHALLENGE_REQUIRED,
          challenge: { seed: fresh.seed, difficultyBits: fresh.difficultyBits },
          message: 'Please complete the verification challenge and retry',
        });
      }
    }

    // 3. Per-phone request-rate limit (FR-021/022) — skipped when a valid
    //    challenge was just solved. Throws 429 (and, once it has fired
    //    `challengeAfter` times, step 2 starts demanding a challenge).
    if (!challengeSolved) {
      await this.abuse.registerCodeRequest(phone);
    }

    const response = {
      expiresInMinutes: this.expiryMinutes,
      attemptsAllowed: this.maxAttempts,
    };

    // 3. Exactly-one-active-admin resolution, unscoped (anonymous caller).
    const holder = await this.tenantContext.runUnscoped(() =>
      this.usersService.findSingleActiveAdminByPhone(phone),
    );
    if (!holder) {
      // DEFAULT (FR-015): neutral — no code, no SMS, no audit row, and a body
      // identical to the success case, so the endpoint reveals nothing about who
      // holds an account.
      //
      // OPT-IN (`LOGIN_CODE_REVEAL_UNKNOWN_PHONE=true`): say so outright. This is a
      // real trade, not a formality — it makes the endpoint answer "is this mobile
      // number a platform administrator?" for anyone who can reach the login page.
      // It is enabled for development, where the neutral 202 makes a mistyped digit
      // and a broken SMS provider look identical.
      //
      // The abuse counters above still ran, and deliberately: they are keyed on the
      // submitted string BEFORE the lookup (research R8), so enabling this does not
      // hand an enumerator an unmetered oracle — they still get 3 probes per window.
      if (this.revealUnknownPhone) {
        throw new NotFoundException({
          error: ErrorCode.PHONE_NOT_REGISTERED,
          message: 'No active administrator account is registered with this mobile number',
        });
      }
      return response;
    }

    const userId = (holder._id as { toString(): string }).toString();
    const { record, plaintext } = await this.otpPrimitives.issue(
      loginCodeCacheKey(userId),
      this.expiryMinutes,
    );

    // FR-018 — supersede any unconsumed code for this admin before creating
    // the new one. A SEPARATE collection from PasswordReset (research R10):
    // this delete must not touch a reset code in flight.
    await this.loginCodeModel.deleteMany({ userId, consumedAt: { $exists: false } }).exec();
    await this.loginCodeModel.create({
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
        `Your CIRO Fuel sign-in code is ${plaintext}. It expires in ${this.expiryMinutes} minutes.`,
      );
    } catch {
      // FR-015 — the response must not change on a send failure.
      this.logger.warn(`Sign-in code SMS failed for user ${userId}`);
    }

    await this.sessionAudit.loginCodeRequested(this.subjectFor(holder));
    return response;
  }

  /**
   * FR-017 — one `LOGIN_CODE_INVALID` for wrong, expired, superseded or
   * attempt-locked-out alike, with no attempt count in the body.
   */
  async verifyCode(phone: string, code: string): Promise<TokenPair & { user: SafeUser }> {
    await this.abuse.assertNotBlocked(phone); // 429 (indistinguishable) / 503

    const record = await this.loginCodeModel
      .findOne({ phone, consumedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .exec();

    const result = this.otpPrimitives.verify(
      record ? { ...record.toObject(), usedAt: record.consumedAt } : undefined,
      code,
      this.maxAttempts,
    );

    if (result !== OtpVerifyResult.MATCH) {
      if (result === OtpVerifyResult.MISMATCH && record) {
        await this.loginCodeModel
          .updateOne({ _id: record._id }, { $inc: { attempts: 1 } })
          .exec();
      }
      // FR-025 — every non-match attempt feeds the cross-code accumulator,
      // which can cross `failThreshold` into a temporary block.
      await this.abuse.recordVerificationFailure(phone);
      if (record) {
        await this.sessionAudit.loginCodeVerifyFailed(
          this.subjectFor(await this.usersService.findById(String(record.userId))),
        );
      }
      throw new BadRequestException({
        error: ErrorCode.LOGIN_CODE_INVALID,
        message: 'Incorrect or expired code',
      });
    }

    const holder = await this.usersService.findById(String(record!.userId));
    const userId = (holder._id as { toString(): string }).toString();
    const cap = this.config.get<number>('auth.maxAdminSessions') ?? 3;
    const sid = generateSid();

    // FR-016 side effects — all in one transaction (Principle V): consume the
    // code, open the session, write SIGNED_IN plus any eviction row.
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.loginCodeModel
          .updateOne({ _id: record!._id }, { $set: { consumedAt: new Date() } }, { session })
          .exec();
        const { evictedSids } = await this.usersService.openSession(userId, sid, cap, session);
        const base = this.subjectFor(holder);
        for (const evictedSid of evictedSids) {
          await this.sessionAudit.revoked(
            { ...base, sid: evictedSid },
            SessionRevocationCause.SESSION_LIMIT_EXCEEDED,
            session,
          );
        }
        await this.sessionAudit.signedIn({ ...base, sid }, session);
      });
    } finally {
      await session.endSession();
    }

    // FR-029 — a successful sign-in clears the number's rate and failure
    // counters. Redis, so outside the Mongo transaction.
    await this.abuse.clearOnSuccess(phone);
    await this.otpPrimitives.clearCache(loginCodeCacheKey(userId));

    return this.authService.issueAdminCodeSession(holder, sid);
  }

  private subjectFor(user: {
    _id: unknown;
    companyId?: { toString(): string };
    role: SessionSubject['role'];
    sessionGeneration?: number;
  }): SessionSubject {
    return {
      userId: String(user._id),
      companyId: user.companyId?.toString(),
      role: user.role,
      generation: user.sessionGeneration ?? 0,
    };
  }
}
