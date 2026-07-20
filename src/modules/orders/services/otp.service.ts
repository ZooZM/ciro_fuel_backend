import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { ClientSession, Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { Order, OrderDocument, OtpPurpose, OtpRecord } from '../schemas/order.schema';
import { RealtimeGatewayService } from '../../../common/realtime/realtime-gateway.service';

const MAX_ATTEMPTS = 5;

function hashOtp(otp: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${otp}`).digest('hex');
}

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
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
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

    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const expiryMinutes = this.config.get<number>('otp.expiryMinutes') ?? 30;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);

    const record: OtpRecord = {
      purpose,
      hash: hashOtp(otp, salt),
      salt,
      expiresAt,
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
      .updateOne({ _id: orderId }, { $push: { otps: record } }, { session })
      .exec();

    await this.redis.set(plaintextCacheKey(orderId, purpose), otp, 'EX', expiryMinutes * 60);

    // Direct-to-user push (never to the order room — drivers must never see this).
    this.realtimeGateway.emitToUser(String(order.clientId), 'order:otp', {
      orderId,
      purpose,
      otp,
      expiresAt,
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
    if (recordIndex === -1) {
      throw new UnauthorizedException('No active OTP for this step');
    }
    const record = order.otps[recordIndex];

    if (record.expiresAt <= new Date()) {
      throw new UnauthorizedException('OTP has expired');
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      this.logger.warn(
        `OTP lockout: order=${orderId} purpose=${purpose} (${MAX_ATTEMPTS} attempts exhausted)`,
      );
      throw new UnauthorizedException('Too many incorrect attempts — request a new code');
    }

    const isMatch = hashOtp(submittedOtp, record.salt) === record.hash;
    if (!isMatch) {
      await this.orderModel
        .updateOne(
          { _id: orderId, [`otps.${recordIndex}`]: { $exists: true } },
          { $inc: { [`otps.${recordIndex}.attempts`]: 1 } },
          { session },
        )
        .exec();
      this.logger.warn(
        `Incorrect OTP: order=${orderId} purpose=${purpose} attempt=${record.attempts + 1}/${MAX_ATTEMPTS}`,
      );
      throw new UnauthorizedException('Incorrect OTP');
    }

    await this.orderModel
      .updateOne(
        { _id: orderId },
        { $set: { [`otps.${recordIndex}.usedAt`]: new Date() } },
        { session },
      )
      .exec();
    await this.redis.del(plaintextCacheKey(orderId, purpose));
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
        this.redis.del(plaintextCacheKey(orderId, purpose)),
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

    const otp = await this.redis.get(plaintextCacheKey(orderId, purpose));
    if (!otp) return null; // cache expired/evicted independently of the hash record

    return { purpose: record.purpose, otp, expiresAt: record.expiresAt };
  }
}
