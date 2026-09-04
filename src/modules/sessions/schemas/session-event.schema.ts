import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { UserRole } from '../../../common/enums/user-role.enum';
import { SessionEventType } from '../../../common/enums/session-event-type.enum';
import { SessionRevocationCause } from '../../../common/enums/session-revocation-cause.enum';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type SessionEventDocument = SessionEvent & Document;

/**
 * The audit trail FR-043–046 requires: one append-only row per session
 * lifecycle event, written exclusively by `SessionAuditService`. Never
 * updated or deleted after creation.
 *
 * Deliberately NOT a per-request log (FR-046) — nothing outside
 * `SessionAuditService` writes here, and that service exposes one method
 * per {@link SessionEventType}, not a generic "log this request" call.
 *
 * Deliberately NO TTL index, unlike `PhoneVerification`/`PasswordReset`:
 * FR-044 requires answering, after the fact, which driver held a session
 * when a given delivery completed — a question asked during a dispute,
 * which is exactly when a TTL would already have deleted the answer
 * (research R7). Retained at least 2 years (FR-044), matching the
 * platform's existing order/payment retention.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SessionEvent {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  userId!: Types.ObjectId;

  // Optional, not required: a SUPER_ADMIN has no companyId on User at all
  // (that role is exempt from tenant isolation platform-wide), and this
  // event type is written on every login regardless of role. A required
  // field here would throw on every platform-operator sign-in — this was
  // a real defect found and fixed during this plan's post-design
  // constitution re-check (see plan.md).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company' })
  companyId?: Types.ObjectId;

  // Denormalized so a historical row stays readable if the account's role
  // ever changes.
  @Prop({ type: String, required: true, enum: UserRole, immutable: true })
  role!: UserRole;

  @Prop({ type: String, required: true, enum: SessionEventType, immutable: true })
  type!: SessionEventType;

  // Present on revocation events; absent on SIGNED_IN, RECOVERY_REQUESTED
  // and RECOVERY_VERIFY_FAILED.
  @Prop({ type: String, enum: SessionRevocationCause, immutable: true })
  cause?: SessionRevocationCause;

  // The sessionGeneration in force AFTER this event, so a row ties to the
  // exact session it concerns.
  @Prop({ required: true, min: 0, immutable: true })
  generation!: number;

  // spec 015 (dashboard auth) §6 / FR-040 — WHICH administrator session this
  // event concerns. For an admin, `generation` no longer changes between
  // sign-ins, so rows are distinguished by `type`, `occurredAt` and this.
  // Present on admin session events (SIGNED_IN, SIGNED_OUT, and the
  // per-eviction REVOKED row); ABSENT for DRIVER/CLIENT and on account-level
  // events (password reset, deactivation, company suspension) that end every
  // session at once. Without it, "which session did this admin hold at time
  // T" — the question FR-040 asks and the reason this collection has no TTL —
  // would be unanswerable.
  @Prop({ type: String, immutable: true })
  sid?: string;

  @Prop({ required: true, default: Date.now, immutable: true })
  occurredAt!: Date;

  createdAt!: Date;
}

export const SessionEventSchema = SchemaFactory.createForClass(SessionEvent);
markTenantScoped(SessionEventSchema);

// The reconstruction query FR-044/SC-009a exist for: which session did
// this driver hold at time T.
SessionEventSchema.index({ userId: 1, occurredAt: -1 });
// An administrator reviewing their own fleet.
SessionEventSchema.index({ companyId: 1, occurredAt: -1 });
