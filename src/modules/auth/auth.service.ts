import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { UsersService } from '../users/users.service';
import {
  AuthenticatedUser,
  JwtPayload,
} from '../../common/interfaces/jwt-payload.interface';
import { UserDocument } from '../users/schemas/user.schema';
import { LoginDto } from './dto/login.dto';
import { SessionAuditService } from '../sessions/session-audit.service';
import { SessionRevocationCause } from '../../common/enums/session-revocation-cause.enum';
import { RealtimeGatewayService } from '../../common/realtime/realtime-gateway.service';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { isSessionCappedRole } from '../../common/constants/session-capped-roles';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const GENERIC_AUTH_ERROR = 'Invalid credentials'; // never distinguish bad password vs inactive vs suspended
const SESSION_REVOKED_EVENT = 'session:revoked';

/** spec 015 §1.1 — 32 bytes of randomness, hex, generated per admin sign-in. */
export function generateSid(): string {
  return randomBytes(32).toString('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly sessionAudit: SessionAuditService,
    private readonly realtimeGateway: RealtimeGatewayService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async login(dto: LoginDto): Promise<TokenPair & { user: SafeUser }> {
    const user = dto.phone
      ? await this.usersService.findByPhoneForAuth(dto.phone)
      : await this.usersService.findByEmailForAuth(dto.email!);
    if (!user) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const passwordMatches = await UsersService.comparePassword(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const userId = (user._id as { toString(): string }).toString();
    // Re-run the same active-session checks used on every subsequent request.
    await this.usersService.validateActiveSession(userId);

    return isSessionCappedRole(user.role)
      ? this.adminLogin(user, userId)
      : this.mobileLogin(user, userId);
  }

  /**
   * DRIVER / CLIENT — UNCHANGED from spec 006 (FR-033, SC-013, SC-020). A
   * driver holds at most one session; every login unconditionally displaces
   * whatever came before, pushes `session:revoked` into the per-user room,
   * and disconnects the displaced sockets. `revokeAllSessions` is the old
   * `revokeSession` plus an `activeSessions` clear that is a no-op for these
   * roles (their array is never populated).
   */
  private async mobileLogin(
    user: UserDocument,
    userId: string,
  ): Promise<TokenPair & { user: SafeUser }> {
    const session = await this.connection.startSession();
    let generation!: number;
    try {
      await session.withTransaction(async () => {
        const revokedUser = await this.usersService.revokeAllSessions(
          userId,
          SessionRevocationCause.SIGNED_IN_ELSEWHERE,
          session,
        );
        generation = revokedUser.sessionGeneration ?? 0;
        const subject = {
          userId,
          companyId: user.companyId?.toString(),
          role: user.role,
          generation,
        };
        await this.sessionAudit.revoked(
          subject,
          SessionRevocationCause.SIGNED_IN_ELSEWHERE,
          session,
        );
        await this.sessionAudit.signedIn(subject, session);
      });
    } finally {
      await session.endSession();
    }

    // Generation is already bumped — genuinely dead — before this goes out,
    // since Socket.io won't re-validate a frame already in flight to the
    // displaced device (spec 006 research R2).
    this.realtimeGateway.emitToUser(userId, SESSION_REVOKED_EVENT, {
      cause: SessionRevocationCause.SIGNED_IN_ELSEWHERE,
      occurredAt: new Date().toISOString(),
    });
    this.realtimeGateway.disconnectUser(userId);

    const tokens = await this.issueTokenPair(user, generation);
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * SUPER_ADMIN / FUEL_COMPANY_ADMIN / TRANSPORT_COMPANY_ADMIN (spec 015
   * FR-032/038). A new `ActiveSession` is opened; prior sessions survive up
   * to `auth.maxAdminSessions`; the oldest is evicted beyond it. NO
   * `sessionGeneration` bump — the admin's other devices must keep working.
   *
   * T025: deliberately NO `session:revoked` emit and NO `disconnectUser`
   * here (research R3) — the realtime room is `user:{userId}`, per user not
   * per session, so either would sign the administrator out of the very
   * devices this feature exists to keep working. The evicted device learns
   * on its next platform contact, via `validateActiveSessionWithScoping`.
   * Do not "fix" this back.
   */
  private async adminLogin(
    user: UserDocument,
    userId: string,
  ): Promise<TokenPair & { user: SafeUser }> {
    const cap = this.config.get<number>('auth.maxAdminSessions') ?? 3;
    const sid = generateSid();
    const generation = user.sessionGeneration ?? 0; // unchanged for admins

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const { evictedSids } = await this.usersService.openSession(userId, sid, cap, session);
        const baseSubject = {
          userId,
          companyId: user.companyId?.toString(),
          role: user.role,
          generation,
        };
        for (const evictedSid of evictedSids) {
          await this.sessionAudit.revoked(
            { ...baseSubject, sid: evictedSid },
            SessionRevocationCause.SESSION_LIMIT_EXCEEDED,
            session,
          );
        }
        await this.sessionAudit.signedIn({ ...baseSubject, sid }, session);
      });
    } finally {
      await session.endSession();
    }

    const tokens = await this.issueTokenPair(user, generation, sid);
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * FR-029 (mobile) / spec 015 FR-035 (admin): sign-out ends the session
   * server-side, not just on the device.
   *
   * DRIVER / CLIENT — UNCHANGED: `revokeAllSessions` bumps the generation,
   * ending their one session. No `cause`: this device already cleared its
   * own tokens.
   *
   * Admin roles — closes ONLY the calling `sid` (read off the authenticated
   * request's own token, stamped by `JwtStrategy.validate`). The
   * administrator's other devices continue. There is no request body and no
   * way to sign another device out.
   */
  async logout(actor: AuthenticatedUser): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (isSessionCappedRole(actor.role) && actor.sid) {
          const user = await this.usersService.closeSession(actor.userId, actor.sid, session);
          await this.sessionAudit.signedOut(
            {
              userId: actor.userId,
              companyId: user.companyId?.toString(),
              role: user.role,
              generation: user.sessionGeneration ?? 0,
              sid: actor.sid,
            },
            session,
          );
          return;
        }
        const user = await this.usersService.revokeAllSessions(actor.userId, undefined, session);
        await this.sessionAudit.signedOut(
          {
            userId: actor.userId,
            companyId: user.companyId?.toString(),
            role: user.role,
            generation: user.sessionGeneration ?? 0,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const user = await this.usersService.validateActiveSession(payload.sub);
    // spec 006 FR-027/029/035b: a refresh token minted against a session
    // generation that has since been bumped must not renew the session it
    // belonged to. Same structured `SESSION_REVOKED`+`cause` shape as
    // `validateActiveSessionWithScoping`'s own mismatch branch (FR-036).
    if ((payload.sgen ?? 0) !== (user.sessionGeneration ?? 0)) {
      throw new UnauthorizedException({
        error: ErrorCode.SESSION_REVOKED,
        cause: user.lastRevocationCause,
        message: 'Your session has ended',
      });
    }

    // spec 015 FR-039: an admin refresh token whose `sid` is no longer in
    // `activeSessions` (evicted by the cap, or closed by that device's own
    // sign-out) must not be renewable. Skipped entirely for DRIVER/CLIENT,
    // whose tokens carry no `sid`.
    if (isSessionCappedRole(user.role)) {
      const open = (user.activeSessions ?? []).some((s) => s.sid === payload.sid);
      if (!payload.sid || !open) {
        throw new UnauthorizedException({
          error: ErrorCode.SESSION_REVOKED,
          cause: SessionRevocationCause.SESSION_LIMIT_EXCEEDED,
          message: 'Your session has ended',
        });
      }
    }

    // spec 015 T028a: pass the PRESENTED token's own `sid` through. Refresh
    // re-issues a credential for an EXISTING session; it does not open a new
    // one. A freshly generated `sid` here would be absent from
    // `activeSessions`, so the next request with the renewed token is
    // refused — every admin session would die one access-token lifetime
    // after sign-in, and the symptom looks nothing like the cause.
    // `payload.sid` is `undefined` for DRIVER/CLIENT, so nothing is carried.
    return this.issueTokenPair(user, user.sessionGeneration ?? 0, payload.sid);
  }

  /**
   * spec 015 — `LoginCodeService` opens the admin session (and writes its
   * audit rows) in its own transaction, then calls this to mint the pair.
   * The response shape is byte-identical to `login` (FR-016).
   */
  async issueAdminCodeSession(
    user: UserDocument,
    sid: string,
  ): Promise<TokenPair & { user: SafeUser }> {
    const tokens = await this.issueTokenPair(user, user.sessionGeneration ?? 0, sid);
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * `sid` is an explicit INPUT, never generated here (spec 015 T026/T028a).
   * Carried on both tokens only when provided — i.e. for admin roles.
   * DRIVER/CLIENT payloads stay byte-identical to spec 006.
   */
  private async issueTokenPair(
    user: UserDocument,
    generation: number,
    sid?: string,
  ): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: (user._id as { toString(): string }).toString(),
      role: user.role,
      companyId: user.companyId?.toString(),
      sgen: generation,
      ...(sid ? { sid } : {}),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.config.get<string>('jwt.secret'),
        expiresIn: this.config.get<string>('jwt.expiresIn'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.config.get<string>('jwt.refreshSecret'),
        expiresIn: this.config.get<string>('jwt.refreshExpiresIn'),
      }),
    ]);

    return { accessToken, refreshToken };
  }
}

export interface SafeUser {
  id: string;
  role: string;
  companyId?: string;
  fullName: string;
  email: string;
}

function toSafeUser(user: UserDocument): SafeUser {
  return {
    id: (user._id as { toString(): string }).toString(),
    role: user.role,
    companyId: user.companyId?.toString(),
    fullName: user.fullName,
    email: user.email,
  };
}
