import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { VerifyResetCodeDto } from './dto/verify-reset-code.dto';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { PasswordResetService } from './services/password-reset.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { UsersService } from '../users/users.service';
import { UserRole } from '../../common/enums/user-role.enum';
import { StationsService } from '../stations/stations.service';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly stationsService: StationsService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // FR-029: ends the session server-side, not just on the device — a
  // refresh token captured before this call must be refused afterwards.
  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.authService.logout(user.userId);
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
