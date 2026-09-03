import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { UsersService } from '../users/users.service';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { UserDocument } from '../users/schemas/user.schema';
import { LoginDto } from './dto/login.dto';
import { SessionAuditService } from '../sessions/session-audit.service';
import { SessionRevocationCause } from '../../common/enums/session-revocation-cause.enum';
import { RealtimeGatewayService } from '../../common/realtime/realtime-gateway.service';
import { ErrorCode } from '../../common/enums/error-code.enum';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const GENERIC_AUTH_ERROR = 'Invalid credentials'; // never distinguish bad password vs inactive vs suspended
const SESSION_REVOKED_EVENT = 'session:revoked';

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

    // FR-042: a driver holds at most one session; there is no bookkeeping
    // that distinguishes "a prior session genuinely existed" from "this is
    // the first sign-in ever" (research R1 — the counter is structural,
    // not tracked), so every login unconditionally displaces whatever
    // came before. Both audit rows land in the same transaction as the
    // bump (Principle V): a REVOKED row without its SIGNED_IN counterpart,
    // or vice versa, would misdescribe what actually happened.
    const session = await this.connection.startSession();
    let generation!: number;
    try {
      await session.withTransaction(async () => {
        const revokedUser = await this.usersService.revokeSession(
          userId,
          session,
          SessionRevocationCause.SIGNED_IN_ELSEWHERE,
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

    // T074: the generation must already be bumped — genuinely dead — before
    // this goes out, since Socket.io won't re-validate a frame already in
    // flight to the displaced device (research R2).
    this.realtimeGateway.emitToUser(userId, SESSION_REVOKED_EVENT, {
      cause: SessionRevocationCause.SIGNED_IN_ELSEWHERE,
      occurredAt: new Date().toISOString(),
    });
    // feature 013 US2 (FR-017, realtime-contract §3): and end the displaced
    // device's socket outright, so it stops retrying and holding a slot with
    // every frame refused. Same ordering as the emit above — generation
    // already committed. Degrades rather than throwing on a Redis-adapter
    // failure (spec 012 Q7); the gateway's per-frame check is the guarantee
    // that survives a lost disconnect.
    this.realtimeGateway.disconnectUser(userId);

    const tokens = await this.issueTokenPair(user, generation);
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * FR-029: sign-out ends the session server-side, not just on the
   * device — otherwise a stolen refresh token would keep working after
   * the driver signed out. No `cause` (see `UsersService.revokeSession`):
   * this device already knows why its own session ended.
   */
  async logout(userId: string): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const user = await this.usersService.revokeSession(userId, session);
        await this.sessionAudit.signedOut(
          {
            userId,
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
    // generation that has since been bumped (sign-out, password reset,
    // deactivation, or displacement by a sign-in elsewhere) must not renew
    // the session it belonged to — otherwise every revocation in this
    // feature would last only until the next silent refresh. Not folded
    // into `validateActiveSession` (see that method's docstring): this is
    // the one place refresh itself owns the comparison, against the token
    // it already holds. Same structured `SESSION_REVOKED`+`cause` shape as
    // `validateActiveSessionWithScoping`'s own mismatch branch (FR-036) —
    // this is presenting a live session's credential too, just over
    // `/auth/refresh` instead of an authenticated request.
    if ((payload.sgen ?? 0) !== (user.sessionGeneration ?? 0)) {
      throw new UnauthorizedException({
        error: ErrorCode.SESSION_REVOKED,
        cause: user.lastRevocationCause,
        message: 'Your session has ended',
      });
    }
    return this.issueTokenPair(user, user.sessionGeneration ?? 0);
  }

  private async issueTokenPair(user: UserDocument, generation: number): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: (user._id as { toString(): string }).toString(),
      role: user.role,
      companyId: user.companyId?.toString(),
      sgen: generation,
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
