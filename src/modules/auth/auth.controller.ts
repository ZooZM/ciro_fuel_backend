import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { VerifyResetCodeDto } from './dto/verify-reset-code.dto';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { RequestLoginCodeDto } from './dto/request-login-code.dto';
import { VerifyLoginCodeDto } from './dto/verify-login-code.dto';
import { PasswordResetService } from './services/password-reset.service';
import { LoginCodeService } from './services/login-code.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { UsersService } from '../users/users.service';
import { UserRole } from '../../common/enums/user-role.enum';
import { StationsService } from '../stations/stations.service';
import { SessionAuditService } from '../sessions/session-audit.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { OperatorAccountDto } from './dto/operator-account.dto';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly stationsService: StationsService,
    private readonly passwordResetService: PasswordResetService,
    private readonly loginCodeService: LoginCodeService,
    private readonly sessionAudit: SessionAuditService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // spec 015 US2 — passwordless administrator sign-in. Both @Public(). This
  // 202 is identical for every outcome (admin, driver, client, unknown,
  // inactive, or more than one match; SMS sent or failed) — never branch on
  // the service result here (FR-015), the same rule `password-reset/request`
  // follows. A code is created and sent ONLY when the number resolves to
  // exactly one active administrator.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(202)
  @Post('login/code/request')
  requestLoginCode(@Body() dto: RequestLoginCodeDto) {
    return this.loginCodeService.requestCode(dto.phone, dto.challenge);
  }

  // Response shape is byte-identical to POST /auth/login (FR-016); both
  // tokens carry `sid`.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login/code/verify')
  verifyLoginCode(@Body() dto: VerifyLoginCodeDto) {
    return this.loginCodeService.verifyCode(dto.phone, dto.code);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // FR-029: ends the session server-side, not just on the device — a
  // refresh token captured before this call must be refused afterwards.
  // spec 015 FR-035: for an admin, only the calling session (`user.sid`,
  // stamped from the verified token) is closed; the other devices continue.
  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.authService.logout(user);
  }

  // spec 006 US3 — FR-021: this response is identical whether `phone`
  // belongs to an account, a code was sent successfully, or the SMS
  // provider rejected the send. Never branch on the service's outcome
  // here; that is precisely the property PasswordResetService.requestReset
  // exists to guarantee.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(202)
  @Post('password-reset/request')
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.passwordResetService.requestReset(dto.phone);
  }

  @Public()
  @HttpCode(200)
  @Post('password-reset/verify')
  verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.passwordResetService.verify(dto.phone, dto.code);
  }

  @Public()
  @HttpCode(204)
  @Post('password-reset/complete')
  async completePasswordReset(@Body() dto: CompletePasswordResetDto) {
    await this.passwordResetService.complete(dto.resetToken, dto.newPassword);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    const fullUser = await this.usersService.findById(user.userId);
    return {
      id: fullUser._id,
      role: fullUser.role,
      companyId: fullUser.companyId,
      fullName: fullUser.fullName,
      email: fullUser.email,
      phone: fullUser.phone,
      isActive: fullUser.isActive,
      // CLIENT-only (spec 004 US3/FR-009); undefined for every other role.
      // spec 005 T017: sourced from the standalone Station collection's
      // default (research R1) rather than the embedded field, but mapped
      // down to the SAME shape the embedded Station carried — this response
      // must stay byte-identical, since the driver app also calls this
      // endpoint and must not notice the migration underneath it.
      station: await this.resolveStation(fullUser),
      creditLimit: fullUser.creditLimit,
    };
  }

  /**
   * spec 017 (operator dashboard) T123/FR-057–FR-059/FR-063 — the operator's
   * own account.
   *
   * A SEPARATE route rather than fields added to `GET /auth/me` above, which
   * both Flutter clients call and which FR-075 freezes. Exposed to
   * `SUPER_ADMIN` alone for now (FR-074); nothing about the shape prevents the
   * other administrator roles being added later.
   *
   * `activeSessionCount` reads `User.activeSessions.length` — the live array,
   * feature 015's concurrent-session model. `lastSignInAt` reads the newest
   * `SIGNED_IN` audit event instead, because that array holds only CURRENT
   * sessions: it empties on sign-out, so reading a last-sign-in time from it
   * would report "never" for an administrator who signs in and out daily. The
   * audit log is append-only and TTL-free, so it stays correct (research R10).
   */
  @Roles(UserRole.SUPER_ADMIN)
  @Get('me/account')
  async meAccount(@CurrentUser() user: AuthenticatedUser): Promise<OperatorAccountDto> {
    const [fullUser, lastSignInAt] = await Promise.all([
      this.usersService.findById(user.userId),
      this.sessionAudit.lastSignInAt(user.userId),
    ]);
    return {
      fullName: fullUser.fullName,
      email: fullUser.email,
      // FR-057: the REAL sign-in identifier. The mock rendered a mask, which
      // is worse than useless on this screen — an operator checking which
      // number they sign in with cannot read it off a mask.
      phone: fullUser.phone,
      activeSessionCount: fullUser.activeSessions?.length ?? 0,
      lastSignInAt: lastSignInAt ? lastSignInAt.toISOString() : null,
      // No permission list and no account statistic — the platform records
      // neither, so neither is fabricated here (FR-063).
    };
  }

  private async resolveStation(fullUser: {
    role: UserRole;
    _id: unknown;
    station?: {
      regionCode: unknown;
      governorateCode: unknown;
      location: unknown;
      addressText: string;
      name?: string;
    };
  }) {
    if (fullUser.role !== UserRole.CLIENT) {
      return undefined;
    }
    const defaultStation = await this.stationsService.findDefaultForClient(String(fullUser._id));
    if (defaultStation) {
      return {
        regionCode: defaultStation.regionCode,
        governorateCode: defaultStation.governorateCode,
        location: defaultStation.location,
        addressText: defaultStation.addressText,
        name: defaultStation.name,
      };
    }
    // Pre-migration fallback: a client whose embedded station hasn't been
    // promoted yet (migration not yet run in this environment) still sees
    // their real station rather than nothing.
    return fullUser.station;
  }
}
