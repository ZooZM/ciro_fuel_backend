import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type PasswordResetDocument = PasswordReset & Document;

/**
 * A short-lived proof that an anonymous requester controls the phone
 * number on an account (spec 006 US3). Modelled on `PhoneVerification`,
 * which solves the same problem for an authenticated caller — same
 * salted-hash-at-rest code, same supersede-on-reissue rule, same TTL
 * self-cleanup.
 *
 * Deliberately NOT tenant-scoped (`markTenantScoped` is never called
 * here): recovery runs before authentication, so there is no acting user
 * and no `companyId` in `AsyncLocalStorage` for the tenant-scope plugin to
 * inject. A scoped query would silently match nothing and every recovery
 * would fail as "code not found". Reached only via
 * `TenantContextService.runUnscoped`, the same mechanism
 * `PhoneVerificationService` already uses to look up a phone across
 * tenants (plan.md Complexity Tracking).
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PasswordReset {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  userId!: Types.ObjectId;

  // Captured at issue so a later phone change can't redirect an
  // outstanding reset (this is the identifier the code was sent to).
  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true })
  hash!: string;

  @Prop({ required: true })
  salt!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ default: 0 })
  attempts!: number;

  // Set on a correct code — opens the window in which a password may be
  // set. A password can never be set on an unverified record.
  @Prop()
  verifiedAt?: Date;

  // SHA-256 of the opaque `resetToken` returned to the caller once, at
  // verify time. Not the record's own `_id`: a Mongo ObjectId embeds a
  // timestamp and counter, so it is not cryptographically random and
  // unsuitable as a bearer secret. Only the hash is ever stored — the
  // same discipline `hash`/`salt` already apply to the code itself.
  @Prop()
  resetTokenHash?: string;

  // Set when the password is actually changed. A record with consumedAt
  // is inert.
  @Prop()
  consumedAt?: Date;

  createdAt!: Date;
}

export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);

PasswordResetSchema.index({ userId: 1, consumedAt: 1 });
PasswordResetSchema.index({ resetTokenHash: 1 });
// TTL: expired records self-delete rather than accumulating — 0 means "at expiresAt itself".
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
