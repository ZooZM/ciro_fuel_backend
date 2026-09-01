import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type PhoneVerificationDocument = PhoneVerification & Document;

/**
 * A pending phone-number change (spec 005 US7/FR-035). Deliberately NOT a
 * field on `User` — the user's phone must stay untouched until the code is
 * accepted (FR-035c), and a short-lived, superseded-on-retry document is a
 * much simpler place to enforce that than a half-applied field on the
 * user itself. Never carries the plaintext code (FR-035g) — only its
 * salted hash, exactly like `order.otps[]`.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PhoneVerification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  userId!: Types.ObjectId;

  @Prop({ required: true })
  newPhone!: string;

  @Prop({ required: true })
  hash!: string;

  @Prop({ required: true })
  salt!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ default: 0 })
  attempts!: number;

  @Prop()
  consumedAt?: Date;

  createdAt!: Date;
}

export const PhoneVerificationSchema = SchemaFactory.createForClass(PhoneVerification);

PhoneVerificationSchema.index({ userId: 1, consumedAt: 1 });
// TTL: expired records self-delete rather than accumulating — 0 means "at expiresAt itself".
PhoneVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
