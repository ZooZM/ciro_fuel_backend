import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { SessionEvent, SessionEventDocument } from './schemas/session-event.schema';
import { SessionEventType } from '../../common/enums/session-event-type.enum';
import { SessionRevocationCause } from '../../common/enums/session-revocation-cause.enum';
import { UserRole } from '../../common/enums/user-role.enum';

/**
 * The information every `SessionEvent` row needs, regardless of which
 * lifecycle event it records. Deliberately a plain object rather than a
 * `UserDocument` — this service is a leaf both `auth/` and `users/` import,
 * and taking a Mongoose document would couple it to their model shape
 * instead of the fields it actually writes.
 */
export interface SessionSubject {
  userId: string;
  /** Absent for a SUPER_ADMIN, who has no `companyId` on `User` at all. */
  companyId?: string;
  role: UserRole;
  /** The `sessionGeneration` in force AFTER the event being recorded. */
  generation: number;
}

/**
 * The single writer of `SessionEvent` (spec 006 FR-043–046). One method
 * per {@link SessionEventType} — deliberately not a generic `record(type,
 * ...)` — so a call site can't accidentally write a per-request row
 * (FR-046) or omit a `cause` that {@link revoked} requires.
 *
 * Every method accepts an optional `ClientSession` so the row commits
 * atomically with whatever else the caller is doing in the same
 * transaction (Principle V) — a generation bump landing without its audit
 * row, or vice versa, is exactly the partial write that matters here.
 */
@Injectable()
export class SessionAuditService {
  constructor(
    @InjectModel(SessionEvent.name)
    private readonly sessionEventModel: Model<SessionEventDocument>,
  ) {}

  async signedIn(subject: SessionSubject, session?: ClientSession): Promise<void> {
    await this._write(subject, SessionEventType.SIGNED_IN, undefined, session);
  }

  async signedOut(subject: SessionSubject, session?: ClientSession): Promise<void> {
    await this._write(subject, SessionEventType.SIGNED_OUT, undefined, session);
  }

  async revoked(
    subject: SessionSubject,
    cause: SessionRevocationCause,
    session?: ClientSession,
  ): Promise<void> {
    await this._write(subject, SessionEventType.REVOKED, cause, session);
  }

  /**
   * Written only when the phone number resolves to an account (FR-021 —
   * an unregistered number gets the identical response with no audit row,
   * since there is no account for the row to belong to; enumeration
   * safety lives entirely in the endpoint's response, not in whether this
   * row exists).
   */
  async recoveryRequested(subject: SessionSubject, session?: ClientSession): Promise<void> {
    await this._write(subject, SessionEventType.RECOVERY_REQUESTED, undefined, session);
  }

  async recoveryVerifyFailed(subject: SessionSubject, session?: ClientSession): Promise<void> {
    await this._write(subject, SessionEventType.RECOVERY_VERIFY_FAILED, undefined, session);
  }

  private async _write(
    subject: SessionSubject,
    type: SessionEventType,
    cause: SessionRevocationCause | undefined,
    session: ClientSession | undefined,
  ): Promise<void> {
    await this.sessionEventModel.create(
      [
        {
          userId: subject.userId,
          companyId: subject.companyId,
          role: subject.role,
          type,
          cause,
          generation: subject.generation,
          occurredAt: new Date(),
        },
      ],
      { session },
    );
  }
}
