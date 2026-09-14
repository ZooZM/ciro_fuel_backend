import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { AnnouncementDeliveryFailureReason } from '../../../common/enums/announcement-delivery-failure-reason.enum';

export type AnnouncementDeliveryDocument = AnnouncementDelivery & Document;

/**
 * spec 017 (operator dashboard) T103/FR-053/FR-054 — one row per intended
 * recipient.
 *
 * This is what makes "the fan-out is retry-safe" and "who was missed, and why"
 * answerable, and it is where the idempotency guarantee actually lives.
 *
 * **No scoping marker**, for the same reason as `Announcement`: the operator
 * must be able to read the delivery record of a send that targeted companies
 * they do not belong to — and they belong to none.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AnnouncementDelivery {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Announcement',
    required: true,
    immutable: true,
  })
  announcementId!: Types.ObjectId;

  /**
   * The administrator this row is about.
   *
   * Absent for exactly one reason: `NO_ACTIVE_ADMIN`, where a targeted company
   * has no administrator to address at all. That failure is recorded against
   * the COMPANY because there is no person to record it against — and it is
   * precisely the gap an operator most needs told about, since nothing else on
   * the platform surfaces "this company can receive nothing".
   *
   * Stays ABSENT rather than explicitly `null`: the first index below is
   * partial on `$exists`, which a stored `null` would satisfy, pulling every
   * company-addressed row into an index that would then collide them all on one
   * shared key. {@link AnnouncementDelivery.companyAddressed} is the
   * discriminator instead.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', immutable: true })
  recipientUserId?: Types.ObjectId;

  /**
   * `true` on exactly the rows that name a company and no person — the
   * `NO_ACTIVE_ADMIN` case above. Absent on every row that names a recipient.
   *
   * **This field exists to be indexable.** The company-addressed uniqueness
   * guarantee needs a partial filter selecting "rows with no recipient", and
   * MongoDB rejects `$exists: false` inside a `partialFilterExpression`
   * outright ("Expression not supported in partial index: $not") — while
   * Mongoose's `autoIndex` swallows the rejection, so an index written that way
   * is silently never created and the application boots clean without it. A
   * stored flag with an equality filter is the shape MongoDB does support, and
   * the one `Station.isDefault` already uses on this platform.
   */
  @Prop({ type: Boolean })
  companyAddressed?: boolean;

  /**
   * The RECIPIENT's company, stamped explicitly by the processor. A BullMQ
   * worker has no request context, so no plugin stamps anything here.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  /** Set on success; absent on failure. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Notification' })
  notificationId?: Types.ObjectId;

  /**
   * Set on failure; absent on success. A NAMED reason, never a boolean — see
   * {@link AnnouncementDeliveryFailureReason}. A row carrying one is recorded
   * as missed and is never counted as delivered.
   */
  @Prop({ type: String, enum: AnnouncementDeliveryFailureReason })
  failureReason?: AnnouncementDeliveryFailureReason;
}

export const AnnouncementDeliverySchema =
  SchemaFactory.createForClass(AnnouncementDelivery);

/**
 * **THIS INDEX IS THE FR-053 GUARANTEE.** Not the queue, and not a prior read.
 *
 * BullMQ is **at-least-once**, and `Worker.close()` deliberately RELEASES an
 * unfinished job for redelivery — which is exactly what feature 012's graceful
 * shutdown wants, and which means a fan-out job will occasionally run twice. So
 * a redelivered job re-runs the insert, this index refuses it, and the
 * processor catches the duplicate-key error and skips. A retry therefore
 * produces zero duplicate notifications.
 *
 * An application-level "have I already delivered this?" read before each insert
 * is rejected outright: under redelivery it is a read-then-write race whose
 * collision only appears at commit — precisely the defect feature 009 hit on
 * concurrent assignment. Constitution V: concurrency safety at the data layer,
 * never assumed from application ordering.
 */
AnnouncementDeliverySchema.index(
  { announcementId: 1, recipientUserId: 1 },
  // Partial on `recipientUserId` existing. Without it, every company-addressed
  // `NO_ACTIVE_ADMIN` row would collide with every other on a missing key,
  // and one such company per announcement would be the most the platform could
  // record. UNCHANGED — deliberately: Mongoose never redefines an index that
  // already exists under the same name, so altering this filter would leave
  // every deployed database enforcing the old one while the code claimed the
  // new one.
  { unique: true, partialFilterExpression: { recipientUserId: { $exists: true } } },
);

/**
 * The company-addressed counterpart, so a `NO_ACTIVE_ADMIN` row is idempotent
 * under redelivery for the same reason and by the same mechanism.
 *
 * **Partial on the stored `companyAddressed` flag, NOT on
 * `recipientUserId: { $exists: false }`.** MongoDB rejects `$exists: false`
 * inside a `partialFilterExpression` ("Expression not supported in partial
 * index: $not") and Mongoose's `autoIndex` swallows the rejection, so this
 * index — written that way — was silently never created: the application
 * booted clean, every user-addressed idempotency test passed, and a redelivered
 * fan-out was free to duplicate this row. Found by walking the quickstart
 * against a real database; now pinned by an index-existence assertion in
 * `announcements.e2e-spec.ts`, because a swallowed index build is invisible to
 * every test that only exercises behaviour the index is not guarding.
 */
AnnouncementDeliverySchema.index(
  { announcementId: 1, companyId: 1 },
  { unique: true, partialFilterExpression: { companyAddressed: true } },
);
