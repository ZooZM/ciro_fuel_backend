import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Order, OrderDocument, OtpPurpose, OtpRecord } from '../schemas/order.schema';
import { RealtimeGatewayService } from '../../../common/realtime/realtime-gateway.service';
import { OtpPrimitivesService, OtpVerifyResult } from '../../../common/otp/otp-primitives.service';

const MAX_ATTEMPTS = 5;

function plaintextCacheKey(orderId: string, purpose: OtpPurpose): string {
  return `otp:${orderId}:${purpose}`;
}

/**
 * The order document only ever stores a salted hash of each OTP (FR-023) —
 * a DB compromise must not reveal codes. But the client-facing "current OTP"
 * endpoint (contracts/rest-api.md) needs the plaintext back, so issuance
 * also caches it in Redis with a TTL matching expiry; the cache is deleted
 * the moment the OTP is consumed or invalidated, so it never outlives the
 * hash's own validity window.
 *
 * Delegates its hash/salt/cache/lockout primitives to
 * `OtpPrimitivesService` (spec 005 research R4) — this class owns only
 * where those primitives are persisted: the order document's `otps[]`
 * array, addressed by array index. Every external behaviour (Redis key
 * shape, MAX_ATTEMPTS, the `order:otp` realtime emit, and `peekCurrent`
 * being the sole plaintext-return path) is unchanged from before the
 * extraction.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly config: ConfigService,
    private readonly otpPrimitives: OtpPrimitivesService,
    private readonly realtimeGateway: RealtimeGatewayService,
  ) {}

  async issue(orderId: string, purpose: OtpPurpose, session?: ClientSession): Promise<void> {
    const order = await this.orderModel
      .findById(orderId)
      .session(session ?? null)
      .exec();
    if (!order) {
      throw new ConflictException('Order not found');
    }

    const active = order.otps.find(
      (o) => o.purpose === purpose && !o.usedAt && o.expiresAt > new Date(),
    );
    if (active) {
      return; // still valid — do not regenerate (avoids spam / re-arrival churn)
    }

    const expiryMinutes = this.config.get<number>('otp.expiryMinutes') ?? 30;
    const { record, plaintext } = await this.otpPrimitives.issue(
      plaintextCacheKey(orderId, purpose),
      expiryMinutes,
    );

    const otpRecord: OtpRecord = {
      purpose,
      hash: record.hash,
      salt: record.salt,
      expiresAt: record.expiresAt,
      attempts: 0,
      createdAt: new Date(),
    };

    // Drop any stale (expired, unused) record for this purpose before pushing the new one.
    await this.orderModel
      .updateOne(
        { _id: orderId },
        { $pull: { otps: { purpose, usedAt: { $exists: false } } } },
        { session },
      )
      .exec();
    await this.orderModel
      .updateOne({ _id: orderId }, { $push: { otps: otpRecord } }, { session })
      .exec();

    // Direct-to-user push (never to the order room — drivers must never see this).
    this.realtimeGateway.emitToUser(String(order.clientId), 'order:otp', {
      orderId,
      purpose,
      otp: plaintext,
      expiresAt: record.expiresAt,
    });
  }

  async verify(
    orderId: string,
    purpose: OtpPurpose,
    submittedOtp: string,
    session?: ClientSession,
  ): Promise<void> {
    const order = await this.orderModel
      .findById(orderId)
      .session(session ?? null)
      .exec();
    if (!order) {
      throw new ConflictException('Order not found');
    }

    const recordIndex = order.otps.findIndex((o) => o.purpose === purpose && !o.usedAt);
    const record = recordIndex === -1 ? undefined : order.otps[recordIndex];

    const result = this.otpPrimitives.verify(record, submittedOtp, MAX_ATTEMPTS);

    switch (result) {
      case OtpVerifyResult.NOT_FOUND:
        throw new UnauthorizedException('No active OTP for this step');

      case OtpVerifyResult.EXPIRED:
        throw new UnauthorizedException('OTP has expired');

      case OtpVerifyResult.LOCKED_OUT:
        this.logger.warn(
          `OTP lockout: order=${orderId} purpose=${purpose} (${MAX_ATTEMPTS} attempts exhausted)`,
        );
        throw new UnauthorizedException('Too many incorrect attempts — request a new code');

      case OtpVerifyResult.MISMATCH: {
        const attemptsSoFar = record!.attempts;
        await this.orderModel
          .updateOne(
            { _id: orderId, [`otps.${recordIndex}`]: { $exists: true } },
            { $inc: { [`otps.${recordIndex}.attempts`]: 1 } },
            { session },
          )
          .exec();
        this.logger.warn(
          `Incorrect OTP: order=${orderId} purpose=${purpose} attempt=${attemptsSoFar + 1}/${MAX_ATTEMPTS}`,
        );
        throw new UnauthorizedException('Incorrect OTP');
      }

      case OtpVerifyResult.MATCH:
        await this.orderModel
          .updateOne(
            { _id: orderId },
            { $set: { [`otps.${recordIndex}.usedAt`]: new Date() } },
            { session },
          )
          .exec();
        await this.otpPrimitives.clearCache(plaintextCacheKey(orderId, purpose));
        return;
    }
  }

  /** Invalidates any currently-active (unused) OTPs — used by force-complete (FR-025). */
  async invalidateActive(orderId: string, session?: ClientSession): Promise<void> {
    await this.orderModel
      .updateOne(
        { _id: orderId },
        { $set: { 'otps.$[unused].usedAt': new Date() } },
        { session, arrayFilters: [{ 'unused.usedAt': { $exists: false } }] },
      )
      .exec();
    await Promise.all(
      Object.values(OtpPurpose).map((purpose) =>
        this.otpPrimitives.clearCache(plaintextCacheKey(orderId, purpose)),
      ),
    );
  }

  /** Client-facing plaintext lookup — the ONLY place an OTP value is ever returned (FR-023). */
  async peekCurrent(
    orderId: string,
    purpose: OtpPurpose,
  ): Promise<{ purpose: OtpPurpose; otp: string; expiresAt: Date } | null> {
    const order = await this.orderModel.findById(orderId).exec();
    const record = order?.otps.find(
      (o) => o.purpose === purpose && !o.usedAt && o.expiresAt > new Date(),
    );
    if (!record) return null;

    const otp = await this.otpPrimitives.getCachedPlaintext(plaintextCacheKey(orderId, purpose));
    if (!otp) return null; // cache expired/evicted independently of the hash record

    return { purpose: record.purpose, otp, expiresAt: record.expiresAt };
  }
}
