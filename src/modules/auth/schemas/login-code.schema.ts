import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type LoginCodeDocument = LoginCode & Document;

/**
 * spec 015 (dashboard auth) §2 — a short-lived, salted-hash-at-rest code that
 * lets an administrator sign in with their mobile number instead of a
 * password. Modelled on `PasswordReset`, and DELIBERATELY a separate
 * collection from it (research R10): both apply a "supersede any unconsumed
 * record for this subject" rule, and sharing one collection would make a
 * sign-in request silently invalidate a password-reset code already in
 * flight, with only a discriminator field between them for a reviewer to
 * notice.
 *
 * Deliberately NOT tenant-scoped — `markTenantScoped` is never called, for
 * exactly the reason `PasswordReset`'s comment gives: the caller is
 * anonymous, there is no `companyId` in `AsyncLocalStorage`, and a scoped
 * query would match nothing and fail every sign-in as "code not found".
 * Reached only via `TenantContextService.runUnscoped`.
 *
 * The code itself is NEVER stored, returned, or logged (FR-019, FR-020) —
 * only the salted hash exists at rest.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class LoginCode {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  userId!: Types.ObjectId;

  // The number the code was SENT to, captured at issue — so a phone change
  // mid-flight cannot redirect a live code (mirrors `PasswordReset.phone`).
  @Prop({ required: true, immutable: true })
  phone!: string;

  @Prop({ required: true })
  hash!: string;

  @Prop({ required: true })
  salt!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  // Per-code attempt counter (FR-024). Distinct from the cross-code failure
  // accumulator, which lives in Redis (research R8) because it must outlive
  // the codes it counts across.
  @Prop({ default: 0 })
  attempts!: number;

  // Set when the code successfully established a session. A record with
  // `consumedAt` is inert.
  @Prop()
  consumedAt?: Date;

  createdAt!: Date;
}

export const LoginCodeSchema = SchemaFactory.createForClass(LoginCode);

// The supersede-and-find query.
LoginCodeSchema.index({ userId: 1, consumedAt: 1 });
// Verification looks up by the submitted phone, not by user.
LoginCodeSchema.index({ phone: 1, consumedAt: 1 });
// TTL self-cleanup, same as `PasswordReset` — 0 means "at expiresAt itself".
LoginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
