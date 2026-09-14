import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { AnnouncementState } from '../../../common/enums/announcement-state.enum';

export type AnnouncementDocument = Announcement & Document;

/**
 * spec 017 (operator dashboard) T102/FR-048/FR-052 — one row per send.
 *
 * Distinct from the deliveries it produces, which is the whole reason this is a
 * collection rather than a burst of notifications with no record above them:
 * FR-052 asks what was sent and to whom, and that question has no answer if the
 * only artefact is N notifications scattered across N recipients' inboxes.
 *
 * **No scoping marker, deliberately.** An announcement belongs to the platform,
 * not to a company — its author is a `SUPER_ADMIN`, who has no `companyId` at
 * all. `markTenantScoped` here would make an announcement **unreadable by its
 * own sender**, since the injected filter would match a tenant the operator
 * does not have. This follows `Company`'s and `Warehouse`'s established
 * precedent for platform-level records (spec 008 made the same call for
 * `Warehouse`, for the same reason). Access is enforced by
 * `@Roles(SUPER_ADMIN)` on the routes, which is the correct enforcement point
 * for a collection with exactly one legitimate reader (FR-056).
 */
@Schema({ timestamps: true })
export class Announcement {
  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ required: true, trim: true })
  body!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  sentBy!: Types.ObjectId;

  /**
   * **An empty array means every active company** (FR-049, FR-050).
   *
   * The alternative — a `targetsAllCompanies` boolean beside the array, the
   * shape feature 013 used for `CashbackProgramme` — is rejected here because
   * it admits two contradictory states (`targetsAll: true` with a non-empty
   * list) that every reader would then have to arbitrate, and they would not
   * all arbitrate it the same way. One field, one meaning.
   */
  @Prop({ type: [{ type: MongooseSchema.Types.ObjectId, ref: 'Company' }], default: [] })
  targetCompanyIds!: Types.ObjectId[];

  /** Resolved at enqueue, so the 202 can state it before any delivery happens. */
  @Prop({ required: true, min: 0 })
  intendedRecipientCount!: number;

  @Prop({ default: 0, min: 0 })
  deliveredCount!: number;

  @Prop({ default: 0, min: 0 })
  failedCount!: number;

  @Prop({
    type: String,
    required: true,
    enum: AnnouncementState,
    default: AnnouncementState.QUEUED,
  })
  state!: AnnouncementState;
}

export const AnnouncementSchema = SchemaFactory.createForClass(Announcement);

// Newest first, for the operator's cursor-paged list (FR-052).
AnnouncementSchema.index({ createdAt: -1, _id: -1 });
