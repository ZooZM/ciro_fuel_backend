import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { CompaniesService } from '../companies/companies.service';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { SessionRevocationCause } from '../../common/enums/session-revocation-cause.enum';
import {
  SESSION_CAPPED_ROLES,
  isSessionCappedRole,
} from '../../common/constants/session-capped-roles';

const SALT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly companiesService: CompaniesService,
  ) {}

  async findByEmailForAuth(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').exec();
  }

  // Scoped to the mobile roles: for password login an admin account is
  // reachable by email only. spec 015 T053 keeps this exactly as-is —
  // `findSingleActiveAdminByPhone` below is the admin-phone resolver, and it
  // is deliberately separate.
  async findByPhoneForAuth(phone: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ phone: phone.trim(), role: { $in: [UserRole.CLIENT, UserRole.DRIVER] } })
      .select('+passwordHash')
      .exec();
  }

  /**
   * spec 015 FR-014 / R5 — the load-bearing "exactly one active
   * administrator" guarantee for passwordless code sign-in. Returns a user
   * ONLY when the phone matches exactly one `isActive` account holding an
   * administrator role. Zero matches, two-or-more matches, or an inactive
   * match all return `null`, which folds into the same neutral response an
   * unknown number gets — failing safe and silently, which is what
   * enumeration-safety requires anyway (FR-027). The partial unique index on
   * `phone` is a second line of defence; this `countDocuments`-style check
   * is the guarantee, because the index says nothing about `isActive`.
   *
   * Anonymous caller: must be run inside `TenantContextService.runUnscoped`,
   * exactly as `PasswordResetService` runs `findByPhoneForAuth`.
   */
  async findSingleActiveAdminByPhone(phone: string): Promise<UserDocument | null> {
    const matches = await this.userModel
      .find({
        phone: phone.trim(),
        role: { $in: SESSION_CAPPED_ROLES as UserRole[] },
        isActive: true,
      })
      .limit(2)
      .exec();
    return matches.length === 1 ? matches[0] : null;
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * The isActive + company-suspension check shared by every entry point
   * below. Deliberately does NOT compare `sessionGeneration` — that check
   * only makes sense against a payload that was actually minted with one,
   * which login and refresh don't have yet (they're establishing or
   * re-establishing the session, not presenting a live one).
   *
   * Returns `usable: false` rather than throwing — deactivation flips
   * `isActive` in the very same write that bumps `sessionGeneration`
   * (spec 006 FR-035/036), so a stale request from a just-deactivated
   * driver must reach `validateActiveSessionWithScoping`'s structured
   * `SESSION_REVOKED`+`cause` response (T077) rather than short-circuit
   * here into the plain message login/refresh use for FR-037. The user
   * document (when one was found at all) is still returned alongside
   * `usable: false` so that caller can read `lastRevocationCause` off it.
   */
  private async _loadActiveUser(userId: string): Promise<{
    user: UserDocument | null;
    usable: boolean;
    parentFuelCompanyId?: string;
    // spec 013 FR-090/Edge Cases: distinguishes WHY `usable` is false, so a caller
    // with a live session (validateActiveSessionWithScoping) can state the specific
    // reason instead of falling back to whatever `lastRevocationCause` happens to
    // hold — that field tracks ACCOUNT-level revocation and is never set when the
    // company itself is suspended, so without this the two were indistinguishable.
    unusableReason?: 'ACCOUNT_INACTIVE' | 'COMPANY_SUSPENDED';
  }> {
    const user = await this.userModel.findById(userId).exec();
    if (!user || !user.isActive) {
      return { user: user ?? null, usable: false, unusableReason: 'ACCOUNT_INACTIVE' };
    }
    if (user.role === UserRole.SUPER_ADMIN || !user.companyId) {
      return { user, usable: true };
    }
    const scoping = await this.companiesService.getScopingInfo(user.companyId);
    if (!scoping || !scoping.isActive) {
      return { user, usable: false, unusableReason: 'COMPANY_SUSPENDED' };
    }
    return { user, usable: true, parentFuelCompanyId: scoping.parentFuelCompanyId };
  }

  /**
   * Re-validated on every authenticated request (not just at login) so a
   * deactivated account or suspended company loses access immediately,
   * rather than waiting for the JWT to expire.
   *
   * Used by login (establishing a session) and refresh (re-establishing
   * one) — neither presents a live `sessionGeneration` to compare against,
   * so unlike {@link validateActiveSessionWithScoping} this performs no
   * revocation check (spec 006 research R1). `AuthService.refresh` runs
   * its own `sgen` comparison against the refresh token it already holds.
   * Always the plain generic message (FR-037): a login/refresh attempt
   * must never distinguish a wrong password from an inactive account.
   */
  async validateActiveSession(userId: string): Promise<UserDocument> {
    const { user, usable } = await this._loadActiveUser(userId);
    if (!usable || !user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  /**
   * As {@link validateActiveSession}, but also resolves `parentFuelCompanyId`
   * for the multi-party isolation filter (spec 004 plan.md §1): a
   * TRANSPORT_COMPANY_ADMIN or DRIVER's own `companyId` names the
   * Transportation Company they belong to, not the Fuel Company that owns
   * orders/invoices they may see — so the owning Fuel Company is resolved
   * here, once per request, from the one company lookup this method already
   * performs for the isActive check (not a second query).
   *
   * Used by the two request-entry points that build `TenantContext`
   * (`JwtStrategy.validate`, `authenticateSocket`); `validateActiveSession`'s
   * other callers (login, refresh) don't need this and stay unaffected.
   *
   * Also the session-revocation choke point (spec 006 FR-027/029/035a/035b/
   * 042): every authenticated request and every `/tracking` handshake calls
   * this, so comparing the presented token's `sessionGeneration` here — on
   * a document this method already fetches — makes revocation immediate
   * with no extra query. Both sides normalize an absent value to 0, so a
   * token minted before this feature stays valid (research R1).
   *
   * Unlike {@link validateActiveSession}, an unusable account here — whether
   * from deactivation or a generation mismatch — carries a `cause`
   * (FR-036/T077): the driver already had a *live* session, so the app owes
   * them a specific reason, not the generic "invalid credentials" an
   * inactive account gets at login.
   */
  async validateActiveSessionWithScoping(
    payload: Pick<JwtPayload, 'sub' | 'sgen' | 'sid'>,
  ): Promise<{ user: UserDocument; parentFuelCompanyId?: string }> {
    const { user, usable, parentFuelCompanyId, unusableReason } = await this._loadActiveUser(
      payload.sub,
    );
    const sgenMismatch = !user || (payload.sgen ?? 0) !== (user.sessionGeneration ?? 0);
    if (!usable || sgenMismatch) {
      // spec 013 FR-090/Edge Cases: a suspended company gives every one of its users a
      // distinct cause here, not `lastRevocationCause` (which only ever tracks
      // ACCOUNT-level revocation and is never set by company suspension — falling back
      // to it would misreport the reason as stale/unrelated or leave it undefined).
      //
      // spec 015 T022a: company suspension (`usable: false`,
      // `unusableReason: 'COMPANY_SUSPENDED'`) is a LIVE check in
      // `_loadActiveUser`, not a revocation write, so it is caught HERE —
      // before the `sid` membership check below — and keeps reporting
      // `cause: COMPANY_SUSPENDED` for an administrator too (FR-037's second
      // half). The generation bump on password reset / deactivation likewise
      // lands here via `sgenMismatch`, with its own cause, before any `sid`
      // logic is reached.
      const cause =
        unusableReason === 'COMPANY_SUSPENDED'
          ? SessionRevocationCause.COMPANY_SUSPENDED
          : user?.lastRevocationCause;
      throw new UnauthorizedException({
        error: ErrorCode.SESSION_REVOKED,
        cause,
        message: 'Your session has ended',
      });
    }
    // spec 015 T023 / FR-035/038/039 — the per-session check, AFTER the
    // `sgen` comparison above. Only administrators (SESSION_CAPPED_ROLES)
    // carry a `sid`; for DRIVER/CLIENT `payload.sid` is absent and this
    // block is skipped ENTIRELY — that skip is what makes FR-033 structural
    // rather than a regression-test outcome. An admin payload with no `sid`,
    // or one whose `sid` is no longer in `activeSessions` (evicted by the
    // cap, or closed by that device's own sign-out), is refused with the
    // same structured shape. `SESSION_LIMIT_EXCEEDED` is the correct cause
    // for every path that reaches here: a revoke-all bumped `sgen` and was
    // already handled above; only eviction and self-logout leave a `sid`
    // missing without a generation change, and the signed-out device has
    // discarded its tokens anyway.
    if (isSessionCappedRole(user!.role)) {
      const sid = payload.sid;
      const open = (user!.activeSessions ?? []).some((s) => s.sid === sid);
      if (!sid || !open) {
        throw new UnauthorizedException({
          error: ErrorCode.SESSION_REVOKED,
          cause: SessionRevocationCause.SESSION_LIMIT_EXCEEDED,
          message: 'Your session has ended',
        });
      }
    }
    return { user: user!, parentFuelCompanyId };
  }

  static async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  static comparePassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Sets a new password and revokes every session for the account in one
   * atomic write (spec 006 FR-027) — a completed password reset must end
   * every session that existed before it, on any device. The generation
   * bump is what `validateActiveSessionWithScoping` compares against on
   * the next request or handshake; nothing else needs to know a reset
   * happened. Always called inside the caller's own transaction
   * (`PasswordResetService.complete`), alongside consuming the reset
   * record and writing the audit row.
   */
  async revokeAndSetPassword(
    userId: string,
    passwordHash: string,
    session: ClientSession,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        {
          $set: {
            passwordHash,
            lastRevocationCause: SessionRevocationCause.PASSWORD_RESET,
            // spec 015 FR-036: an administrator's every device ends on a
            // completed reset. The generation bump alone already refuses
            // every prior token (the `sgen` comparison runs for every role),
            // so this is belt-and-braces — but leaving stale entries behind
            // would let the array drift up against the cap and silently evict
            // a legitimate new session.
            activeSessions: [],
          },
          $inc: { sessionGeneration: 1 },
        },
        { new: true, session },
      )
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * spec 006 FR-029/035/042 + spec 015 research R2 — "end EVERY session for
   * this account". Bumps `sessionGeneration` (the epoch
   * `validateActiveSessionWithScoping` compares the JWT's `sgen` against)
   * AND clears `activeSessions` (spec 015 FR-036/037: an administrator's
   * every device ends). This is the old `revokeSession` plus one `$set`.
   *
   * Callers: DRIVER/CLIENT login (displacing the prior session) and logout,
   * password reset (via {@link revokeAndSetPassword}), and deactivation.
   * Admin login/logout do NOT call this — they use {@link openSession} /
   * {@link closeSession}, which leave `sessionGeneration` untouched so the
   * administrator's OTHER devices keep working.
   *
   * `cause` records WHY on the user document for
   * `validateActiveSessionWithScoping`'s mismatch branch to read back
   * (FR-036) — omitted for a plain sign-out, which needs no explanation:
   * the device that signed out already cleared its own tokens.
   *
   * Argument order changed from the old `revokeSession(userId, session,
   * cause)` to `(userId, cause, session)` deliberately, so every call site
   * had to be revisited when the semantics widened (research R2).
   */
  async revokeAllSessions(
    userId: string,
    cause?: SessionRevocationCause,
    session?: ClientSession,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        {
          $inc: { sessionGeneration: 1 },
          $set: { activeSessions: [], ...(cause ? { lastRevocationCause: cause } : {}) },
          ...(cause ? {} : { $unset: { lastRevocationCause: '' } }),
        },
        { new: true, session },
      )
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * spec 015 research R2 — admin only. Appends this sign-in's session to
   * `activeSessions`, evicts the oldest beyond `cap`, and returns the
   * evicted `sid`s so the caller writes their REVOKED/SESSION_LIMIT_EXCEEDED
   * audit rows in the SAME transaction (Principle V). Ordering is by
   * `createdAt` — FR-038 says "the oldest session", and `createdAt` needs no
   * write on the request path, unlike an LRU policy which would touch `User`
   * on every request.
   *
   * Does NOT touch `sessionGeneration`: an admin signing in on a laptop must
   * not invalidate the tokens on their phone (FR-032). The read-then-write
   * runs inside the caller's `session.withTransaction`, whose automatic
   * retry on a write conflict covers the rare same-admin concurrent sign-in.
   */
  async openSession(
    userId: string,
    sid: string,
    cap: number,
    session: ClientSession,
  ): Promise<{ evictedSids: string[] }> {
    const user = await this.userModel.findById(userId).session(session).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const merged = [...(user.activeSessions ?? []), { sid, createdAt: new Date() }].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const kept = merged.slice(Math.max(0, merged.length - cap));
    const keptSids = new Set(kept.map((s) => s.sid));
    const evictedSids = merged.filter((s) => !keptSids.has(s.sid)).map((s) => s.sid);
    await this.userModel
      .updateOne({ _id: userId }, { $set: { activeSessions: kept } }, { session })
      .exec();
    return { evictedSids };
  }

  /**
   * spec 015 research R2 — admin only. Removes exactly one session from
   * `activeSessions`. Deliberately does NOT bump `sessionGeneration` —
   * that is precisely what leaves the administrator's other devices working
   * (FR-035). There is no body and no way to close another device's
   * session. Returns the user so the caller can write the SIGNED_OUT row.
   */
  async closeSession(
    userId: string,
    sid: string,
    session?: ClientSession,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $pull: { activeSessions: { sid } } },
        { new: true, session },
      )
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Frees the busy markers a driver's own document carries while working a
   * delivery — the same `$set`/`$unset` shape `orders.service.ts`'s
   * `releaseDriverIfAssigned` applies on cancel/complete/force-complete,
   * mirrored here rather than called into (that would need a
   * `UsersModule` -> `OrdersModule` edge on top of the reverse one that
   * already exists). Deactivation does not transition the order itself —
   * FR-038 only requires it end up in a state an administrator can
   * reassign, and there is no transition yet that moves an
   * `ASSIGNED_TO_DRIVER` order to a different driver (that lands with the
   * web dashboard, spec 003) — so only the deactivated driver's own
   * availability/`activeOrderId` are cleared, stopping dispatch from
   * treating them as busy.
   */
  async releaseActiveOrderOnDeactivation(userId: string, session: ClientSession): Promise<void> {
    await this.userModel
      .updateOne(
        { _id: userId, activeOrderId: { $exists: true } },
        { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
        { session },
      )
      .exec();
  }

  async create(data: Partial<User> & { password: string }): Promise<UserDocument> {
    const { password, ...rest } = data;
    const passwordHash = await UsersService.hashPassword(password);
    try {
      return await this.userModel.create({ ...rest, passwordHash });
    } catch (error) {
      throw UsersService.asConflict(error);
    }
  }

  /**
   * email is unique platform-wide, and phone is too for CLIENT/DRIVER since it
   * is their login identifier — so a collision is a client error, not a 500.
   * The caller is told which field clashed because they cannot pick a different
   * one otherwise; that a number is taken is inherent to global uniqueness.
   */
  private static asConflict(error: unknown): unknown {
    const { code, keyPattern } = (error ?? {}) as {
      code?: number;
      keyPattern?: Record<string, unknown>;
    };
    if (code !== 11000) {
      return error;
    }
    switch (Object.keys(keyPattern ?? {})[0]) {
      case 'phone':
        return new ConflictException('This phone number is already registered');
      case 'email':
        return new ConflictException('This email is already registered');
      default:
        return new ConflictException('A user with these details already exists');
    }
  }

  async countByRole(companyId: string, role: UserRole): Promise<number> {
    return this.userModel.countDocuments({ companyId, role }).exec();
  }

  // Absent filters must be omitted, not passed as `undefined`: Mongoose matches
  // an undefined value literally, so `{ role: undefined }` returns nothing and an
  // unfiltered list would come back empty.
  //
  // spec 013 T238 (US13) — `companyId` is meaningful only for `SUPER_ADMIN`: the
  // tenant-scope plugin already narrows a FUEL_COMPANY_ADMIN/TRANSPORT_COMPANY_ADMIN
  // caller to their own tenant automatically, and passing this filter for either role
  // would be redundant with (never wider than) what the plugin already enforces. For
  // `SUPER_ADMIN`, who bypasses the plugin entirely, this is the ONLY thing that can
  // narrow the result to one company's users at all — omitting it for that role would
  // return every user on the platform.
  findAll(filter: { role?: UserRole; isActive?: boolean; companyId?: string }): Promise<UserDocument[]> {
    const query: FilterQuery<UserDocument> = {};
    if (filter.role !== undefined) {
      query.role = filter.role;
    }
    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }
    if (filter.companyId !== undefined) {
      query.companyId = filter.companyId;
    }
    return this.userModel.find(query).exec();
  }

  async setActive(id: string, isActive: boolean, session?: ClientSession): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(id, { isActive }, { new: true, session })
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /** spec 004 FR-023 — a Fuel Company sets a client's credit limit. The
   * caller (users.controller.ts) is responsible for confirming the target
   * is actually a CLIENT; tenant scoping (the target must belong to the
   * acting admin's own company) is automatic, same as every other write here. */
  // spec 013 T065: `session` lets `CreditLimitRequestsService.resolve` write this in the
  // same transaction as the request's own resolution (Principle V) — a crash between the
  // two must never leave an ACCEPTED request whose grant was never actually applied.
  async setCreditLimit(
    id: string,
    creditLimit: number,
    session?: ClientSession,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(id, { creditLimit }, { new: true, session })
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async update(id: string, data: Partial<User>): Promise<UserDocument> {
    let user: UserDocument | null;
    try {
      user = await this.userModel.findByIdAndUpdate(id, data, { new: true }).exec();
    } catch (error) {
      throw UsersService.asConflict(error);
    }
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
